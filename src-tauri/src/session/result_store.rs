//! Rows of user results, kept in the backend (SPEC §2.2, rule 8) and served to the grid in
//! windows. Stored column by column in chunks of 500 rows: each cell is its lossless text in
//! one buffer per chunk column, an end offset and a kind byte, which keeps a million rows
//! of a few columns within tens of megabytes and makes a window a cheap copy.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use crate::db::errors::YadbeError;
use crate::db::value::{ColumnMeta, Value, ValueKind};
use crate::session::query_model::{
    AggregateRange, CELL_PREVIEW_CHARS, ResultWindow, SelectionAggregate, WindowColumn,
};
use crate::session::result_agg::Accumulator;
use crate::session::result_view::{CellRef, ResultView, ResultViewInfo, ResultViewSpec};

const CHUNK_ROWS: usize = 500;
/// Byte code of a SQL `NULL` cell; the kinds are `1 + index in KINDS`.
const NULL: u8 = 0;

const KINDS: [ValueKind; 15] = [
    ValueKind::Bool,
    ValueKind::Int,
    ValueKind::Decimal,
    ValueKind::Float,
    ValueKind::Text,
    ValueKind::Bytes,
    ValueKind::Date,
    ValueKind::Time,
    ValueKind::Timestamp,
    ValueKind::TimestampTz,
    ValueKind::Interval,
    ValueKind::Uuid,
    ValueKind::Json,
    ValueKind::Array,
    ValueKind::Other,
];

fn code_of(kind: ValueKind) -> u8 {
    KINDS
        .iter()
        .position(|k| *k == kind)
        .and_then(|i| u8::try_from(i + 1).ok())
        .unwrap_or(NULL)
}

fn kind_of(code: u8) -> Option<ValueKind> {
    KINDS.get(usize::from(code).checked_sub(1)?).copied()
}

/// Appends the cell's text to `out` and returns its kind code.
fn encode(value: Value, out: &mut String) -> u8 {
    let kind = match value {
        Value::Null => return NULL,
        Value::Bool(b) => {
            out.push_str(if b { "true" } else { "false" });
            ValueKind::Bool
        }
        Value::Array(items) => {
            // Serializing plain values cannot fail.
            out.push_str(&serde_json::to_string(&items).unwrap_or_default());
            ValueKind::Array
        }
        Value::Int(s) => push(out, s, ValueKind::Int),
        Value::Decimal(s) => push(out, s, ValueKind::Decimal),
        Value::Float(s) => push(out, s, ValueKind::Float),
        Value::Text(s) => push(out, s, ValueKind::Text),
        Value::Bytes(s) => push(out, s, ValueKind::Bytes),
        Value::Date(s) => push(out, s, ValueKind::Date),
        Value::Time(s) => push(out, s, ValueKind::Time),
        Value::Timestamp(s) => push(out, s, ValueKind::Timestamp),
        Value::TimestampTz(s) => push(out, s, ValueKind::TimestampTz),
        Value::Interval(s) => push(out, s, ValueKind::Interval),
        Value::Uuid(s) => push(out, s, ValueKind::Uuid),
        Value::Json(s) => push(out, s, ValueKind::Json),
        Value::Other(s) => push(out, s, ValueKind::Other),
    };
    code_of(kind)
}

fn push(out: &mut String, text: String, kind: ValueKind) -> ValueKind {
    out.push_str(&text);
    kind
}

fn decode(code: u8, text: &str) -> Value {
    let Some(kind) = kind_of(code) else {
        return Value::Null;
    };
    let text = text.to_owned();
    match kind {
        ValueKind::Bool => Value::Bool(text == "true"),
        ValueKind::Array => Value::Array(serde_json::from_str(&text).unwrap_or_default()),
        ValueKind::Int => Value::Int(text),
        ValueKind::Decimal => Value::Decimal(text),
        ValueKind::Float => Value::Float(text),
        ValueKind::Text => Value::Text(text),
        ValueKind::Bytes => Value::Bytes(text),
        ValueKind::Date => Value::Date(text),
        ValueKind::Time => Value::Time(text),
        ValueKind::Timestamp => Value::Timestamp(text),
        ValueKind::TimestampTz => Value::TimestampTz(text),
        ValueKind::Interval => Value::Interval(text),
        ValueKind::Uuid => Value::Uuid(text),
        ValueKind::Json => Value::Json(text),
        ValueKind::Other => Value::Other(text),
    }
}

/// One column of one chunk.
#[derive(Default)]
struct ColumnChunk {
    text: String,
    /// End of each cell in `text`.
    ends: Vec<u32>,
    kinds: Vec<u8>,
}

impl ColumnChunk {
    fn bytes(&self) -> usize {
        self.text.capacity() + self.ends.capacity() * 4 + self.kinds.capacity()
    }

