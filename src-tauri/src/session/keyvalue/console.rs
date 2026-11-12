//! The console of a key-value query tab: command lines as in `redis-cli`, tokenized with its
//! quoting rules and sent as RESP arguments exactly as typed (rule 3), in order, on the tab's
//! own connection (`SELECT` stays with the tab). Dangerous commands are confirmed with their
//! effect before anything runs; every command goes to the history.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::db::driver::KeyValueConnection;
use crate::db::errors::YadbeError;
use crate::db::keyvalue::tokenize::{command_lines, split_args};
use crate::db::keyvalue::{KvBytes, KvCommand, KvReply};
use crate::db::value::{ColumnMeta, Value, ValueKind};
use crate::session::history_hook::HistoryRecorder;
use crate::session::keyvalue::Pool;
use crate::session::keyvalue::gate::{Origin, UserContext};
use crate::session::keyvalue::model::{
    KvConsoleEntry, KvConsoleOutcome, KvReplyView, KvScalarKind,
};
use crate::session::keyvalue::viewer::bytes_value;
use crate::session::result_store::ResultStore;

/// Elements of a nested reply shown in its tree before it is cut.
const TREE_BUDGET: usize = 5_000;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// One console tab's connection, database and results.
pub struct Console {
    tab_id: String,
    connection_id: String,
    conn: tokio::sync::Mutex<Option<(Arc<dyn KeyValueConnection>, u32)>>,
    running: AtomicBool,
    stop: AtomicBool,
    results: Mutex<Vec<u32>>,
}

impl Console {
    pub fn new(tab_id: &str, connection_id: &str) -> Self {
        Self {
            tab_id: tab_id.to_owned(),
            connection_id: connection_id.to_owned(),
            conn: tokio::sync::Mutex::new(None),
            running: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            results: Mutex::new(Vec::new()),
        }
    }

    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    /// Frees the results of the last run.
    pub fn release(&self, store: &ResultStore) {
        let ids: Vec<u32> = lock(&self.results).drain(..).collect();
        store.remove(ids);
    }

    pub async fn close(&self) {
        if let Some((conn, _)) = self.conn.lock().await.take() {
            conn.close().await;
        }
    }

    /// The tab's connection and its database, opened again after a drop (on the connection's
    /// saved database: a `SELECT` does not survive a reconnection).
    async fn connection(
        &self,
        pool: &Pool,
    ) -> Result<(Arc<dyn KeyValueConnection>, u32), YadbeError> {
        let mut slot = self.conn.lock().await;
        if let Some((conn, db)) = slot.as_ref()
            && !conn.link().is_lost()
        {
            return Ok((Arc::clone(conn), *db));
        }
        let conn = pool
            .session()
            .open_dedicated(None)
            .await?
            .into_key_value()?;
        let db = conn.database();
        *slot = Some((Arc::clone(&conn), db));
        Ok((conn, db))
    }

    async fn set_database(&self, db: u32) {
        if let Some((_, current)) = self.conn.lock().await.as_mut() {
            *current = db;
        }
    }

