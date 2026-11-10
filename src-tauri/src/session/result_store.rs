//! Rows of user results, kept in the backend (SPEC §2.2, rule 8) and served to the grid in
//! windows. Stored column by column in chunks of 500 rows: each cell is its lossless text in
//! one buffer per chunk column, an end offset and a kind byte, which keeps a million rows
//! of a few columns within tens of megabytes and makes a window a cheap copy.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use crate::db::errors::YadbeError;
use crate::db::value::{ColumnMeta, Value, ValueKind};
use crate::session::query_model::{CELL_PREVIEW_CHARS, ResultWindow, WindowColumn};

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

/// The rows of one result set.
pub struct StoredResult {
    id: u32,
    columns: Vec<ColumnMeta>,
    data: RwLock<Data>,
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

    /// Rows `offset .. offset + limit` (fewer at the end), cells cut at
    /// [`CELL_PREVIEW_CHARS`].
    pub fn window(&self, offset: usize, limit: usize) -> ResultWindow {
        let data = self.read();
        let start = offset.min(data.rows);
        let count = limit.min(data.rows - start);
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
                    let row = start + i;
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

    /// Rows `offset .. offset + limit` (fewer at the end) as whole values, for exports.
    pub fn rows(&self, offset: usize, limit: usize) -> Vec<Vec<Value>> {
        let data = self.read();
        let start = offset.min(data.rows);
        let end = start.saturating_add(limit).min(data.rows);
        (start..end)
            .map(|row| {
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

    /// One whole cell, `None` outside the result.
    pub fn cell(&self, row: usize, column: usize) -> Option<Value> {
        let data = self.read();
        if row >= data.rows || column >= self.columns.len() {
            return None;
        }
        let (code, text) = data.chunks[row / CHUNK_ROWS][column].cell(row % CHUNK_ROWS);
        Some(decode(code, text))
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