    fn cell(&self, index: usize) -> (u8, &str) {
        let start = index
            .checked_sub(1)
            .and_then(|i| self.ends.get(i))
            .map_or(0, |&e| e as usize);
        let end = self.ends.get(index).map_or(start, |&e| e as usize);
        (
            self.kinds.get(index).copied().unwrap_or(NULL),
            &self.text[start..end],
        )
    }

    fn shrink(&mut self) {
        self.text.shrink_to_fit();
        self.ends.shrink_to_fit();
        self.kinds.shrink_to_fit();
    }
}

#[derive(Default)]
struct Data {
    chunks: Vec<Vec<ColumnChunk>>,
    rows: usize,
    /// Bytes of the full chunks; the last one is measured on demand.
    sealed_bytes: usize,
    /// Rows an apply of an edited result deleted (F-087): kept in place so that row numbers do
    /// not move, left out of what the grid shows.
    removed: HashSet<usize>,
}

impl Data {
    fn bytes(&self) -> usize {
        let open = if self.rows.is_multiple_of(CHUNK_ROWS) {
            0
        } else {
            self.chunks
                .last()
                .map_or(0, |c| c.iter().map(ColumnChunk::bytes).sum())
        };
        self.sealed_bytes + open + self.chunks.capacity() * std::mem::size_of::<Vec<ColumnChunk>>()
    }
}

/// Which stored row each row of the grid is: the stored order, or a view's (F-065).
enum RowMap<'a> {
    Direct(usize),
    View(&'a [u32]),
}

impl RowMap<'_> {
    fn len(&self) -> usize {
        match self {
            RowMap::Direct(rows) => *rows,
            RowMap::View(rows) => rows.len(),
        }
    }

    fn at(&self, index: usize) -> usize {
        match self {
            RowMap::Direct(_) => index,
            RowMap::View(rows) => rows[index] as usize,
        }
    }
}

fn cell_ref(data: &Data, row: usize, column: usize) -> CellRef<'_> {
    let (code, text) = data.chunks[row / CHUNK_ROWS][column].cell(row % CHUNK_ROWS);
    (kind_of(code), text)
}

/// The rows of one result set.
pub struct StoredResult {
    id: u32,
    columns: Vec<ColumnMeta>,
    data: RwLock<Data>,
    /// How the grid shows the rows, when the user sorted or filtered them. Locked after `data`.
    view: Mutex<Option<ResultView>>,
}

impl StoredResult {
    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn columns(&self) -> &[ColumnMeta] {
        &self.columns
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Data> {
        self.data
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn row_count(&self) -> usize {
        self.read().rows
    }

    fn lock_view(&self) -> MutexGuard<'_, Option<ResultView>> {
        self.view
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The row map of the current view, brought up to date with the rows stored since. Rows
    /// an apply deleted are left out, sorted and filtered or not.
    fn mapped<'g>(&self, data: &Data, view: &'g mut Option<ResultView>) -> RowMap<'g> {
        if view.is_none() && !data.removed.is_empty() {
            *view = Some(ResultView::new(ResultViewSpec::default()));
        }
        match view {
            Some(view) => {
                view.refresh(
                    data.rows,
                    self.columns.len(),
                    &|row, column| cell_ref(data, row, column),
                    &|row| !data.removed.contains(&row),
                );
                RowMap::View(view.rows())
            }
            None => RowMap::Direct(data.rows),
        }
    }

    /// Shows the rows sorted and filtered as `spec` says; an empty spec shows them as they
    /// came. Rows that arrive later join the view.
    pub fn set_view(&self, spec: ResultViewSpec) -> Result<ResultViewInfo, YadbeError> {
        if spec
            .max_column()
            .is_some_and(|column| column as usize >= self.columns.len())
        {
            return Err(YadbeError::invalid_argument(
                "A sort or filter names a column the result does not have.",
                "Un tri ou un filtre nomme une colonne absente du résultat.",
            ));
        }
        let data = self.read();
        let mut view = self.lock_view();
        *view = (!spec.is_empty()).then(|| ResultView::new(spec));
        Ok(self.info(&data, &mut view))
    }

    /// Rows shown and rows stored, the view brought up to date.
    pub fn view_info(&self) -> ResultViewInfo {
        let data = self.read();
        let mut view = self.lock_view();
        self.info(&data, &mut view)
    }

    fn info(&self, data: &Data, view: &mut Option<ResultView>) -> ResultViewInfo {
        let shown = self.mapped(data, view).len();
        ResultViewInfo {
            row_count: u32::try_from(shown).unwrap_or(u32::MAX),
            source_rows: u32::try_from(data.rows - data.removed.len()).unwrap_or(u32::MAX),
        }
    }

