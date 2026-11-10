//! yadbe patch: a SQL batch as the stream of everything the server sends back, in order
//! (result sets, rows, row counts, informational messages and errors), cancellable in-band
//! with a TDS Attention while it streams. `QueryStream` keeps only metadata and rows, turns
//! the first error into the stream's end, and its client cannot send an Attention while the
//! stream borrows it; a database explorer needs all of it.

use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{self, Poll};

use futures_util::ready;
use futures_util::stream::{BoxStream, Stream, StreamExt};
use futures_util::task::AtomicWaker;

use crate::row::ColumnType;
use crate::tds::codec::{MetaDataColumn, TokenDone};
use crate::tds::stream::ReceivedToken;
use crate::{Column, Row};

/// Asks a running batch to stop: the connection sends a TDS Attention as soon as it is
/// raised, even while it waits for the rest of a token, then the batch stream reads until
/// the server acknowledges it.
#[derive(Debug, Default)]
pub struct AttentionSignal {
    requested: AtomicBool,
    waker: AtomicWaker,
}

impl AttentionSignal {
    /// A signal not raised yet.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Requests the cancellation; harmless when the batch already ended.
    pub fn request(&self) {
        self.requested.store(true, Ordering::SeqCst);
        self.waker.wake();
    }

    /// Whether the cancellation was requested.
    pub fn is_requested(&self) -> bool {
        self.requested.load(Ordering::SeqCst)
    }
}

/// The Attention of the batch running on a connection, and how far it went.
#[derive(Debug, Default)]
pub(crate) struct ArmedAttention {
    signal: Option<Arc<AttentionSignal>>,
    state: AttentionState,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum AttentionState {
    #[default]
    Idle,
    /// Handed to the transport, not flushed yet.
    Queued,
    /// On the wire, not acknowledged yet.
    Sent,
}

impl ArmedAttention {
    pub(crate) fn arm(signal: Option<Arc<AttentionSignal>>) -> Self {
        Self {
            signal,
            state: AttentionState::Idle,
        }
    }

    /// Requested and not sent yet; otherwise wakes `cx` when it gets requested.
    pub(crate) fn due(&self, cx: &task::Context<'_>) -> bool {
        match (&self.signal, self.state) {
            (Some(signal), AttentionState::Idle) => {
                signal.waker.register(cx.waker());
                signal.is_requested()
            }
            _ => false,
        }
    }

    pub(crate) fn is_queued(&self) -> bool {
        self.state == AttentionState::Queued
    }

    pub(crate) fn set_queued(&mut self) {
        self.state = AttentionState::Queued;
    }

    pub(crate) fn set_sent(&mut self) {
        self.state = AttentionState::Sent;
    }

    /// Sent (or being sent) and not acknowledged: its DONE_ATTN is still to be read.
    pub(crate) fn outstanding(&self) -> bool {
        self.state != AttentionState::Idle
    }
}

/// Which DONE token ended a statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoneKind {
    /// A statement of the batch itself (`DONE`).
    Batch,
    /// A statement inside a procedure or trigger (`DONEINPROC`).
    InProc,
    /// A procedure call (`DONEPROC`).
    Proc,
}

/// The end of a statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BatchDone {
    /// The token that ended the statement.
    pub kind: DoneKind,
    /// Rows returned or affected, when the server counted them (`DONE_COUNT`).
    pub rows: Option<u64>,
    /// Acknowledges an Attention: the batch was cancelled.
    pub attention: bool,
}

impl From<(DoneKind, &TokenDone)> for BatchDone {
    fn from((kind, done): (DoneKind, &TokenDone)) -> Self {
        BatchDone {
            kind,
            rows: done.counted_rows(),
            attention: done.is_attention(),
        }
    }
}

/// An ERROR or INFO token (`PRINT`, `RAISERROR`, warnings…).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerMessage {
    /// An ERROR token (otherwise INFO).
    pub error: bool,
    /// The message number (`sys.messages`), 50000 for `RAISERROR` with text.
    pub number: u32,
    /// The state, which tells apart the places raising the same number.
    pub state: u8,
    /// Severity: up to 10 informational, 11 and above errors.
    pub class: u8,
    /// The text, never translated.
    pub message: String,
    /// The server name.
    pub server: String,
    /// The procedure or trigger raising it; empty for the batch itself.
    pub procedure: String,
    /// 1-based line in the batch, or in the procedure when `procedure` is set.
    pub line: u32,
}

