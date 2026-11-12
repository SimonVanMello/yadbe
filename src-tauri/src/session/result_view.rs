//! Sort and filter of a stored result without running the query again (F-065): an ordered,
//! filtered list of row numbers over the rows the `ResultStore` keeps. The grid reads windows
//! of that list (rule 8: rows stay in the backend), a copy, an aggregate or a selection export
//! reads through it, and the user's statement is never touched.
//!
//! Values compare like the grid shows them: numbers by value (exactly for integers and
//! decimals), text without regard to case unless asked, everything else as text. `NULL` is
//! never greater or smaller than anything: it sorts last in both directions.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::value::ValueKind;
use crate::session::decimal::{Parsed, parse};

/// What a condition asks of a cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ViewFilterOp {
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Equals,
    NotEquals,
    Greater,
    GreaterOrEqual,
    Less,
    LessOrEqual,
    IsNull,
    IsNotNull,
}

/// One sort key: a column of the result (data order) and a direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewSort {
    pub column: u32,
    pub descending: bool,
}

/// A condition on one column, or on every column (`column` absent: some cell matches; for the
/// negative operators, no cell does).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ViewFilter {
    pub column: Option<u32>,
    pub op: ViewFilterOp,
    /// As typed; ignored by `isNull` / `isNotNull`.
    pub value: String,
}

/// How the grid shows a result: the rows that pass every filter, ordered by the sort keys.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultViewSpec {
    pub sort: Vec<ViewSort>,
    pub filters: Vec<ViewFilter>,
    /// Text conditions and sorts tell `a` from `A`.
    #[serde(default)]
    pub match_case: bool,
}

impl ResultViewSpec {
    /// Nothing to sort or filter: the result is shown as it came.
    pub fn is_empty(&self) -> bool {
        self.sort.is_empty() && self.filters.is_empty()
    }

    /// The highest column a key or condition names, `None` when none names one.
    pub fn max_column(&self) -> Option<u32> {
        self.sort
            .iter()
            .map(|key| key.column)
            .chain(self.filters.iter().filter_map(|f| f.column))
            .max()
    }
}

/// The rows a view shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultViewInfo {
    /// Rows shown.
    pub row_count: u32,
    /// Rows the result holds, shown or not.
    pub source_rows: u32,
}

/// Where a cell is: its kind (`None` for `NULL`) and lossless text.
pub type CellRef<'a> = (Option<ValueKind>, &'a str);

enum Number<'a> {
    Decimal(Parsed<'a>),
    Float(f64),
}

impl Number<'_> {
    fn as_float(&self) -> f64 {
        match self {
            Number::Float(value) => *value,
            Number::Decimal(parsed) => parsed.to_text().parse().unwrap_or(f64::NAN),
        }
    }

    fn compare(&self, other: &Number<'_>) -> Ordering {
        match (self, other) {
            (Number::Decimal(a), Number::Decimal(b)) => a.compare(b),
            _ => self
                .as_float()
                .partial_cmp(&other.as_float())
                .unwrap_or(Ordering::Equal),
        }
    }
}

/// A cell as a sort key. The rank orders what is not comparable: numbers, booleans, text.
enum Key<'a> {
    Null,
    Number(Number<'a>),
    Bool(bool),
    Text(&'a str),
}

impl<'a> Key<'a> {
    fn of((kind, text): CellRef<'a>) -> Self {
        match kind {
            None => Key::Null,
            Some(ValueKind::Int | ValueKind::Decimal) => {
                parse(text).map_or(Key::Text(text), |p| Key::Number(Number::Decimal(p)))
            }
            Some(ValueKind::Float) => text
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
                .map_or(Key::Text(text), |n| Key::Number(Number::Float(n))),
            Some(ValueKind::Bool) => Key::Bool(text == "true"),
            Some(_) => Key::Text(text),
        }
    }

    fn rank(&self) -> u8 {
        match self {
            Key::Number(_) => 0,
            Key::Bool(_) => 1,
            Key::Text(_) => 2,
            Key::Null => 3,
        }
    }

    fn compare(&self, other: &Key<'_>, match_case: bool) -> Ordering {
        self.rank()
            .cmp(&other.rank())
            .then_with(|| match (self, other) {
                (Key::Number(a), Key::Number(b)) => a.compare(b),
                (Key::Bool(a), Key::Bool(b)) => a.cmp(b),
                (Key::Text(a), Key::Text(b)) => compare_text(a, b, match_case),
                _ => Ordering::Equal,
            })
    }
}

/// Text compared without regard to case unless `match_case`: what a condition means by equal.
fn compare_folded(a: &str, b: &str, match_case: bool) -> Ordering {
    if match_case {
        return a.cmp(b);
    }
    if a.is_ascii() && b.is_ascii() {
        fn lower(text: &str) -> impl Iterator<Item = u8> + '_ {
            text.bytes().map(|byte| byte.to_ascii_lowercase())
        }
        return lower(a).cmp(lower(b));
    }
    let folded = |text: &str| {
        text.chars()
            .flat_map(char::to_lowercase)
            .collect::<Vec<_>>()
    };
    folded(a).cmp(&folded(b))
}