    /// Rows the grid shows: the stored ones, or those that pass the view.
    pub fn display_row_count(&self) -> usize {
        let data = self.read();
        let mut view = self.lock_view();
        self.mapped(&data, &mut view).len()
    }

    /// Approximate memory held by the rows.
    pub fn bytes(&self) -> usize {
        self.read().bytes()
    }

    /// Appends rows (each as wide as the columns); returns the row count and bytes after.
    pub fn append(&self, rows: Vec<Vec<Value>>) -> (usize, usize) {
        let width = self.columns.len();
        let mut data = self
            .data
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for row in rows {
            if data.rows.is_multiple_of(CHUNK_ROWS) {
                data.chunks
                    .push((0..width).map(|_| ColumnChunk::default()).collect());
            }
            let Some(chunk) = data.chunks.last_mut() else {
                continue;
            };
            let mut values = row.into_iter();
            for column in chunk.iter_mut() {
                let code = encode(values.next().unwrap_or(Value::Null), &mut column.text);
                column.kinds.push(code);
                column
                    .ends
                    .push(u32::try_from(column.text.len()).unwrap_or(u32::MAX));
            }
            data.rows += 1;
            if data.rows.is_multiple_of(CHUNK_ROWS) {
                let sealed: usize = data.chunks.last_mut().map_or(0, |chunk| {
                    chunk.iter_mut().for_each(ColumnChunk::shrink);
                    chunk.iter().map(ColumnChunk::bytes).sum()
                });
                data.sealed_bytes += sealed;
            }
        }
        (data.rows, data.bytes())
    }

    /// Rows `offset .. offset + limit` (fewer at the end) as the grid shows them, cells cut
    /// at [`CELL_PREVIEW_CHARS`].
    pub fn window(&self, offset: usize, limit: usize) -> ResultWindow {
        let data = self.read();
        let mut view = self.lock_view();
        let map = self.mapped(&data, &mut view);
        self.window_through(&data, &map, offset, limit)
    }

    /// Like [`window`](Self::window), in the order the rows were stored, whatever the view
    /// and including the rows an apply deleted: what an edit of the result addresses (F-087).
    pub fn stored_window(&self, offset: usize, limit: usize) -> ResultWindow {
        let data = self.read();
        self.window_through(&data, &RowMap::Direct(data.rows), offset, limit)
    }

    fn window_through(
        &self,
        data: &Data,
        map: &RowMap<'_>,
        offset: usize,
        limit: usize,
    ) -> ResultWindow {
        let start = offset.min(map.len());
        let count = limit.min(map.len() - start);
        let columns = self
            .columns
            .iter()
            .enumerate()
            .map(|(c, meta)| {
                let mut values = Vec::with_capacity(count);
                let mut kinds = Vec::with_capacity(count);
                let mut truncated = Vec::new();
                let mut mixed = false;
                for i in 0..count {
                    let row = map.at(start + i);
                    let (code, text) = data.chunks[row / CHUNK_ROWS][c].cell(row % CHUNK_ROWS);
                    let Some(kind) = kind_of(code) else {
                        values.push(None);
                        kinds.push(meta.kind);
                        continue;
                    };
                    mixed |= kind != meta.kind;
                    kinds.push(kind);
                    let cut = (text.len() > CELL_PREVIEW_CHARS)
                        .then(|| {
                            text.char_indices()
                                .nth(CELL_PREVIEW_CHARS)
                                .map(|(at, _)| at)
                        })
                        .flatten();
                    match cut {
                        Some(at) => {
                            truncated.push(u32::try_from(i).unwrap_or(u32::MAX));
                            values.push(Some(text[..at].to_owned()));
                        }
                        None => values.push(Some(text.to_owned())),
                    }
                }
                WindowColumn {
                    values,
                    kinds: mixed.then_some(kinds),
                    truncated,
                }
            })
            .collect();
        ResultWindow {
            result_id: self.id,
            offset: u32::try_from(start).unwrap_or(u32::MAX),
            row_count: u32::try_from(count).unwrap_or(u32::MAX),
            columns,
        }
    }

    /// Rows `offset .. offset + limit` (fewer at the end) as whole values, for exports, in
    /// the order they arrived (a view is not applied).
    pub fn rows(&self, offset: usize, limit: usize) -> Vec<Vec<Value>> {
        let data = self.read();
        self.rows_through(&data, &RowMap::Direct(data.rows), offset, limit)
    }

