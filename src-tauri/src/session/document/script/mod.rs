//! The mongosh runtime of the document query tab (M4-3). A script runs on a thread of its
//! own in an embedded JavaScript engine (QuickJS, `engine.rs`) whose `db` API (`prelude.js`)
//! sends every operation through the command gate (`bridge.rs`): read-only, dangerous
//! operations confirmed by the user mid-script, timeouts, the statement log. The script's
//! text runs as written; only `use` / `show` / `it` lines are read as shell commands, as
//! mongosh does (`shell.rs`).
//!
//! A run is bounded: the engine's memory and stack, an interrupt hook that stops JavaScript
//! when the run is cancelled or past the statement timeout, `killOp` for the operation the
//! script waits on, caps on the messages and on the documents a result keeps.

pub mod bridge;
pub mod engine;
pub mod shell;

use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::db::document::json::Json;
use crate::db::document::ops::DocEvent;
use crate::db::driver::DocumentConnection;
use crate::db::errors::YadbeError;
use crate::session::ConnectionSession;
use crate::session::document::gate::GateOutcome;
use crate::session::document::model::{ScriptFailure, ScriptOutcome, ScriptRequest, ScriptResult};
use crate::session::document::results::store_documents;
use crate::session::query_model::{TextPosition, TextRange};
use crate::session::result_store::ResultStore;

use bridge::{Bridge, ConfirmHook, OpenCursor};
use engine::ScriptValue;

/// A result keeps at most this many documents of a cursor…
pub const RESULT_MAX_DOCUMENTS: usize = 50_000;
/// …and about this much of their Extended JSON text: the documents are held twice (grid and
/// documents view), and both stay in memory until the tab runs again.
pub const RESULT_MAX_BYTES: usize = 64 * 1024 * 1024;
/// The script thread's stack: the engine's own limit plus the native calls under it.
const THREAD_STACK: usize = 16 * 1024 * 1024;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What stops a run, shared by its thread, its operations and the cancel command.
pub struct ScriptControl {
    cancel: CancellationToken,
    deadline: Option<Instant>,
    limit_secs: u64,
    conn: Arc<dyn DocumentConnection>,
    /// The gate tokens of the operations in flight, for `killOp`.
    tokens: Mutex<Vec<String>>,
    /// The confirmation the script waits for.
    confirm: Mutex<Option<(u32, oneshot::Sender<bool>)>>,
    next_request: AtomicU32,
}

impl ScriptControl {
    pub fn new(conn: Arc<dyn DocumentConnection>, timeout: Option<Duration>) -> Self {
        Self {
            cancel: CancellationToken::new(),
            deadline: timeout.map(|t| Instant::now() + t),
            limit_secs: timeout.map_or(0, |t| t.as_secs()),
            conn,
            tokens: Mutex::new(Vec::new()),
            confirm: Mutex::new(None),
            next_request: AtomicU32::new(1),
        }
    }

    /// The run must stop now (the engine's interrupt hook).
    pub fn interrupted(&self) -> bool {
        self.cancel.is_cancelled() || self.deadline.is_some_and(|at| Instant::now() >= at)
    }

    pub fn stop_reason(&self) -> Option<YadbeError> {
        if self.cancel.is_cancelled() {
            Some(YadbeError::cancelled())
        } else if self.deadline.is_some_and(|at| Instant::now() >= at) {
            Some(self.timeout_error())
        } else {
            None
        }
    }

    pub fn timeout_error(&self) -> YadbeError {
        YadbeError::statement_timeout(self.limit_secs)
    }