    pub async fn run(
        &self,
        pool: &Pool,
        store: &ResultStore,
        history: &dyn HistoryRecorder,
        text: &str,
        confirmed: bool,
    ) -> Result<KvConsoleOutcome, YadbeError> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(YadbeError::execution_running());
        }
        let outcome = self.run_inner(pool, store, history, text, confirmed).await;
        self.running.store(false, Ordering::SeqCst);
        outcome
    }

    async fn run_inner(
        &self,
        pool: &Pool,
        store: &ResultStore,
        history: &dyn HistoryRecorder,
        text: &str,
        confirmed: bool,
    ) -> Result<KvConsoleOutcome, YadbeError> {
        self.stop.store(false, Ordering::SeqCst);
        let lines = command_lines(text);
        let (conn, mut db) = self.connection(pool).await?;
        let gate = pool.gate(history);

        // Every line is split first: a quoting mistake runs nothing.
        let mut commands = Vec::with_capacity(lines.len());
        for (line, source) in &lines {
            let line = u32::try_from(*line).unwrap_or(u32::MAX);
            match split_args(source) {
                Ok(args) => commands.push((line, KvCommand::new(args))),
                Err(error) => {
                    return Ok(KvConsoleOutcome::Ran {
                        entries: vec![KvConsoleEntry {
                            line,
                            command: (*source).to_owned(),
                            database: db,
                            duration_ms: 0.0,
                            reply: None,
                            error: Some(error),
                        }],
                        database: db,
                        skipped: u32::try_from(lines.len().saturating_sub(1)).unwrap_or(u32::MAX),
                    });
                }
            }
        }
        if !confirmed {
            let dangers = gate.dangers(&*conn, db, &commands).await;
            if !dangers.is_empty() {
                return Ok(KvConsoleOutcome::NeedsConfirmation { dangers });
            }
        }

        self.release(store);
        let mut entries = Vec::with_capacity(commands.len());
        let mut skipped = 0_u32;
        for (index, (line, cmd)) in commands.iter().enumerate() {
            if self.stop.load(Ordering::SeqCst) {
                skipped = u32::try_from(commands.len() - index).unwrap_or(u32::MAX);
                break;
            }
            let context = UserContext {
                tab_id: self.tab_id.clone(),
                connection_id: self.connection_id.clone(),
                database: db,
            };
            let start = Instant::now();
            let result = gate.run(&*conn, cmd, Origin::User(&context), true).await;
            let duration_ms = (start.elapsed().as_secs_f64() * 10_000.0).round() / 10.0;
            let ran_on = db;
            let failed = result.is_err();
            let (reply, error) = match result {
                Ok(reply) => {
                    if cmd.name() == "select"
                        && let Some(next) = cmd.arg_lower(1).and_then(|n| n.parse::<u32>().ok())
                    {
                        db = next;
                        self.set_database(db).await;
                    }
                    let (view, result_id) = reply_view(reply, store);
                    if let Some(id) = result_id {
                        lock(&self.results).push(id);
                    }
                    (Some(view), None)
                }
                Err(error) => (None, Some(error)),
            };
            entries.push(KvConsoleEntry {
                line: *line,
                command: cmd.display(),
                database: ran_on,
                duration_ms,
                reply,
                error,
            });
            if failed {
                skipped = u32::try_from(commands.len() - index - 1).unwrap_or(u32::MAX);
                break;
            }
        }
        Ok(KvConsoleOutcome::Ran {
            entries,
            database: db,
            skipped,
        })
    }
}

fn scalar_value(reply: &KvReply) -> Value {
    match reply {
        KvReply::Nil => Value::Null,
        KvReply::Int(n) => Value::int(n),
        KvReply::Double(f) => Value::float(*f),
        KvReply::Bool(b) => Value::Bool(*b),
        KvReply::BigNumber(digits) => Value::Decimal(digits.clone()),
        KvReply::Status(text) => Value::Text(text.clone()),
        KvReply::Bulk(bytes) => bytes_value(bytes),
        KvReply::Error(message) => Value::Other(format!("(error) {message}")),
        KvReply::Array(_) | KvReply::Set(_) | KvReply::Map(_) => {
            let (json, _) = reply.to_json(TREE_BUDGET);
            Value::Json(json.to_string())
        }
    }
}

fn kind_of(values: &[Value]) -> ValueKind {
    let mut kinds = values.iter().filter_map(|v| match v {
        Value::Null => None,
        Value::Int(_) => Some(ValueKind::Int),
        Value::Float(_) => Some(ValueKind::Float),
        Value::Bytes(_) => Some(ValueKind::Bytes),
        _ => Some(ValueKind::Text),
    });
    let first = kinds.next().unwrap_or(ValueKind::Text);
    if kinds.all(|k| k == first) {
        first
    } else {
        ValueKind::Text
    }
}

fn grid(
    store: &ResultStore,
    names: &[String],
    rows: Vec<Vec<Value>>,
) -> (KvReplyView, Option<u32>) {
    let columns: Vec<ColumnMeta> = names
        .iter()
        .enumerate()
        .map(|(i, name)| {
            let cells: Vec<Value> = rows.iter().filter_map(|r| r.get(i).cloned()).collect();
            ColumnMeta {
                name: name.clone(),
                type_name: String::new(),
                kind: kind_of(&cells),
            }
        })
        .collect();
    let result = store.create(columns.clone());
    let row_count = rows.len();
    result.append(rows);
    let id = result.id();
    (
        KvReplyView::Grid {
            result_id: id,
            columns,
            row_count: u32::try_from(row_count).unwrap_or(u32::MAX),
        },
        Some(id),
    )
}