    /// Like [`rows`](Self::rows), without the rows an apply deleted (F-087): stored rows
    /// `offset .. offset + limit` that are still there, for a whole export.
    pub fn kept_rows(&self, offset: usize, limit: usize) -> Vec<Vec<Value>> {
        let data = self.read();
        if data.removed.is_empty() {
            return self.rows_through(&data, &RowMap::Direct(data.rows), offset, limit);
        }
        let end = offset.saturating_add(limit).min(data.rows);
        let kept: Vec<u32> = (offset.min(end)..end)
            .filter(|row| !data.removed.contains(row))
            .map(|row| u32::try_from(row).unwrap_or(u32::MAX))
            .collect();
        self.rows_through(&data, &RowMap::View(&kept), 0, kept.len())
    }

    /// Like [`rows`](Self::rows), for rows as the grid shows them (sorted and filtered).
    pub fn display_rows(&self, offset: usize, limit: usize) -> Vec<Vec<Value>> {
        let data = self.read();
        let mut view = self.lock_view();
        let map = self.mapped(&data, &mut view);
        self.rows_through(&data, &map, offset, limit)
    }

    fn rows_through(
        &self,
        data: &Data,
        map: &RowMap<'_>,
        offset: usize,
        limit: usize,
    ) -> Vec<Vec<Value>> {
        let start = offset.min(map.len());
        let end = start.saturating_add(limit).min(map.len());
        (start..end)
            .map(|shown| {
                let row = map.at(shown);
                let chunk = &data.chunks[row / CHUNK_ROWS];
                chunk
                    .iter()
                    .map(|column| {
                        let (code, text) = column.cell(row % CHUNK_ROWS);
                        decode(code, text)
                    })
                    .collect()
            })
            .collect()
    }

    /// Count, sum, average, minimum and maximum of the selected cells (F-065). Ranges are in
    /// the order the grid shows the rows; a cell covered twice counts once.
    pub fn aggregate(&self, ranges: &[AggregateRange]) -> SelectionAggregate {
        let data = self.read();
        let mut view = self.lock_view();
        let map = self.mapped(&data, &mut view);
        let mut per_column: Vec<Vec<(usize, usize)>> = vec![Vec::new(); self.columns.len()];
        for range in ranges {
            let start = range.row_start as usize;
            let end = (range.row_end as usize).min(map.len());
            if start >= end {
                continue;
            }
            for &column in &range.columns {
                if let Some(spans) = per_column.get_mut(column as usize) {
                    spans.push((start, end));
                }
            }
        }
        let mut accumulator = Accumulator::default();
        for (column, mut spans) in per_column.into_iter().enumerate() {
            spans.sort_unstable();
            let mut merged: Vec<(usize, usize)> = Vec::with_capacity(spans.len());
            for (start, end) in spans {
                match merged.last_mut() {
                    Some(last) if start <= last.1 => last.1 = last.1.max(end),
                    _ => merged.push((start, end)),
                }
            }
            for (start, end) in merged {
                for shown in start..end {
                    let (kind, text) = cell_ref(&data, map.at(shown), column);
                    accumulator.cell(kind, text);
                }
            }
        }
        accumulator.finish()
    }

    /// One whole cell of a row as the grid shows it, `None` outside the result.
    pub fn cell(&self, row: usize, column: usize) -> Option<Value> {
        let data = self.read();
        let mut view = self.lock_view();
        let map = self.mapped(&data, &mut view);
        Self::cell_through(&data, &map, self.columns.len(), row, column)
    }

    /// One whole cell of a stored row (see [`stored_window`](Self::stored_window)).
    pub fn stored_cell(&self, row: usize, column: usize) -> Option<Value> {
        let data = self.read();
        Self::cell_through(
            &data,
            &RowMap::Direct(data.rows),
            self.columns.len(),
            row,
            column,
        )
    }

