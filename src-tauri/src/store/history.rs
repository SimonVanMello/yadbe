//! History of the statements the user ran (F-100, F-104): SQLite table with an FTS5 index on
//! the statement text, keyset-paginated search, retention and clearing.

use rusqlite::types::Value as SqlValue;
use rusqlite::{Row, params, params_from_iter};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::Store;
use crate::db::dialect::Engine;
use crate::db::errors::{ErrorCode, YadbeError};

/// Rows per page of a search.
pub const HISTORY_PAGE_SIZE: u32 = 500;
/// Characters of a statement sent in a list row; `get_history_entry` has the whole text.
pub const HISTORY_PREVIEW_CHARS: usize = 600;
const ERROR_PREVIEW_CHARS: usize = 240;
/// A statement longer than this is stored cut (a multi-megabyte `INSERT` would bloat the
/// database and the index).
pub const MAX_STORED_SQL_BYTES: usize = 1024 * 1024;
const MAX_SEARCH_TERMS: usize = 12;
const TRUNCATION_MARK: &str = "\n-- … cut by the yadbe history";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HistoryOutcome {
    Ok,
    Error,
    Cancelled,
    /// Not sent: the connection is read-only and the statement may write.
    Refused,
}

impl HistoryOutcome {
    pub fn id(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
            Self::Refused => "refused",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Some(match id {
            "ok" => Self::Ok,
            "error" => Self::Error,
            "cancelled" => Self::Cancelled,
            "refused" => Self::Refused,
            _ => return None,
        })
    }

    pub fn of(result: &Result<(), YadbeError>) -> Self {
        match result {
            Ok(()) => Self::Ok,
            Err(e) if e.code == ErrorCode::Cancelled => Self::Cancelled,
            Err(e) if e.code == ErrorCode::ReadOnlyViolation => Self::Refused,
            Err(_) => Self::Error,
        }
    }
}

/// Entries are identified, and ordered, by `started_at_ms * ID_SLOTS + n`: the id order is
/// the start-time order even when statements are recorded out of order (a long statement
/// that ends after later ones), which lets a search stream rows newest first straight from
/// the full-text index. 1024 statements can start in the same millisecond.
const ID_SLOTS: i64 = 1024;

/// A statement to record. `started_at_ms` is Unix time in milliseconds.
#[derive(Debug, Clone)]
pub struct NewHistoryEntry {
    pub connection_id: String,
    pub connection_name: String,
    pub engine: Engine,
    pub database: Option<String>,
    pub sql: String,
    pub started_at_ms: i64,
    pub duration_ms: f64,
    pub rows: Option<i64>,
    pub outcome: HistoryOutcome,
    pub error_code: Option<ErrorCode>,
    pub error_message: Option<String>,
}

/// One history entry. In a search page `sql` is cut to [`HISTORY_PREVIEW_CHARS`]
/// (`sqlTruncated`); `get_history_entry` returns it whole.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: f64,
    pub connection_id: String,
    /// The connection's name when the statement ran.
    pub connection_name: String,
    pub engine: Engine,
    /// `null`: the connection's own database was unnamed (SQLite file).
    pub database: Option<String>,
    pub sql: String,
    pub sql_truncated: bool,
    /// Unix time in milliseconds.
    pub started_at: f64,
    pub duration_ms: f64,
    /// Rows returned or affected, when known.
    pub rows: Option<f64>,
    pub outcome: HistoryOutcome,
    pub error_code: Option<ErrorCode>,
    /// The server's message (or yadbe's when it never reached the server).
    pub error_message: Option<String>,
}

/// Newest first. Every field narrows the result.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    /// Words of the statement text; each matches as a prefix, all must match.
    pub text: Option<String>,
    pub connection_id: Option<String>,
    /// Empty: every outcome.
    pub outcomes: Vec<HistoryOutcome>,
    /// Unix milliseconds, inclusive.
    pub from: Option<f64>,
    /// Unix milliseconds, exclusive.
    pub to: Option<f64>,
    pub min_duration_ms: Option<f64>,
    /// The `next` of the previous page (an entry id: entries are ordered by id).
    pub after: Option<f64>,
    /// At most [`HISTORY_PAGE_SIZE`] (the default).
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub rows: Vec<HistoryRow>,
    /// Pass it as `after` for the following page; `null` on the last page.
    pub next: Option<f64>,
}