/// Sort order of text: `compare_folded`, ties broken by the exact text so the order is total.
fn compare_text(a: &str, b: &str, match_case: bool) -> Ordering {
    compare_folded(a, b, match_case).then_with(|| a.cmp(b))
}

fn contains_text(hay: &str, needle: &str, folded_needle: &str, match_case: bool) -> bool {
    if match_case {
        return hay.contains(needle);
    }
    if hay.is_ascii() && folded_needle.is_ascii() {
        let wanted = folded_needle.as_bytes();
        return wanted.is_empty()
            || hay
                .as_bytes()
                .windows(wanted.len())
                .any(|window| window.eq_ignore_ascii_case(wanted));
    }
    hay.to_lowercase().contains(folded_needle)
}

fn starts_with_text(hay: &str, needle: &str, folded_needle: &str, match_case: bool) -> bool {
    if match_case {
        return hay.starts_with(needle);
    }
    if hay.is_ascii() && folded_needle.is_ascii() {
        let wanted = folded_needle.as_bytes();
        return hay.len() >= wanted.len()
            && hay.as_bytes()[..wanted.len()].eq_ignore_ascii_case(wanted);
    }
    hay.to_lowercase().starts_with(folded_needle)
}

fn ends_with_text(hay: &str, needle: &str, folded_needle: &str, match_case: bool) -> bool {
    if match_case {
        return hay.ends_with(needle);
    }
    if hay.is_ascii() && folded_needle.is_ascii() {
        let wanted = folded_needle.as_bytes();
        return hay.len() >= wanted.len()
            && hay.as_bytes()[hay.len() - wanted.len()..].eq_ignore_ascii_case(wanted);
    }
    hay.to_lowercase().ends_with(folded_needle)
}

/// A condition ready to run: the value typed once, as text and, when it reads as one, as a
/// number.
struct Condition {
    column: Option<usize>,
    op: ViewFilterOp,
    needle: String,
    folded: String,
    number: Option<(bool, String, String)>,
    match_case: bool,
}

impl Condition {
    fn new(filter: &ViewFilter, match_case: bool) -> Self {
        let number =
            parse(&filter.value).map(|p| (p.negative, p.int.to_owned(), p.frac.to_owned()));
        Self {
            column: filter.column.map(|c| c as usize),
            op: filter.op,
            folded: filter.value.to_lowercase(),
            needle: filter.value.clone(),
            number,
            match_case,
        }
    }