    fn cell_through(
        data: &Data,
        map: &RowMap<'_>,
        width: usize,
        row: usize,
        column: usize,
    ) -> Option<Value> {
        if row >= map.len() || column >= width {
            return None;
        }
        let row = map.at(row);
        let (code, text) = data.chunks[row / CHUNK_ROWS][column].cell(row % CHUNK_ROWS);
        Some(decode(code, text))
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Data> {
        self.data
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Replaces stored row `row` with `values` (as wide as the columns): the row as an apply
    /// read it back (F-087). A view is built again with it. `false` outside the result.
    pub fn replace_row(&self, row: usize, values: Vec<Value>) -> bool {
        let mut data = self.write();
        if row >= data.rows {
            return false;
        }
        let rows = data.rows;
        let chunk_index = row / CHUNK_ROWS;
        let target = row % CHUNK_ROWS;
        let in_chunk = (rows - chunk_index * CHUNK_ROWS).min(CHUNK_ROWS);
        let sealed = rows >= (chunk_index + 1) * CHUNK_ROWS;
        let Some(chunk) = data.chunks.get_mut(chunk_index) else {
            return false;
        };
        let before: usize = chunk.iter().map(ColumnChunk::bytes).sum();
        let mut values = values.into_iter();
        for column in chunk.iter_mut() {
            let mut value = Some(values.next().unwrap_or(Value::Null));
            let mut next = ColumnChunk::default();
            for index in 0..in_chunk {
                let code = if index == target {
                    encode(value.take().unwrap_or(Value::Null), &mut next.text)
                } else {
                    let (code, text) = column.cell(index);
                    next.text.push_str(text);
                    code
                };
                next.kinds.push(code);
                next.ends
                    .push(u32::try_from(next.text.len()).unwrap_or(u32::MAX));
            }
            if sealed {
                next.shrink();
            }
            *column = next;
        }
        if sealed {
            let after: usize = chunk.iter().map(ColumnChunk::bytes).sum();
            data.sealed_bytes = data.sealed_bytes.saturating_sub(before) + after;
        }
        Self::forget_view_rows(&mut self.lock_view());
        true
    }

    /// Leaves stored rows out of what the grid shows (rows an apply deleted, F-087); their
    /// numbers stay, so an edit of the result keeps addressing the others.
    pub fn remove_rows(&self, rows: &[usize]) {
        let mut data = self.write();
        let total = data.rows;
        data.removed
            .extend(rows.iter().copied().filter(|&row| row < total));
        Self::forget_view_rows(&mut self.lock_view());
    }

    /// The rows behind the view changed: it is built again on the next read. Called with
    /// `data` still locked for writing, so no read sees the new rows through the old view.
    fn forget_view_rows(view: &mut Option<ResultView>) {
        if let Some(view) = view.as_mut() {
            view.invalidate();
        }
    }
}

/// Every live result, by id. A result lives until its tab runs again or closes.
#[derive(Default)]
pub struct ResultStore {
    results: Mutex<HashMap<u32, Arc<StoredResult>>>,
    next_id: AtomicU32,
}

impl ResultStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Arc<StoredResult>>> {
        self.results
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn create(&self, columns: Vec<ColumnMeta>) -> Arc<StoredResult> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let result = Arc::new(StoredResult {
            id,
            columns,
            data: RwLock::new(Data::default()),
            view: Mutex::new(None),
        });
        self.lock().insert(id, Arc::clone(&result));
        result
    }

    pub fn get(&self, id: u32) -> Result<Arc<StoredResult>, YadbeError> {
        self.lock()
            .get(&id)
            .cloned()
            .ok_or_else(|| YadbeError::result_not_found(id))
    }

    pub fn remove(&self, ids: impl IntoIterator<Item = u32>) {
        let mut results = self.lock();
        for id in ids {
            results.remove(&id);
        }
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::result_view::{ViewFilter, ViewFilterOp, ViewSort};

    fn meta(name: &str, kind: ValueKind) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            type_name: String::new(),
            kind,
        }
    }

    #[test]
    fn round_trips_every_kind_through_windows_and_cells() {
        let store = ResultStore::default();
        let values = vec![
            Value::Null,
            Value::Bool(true),
            Value::int(i64::MIN),
            Value::Decimal("123456789012345678901234567890.000001".into()),
            Value::float(f64::NEG_INFINITY),
            Value::Text("é😀\n\t".into()),
            Value::bytes(&[0, 255]),
            Value::Date("0001-12-31 BC".into()),
            Value::Time("23:59:59.999999+05:30".into()),
            Value::Timestamp("2025-02-28 12:00:00".into()),
            Value::TimestampTz("2025-02-28 12:00:00+00".into()),
            Value::Interval("1 year 2 mons".into()),
            Value::Uuid("5f0c00a1-7b2e-4c3d-9e8f-000000000001".into()),
            Value::Json("{\"a\": 12345678901234567890.1}".into()),
            Value::Array(vec![Value::int(1), Value::Null, Value::Array(vec![])]),
            Value::Other("(1,2)".into()),
        ];
        let columns: Vec<_> = (0..values.len())
            .map(|i| meta(&format!("c{i}"), ValueKind::Text))
            .collect();
        let result = store.create(columns);
        result.append(vec![values.clone()]);
        for (index, value) in values.iter().enumerate() {
            assert_eq!(result.cell(0, index).as_ref(), Some(value), "{index}");
        }
        let window = result.window(0, 10);
        assert_eq!(window.row_count, 1);
        assert_eq!(window.columns[0].values, [None]);
        assert_eq!(window.columns[1].values, [Some("true".into())]);
        assert_eq!(
            window.columns[2].values,
            [Some("-9223372036854775808".into())]
        );
        assert_eq!(
            window.columns[14].values,
            [Some(
                r#"[{"kind":"int","value":"1"},{"kind":"null"},{"kind":"array","value":[]}]"#
                    .into()
            )]
        );
        assert_eq!(window.columns[5].kinds, None, "same kind as the column");
        assert_eq!(window.columns[0].kinds, None, "NULL takes the column kind");
        assert_eq!(window.columns[2].kinds, Some(vec![ValueKind::Int]));
    }

