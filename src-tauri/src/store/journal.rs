//! Change journal (F-090): every change set applied from a table tab, with the statements as
//! run and its inverse, so that it can be reverted. Bounded like the history (entries and
//! age, both preferences).

use rusqlite::types::Value as SqlValue;
use rusqlite::{OptionalExtension, Row, params, params_from_iter};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::Store;
use crate::db::dialect::Engine;
use crate::db::errors::YadbeError;
use crate::db::meta::ObjectRef;

/// Rows per page of a search.
pub const JOURNAL_PAGE_SIZE: u32 = 200;
/// Characters of the first statement sent in a list row.
pub const JOURNAL_PREVIEW_CHARS: usize = 300;
/// A statement longer than this is kept cut for display (a row with a large value). The
/// inverse keeps the values whole, up to [`MAX_INVERSE_BYTES`].
pub const MAX_STATEMENT_CHARS: usize = 64 * 1024;
/// The inverse of a change set is not kept beyond this (its values are too large): the change
/// set cannot be reverted then.
pub const MAX_INVERSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SEARCH_CHARS: usize = 200;
const CUT_MARK: &str = " … (cut by the yadbe journal)";

/// Why a change set cannot be reverted faithfully: yadbe refuses rather than guess.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RevertBlocker {
    /// An edited value was sent without the value it replaced.
    OriginalUnknown { column: String },
    /// A deleted row was sent without its values.
    DeletedRowUnknown,
    /// A deleted row lacks columns of the table (not loaded).
    ColumnsNotLoaded { columns: Vec<String> },
    /// A deleted row holds a value of a type yadbe cannot write back (SQL Server
    /// `sql_variant`, spatial types…).
    UnwritableColumn { column: String },
    /// A deleted row's identity value cannot be written back on this engine.
    IdentityNotRestorable { column: String },
    /// An inserted row could not be read back (no key value to find it).
    InsertedRowUnknown,
    /// The updated rows could not be read back after the change.
    UpdatedRowUnknown,
    /// The values are too large to be kept.
    TooLarge,
    /// The inverse statements could not be planned.
    NotPlannable,
}

/// A statement of a change set, as run (values written as literals, like the SQL preview).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalStatement {
    pub sql: String,
    /// Rows the statement changed, when known.
    pub rows_affected: Option<f64>,
}

/// A change set to record.
#[derive(Debug, Clone)]
pub struct NewJournalEntry {
    pub connection_id: String,
    pub connection_name: String,
    pub engine: Engine,
    pub table: ObjectRef,
    /// Unix time in milliseconds.
    pub applied_at_ms: i64,
    pub duration_ms: f64,
    pub updated: u32,
    pub inserted: u32,
    pub deleted: u32,
    pub statements: Vec<JournalStatement>,
    /// The inverse change set, as JSON; `None` with a `blocker`.
    pub inverse: Option<String>,
    /// The inverse as readable SQL (what a revert would run, planned when recorded).
    pub inverse_statements: Vec<String>,
    pub blocker: Option<RevertBlocker>,
    /// The entry this change set reverted.
    pub reverts: Option<i64>,
}

/// One applied change set, as listed.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub id: u32,
    pub connection_id: String,
    /// The connection's name when the change set was applied.
    pub connection_name: String,
    pub engine: Engine,
    pub table: ObjectRef,
    /// Unix time in milliseconds.
    pub applied_at: f64,
    pub duration_ms: f64,
    pub updated: u32,
    pub inserted: u32,
    pub deleted: u32,
    pub statement_count: u32,
    /// The first statement, cut to [`JOURNAL_PREVIEW_CHARS`].
    pub preview: String,
    /// `null`: it can be reverted (unless already reverted).
    pub revert_blocker: Option<RevertBlocker>,
    /// The entry this change set reverted.
    pub reverts: Option<u32>,
    /// The entry that reverted this change set.
    pub reverted_by: Option<u32>,
}

/// An entry with its statements and the inverse statements.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalDetail {
    pub entry: JournalEntry,
    pub statements: Vec<JournalStatement>,
    /// What "Revert this change set" would run, as planned when the change set was applied
    /// (the revert plans it again on the table as it is then).
    pub inverse_statements: Vec<String>,
}

/// Newest first. Every field narrows the result.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalQuery {
    /// Matched in the table name and the statements (case-insensitive substring).
    pub text: Option<String>,
    pub connection_id: Option<String>,
    /// Database (when not empty), schema (when set) and name of the table.
    pub table: Option<ObjectRef>,
    /// The `next` of the previous page.
    pub after: Option<u32>,
    /// At most [`JOURNAL_PAGE_SIZE`] (the default).
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalPage {
    pub entries: Vec<JournalEntry>,
    /// Pass it as `after` for the following page; `null` on the last page.
    pub next: Option<u32>,
}