/// How a reply is shown: scalars as a value; a flat list or set as a one-column grid; a map
/// of scalars as a field / value grid; a list of equal-length scalar tuples as a grid with one
/// column per position; anything else as a tree. Grid rows go to the result store (rule 8).
pub fn reply_view(reply: KvReply, store: &ResultStore) -> (KvReplyView, Option<u32>) {
    let scalar =
        |value: KvBytes, scalar: KvScalarKind| (KvReplyView::Scalar { value, scalar }, None);
    match reply {
        KvReply::Nil => (KvReplyView::Nil, None),
        KvReply::Int(n) => scalar(KvBytes::text(n.to_string()), KvScalarKind::Int),
        KvReply::Double(f) => scalar(
            KvBytes::text(crate::db::value::format_float(f)),
            KvScalarKind::Double,
        ),
        KvReply::Bool(b) => scalar(KvBytes::text(b.to_string()), KvScalarKind::Bool),
        KvReply::BigNumber(d) => scalar(KvBytes::text(d), KvScalarKind::BigNumber),
        KvReply::Status(s) => scalar(KvBytes::text(s), KvScalarKind::Status),
        KvReply::Bulk(bytes) => scalar(KvBytes::from_bytes(&bytes), KvScalarKind::Bulk),
        KvReply::Error(message) => scalar(KvBytes::text(message), KvScalarKind::Error),
        KvReply::Map(pairs) if pairs.is_empty() => (KvReplyView::Empty, None),
        KvReply::Map(pairs) => {
            if pairs.iter().all(|(k, v)| k.is_scalar() && v.is_scalar()) {
                let rows = pairs
                    .iter()
                    .map(|(k, v)| vec![scalar_value(k), scalar_value(v)])
                    .collect();
                grid(store, &["field".to_owned(), "value".to_owned()], rows)
            } else {
                tree(&KvReply::Map(pairs))
            }
        }
        KvReply::Array(items) | KvReply::Set(items) if items.is_empty() => {
            (KvReplyView::Empty, None)
        }
        KvReply::Array(items) | KvReply::Set(items) => {
            if items.iter().all(KvReply::is_scalar) {
                let rows = items
                    .iter()
                    .enumerate()
                    .map(|(i, item)| vec![Value::int(i + 1), scalar_value(item)])
                    .collect();
                return grid(store, &["#".to_owned(), "value".to_owned()], rows);
            }
            let width = items.first().and_then(KvReply::items).map(<[KvReply]>::len);
            let tuples = width.is_some_and(|w| w >= 2)
                && items.iter().all(|item| {
                    item.items().is_some_and(|parts| {
                        Some(parts.len()) == width && parts.iter().all(KvReply::is_scalar)
                    })
                });
            if let (true, Some(width)) = (tuples, width) {
                let names: Vec<String> = (1..=width).map(|i| i.to_string()).collect();
                let rows = items
                    .iter()
                    .map(|item| {
                        item.items()
                            .unwrap_or_default()
                            .iter()
                            .map(scalar_value)
                            .collect()
                    })
                    .collect();
                return grid(store, &names, rows);
            }
            tree(&KvReply::Array(items))
        }
    }
}

fn tree(reply: &KvReply) -> (KvReplyView, Option<u32>) {
    let (json, truncated) = reply.to_json(TREE_BUDGET);
    (
        KvReplyView::Tree {
            json: json.to_string(),
            truncated,
        },
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bulk(s: &str) -> KvReply {
        KvReply::Bulk(s.as_bytes().to_vec())
    }

    #[test]
    fn replies_take_the_view_of_their_shape() {
        let store = ResultStore::default();
        assert_eq!(reply_view(KvReply::Nil, &store).0, KvReplyView::Nil);
        assert!(matches!(
            reply_view(KvReply::Status("OK".into()), &store).0,
            KvReplyView::Scalar {
                scalar: KvScalarKind::Status,
                ..
            }
        ));
        let list = reply_view(KvReply::Array(vec![bulk("a"), bulk("b")]), &store);
        match list.0 {
            KvReplyView::Grid {
                columns,
                row_count,
                result_id,
            } => {
                assert_eq!(columns[1].name, "value");
                assert_eq!(row_count, 2);
                assert_eq!(Some(result_id), list.1);
            }
            other => panic!("grid expected, got {other:?}"),
        }
        let map = reply_view(KvReply::Map(vec![(bulk("f"), KvReply::Int(1))]), &store);
        assert!(
            matches!(map.0, KvReplyView::Grid { ref columns, .. } if columns[0].name == "field")
        );
        let pairs = reply_view(
            KvReply::Array(vec![
                KvReply::Array(vec![bulk("m1"), KvReply::Double(1.0)]),
                KvReply::Array(vec![bulk("m2"), KvReply::Double(2.0)]),
            ]),
            &store,
        );
        assert!(matches!(pairs.0, KvReplyView::Grid { ref columns, .. } if columns.len() == 2));
        let nested = reply_view(
            KvReply::Array(vec![bulk("x"), KvReply::Array(vec![bulk("y")])]),
            &store,
        );
        assert!(matches!(
            nested.0,
            KvReplyView::Tree {
                truncated: false,
                ..
            }
        ));
        assert_eq!(
            reply_view(KvReply::Array(vec![]), &store).0,
            KvReplyView::Empty
        );
    }
}