    #[test]
    fn windows_span_chunks_and_cut_long_cells() {
        let store = ResultStore::default();
        let result = store.create(vec![meta("n", ValueKind::Int), meta("t", ValueKind::Text)]);
        let long = "x".repeat(CELL_PREVIEW_CHARS + 10);
        let rows: Vec<Vec<Value>> = (0..1234)
            .map(|i| {
                let text = if i == 600 {
                    long.clone()
                } else {
                    format!("r{i}")
                };
                vec![Value::int(i), Value::Text(text)]
            })
            .collect();
        let (count, bytes) = result.append(rows);
        assert_eq!(count, 1234);
        assert!(bytes > 0);
        let window = result.window(450, 500);
        assert_eq!(window.offset, 450);
        assert_eq!(window.row_count, 500);
        assert_eq!(window.columns[0].values[0].as_deref(), Some("450"));
        assert_eq!(window.columns[0].values[499].as_deref(), Some("949"));
        assert_eq!(window.columns[1].truncated, [150]);
        assert_eq!(
            window.columns[1].values[150].as_ref().map(String::len),
            Some(CELL_PREVIEW_CHARS)
        );
        assert_eq!(result.cell(600, 1), Some(Value::Text(long)));
        let tail = result.window(1200, 500);
        assert_eq!(tail.row_count, 34);
        let past = result.window(5000, 500);
        assert_eq!((past.offset, past.row_count), (1234, 0));
        assert_eq!(result.cell(1234, 0), None);
    }

    #[test]
    fn aggregates_a_selection_across_chunks_counting_overlaps_once() {
        let store = ResultStore::default();
        let result = store.create(vec![
            meta("n", ValueKind::Int),
            meta("d", ValueKind::Decimal),
            meta("t", ValueKind::Text),
        ]);
        let rows: Vec<Vec<Value>> = (0..1200_i64)
            .map(|i| {
                vec![
                    Value::int(i64::MAX - i),
                    if i % 10 == 0 {
                        Value::Null
                    } else {
                        Value::Decimal(format!("{i}.25"))
                    },
                    Value::Text("x".into()),
                ]
            })
            .collect();
        result.append(rows);
        let range = |row_start, row_end, columns: &[u32]| AggregateRange {
            row_start,
            row_end,
            columns: columns.to_vec(),
        };

        // Rows 400..700 (two chunks) of both numeric columns, and 600..800 of the first again.
        let aggregate = result.aggregate(&[range(400, 700, &[0, 1]), range(600, 800, &[0])]);
        assert_eq!(aggregate.cells, 300 * 2 + 100);
        // The decimal column has a NULL every tenth row: 30 of its 300 cells.
        assert_eq!(aggregate.non_null, 700 - 30);
        assert_eq!(aggregate.numeric, aggregate.non_null);
        assert!(aggregate.exact);
        // Σ(i64::MAX - i) over 400..800 minus nothing else, plus the decimals of 400..700
        // that are not multiples of ten: 270 rows of `i.25`.
        let ints: i128 = (400..800).map(|i| i128::from(i64::MAX) - i).sum();
        let decimals: i128 = (400..700).filter(|i| i % 10 != 0).sum();
        // 270 × 0.25 = 67.5: the fraction is exactly .5 in the sum.
        assert_eq!(
            aggregate.sum.as_deref(),
            Some(format!("{}.5", ints + decimals + 67).as_str())
        );
        assert_eq!(aggregate.max.as_deref(), Some("9223372036854775407"));
        assert_eq!(aggregate.min.as_deref(), Some("401.25"));

        // A text column has cells but no figures.
        let text = result.aggregate(&[range(0, 1200, &[2])]);
        assert_eq!((text.cells, text.non_null, text.numeric), (1200, 1200, 0));
        assert_eq!(text.sum, None);
        // Past the end and unknown columns select nothing.
        let none = result.aggregate(&[range(5000, 6000, &[0]), range(0, 10, &[9])]);
        assert_eq!(none.cells, 0);
    }

    fn view_fixture() -> Arc<StoredResult> {
        let store = ResultStore::default();
        let result = store.create(vec![
            meta("n", ValueKind::Int),
            meta("d", ValueKind::Decimal),
            meta("t", ValueKind::Text),
        ]);
        // 1200 rows over three chunks: n counts down, d is NULL every tenth row, t cycles.
        let rows: Vec<Vec<Value>> = (0..1200_i64)
            .map(|i| {
                vec![
                    Value::int(1200 - i),
                    if i % 10 == 0 {
                        Value::Null
                    } else {
                        Value::Decimal(format!("{}.5", i % 7))
                    },
                    Value::Text(["red", "Green", "blue"][(i % 3) as usize].into()),
                ]
            })
            .collect();
        result.append(rows);
        result
    }