/// A table that has entries, for the filter.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalTable {
    pub connection_id: String,
    pub table: ObjectRef,
    pub entries: u32,
}

/// What a revert needs from an entry.
#[derive(Debug, Clone)]
pub struct StoredInverse {
    pub entry: JournalEntry,
    /// The inverse change set, as JSON.
    pub inverse: Option<String>,
}

/// Bounds of the journal: whichever is reached first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JournalRetention {
    pub max_entries: u32,
    pub max_age_days: u32,
}

fn cut_chars(text: &str, max: usize) -> (&str, bool) {
    match text.char_indices().nth(max) {
        Some((at, _)) => (&text[..at], true),
        None => (text, false),
    }
}

/// A statement as kept: whole, unless longer than [`MAX_STATEMENT_CHARS`].
pub fn kept_statement(sql: &str) -> String {
    match cut_chars(sql, MAX_STATEMENT_CHARS) {
        (kept, true) => format!("{kept}{CUT_MARK}"),
        (whole, false) => whole.to_owned(),
    }
}

const ENTRY_COLUMNS: &str = "id, connection_id, connection_name, engine, database_name, \
    schema_name, table_name, applied_at, duration_ms, updated, inserted, deleted, statements, \
    revert_blocker, reverts, reverted_by";

fn corrupt(index: usize, what: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        format!("unexpected {what} in the change journal").into(),
    )
}