/// What clearing, or counting before clearing, applies to.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryScope {
    pub connection_id: Option<String>,
    /// Unix milliseconds, inclusive.
    pub from: Option<f64>,
    /// Unix milliseconds, exclusive.
    pub to: Option<f64>,
}

/// Bounds of the history (F-100): whichever is reached first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryRetention {
    pub max_entries: u32,
    pub max_age_days: u32,
}

impl Default for HistoryRetention {
    fn default() -> Self {
        Self {
            max_entries: 50_000,
            max_age_days: 365,
        }
    }
}

/// The words of `text` as an FTS5 query: every word a quoted prefix term. `None` when there
/// is no word at all (only punctuation).
fn fts_query(text: &str) -> Option<String> {
    let terms: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .take(MAX_SEARCH_TERMS)
        .map(|t| format!("\"{t}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

fn cut_chars(text: &str, max: usize) -> (&str, bool) {
    match text.char_indices().nth(max) {
        Some((at, _)) => (&text[..at], true),
        None => (text, false),
    }
}

/// `sql` as it is stored: whole, unless it exceeds [`MAX_STORED_SQL_BYTES`].
pub fn stored_sql(sql: &str) -> String {
    if sql.len() <= MAX_STORED_SQL_BYTES {
        return sql.to_owned();
    }
    let mut end = MAX_STORED_SQL_BYTES;
    while !sql.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATION_MARK}", &sql[..end])
}

fn error_code_id(code: ErrorCode) -> Option<String> {
    serde_json::to_value(code)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
}

fn error_code_from_id(id: &str) -> Option<ErrorCode> {
    serde_json::from_value(serde_json::Value::String(id.to_owned())).ok()
}

/// Columns of a list row: the text is read one character past the preview so truncation is
/// detected without measuring the whole statement.
const ROW_COLUMNS: &str = "h.id, h.connection_id, h.connection_name, h.engine, h.database_name, \
     substr(h.sql, 1, ?1), h.started_at, h.duration_ms, h.rows, h.outcome, h.error_code, \
     substr(h.error_message, 1, ?2)";

fn row_to_history(
    row: &Row<'_>,
    sql_chars: usize,
    error_chars: usize,
) -> rusqlite::Result<HistoryRow> {
    let engine: String = row.get(3)?;
    let outcome: String = row.get(9)?;
    let sql: String = row.get(5)?;
    let (sql, sql_truncated) = cut_chars(&sql, sql_chars);
    let error_code: Option<String> = row.get(10)?;
    let error_message: Option<String> = row.get(11)?;
    Ok(HistoryRow {
        id: row.get::<_, i64>(0)? as f64,
        connection_id: row.get(1)?,
        connection_name: row.get(2)?,
        engine: Engine::from_id(&engine).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                format!("unexpected engine `{engine}` in the history").into(),
            )
        })?,
        database: row.get(4)?,
        sql: sql.to_owned(),
        sql_truncated,
        started_at: row.get::<_, i64>(6)? as f64,
        duration_ms: row.get(7)?,
        rows: row.get::<_, Option<i64>>(8)?.map(|r| r as f64),
        outcome: HistoryOutcome::from_id(&outcome).unwrap_or(HistoryOutcome::Error),
        error_code: error_code.as_deref().and_then(error_code_from_id),
        error_message: error_message.map(|m| {
            let (m, _) = cut_chars(&m, error_chars);
            m.to_owned()
        }),
    })
}

/// A `WHERE` clause under construction, with its positional parameters, numbered from `base`
/// (a search keeps `?1` and `?2` for the column list).
struct Filter {
    base: usize,
    /// The id column to constrain.
    id: &'static str,
    clauses: Vec<String>,
    params: Vec<SqlValue>,
}