/// The columns of a new result set.
#[derive(Debug, Clone)]
pub struct BatchMetadata {
    /// Names and types, as `Row`s of this result carry them.
    pub columns: Arc<Vec<Column>>,
    /// Full type information (length, precision, scale, collation…).
    pub metadata: Arc<Vec<MetaDataColumn<'static>>>,
    /// 0-based index of the result set in the batch.
    pub result_index: usize,
}

/// What a batch sends back, in order.
#[derive(Debug)]
pub enum BatchItem {
    /// A result set starts.
    Metadata(BatchMetadata),
    /// A row of the current result set.
    Row(Row),
    /// A statement ended.
    Done(BatchDone),
    /// An informational message or an error.
    Message(ServerMessage),
}

/// The response of [`Client::batch`](crate::Client::batch). Must be read to its end (or
/// dropped and followed by another request, which drains it) before the next request.
pub struct BatchStream<'a> {
    tokens: BoxStream<'a, crate::Result<ReceivedToken>>,
    columns: Option<Arc<Vec<Column>>>,
    result_index: Option<usize>,
}

impl std::fmt::Debug for BatchStream<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BatchStream")
            .field("result_index", &self.result_index)
            .finish()
    }
}

impl<'a> BatchStream<'a> {
    pub(crate) fn new(tokens: BoxStream<'a, crate::Result<ReceivedToken>>) -> Self {
        Self {
            tokens,
            columns: None,
            result_index: None,
        }
    }
}

impl Stream for BatchStream<'_> {
    type Item = crate::Result<BatchItem>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut task::Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            let token = match ready!(this.tokens.poll_next_unpin(cx)) {
                Some(Ok(token)) => token,
                Some(Err(err)) => return Poll::Ready(Some(Err(err))),
                None => return Poll::Ready(None),
            };
            let item = match token {
                ReceivedToken::NewResultset(meta) => {
                    let columns: Arc<Vec<Column>> = Arc::new(
                        meta.columns
                            .iter()
                            .map(|c| Column {
                                name: c.col_name.to_string(),
                                column_type: ColumnType::from(&c.base.ty),
                            })
                            .collect(),
                    );
                    this.columns = Some(Arc::clone(&columns));
                    let result_index = this.result_index.map_or(0, |i| i + 1);
                    this.result_index = Some(result_index);
                    BatchItem::Metadata(BatchMetadata {
                        columns,
                        metadata: Arc::new(meta.columns.clone()),
                        result_index,
                    })
                }
                ReceivedToken::Row(data) => {
                    let Some(columns) = this.columns.as_ref() else {
                        return Poll::Ready(Some(Err(crate::Error::Protocol(
                            "ROW token arrived before any column metadata".into(),
                        ))));
                    };
                    BatchItem::Row(Row {
                        columns: Arc::clone(columns),
                        data,
                        result_index: this.result_index.unwrap_or(0),
                    })
                }
                ReceivedToken::Done(done) => BatchItem::Done((DoneKind::Batch, &done).into()),
                ReceivedToken::DoneInProc(done) => {
                    BatchItem::Done((DoneKind::InProc, &done).into())
                }
                ReceivedToken::DoneProc(done) => BatchItem::Done((DoneKind::Proc, &done).into()),
                ReceivedToken::Info(info) => BatchItem::Message(ServerMessage {
                    error: false,
                    number: info.number,
                    state: info.state,
                    class: info.class,
                    message: info.message,
                    server: info.server,
                    procedure: info.procedure,
                    line: info.line,
                }),
                ReceivedToken::Error(error) => BatchItem::Message(ServerMessage {
                    error: true,
                    number: error.code,
                    state: error.state,
                    class: error.class,
                    message: error.message,
                    server: error.server,
                    procedure: error.procedure,
                    line: error.line,
                }),
                _ => continue,
            };
            return Poll::Ready(Some(Ok(item)));
        }
    }
}