    fn spec(sort: Vec<ViewSort>, filters: Vec<ViewFilter>) -> ResultViewSpec {
        ResultViewSpec {
            sort,
            filters,
            match_case: false,
        }
    }

    #[test]
    fn a_view_sorts_and_filters_what_windows_cells_and_aggregates_read() {
        let result = view_fixture();
        // Ascending by n reverses the stored order, across chunk boundaries.
        let info = result
            .set_view(spec(
                vec![ViewSort {
                    column: 0,
                    descending: false,
                }],
                vec![],
            ))
            .expect("view");
        assert_eq!((info.row_count, info.source_rows), (1200, 1200));
        let window = result.window(498, 4);
        assert_eq!(window.offset, 498);
        assert_eq!(window.columns[0].values[0].as_deref(), Some("499"));
        assert_eq!(window.columns[0].values[3].as_deref(), Some("502"));
        assert_eq!(result.cell(0, 0), Some(Value::int(1)));
        assert_eq!(result.cell(1199, 0), Some(Value::int(1200)));

        // Rows of t equal to "green" (any case), the highest n first.
        let info = result
            .set_view(spec(
                vec![ViewSort {
                    column: 0,
                    descending: true,
                }],
                vec![ViewFilter {
                    column: Some(2),
                    op: ViewFilterOp::Equals,
                    value: "GREEN".into(),
                }],
            ))
            .expect("view");
        assert_eq!((info.row_count, info.source_rows), (400, 1200));
        // Stored row 1 (i = 1) is the first green one: n = 1199.
        assert_eq!(result.cell(0, 0), Some(Value::int(1199)));
        assert_eq!(result.cell(1, 0), Some(Value::int(1196)));
        assert_eq!(result.cell(400, 0), None, "past the view");
        let window = result.window(398, 10);
        assert_eq!(window.row_count, 2);
        assert_eq!(result.display_row_count(), 400);
        assert_eq!(result.row_count(), 1200);
        // Aggregates read the displayed rows: the first 3 shown rows of the n column.
        let sum = result.aggregate(&[AggregateRange {
            row_start: 0,
            row_end: 3,
            columns: vec![0],
        }]);
        assert_eq!(sum.sum.as_deref(), Some("3588"));
        // An export of a selection reads the same rows; a whole export reads stored order.
        let shown = result.display_rows(0, 2);
        assert_eq!(shown[0][0], Value::int(1199));
        assert_eq!(result.rows(0, 1)[0][0], Value::int(1200));

        // An empty spec shows the rows as they came.
        let info = result.set_view(ResultViewSpec::default()).expect("clear");
        assert_eq!(info.row_count, 1200);
        assert_eq!(result.cell(0, 0), Some(Value::int(1200)));
    }

    #[test]
    fn a_view_follows_a_result_that_keeps_streaming() {
        let store = ResultStore::default();
        let result = store.create(vec![meta("n", ValueKind::Int)]);
        let batch = |from: i64, to: i64| (from..to).map(|i| vec![Value::int(i)]).collect();
        result.append(batch(0, 10));
        let view = spec(
            vec![ViewSort {
                column: 0,
                descending: true,
            }],
            vec![ViewFilter {
                column: Some(0),
                op: ViewFilterOp::GreaterOrEqual,
                value: "5".into(),
            }],
        );
        assert_eq!(result.set_view(view).expect("view").row_count, 5);
        result.append(batch(10, 20));
        let info = result.view_info();
        assert_eq!((info.row_count, info.source_rows), (15, 20));
        assert_eq!(result.cell(0, 0), Some(Value::int(19)));
        assert_eq!(result.cell(14, 0), Some(Value::int(5)));
    }

    #[test]
    fn a_view_of_a_hundred_thousand_rows_is_built_in_well_under_a_second() {
        let store = ResultStore::default();
        let result = store.create(vec![
            meta("d", ValueKind::Decimal),
            meta("t", ValueKind::Text),
        ]);
        for batch in 0..200_i64 {
            let rows = (0..500_i64)
                .map(|i| {
                    let n = batch * 500 + i;
                    vec![
                        Value::Decimal(format!("{}.{:02}", (n * 7919) % 100_000, n % 100)),
                        Value::Text(format!("Customer {n} of Region {}", n % 37)),
                    ]
                })
                .collect();
            result.append(rows);
        }
        let started = std::time::Instant::now();
        let sorted = result
            .set_view(spec(
                vec![ViewSort {
                    column: 0,
                    descending: true,
                }],
                vec![],
            ))
            .expect("sort");
        let sort_time = started.elapsed();
        assert_eq!(sorted.row_count, 100_000);
        let started = std::time::Instant::now();
        let filtered = result
            .set_view(spec(
                vec![],
                vec![ViewFilter {
                    column: None,
                    op: ViewFilterOp::Contains,
                    value: "region 36".into(),
                }],
            ))
            .expect("filter");
        let filter_time = started.elapsed();
        assert!(filtered.row_count > 2000);
        eprintln!("100k rows: sort {sort_time:?}, filter on every column {filter_time:?}");
        // A debug build, on a loaded machine: a generous bound that still catches a quadratic.
        assert!(sort_time.as_millis() < 3000 && filter_time.as_millis() < 3000);
    }