impl Filter {
    fn new(base: usize, id: &'static str) -> Self {
        Self {
            base,
            id,
            clauses: Vec::new(),
            params: Vec::new(),
        }
    }

    fn push(&mut self, clause: impl FnOnce(usize) -> String, value: SqlValue) {
        let index = self.params.len() + self.base;
        self.clauses.push(clause(index));
        self.params.push(value);
    }

    fn scope(&mut self, scope: &HistoryScope) {
        let id = self.id;
        if let Some(id) = &scope.connection_id {
            self.push(
                |i| format!("h.connection_id = ?{i}"),
                SqlValue::Text(id.clone()),
            );
        }
        if let Some(from) = scope.from {
            self.push(
                |i| format!("{id} >= ?{i}"),
                SqlValue::Integer((from as i64).saturating_mul(ID_SLOTS)),
            );
        }
        if let Some(to) = scope.to {
            self.push(
                |i| format!("{id} < ?{i}"),
                SqlValue::Integer((to as i64).saturating_mul(ID_SLOTS)),
            );
        }
    }

    fn where_sql(&self) -> String {
        if self.clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", self.clauses.join(" AND "))
        }
    }
}

impl Store {
    /// Records `entries` in one transaction.
    pub fn insert_history(&self, entries: &[NewHistoryEntry]) -> Result<(), YadbeError> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO history (id, connection_id, connection_name, engine, database_name,
                    sql, started_at, duration_ms, rows, outcome, error_code, error_message)
                 VALUES (?12, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?;
            let mut last_in_slot =
                tx.prepare_cached("SELECT MAX(id) FROM history WHERE id >= ?1 AND id < ?1 + ?2")?;
            let mut newest = tx.prepare_cached("SELECT COALESCE(MAX(id), 0) FROM history")?;
            for e in entries {
                let first = e.started_at_ms.saturating_mul(ID_SLOTS);
                let taken: Option<i64> =
                    last_in_slot.query_row(params![first, ID_SLOTS], |row| row.get(0))?;
                let id = match taken {
                    None => first,
                    Some(id) if id + 1 < first + ID_SLOTS => id + 1,
                    // The millisecond is full: still unique, just not in start order.
                    Some(_) => newest.query_row([], |row| row.get::<_, i64>(0))? + 1,
                };
                stmt.execute(params![
                    e.connection_id,
                    e.connection_name,
                    e.engine.id(),
                    e.database,
                    stored_sql(&e.sql),
                    e.started_at_ms,
                    e.duration_ms,
                    e.rows,
                    e.outcome.id(),
                    e.error_code.and_then(error_code_id),
                    e.error_message,
                    id,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// One page of the history, newest first.
    pub fn search_history(&self, query: &HistoryQuery) -> Result<HistoryPage, YadbeError> {
        let limit = query
            .limit
            .unwrap_or(HISTORY_PAGE_SIZE)
            .clamp(1, HISTORY_PAGE_SIZE) as usize;
        let mut filter = Filter::new(3, "h.id");
        let mut fts_join = false;
        if let Some(text) = query
            .text
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            match fts_query(text) {
                Some(fts) => {
                    fts_join = true;
                    // Reading the index in rowid order streams the newest matches first,
                    // instead of building the whole match set to sort it.
                    filter.push(|i| format!("f.history_fts MATCH ?{i}"), SqlValue::Text(fts));
                }
                None => filter.push(
                    |i| format!("instr(h.sql, ?{i}) > 0"),
                    SqlValue::Text(text.to_owned()),
                ),
            }
        }
        filter.scope(&HistoryScope {
            connection_id: query.connection_id.clone(),
            from: query.from,
            to: query.to,
        });
        if !query.outcomes.is_empty() {
            let list = query
                .outcomes
                .iter()
                .map(|o| format!("'{}'", o.id()))
                .collect::<Vec<_>>()
                .join(", ");
            filter.clauses.push(format!("h.outcome IN ({list})"));
        }
        if let Some(min) = query.min_duration_ms {
            filter.push(|i| format!("h.duration_ms >= ?{i}"), SqlValue::Real(min));
        }
        let (from, order) = if fts_join {
            ("history_fts f JOIN history h ON h.id = f.rowid", "f.rowid")
        } else {
            ("history h", "h.id")
        };
        if let Some(after) = query.after {
            filter.push(
                |i| format!("{order} < ?{i}"),
                SqlValue::Integer(after as i64),
            );
        }
        let sql = format!(
            "SELECT {ROW_COLUMNS} FROM {from} {} ORDER BY {order} DESC LIMIT {}",
            filter.where_sql(),
            limit + 1
        );
        let mut params = vec![
            SqlValue::Integer((HISTORY_PREVIEW_CHARS + 1) as i64),
            SqlValue::Integer(ERROR_PREVIEW_CHARS as i64),
        ];
        params.extend(filter.params);

        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt
            .query_map(params_from_iter(params), |row| {
                row_to_history(row, HISTORY_PREVIEW_CHARS, ERROR_PREVIEW_CHARS)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let next = if rows.len() > limit {
            rows.truncate(limit);
            rows.last().map(|r| r.id)
        } else {
            None
        };
        Ok(HistoryPage { rows, next })
    }

    /// An entry with its whole statement and error message.
    pub fn history_entry(&self, id: f64) -> Result<Option<HistoryRow>, YadbeError> {
        let conn = self.conn();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {ROW_COLUMNS} FROM history h WHERE h.id = ?3"
        ))?;
        let mut rows = stmt.query_map(params![i64::MAX / 4, i64::MAX / 4, id as i64], |row| {
            row_to_history(row, usize::MAX, usize::MAX)
        })?;
        Ok(rows.next().transpose()?)
    }

    /// `true` when the entry existed.
    pub fn delete_history_entry(&self, id: f64) -> Result<bool, YadbeError> {
        let changed = self
            .conn()
            .execute("DELETE FROM history WHERE id = ?1", [id as i64])?;
        Ok(changed > 0)
    }

    /// Entries inside `scope` (for the confirmation before clearing).
    pub fn count_history(&self, scope: &HistoryScope) -> Result<u32, YadbeError> {
        let mut filter = Filter::new(1, "h.id");
        filter.scope(scope);
        let sql = format!("SELECT COUNT(*) FROM history h {}", filter.where_sql());
        let count: i64 = self
            .conn()
            .query_row(&sql, params_from_iter(filter.params), |row| row.get(0))?;
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    /// Deletes the entries inside `scope`; returns how many.
    pub fn clear_history(&self, scope: &HistoryScope) -> Result<u32, YadbeError> {
        let mut filter = Filter::new(1, "h.id");
        filter.scope(scope);
        let sql = format!(
            "DELETE FROM history WHERE id IN (SELECT h.id FROM history h {})",
            filter.where_sql()
        );
        let changed = self.conn().execute(&sql, params_from_iter(filter.params))?;
        Ok(u32::try_from(changed).unwrap_or(u32::MAX))
    }

    /// Applies the retention bounds as of `now_ms`; returns how many entries went.
    pub fn prune_history(
        &self,
        retention: HistoryRetention,
        now_ms: i64,
    ) -> Result<u32, YadbeError> {
        let cutoff = now_ms - i64::from(retention.max_age_days) * 86_400_000;
        let conn = self.conn();
        let aged = conn.execute(
            "DELETE FROM history WHERE id < ?1",
            [cutoff.saturating_mul(ID_SLOTS)],
        )?;
        let over = conn.execute(
            "DELETE FROM history WHERE id IN (
                SELECT id FROM history ORDER BY id DESC LIMIT -1 OFFSET ?1)",
            [i64::from(retention.max_entries)],
        )?;
        Ok(u32::try_from(aged + over).unwrap_or(u32::MAX))
    }
}