    /// The time left before the statement timeout, for an operation's own limit.
    pub fn remaining(&self) -> Option<Duration> {
        self.deadline.map(|at| {
            at.saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1))
        })
    }

    fn track(&self, token: &str) {
        lock(&self.tokens).push(token.to_owned());
    }

    fn untrack(&self, token: &str) {
        lock(&self.tokens).retain(|t| t != token);
    }

    fn pending(&self, answer: oneshot::Sender<bool>) -> u32 {
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        *lock(&self.confirm) = Some((id, answer));
        id
    }

    fn forget_pending(&self, id: u32) {
        let mut confirm = lock(&self.confirm);
        if confirm.as_ref().is_some_and(|(pending, _)| *pending == id) {
            *confirm = None;
        }
    }

    /// The user's answer to confirmation `request_id`; `false` when the script no longer
    /// waits for it.
    pub fn answer(&self, request_id: u32, accepted: bool) -> bool {
        let mut confirm = lock(&self.confirm);
        match confirm.take() {
            Some((id, sender)) if id == request_id => sender.send(accepted).is_ok(),
            other => {
                *confirm = other;
                false
            }
        }
    }

    /// Stops the run: the operations in flight are killed on the server first, then the
    /// script is interrupted (and a pending confirmation declined).
    pub async fn cancel(&self) {
        let tokens = lock(&self.tokens).clone();
        for token in tokens {
            if let Err(err) = self.conn.kill(&token).await {
                tracing::warn!(error = %err, "could not stop a script's operation");
            }
        }
        self.cancel.cancel();
        if let Some((_, sender)) = lock(&self.confirm).take() {
            let _ = sender.send(false);
        }
    }
}

/// Where the code that runs sits in the editor text, to place errors there.
pub struct SourceMap {
    text: String,
    /// Byte range of the code in `text`.
    from: usize,
    to: usize,
    /// 0-based line of `from`, and its byte column.
    base_line: usize,
    base_column: usize,
}

fn byte_offset(text: &str, utf16: u32) -> Option<usize> {
    let mut units = 0_u32;
    for (at, c) in text.char_indices() {
        if units >= utf16 {
            return (units == utf16).then_some(at);
        }
        units += u32::try_from(c.len_utf16()).unwrap_or(2);
    }
    (units == utf16).then_some(text.len())
}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

impl SourceMap {
    pub fn new(text: &str, range: Option<TextRange>) -> Result<Self, YadbeError> {
        let (from, to) = match range {
            None => (0, text.len()),
            Some(range) => {
                let bad = || {
                    YadbeError::invalid_argument(
                        "The selection is outside the editor text.",
                        "La sélection est en dehors du texte de l'éditeur.",
                    )
                };
                let from = byte_offset(text, range.from).ok_or_else(bad)?;
                let to = byte_offset(text, range.to).ok_or_else(bad)?;
                if from > to {
                    return Err(bad());
                }
                (from, to)
            }
        };
        let before = &text[..from];
        let line_start = before.rfind('\n').map_or(0, |at| at + 1);
        Ok(Self {
            text: text.to_owned(),
            from,
            to,
            base_line: before.matches('\n').count(),
            base_column: from - line_start,
        })
    }

    /// The code that runs.
    pub fn code(&self) -> &str {
        &self.text[self.from..self.to]
    }

    /// A piece of the code (`start..end` of [`Self::code`], starting a line) preceded by
    /// blank lines and spaces, so that the engine's line and column are the editor's (one
    /// more line: the engine counts the first line's columns from 0).
    pub fn padded(&self, code: &str, start: usize, end: usize) -> String {
        let line = code[..start].matches('\n').count();
        let mut out = "\n".repeat(1 + self.base_line + line);
        if line == 0 {
            out.push_str(&" ".repeat(self.base_column));
        }
        out.push_str(&code[start..end]);
        out
    }

    /// The editor position of the engine's (1-based line, 1-based byte column) in a padded
    /// piece.
    pub fn place(&self, line: u32, column: u32) -> TextPosition {
        let line = (line as usize).saturating_sub(2);
        self.position(line, (column as usize).saturating_sub(1))
    }

    /// The editor position of the line holding byte `start` of the code.
    pub fn line_start(&self, start: usize) -> TextPosition {
        let code = self.code();
        let line = code[..start.min(code.len())].matches('\n').count();
        let column = if line == 0 { self.base_column } else { 0 };
        self.position(self.base_line + line, column)
    }

