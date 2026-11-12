//! Aggregates of a selection of result cells (F-065): count, sum, average, minimum, maximum.
//! Integers and decimals add up exactly (`decimal.rs`); floating-point cells make the figures
//! floating point, which `SelectionAggregate::exact` says.

use std::cmp::Ordering;

use crate::db::value::ValueKind;
use crate::session::decimal::{DecimalSum, Parsed, parse};
use crate::session::query_model::SelectionAggregate;

#[derive(Default)]
pub struct Accumulator {
    cells: u64,
    non_null: u64,
    /// Integers and decimals, added exactly.
    exact: u64,
    floats: u64,
    sum: DecimalSum,
    min: Option<String>,
    max: Option<String>,
    float_sum: f64,
    float_min: Option<f64>,
    float_max: Option<f64>,
}

impl Accumulator {
    /// One selected cell; `kind` is `None` for `NULL`.
    pub fn cell(&mut self, kind: Option<ValueKind>, text: &str) {
        self.cells += 1;
        let Some(kind) = kind else {
            return;
        };
        self.non_null += 1;
        match kind {
            ValueKind::Int | ValueKind::Decimal => {
                if let Some(number) = parse(text) {
                    self.exact += 1;
                    self.sum.add(&number);
                    self.track(&number);
                }
            }
            ValueKind::Float => {
                if let Some(number) = text.trim().parse::<f64>().ok().filter(|n| n.is_finite()) {
                    self.floats += 1;
                    self.float_sum += number;
                    self.float_min = Some(self.float_min.map_or(number, |m| m.min(number)));
                    self.float_max = Some(self.float_max.map_or(number, |m| m.max(number)));
                }
            }
            _ => {}
        }
    }

    fn track(&mut self, number: &Parsed<'_>) {
        let beats = |current: &Option<String>, wanted: Ordering| {
            current
                .as_deref()
                .and_then(parse)
                .is_none_or(|held| number.compare(&held) == wanted)
        };
        if beats(&self.min, Ordering::Less) {
            self.min = Some(number.to_text());
        }
        if beats(&self.max, Ordering::Greater) {
            self.max = Some(number.to_text());
        }
    }

    pub fn finish(self) -> SelectionAggregate {
        let numeric = self.exact + self.floats;
        let saturate = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
        let mut result = SelectionAggregate {
            cells: saturate(self.cells),
            non_null: saturate(self.non_null),
            numeric: saturate(numeric),
            exact: self.floats == 0,
            ..SelectionAggregate::default()
        };
        if self.non_null == 0 || numeric != self.non_null {
            return result;
        }
        if self.floats == 0 {
            result.sum = Some(self.sum.to_text());
            result.avg = self.sum.average(self.exact);
            result.min = self.min;
            result.max = self.max;
            return result;
        }
        let as_float = |text: &str| text.parse::<f64>().ok();
        let total = self.float_sum + as_float(&self.sum.to_text()).unwrap_or(0.0);
        let extreme = |float: Option<f64>, exact: &Option<String>, pick: fn(f64, f64) -> f64| {
            [float, exact.as_deref().and_then(as_float)]
                .into_iter()
                .flatten()
                .reduce(pick)
        };
        let show = |n: f64| format!("{n}");
        result.sum = Some(show(total));
        result.avg = Some(show(total / numeric as f64));
        result.min = extreme(self.float_min, &self.min, f64::min).map(show);
        result.max = extreme(self.float_max, &self.max, f64::max).map(show);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(cells: &[(Option<ValueKind>, &str)]) -> SelectionAggregate {
        let mut acc = Accumulator::default();
        for (kind, text) in cells {
            acc.cell(*kind, text);
        }
        acc.finish()
    }

    fn some(kind: ValueKind, text: &str) -> (Option<ValueKind>, &str) {
        (Some(kind), text)
    }

    #[test]
    fn adds_integers_and_decimals_exactly_and_skips_nulls() {
        let aggregate = run(&[
            some(ValueKind::Int, "9223372036854775807"),
            some(ValueKind::Decimal, "0.10"),
            (None, ""),
            some(ValueKind::Decimal, "0.20"),
            some(ValueKind::Int, "-5"),
        ]);
        assert_eq!(aggregate.cells, 5);
        assert_eq!(aggregate.non_null, 4);
        assert_eq!(aggregate.numeric, 4);
        assert!(aggregate.exact);
        assert_eq!(aggregate.sum.as_deref(), Some("9223372036854775802.3"));
        assert_eq!(aggregate.min.as_deref(), Some("-5"));
        assert_eq!(aggregate.max.as_deref(), Some("9223372036854775807"));
        assert_eq!(aggregate.avg.as_deref(), Some("2305843009213693950.575"));
    }

    #[test]
    fn gives_no_figures_when_a_cell_is_not_a_number() {
        let aggregate = run(&[some(ValueKind::Int, "1"), some(ValueKind::Text, "x")]);
        assert_eq!(
            (aggregate.cells, aggregate.non_null, aggregate.numeric),
            (2, 2, 1)
        );
        assert_eq!(aggregate.sum, None);
        let only_nulls = run(&[(None, ""), (None, "")]);
        assert_eq!((only_nulls.cells, only_nulls.non_null), (2, 0));
        assert_eq!(only_nulls.sum, None);
        let nan = run(&[
            some(ValueKind::Decimal, "NaN"),
            some(ValueKind::Float, "Infinity"),
        ]);
        assert_eq!(nan.numeric, 0);
        assert_eq!(nan.min, None);
    }

    #[test]
    fn floats_turn_the_figures_to_floating_point() {
        let aggregate = run(&[
            some(ValueKind::Float, "1.5"),
            some(ValueKind::Int, "2"),
            some(ValueKind::Decimal, "-0.5"),
        ]);
        assert!(!aggregate.exact);
        assert_eq!(aggregate.sum.as_deref(), Some("3"));
        assert_eq!(aggregate.avg.as_deref(), Some("1"));
        assert_eq!(aggregate.min.as_deref(), Some("-0.5"));
        assert_eq!(aggregate.max.as_deref(), Some("2"));
    }

    #[test]
    fn an_empty_selection_has_nothing_to_report() {
        let aggregate = run(&[]);
        assert_eq!(aggregate.cells, 0);
        assert!(aggregate.sum.is_none() && aggregate.avg.is_none());
    }
}