    #[test]
    fn rows_read_back_and_removed_follow_their_stored_row_under_a_view() {
        let result = view_fixture();
        let bytes = result.bytes();
        result
            .set_view(spec(
                vec![ViewSort {
                    column: 0,
                    descending: false,
                }],
                vec![],
            ))
            .expect("view");
        // Stored row 700 (n = 500) is shown at 499 by the ascending view; its value changes in
        // place, in a sealed chunk, and the view is built again with it.
        assert_eq!(result.cell(499, 0), Some(Value::int(500)));
        assert!(result.replace_row(
            700,
            vec![
                Value::int(5000),
                Value::Decimal("1.5".into()),
                Value::Text("x".repeat(40))
            ],
        ));
        assert!(!result.replace_row(1200, vec![Value::Null]));
        assert_eq!(result.cell(1199, 0), Some(Value::int(5000)));
        assert_eq!(result.cell(499, 0), Some(Value::int(501)));
        assert_eq!(result.stored_cell(700, 0), Some(Value::int(5000)));
        assert_eq!(result.stored_cell(701, 0), Some(Value::int(499)));
        assert_eq!(
            result.stored_cell(700, 2),
            Some(Value::Text("x".repeat(40)))
        );
        assert!(result.bytes() > bytes);
        // Removed rows leave the view and, without one, what the grid shows; stored reads keep
        // every row and its number.
        result.remove_rows(&[1199, 0, 5000]);
        let info = result.view_info();
        assert_eq!((info.row_count, info.source_rows), (1198, 1198));
        assert_eq!(result.cell(0, 0), Some(Value::int(2)));
        assert_eq!(result.window(1197, 5).row_count, 1);
        result.set_view(ResultViewSpec::default()).expect("clear");
        assert_eq!(result.display_row_count(), 1198);
        assert_eq!(result.cell(0, 0), Some(Value::int(1199)));
        assert_eq!(result.stored_window(0, 2).row_count, 2);
        assert_eq!(result.stored_cell(0, 0), Some(Value::int(1200)));
        assert_eq!(result.row_count(), 1200);
        // A whole export keeps the stored order without them.
        let kept = result.kept_rows(0, 3);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0][0], Value::int(1199));
        assert_eq!(result.kept_rows(1199, 10).len(), 0);
        // Rows that arrive later join what is shown.
        result.append(vec![vec![Value::int(-1), Value::Null, Value::Null]]);
        assert_eq!(result.display_row_count(), 1199);
        assert_eq!(result.cell(1198, 0), Some(Value::int(-1)));
    }

    #[test]
    fn a_view_refuses_a_column_the_result_does_not_have() {
        let result = view_fixture();
        let err = result
            .set_view(spec(
                vec![ViewSort {
                    column: 3,
                    descending: false,
                }],
                vec![],
            ))
            .expect_err("no such column");
        assert_eq!(err.code, crate::db::errors::ErrorCode::InvalidArgument);
    }

    #[test]
    fn removed_results_are_not_found() {
        let store = ResultStore::default();
        let a = store.create(vec![]);
        let b = store.create(vec![]);
        assert_ne!(a.id(), b.id());
        store.remove([a.id()]);
        assert_eq!(
            store.get(a.id()).err().map(|e| e.code),
            Some(crate::db::errors::ErrorCode::ResultNotFound)
        );
        assert!(store.get(b.id()).is_ok());
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn a_million_small_rows_stay_compact() {
        let store = ResultStore::default();
        let result = store.create(vec![meta("n", ValueKind::Int)]);
        for batch in 0..2000 {
            let rows = (0..500)
                .map(|i| vec![Value::int(batch * 500 + i)])
                .collect();
            result.append(rows);
        }
        let bytes = result.bytes();
        assert_eq!(result.row_count(), 1_000_000);
        // About 12 bytes per cell (digits, end offset, kind) instead of ~60 as `Value`s.
        assert!(bytes < 16_000_000, "{bytes}");
    }
}