    fn position(&self, line: usize, byte_column: usize) -> TextPosition {
        let mut start = 0;
        for _ in 0..line {
            match self.text[start..].find('\n') {
                Some(at) => start += at + 1,
                None => break,
            }
        }
        let end = self.text[start..]
            .find('\n')
            .map_or(self.text.len(), |at| start + at);
        let mut at = (start + byte_column).min(end);
        while !self.text.is_char_boundary(at) {
            at -= 1;
        }
        let column = self.text[start..at].encode_utf16().count();
        TextPosition {
            offset: to_u32(self.text[..at].encode_utf16().count()),
            line: to_u32(self.text[..start].matches('\n').count() + 1),
            column: to_u32(column + 1),
        }
    }
}

/// Everything a run needs from its session.
pub struct ScriptRun {
    pub session: Arc<ConnectionSession>,
    pub conn: Arc<dyn DocumentConnection>,
    pub control: Arc<ScriptControl>,
    pub confirm: ConfirmHook,
    pub store: Arc<ResultStore>,
}

/// A finished run: its outcome, and what the history and the tab need to know.
pub struct ScriptFinished {
    pub outcome: ScriptOutcome,
    /// The code that ran, as typed.
    pub code: String,
    /// Documents of the result, when it has some.
    pub rows: Option<u64>,
    /// Results it put in the store.
    pub result_ids: Vec<u32>,
}

struct ThreadEnd {
    end: engine::EngineEnd,
    messages: Vec<crate::session::document::model::ScriptMessage>,
    truncated: bool,
}

/// Runs a script to its end (or its failure), then drains the cursor it left as its result.
pub async fn execute(
    run: ScriptRun,
    request: &ScriptRequest,
) -> Result<ScriptFinished, YadbeError> {
    let started = Instant::now();
    let map = SourceMap::new(&request.text, request.range)?;
    let code = map.code().to_owned();
    let (tx, rx) = oneshot::channel();
    let handle = tokio::runtime::Handle::current();
    let thread_control = Arc::clone(&run.control);
    let session = Arc::clone(&run.session);
    let conn = Arc::clone(&run.conn);
    let confirm = Arc::clone(&run.confirm);
    let database = request.database.clone();
    let thread_code = code.clone();
    std::thread::Builder::new()
        .name("yadbe-mongosh".to_owned())
        .stack_size(THREAD_STACK)
        .spawn(move || {
            let bridge = Rc::new(Bridge::new(
                handle,
                session,
                conn,
                Arc::clone(&thread_control),
                confirm,
            ));
            let end = engine::run(&bridge, &thread_control, &thread_code, &map, &database);
            bridge.close_all();
            let (messages, truncated) = bridge.take_messages();
            let _ = tx.send(ThreadEnd {
                end,
                messages,
                truncated,
            });
        })
        .map_err(|err| YadbeError::internal(format!("cannot start the script thread: {err}")))?;
    let ThreadEnd {
        end,
        messages,
        truncated,
    } = rx
        .await
        .map_err(|_| YadbeError::internal("the script engine stopped unexpectedly"))?;
    let mut failure = end
        .failure
        .map(|(error, position)| ScriptFailure { error, position });
    let mut result_ids = Vec::new();
    let mut rows = None;
    let result = match end.value {
        ScriptValue::None => None,
        ScriptValue::Text { text, truncated } => Some(ScriptResult::Text { text, truncated }),
        ScriptValue::Documents { documents, single } => {
            let stored = store_documents(&run.store, &documents);
            result_ids.extend([stored.result.result_id, stored.documents_id]);
            rows = Some(documents.len() as u64);
            Some(ScriptResult::Documents {
                documents: stored,
                cursor: false,
                single,
                truncated: false,
            })
        }
        ScriptValue::Cursor { buffered, rest } => {
            let (documents, truncated, error) = drain(&run.control, buffered, rest).await;
            if let Some(error) = error {
                failure = Some(ScriptFailure {
                    error,
                    position: None,
                });
                None
            } else {
                let stored = store_documents(&run.store, &documents);
                result_ids.extend([stored.result.result_id, stored.documents_id]);
                rows = Some(documents.len() as u64);
                Some(ScriptResult::Documents {
                    documents: stored,
                    cursor: true,
                    single: false,
                    truncated,
                })
            }
        }
    };
    Ok(ScriptFinished {
        outcome: ScriptOutcome {
            result,
            messages,
            messages_truncated: truncated,
            failure,
            database: end.database,
            duration_ms: (started.elapsed().as_secs_f64() * 1000.0).round(),
        },
        code,
        rows,
        result_ids,
    })
}