    fn needle_number(&self) -> Option<Number<'_>> {
        self.number.as_ref().map(|(negative, int, frac)| {
            Number::Decimal(Parsed {
                negative: *negative,
                int,
                frac,
            })
        })
    }

    /// The cell against the condition's value: by number when both are numbers, else as text.
    fn order(&self, cell: (ValueKind, &str)) -> Ordering {
        let (kind, text) = cell;
        if matches!(kind, ValueKind::Int | ValueKind::Decimal | ValueKind::Float)
            && let (Key::Number(value), Some(wanted)) =
                (Key::of((Some(kind), text)), self.needle_number())
        {
            return value.compare(&wanted);
        }
        compare_folded(text, &self.needle, self.match_case)
    }

    /// The positive form of the operator on one non-`NULL` cell.
    fn positive(&self, cell: (ValueKind, &str)) -> bool {
        let text = cell.1;
        match self.op {
            ViewFilterOp::Contains | ViewFilterOp::NotContains => {
                contains_text(text, &self.needle, &self.folded, self.match_case)
            }
            ViewFilterOp::StartsWith => {
                starts_with_text(text, &self.needle, &self.folded, self.match_case)
            }
            ViewFilterOp::EndsWith => {
                ends_with_text(text, &self.needle, &self.folded, self.match_case)
            }
            ViewFilterOp::Equals | ViewFilterOp::NotEquals => self.order(cell) == Ordering::Equal,
            ViewFilterOp::Greater => self.order(cell) == Ordering::Greater,
            ViewFilterOp::GreaterOrEqual => self.order(cell) != Ordering::Less,
            ViewFilterOp::Less => self.order(cell) == Ordering::Less,
            ViewFilterOp::LessOrEqual => self.order(cell) != Ordering::Greater,
            ViewFilterOp::IsNull | ViewFilterOp::IsNotNull => true,
        }
    }

    fn negated(&self) -> bool {
        matches!(self.op, ViewFilterOp::NotContains | ViewFilterOp::NotEquals)
    }

    /// Whether a cell passes. A `NULL` cell is only ever matched by `isNull` and the
    /// negative operators.
    fn cell(&self, (kind, text): CellRef<'_>) -> bool {
        match (self.op, kind) {
            (ViewFilterOp::IsNull, kind) => kind.is_none(),
            (ViewFilterOp::IsNotNull, kind) => kind.is_some(),
            (_, None) => self.negated(),
            (_, Some(kind)) => self.positive((kind, text)) != self.negated(),
        }
    }
}

/// An ordered, filtered list of rows of a result.
#[derive(Debug)]
pub struct ResultView {
    spec: ResultViewSpec,
    rows: Vec<u32>,
    /// Rows of the result already taken into account.
    built: usize,
}

impl ResultView {
    pub fn new(spec: ResultViewSpec) -> Self {
        Self {
            spec,
            rows: Vec::new(),
            built: 0,
        }
    }

    pub fn rows(&self) -> &[u32] {
        &self.rows
    }