fn to_id(value: i64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn count(value: i64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// An entry row; also returns the statements.
fn row_to_entry(row: &Row<'_>) -> rusqlite::Result<(JournalEntry, Vec<JournalStatement>)> {
    let engine: String = row.get(3)?;
    let statements: String = row.get(12)?;
    let statements: Vec<JournalStatement> =
        serde_json::from_str(&statements).map_err(|_| corrupt(12, "statement list"))?;
    let blocker: Option<String> = row.get(13)?;
    let preview = statements
        .first()
        .map(|s| cut_chars(&s.sql, JOURNAL_PREVIEW_CHARS).0.to_owned())
        .unwrap_or_default();
    let entry = JournalEntry {
        id: to_id(row.get(0)?),
        connection_id: row.get(1)?,
        connection_name: row.get(2)?,
        engine: Engine::from_id(&engine).ok_or_else(|| corrupt(3, "engine"))?,
        table: ObjectRef {
            database: row.get(4)?,
            schema: row.get(5)?,
            name: row.get(6)?,
        },
        applied_at: row.get::<_, i64>(7)? as f64,
        duration_ms: row.get(8)?,
        updated: count(row.get(9)?),
        inserted: count(row.get(10)?),
        deleted: count(row.get(11)?),
        statement_count: count(i64::try_from(statements.len()).unwrap_or(i64::MAX)),
        preview,
        // An unreadable reason still blocks the revert.
        revert_blocker: blocker
            .map(|b| serde_json::from_str(&b).unwrap_or(RevertBlocker::NotPlannable)),
        reverts: row.get::<_, Option<i64>>(14)?.map(to_id),
        reverted_by: row.get::<_, Option<i64>>(15)?.map(to_id),
    };
    Ok((entry, statements))
}

/// The `WHERE` of a search, with its parameters.
fn search_filter(query: &JournalQuery) -> (String, Vec<SqlValue>) {
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    let mut push = |clause: &str, value: SqlValue| {
        params.push(value);
        clauses.push(clause.replace('?', &format!("?{}", params.len())));
    };
    if let Some(text) = query
        .text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        let (text, _) = cut_chars(text, MAX_SEARCH_CHARS);
        // `instr` on lowered text: no LIKE wildcards to escape. The table name is in the
        // statements too.
        push(
            "instr(lower(statements), lower(?)) > 0",
            SqlValue::Text(text.to_owned()),
        );
    }
    if let Some(id) = &query.connection_id {
        push("connection_id = ?", SqlValue::Text(id.clone()));
    }
    if let Some(table) = &query.table {
        push("table_name = ?", SqlValue::Text(table.name.clone()));
        if let Some(schema) = &table.schema {
            push("schema_name = ?", SqlValue::Text(schema.clone()));
        }
        if !table.database.is_empty() {
            push("database_name = ?", SqlValue::Text(table.database.clone()));
        }
    }
    if let Some(after) = query.after {
        push("id < ?", SqlValue::Integer(i64::from(after)));
    }
    let sql = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    (sql, params)
}

impl Store {
    /// Records a change set; returns its id.
    pub fn insert_journal(&self, entry: &NewJournalEntry) -> Result<i64, YadbeError> {
        let statements: Vec<JournalStatement> = entry
            .statements
            .iter()
            .map(|s| JournalStatement {
                sql: kept_statement(&s.sql),
                rows_affected: s.rows_affected,
            })
            .collect();
        let inverse_statements: Vec<String> = entry
            .inverse_statements
            .iter()
            .map(|s| kept_statement(s))
            .collect();
        let blocker = entry
            .blocker
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let conn = self.conn();
        conn.execute(
            "INSERT INTO change_journal (connection_id, connection_name, engine, database_name,
                schema_name, table_name, applied_at, duration_ms, updated, inserted, deleted,
                statements, inverse, inverse_statements, revert_blocker, reverts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                entry.connection_id,
                entry.connection_name,
                entry.engine.id(),
                entry.table.database,
                entry.table.schema,
                entry.table.name,
                entry.applied_at_ms,
                entry.duration_ms,
                entry.updated,
                entry.inserted,
                entry.deleted,
                serde_json::to_string(&statements)?,
                entry.inverse,
                serde_json::to_string(&inverse_statements)?,
                blocker,
                entry.reverts,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Marks `id` as reverted by `by`.
    pub fn mark_journal_reverted(&self, id: i64, by: i64) -> Result<(), YadbeError> {
        self.conn().execute(
            "UPDATE change_journal SET reverted_by = ?2 WHERE id = ?1",
            params![id, by],
        )?;
        Ok(())
    }

    /// One page of the journal, newest first.
    pub fn search_journal(&self, query: &JournalQuery) -> Result<JournalPage, YadbeError> {
        let limit = query
            .limit
            .unwrap_or(JOURNAL_PAGE_SIZE)
            .clamp(1, JOURNAL_PAGE_SIZE) as usize;
        let (filter, params) = search_filter(query);
        let sql = format!(
            "SELECT {ENTRY_COLUMNS} FROM change_journal {filter} ORDER BY id DESC LIMIT {}",
            limit + 1
        );
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let mut entries = stmt
            .query_map(params_from_iter(params), |row| {
                row_to_entry(row).map(|(entry, _)| entry)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let next = if entries.len() > limit {
            entries.truncate(limit);
            entries.last().map(|e| e.id)
        } else {
            None
        };
        Ok(JournalPage { entries, next })
    }

    /// An entry with its statements.
    pub fn journal_entry(&self, id: u32) -> Result<Option<JournalDetail>, YadbeError> {
        let conn = self.conn();
        let found = conn
            .query_row(
                &format!(
                    "SELECT {ENTRY_COLUMNS}, inverse_statements FROM change_journal WHERE id = ?1"
                ),
                [i64::from(id)],
                |row| {
                    let (entry, statements) = row_to_entry(row)?;
                    let inverse: String = row.get(16)?;
                    Ok((entry, statements, inverse))
                },
            )
            .optional()?;
        let Some((entry, statements, inverse)) = found else {
            return Ok(None);
        };
        Ok(Some(JournalDetail {
            entry,
            statements,
            inverse_statements: serde_json::from_str(&inverse).unwrap_or_default(),
        }))
    }

    /// An entry and its inverse change set (JSON), for a revert.
    pub fn journal_inverse(&self, id: u32) -> Result<Option<StoredInverse>, YadbeError> {
        let conn = self.conn();
        Ok(conn
            .query_row(
                &format!("SELECT {ENTRY_COLUMNS}, inverse FROM change_journal WHERE id = ?1"),
                [i64::from(id)],
                |row| {
                    let (entry, _) = row_to_entry(row)?;
                    Ok(StoredInverse {
                        entry,
                        inverse: row.get(16)?,
                    })
                },
            )
            .optional()?)
    }

    /// The tables that have entries (of one connection, or all), most recent first.
    pub fn journal_tables(
        &self,
        connection_id: Option<&str>,
    ) -> Result<Vec<JournalTable>, YadbeError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT connection_id, database_name, schema_name, table_name, COUNT(*), MAX(id) AS last
             FROM change_journal WHERE ?1 IS NULL OR connection_id = ?1
             GROUP BY connection_id, database_name, schema_name, table_name
             ORDER BY last DESC",
        )?;
        let rows = stmt
            .query_map([connection_id], |row| {
                Ok(JournalTable {
                    connection_id: row.get(0)?,
                    table: ObjectRef {
                        database: row.get(1)?,
                        schema: row.get(2)?,
                        name: row.get(3)?,
                    },
                    entries: count(row.get(4)?),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Deletes the entries of a connection (all when `None`); returns how many.
    pub fn clear_journal(&self, connection_id: Option<&str>) -> Result<u32, YadbeError> {
        let changed = self.conn().execute(
            "DELETE FROM change_journal WHERE ?1 IS NULL OR connection_id = ?1",
            [connection_id],
        )?;
        Ok(u32::try_from(changed).unwrap_or(u32::MAX))
    }

    /// Applies the retention bounds as of `now_ms`; returns how many entries went.
    pub fn prune_journal(
        &self,
        retention: JournalRetention,
        now_ms: i64,
    ) -> Result<u32, YadbeError> {
        let cutoff = now_ms - i64::from(retention.max_age_days) * 86_400_000;
        let conn = self.conn();
        let aged = conn.execute("DELETE FROM change_journal WHERE applied_at < ?1", [cutoff])?;
        let over = conn.execute(
            "DELETE FROM change_journal WHERE id IN (
                SELECT id FROM change_journal ORDER BY id DESC LIMIT -1 OFFSET ?1)",
            [i64::from(retention.max_entries)],
        )?;
        Ok(u32::try_from(aged + over).unwrap_or(u32::MAX))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(table: &str, at: i64, sql: &str) -> NewJournalEntry {
        NewJournalEntry {
            connection_id: "c1".into(),
            connection_name: "Local".into(),
            engine: Engine::Postgres,
            table: ObjectRef {
                database: "shop".into(),
                schema: Some("public".into()),
                name: table.into(),
            },
            applied_at_ms: at,
            duration_ms: 1.5,
            updated: 1,
            inserted: 0,
            deleted: 0,
            statements: vec![JournalStatement {
                sql: sql.into(),
                rows_affected: Some(1.0),
            }],
            inverse: Some("{}".into()),
            inverse_statements: vec!["UPDATE back".into()],
            blocker: None,
            reverts: None,
        }
    }

    #[test]
    fn records_searches_reverts_and_prunes() {
        let store = Store::open_in_memory().expect("store");
        let first = store
            .insert_journal(&entry("orders", 1_000, "UPDATE \"orders\" SET a = 'Zed'"))
            .expect("insert");
        let mut blocked = entry("customers", 2_000, "DELETE FROM customers");
        blocked.blocker = Some(RevertBlocker::UnwritableColumn {
            column: "shape".into(),
        });
        blocked.inverse = None;
        blocked.connection_id = "c2".into();
        let second = store.insert_journal(&blocked).expect("insert");
        let long = "x".repeat(MAX_STATEMENT_CHARS + 5);
        let third = store
            .insert_journal(&entry("orders", 3_000, &long))
            .expect("insert");

        let all = store.search_journal(&JournalQuery::default()).expect("all");
        let ids: Vec<u32> = all.entries.iter().map(|e| e.id).collect();
        assert_eq!(ids, [third as u32, second as u32, first as u32]);
        assert_eq!(
            all.entries[0].preview.chars().count(),
            JOURNAL_PREVIEW_CHARS
        );
        assert_eq!(
            all.entries[1].revert_blocker,
            Some(RevertBlocker::UnwritableColumn {
                column: "shape".into()
            })
        );
        let text = store
            .search_journal(&JournalQuery {
                text: Some("zed".into()),
                ..JournalQuery::default()
            })
            .expect("text");
        assert_eq!(text.entries.len(), 1);
        assert_eq!(text.entries[0].id, first as u32);
        let by_table = store
            .search_journal(&JournalQuery {
                table: Some(ObjectRef {
                    database: "shop".into(),
                    schema: Some("public".into()),
                    name: "orders".into(),
                }),
                limit: Some(1),
                ..JournalQuery::default()
            })
            .expect("table");
        assert_eq!(by_table.entries.len(), 1);
        assert_eq!(by_table.next, Some(third as u32));
        let page2 = store
            .search_journal(&JournalQuery {
                table: by_table.entries[0].table.clone().into(),
                after: by_table.next,
                ..JournalQuery::default()
            })
            .expect("page 2");
        assert_eq!(page2.entries[0].id, first as u32);
        let by_connection = store
            .search_journal(&JournalQuery {
                connection_id: Some("c2".into()),
                ..JournalQuery::default()
            })
            .expect("connection");
        assert_eq!(by_connection.entries.len(), 1);

        let detail = store
            .journal_entry(third as u32)
            .expect("detail")
            .expect("found");
        assert!(detail.statements[0].sql.ends_with(CUT_MARK));
        assert_eq!(detail.inverse_statements, ["UPDATE back"]);
        let tables = store.journal_tables(None).expect("tables");
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[0].table.name, "orders");
        assert_eq!(tables[0].entries, 2);

        store
            .mark_journal_reverted(first, third)
            .expect("mark reverted");
        let inverse = store
            .journal_inverse(first as u32)
            .expect("inverse")
            .expect("found");
        assert_eq!(inverse.entry.reverted_by, Some(third as u32));
        assert_eq!(inverse.inverse.as_deref(), Some("{}"));

        let gone = store
            .prune_journal(
                JournalRetention {
                    max_entries: 1,
                    max_age_days: 1,
                },
                2_500 + 86_400_000,
            )
            .expect("prune");
        assert_eq!(gone, 2);
        assert_eq!(store.clear_journal(Some("c2")).expect("clear"), 0);
        assert_eq!(store.clear_journal(None).expect("clear"), 1);
    }
}