/// Reads the rest of a result cursor, up to the result's caps: the documents, whether some
/// were left, and the error that stopped it.
async fn drain(
    control: &ScriptControl,
    mut documents: Vec<Json>,
    rest: Option<OpenCursor>,
) -> (Vec<Json>, bool, Option<YadbeError>) {
    let Some(mut cursor) = rest else {
        return (documents, false, None);
    };
    let mut bytes: usize = documents.iter().map(|d| d.to_text().len()).sum();
    let full = |documents: &Vec<Json>, bytes: usize| {
        documents.len() >= RESULT_MAX_DOCUMENTS || bytes >= RESULT_MAX_BYTES
    };
    let deadline = async {
        match control.deadline {
            Some(at) => tokio::time::sleep_until(at.into()).await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(deadline);
    let mut truncated = false;
    let error = loop {
        let next = tokio::select! {
            biased;
            () = control.cancel.cancelled() => break Some(YadbeError::cancelled()),
            () = &mut deadline => {
                if let Err(err) = control.conn.kill(&cursor.token).await {
                    tracing::warn!(error = %err, "could not stop a result cursor past the timeout");
                }
                break Some(control.timeout_error());
            }
            next = cursor.rx.recv() => next,
        };
        match next {
            Some(DocEvent::Documents(batch)) => {
                if full(&documents, bytes) {
                    truncated = true;
                    break None;
                }
                for document in batch {
                    if full(&documents, bytes) {
                        truncated = true;
                        break;
                    }
                    bytes += document.to_text().len();
                    documents.push(document);
                }
                if truncated {
                    break None;
                }
            }
            None => {
                break match (&mut cursor.task).await {
                    Ok(Ok(GateOutcome::Done(_))) => None,
                    Ok(Ok(GateOutcome::Confirm(_))) => Some(YadbeError::internal(
                        "a cursor operation asked for a confirmation",
                    )),
                    Ok(Err(err)) => Some(err),
                    Err(join) => Some(YadbeError::internal(format!("cursor task: {join}"))),
                };
            }
        }
    };
    control.untrack(&cursor.token);
    drop(cursor);
    (documents, truncated, error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_land_in_the_editor_text() {
        let text = "// é\nconst a = 1;\n  db.x.find().foo()";
        let map = SourceMap::new(text, None).expect("map");
        let padded = map.padded(map.code(), 0, map.code().len());
        assert!(padded.starts_with("\n// é"));
        // Line 3 of the text is line 4 of the padded source; byte column 6 is `x`.
        let at = map.place(4, 6);
        assert_eq!((at.line, at.column, at.offset), (3, 6, 23));
        // A selection starting mid-line keeps its columns.
        let selected = SourceMap::new(text, Some(TextRange { from: 20, to: 37 })).expect("map");
        assert_eq!(selected.code(), "db.x.find().foo()");
        let padded = selected.padded(selected.code(), 0, selected.code().len());
        assert_eq!(padded, format!("{}  db.x.find().foo()", "\n".repeat(3)));
        let at = selected.place(4, 12);
        assert_eq!((at.line, at.column), (3, 12));
        // Columns count UTF-16 units, as the editor does.
        let wide = SourceMap::new("\"é😀\"; null.x", None).expect("map");
        let at = wide.place(2, 11);
        assert_eq!((at.line, at.column, at.offset), (1, 8, 7));
        assert!(SourceMap::new("abc", Some(TextRange { from: 2, to: 9 })).is_err());
    }
}