    /// Takes the rows the result gained since the last call into account: appended to a
    /// filtered view in their order, a sorted view is built again.
    pub fn refresh<'a>(
        &mut self,
        total: usize,
        width: usize,
        cell: &impl Fn(usize, usize) -> CellRef<'a>,
    ) {
        if self.built == total {
            return;
        }
        let conditions: Vec<Condition> = self
            .spec
            .filters
            .iter()
            .map(|filter| Condition::new(filter, self.spec.match_case))
            .collect();
        let passes = |row: usize| {
            conditions.iter().all(|condition| match condition.column {
                Some(column) => condition.cell(cell(row, column)),
                None => {
                    let any = |f: &dyn Fn(CellRef<'a>) -> bool| (0..width).any(|c| f(cell(row, c)));
                    match condition.op {
                        ViewFilterOp::IsNotNull => (0..width).all(|c| cell(row, c).0.is_some()),
                        ViewFilterOp::NotContains | ViewFilterOp::NotEquals => {
                            !any(&|c| matches!(c.0, Some(kind) if condition.positive((kind, c.1))))
                        }
                        ViewFilterOp::IsNull => any(&|c| c.0.is_none()),
                        _ => any(&|c| matches!(c.0, Some(kind) if condition.positive((kind, c.1)))),
                    }
                }
            })
        };
        let to_row = |row: usize| u32::try_from(row).unwrap_or(u32::MAX);
        if self.spec.sort.is_empty() {
            self.rows
                .extend((self.built..total).filter(|&row| passes(row)).map(to_row));
            self.built = total;
            return;
        }
        let mut rows: Vec<u32> = (0..total).filter(|&row| passes(row)).map(to_row).collect();
        let keys: Vec<Vec<Key<'a>>> = self
            .spec
            .sort
            .iter()
            .map(|sort| {
                rows.iter()
                    .map(|&row| Key::of(cell(row as usize, sort.column as usize)))
                    .collect()
            })
            .collect();
        let mut order: Vec<usize> = (0..rows.len()).collect();
        order.sort_by(|&a, &b| {
            for (sort, column) in self.spec.sort.iter().zip(&keys) {
                let (left, right) = (&column[a], &column[b]);
                // NULL stays last whatever the direction.
                let ordering = match (matches!(left, Key::Null), matches!(right, Key::Null)) {
                    (true, true) => Ordering::Equal,
                    (true, false) => return Ordering::Greater,
                    (false, true) => return Ordering::Less,
                    (false, false) => {
                        let found = left.compare(right, self.spec.match_case);
                        if sort.descending {
                            found.reverse()
                        } else {
                            found
                        }
                    }
                };
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            Ordering::Equal
        });
        rows = order.into_iter().map(|i| rows[i]).collect();
        self.rows = rows;
        self.built = total;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny grid of `(kind, text)` cells for the tests; `None` is NULL.
    struct Grid(Vec<Vec<Option<(ValueKind, &'static str)>>>);

    impl Grid {
        fn cell(&self, row: usize, col: usize) -> CellRef<'_> {
            match self.0[row][col] {
                Some((kind, text)) => (Some(kind), text),
                None => (None, ""),
            }
        }

        fn view(&self, spec: ResultViewSpec) -> Vec<u32> {
            let mut view = ResultView::new(spec);
            view.refresh(self.0.len(), self.0[0].len(), &|r, c| self.cell(r, c));
            view.rows().to_vec()
        }
    }

    fn spec(sort: &[(u32, bool)], filters: Vec<ViewFilter>) -> ResultViewSpec {
        ResultViewSpec {
            sort: sort
                .iter()
                .map(|&(column, descending)| ViewSort { column, descending })
                .collect(),
            filters,
            match_case: false,
        }
    }

    fn filter(column: Option<u32>, op: ViewFilterOp, value: &str) -> ViewFilter {
        ViewFilter {
            column,
            op,
            value: value.to_owned(),
        }
    }

    use ValueKind::{Decimal, Int, Text};

    fn sample() -> Grid {
        Grid(vec![
            vec![
                Some((Int, "10")),
                Some((Text, "banana")),
                Some((Decimal, "1.50")),
            ],
            vec![Some((Int, "9")), Some((Text, "Apple")), None],
            vec![
                Some((Int, "-3")),
                Some((Text, "cherry")),
                Some((Decimal, "1.5")),
            ],
            vec![None, Some((Text, "apple")), Some((Decimal, "0.25"))],
            vec![
                Some((Int, "9223372036854775807")),
                Some((Text, "")),
                Some((Decimal, "-1")),
            ],
        ])
    }

    #[test]
    fn sorts_numbers_by_value_text_without_case_and_keeps_null_last() {
        let grid = sample();
        // 9 < 10, not "10" < "9"; the NULL last.
        assert_eq!(grid.view(spec(&[(0, false)], vec![])), [2, 1, 0, 4, 3]);
        // Descending keeps the NULL last too.
        assert_eq!(grid.view(spec(&[(0, true)], vec![])), [4, 0, 1, 2, 3]);
        // Text: empty first, `Apple` and `apple` together (the tie keeps A before a).
        assert_eq!(grid.view(spec(&[(1, false)], vec![])), [4, 1, 3, 0, 2]);
        // Equal decimals (1.50, 1.5) keep their order: the sort is stable.
        assert_eq!(grid.view(spec(&[(2, false)], vec![])), [4, 3, 0, 2, 1]);
        // Two keys: rows 0 and 2 tie on the decimal column, the second key breaks it.
        assert_eq!(
            grid.view(spec(&[(2, false), (0, true)], vec![])),
            [4, 3, 0, 2, 1]
        );
    }

    #[test]
    fn filters_by_text_numbers_and_nulls() {
        let grid = sample();
        let rows = |f: ViewFilter| grid.view(spec(&[], vec![f]));
        assert_eq!(rows(filter(Some(1), ViewFilterOp::Contains, "PP")), [1, 3]);
        assert_eq!(rows(filter(Some(1), ViewFilterOp::StartsWith, "c")), [2]);
        assert_eq!(rows(filter(Some(1), ViewFilterOp::EndsWith, "ANA")), [0]);
        assert_eq!(rows(filter(Some(1), ViewFilterOp::Equals, "APPLE")), [1, 3]);
        assert_eq!(
            rows(filter(Some(1), ViewFilterOp::NotContains, "an")),
            [1, 2, 3, 4]
        );
        // Numbers compare by value: 1.5 equals 1.50, 10 is greater than 9.
        assert_eq!(rows(filter(Some(2), ViewFilterOp::Equals, "1.500")), [0, 2]);
        assert_eq!(rows(filter(Some(0), ViewFilterOp::Greater, "9")), [0, 4]);
        assert_eq!(
            rows(filter(Some(0), ViewFilterOp::LessOrEqual, "9")),
            [1, 2]
        );
        assert_eq!(
            rows(filter(Some(0), ViewFilterOp::Less, "-3")),
            Vec::<u32>::new()
        );
        // 64-bit integers are compared exactly.
        assert_eq!(
            rows(filter(Some(0), ViewFilterOp::Equals, "9223372036854775807")),
            [4]
        );
        assert_eq!(
            rows(filter(
                Some(0),
                ViewFilterOp::Greater,
                "9223372036854775806"
            )),
            [4]
        );
        // NULLs.
        assert_eq!(rows(filter(Some(0), ViewFilterOp::IsNull, "")), [3]);
        assert_eq!(
            rows(filter(Some(2), ViewFilterOp::IsNotNull, "")),
            [0, 2, 3, 4]
        );
        // A NULL is not "not equal" to a number it was never compared with: it matches the
        // negative operators, like "does not contain".
        assert_eq!(
            rows(filter(Some(2), ViewFilterOp::NotEquals, "1.5")),
            [1, 3, 4]
        );
    }

    #[test]
    fn a_condition_on_every_column_matches_when_some_cell_does() {
        let grid = sample();
        let rows = |f: ViewFilter| grid.view(spec(&[], vec![f]));
        assert_eq!(rows(filter(None, ViewFilterOp::Contains, "ana")), [0]);
        assert_eq!(rows(filter(None, ViewFilterOp::Contains, "1.5")), [0, 2]);
        // The negative form: no cell contains it.
        assert_eq!(rows(filter(None, ViewFilterOp::NotContains, "a")), [2, 4]);
        assert_eq!(rows(filter(None, ViewFilterOp::IsNull, "")), [1, 3]);
    }

    #[test]
    fn filters_and_sorts_together_and_match_case_is_honoured() {
        let grid = sample();
        let mut wanted = spec(
            &[(0, true)],
            vec![filter(Some(1), ViewFilterOp::Contains, "a")],
        );
        assert_eq!(grid.view(wanted.clone()), [0, 1, 3]);
        wanted.match_case = true;
        wanted.filters = vec![filter(Some(1), ViewFilterOp::Contains, "A")];
        assert_eq!(grid.view(wanted), [1]);
    }

    #[test]
    fn rows_that_arrive_later_are_taken_into_account() {
        let mut cells = vec![
            vec![Some((Int, "5"))],
            vec![Some((Int, "1"))],
            vec![Some((Int, "7"))],
        ];
        let sorted = spec(&[(0, false)], vec![]);
        let filtered = spec(&[], vec![filter(Some(0), ViewFilterOp::Greater, "2")]);
        let mut sorted_view = ResultView::new(sorted);
        let mut filtered_view = ResultView::new(filtered);
        {
            let grid = Grid(cells.clone());
            sorted_view.refresh(3, 1, &|r, c| grid.cell(r, c));
            filtered_view.refresh(3, 1, &|r, c| grid.cell(r, c));
        }
        assert_eq!(sorted_view.rows(), [1, 0, 2]);
        assert_eq!(filtered_view.rows(), [0, 2]);
        cells.push(vec![Some((Int, "3"))]);
        cells.push(vec![Some((Int, "0"))]);
        let grid = Grid(cells);
        sorted_view.refresh(5, 1, &|r, c| grid.cell(r, c));
        filtered_view.refresh(5, 1, &|r, c| grid.cell(r, c));
        assert_eq!(sorted_view.rows(), [4, 1, 3, 0, 2]);
        assert_eq!(filtered_view.rows(), [0, 2, 3]);
    }

    #[test]
    fn mixed_kinds_sort_numbers_before_text() {
        let grid = Grid(vec![
            vec![Some((Text, "b"))],
            vec![Some((ValueKind::Float, "2.5"))],
            vec![Some((Int, "10"))],
            vec![Some((ValueKind::Bool, "true"))],
        ]);
        assert_eq!(grid.view(spec(&[(0, false)], vec![])), [1, 2, 3, 0]);
    }
}
