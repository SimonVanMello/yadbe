//! Where an export reads its rows from.
//!
//! `ExportSource` is the seam: the writer only sees batches of rows. The query-result
//! implementation reads the `ResultStore` first, then the live tail of the statement; the
//! table implementation reads pages of a table tab's table (`TableExportRows`).

use std::future::Future;

use tokio::sync::mpsc;

use super::model::ExportScope;
use crate::db::errors::YadbeError;
use crate::db::value::{ColumnMeta, Value};
use crate::session::QueryRunner;
use crate::session::result_store::StoredResult;
use crate::session::result_tap::{ResultStream, TapEnd, TapMsg};
use crate::session::table_data::TableExportRows;

/// Rows read from the store per batch.
const STORE_BATCH: usize = 500;

pub trait ExportSource: Send {
    fn columns(&self) -> &[ColumnMeta];

    /// The next rows, `None` at the end. Cancel-safe: dropping the future loses nothing.
    fn next_batch(
        &mut self,
    ) -> impl Future<Output = Result<Option<Vec<Vec<Value>>>, YadbeError>> + Send;

    /// Some rows of the statement are missing from what this source gives.
    fn truncated(&self) -> bool {
        false
    }
}

/// A rectangle of a result, validated against its size.
struct Bounds {
    rows: std::ops::Range<usize>,
    columns: Option<Vec<usize>>,
}

fn bounds(scope: &ExportScope, loaded_rows: usize, width: usize) -> Result<Bounds, YadbeError> {
    match scope {
        ExportScope::All => Ok(Bounds {
            rows: 0..loaded_rows,
            columns: None,
        }),
        ExportScope::Range {
            row_from,
            row_to,
            columns,
        } => {
            if row_from > row_to
                || columns.is_empty()
                || columns.iter().any(|&c| c as usize >= width)
            {
                return Err(YadbeError::invalid_argument(
                    "The selection is outside the result.",
                    "La sélection est hors du résultat.",
                ));
            }
            let end = (*row_to as usize).saturating_add(1).min(loaded_rows);
            let start = (*row_from as usize).min(end);
            Ok(Bounds {
                rows: start..end,
                columns: Some(columns.iter().map(|&c| c as usize).collect()),
            })
        }
    }
}

fn project(row: Vec<Value>, columns: Option<&[usize]>) -> Vec<Value> {
    match columns {
        None => row,
        Some(indexes) => {
            let mut row: Vec<Option<Value>> = row.into_iter().map(Some).collect();
            indexes
                .iter()
                .map(|&i| row.get_mut(i).and_then(Option::take).unwrap_or(Value::Null))
                .collect()
        }
    }
}

fn projected_columns(all: &[ColumnMeta], columns: Option<&[usize]>) -> Vec<ColumnMeta> {
    match columns {
        None => all.to_vec(),
        Some(indexes) => indexes
            .iter()
            .filter_map(|&i| all.get(i).cloned())
            .collect(),
    }
}

/// The rows of a query result.
pub struct QueryResultSource {
    stored: std::sync::Arc<StoredResult>,
    columns: Vec<ColumnMeta>,
    projection: Option<Vec<usize>>,
    next: usize,
    stored_end: usize,
    /// Rows are numbered as the grid shows them (a selection, which a sort or a filter of the
    /// result changed); a whole result is exported in the order the statement returned it,
    /// without the rows an apply of an edited result deleted.
    shown: bool,
    tail: Option<mpsc::Receiver<TapMsg>>,
    truncated: bool,
}

impl QueryResultSource {
    /// `All` follows the statement to its end (the rest of a paused or streaming result is
    /// read from the server, not stored); a `Range` reads loaded rows only.
    pub fn open(
        runner: &QueryRunner,
        result_id: u32,
        scope: ExportScope,
    ) -> Result<Self, YadbeError> {
        let stream = match scope {
            ExportScope::All => runner.open_result_stream(result_id)?,
            ExportScope::Range { .. } => {
                let stored = runner.store().get(result_id)?;
                let stored_rows = stored.display_row_count();
                ResultStream {
                    stored,
                    stored_rows,
                    tail: None,
                    truncated: false,
                }
            }
        };
        Self::from_stream(stream, scope)
    }

    fn from_stream(stream: ResultStream, scope: ExportScope) -> Result<Self, YadbeError> {
        let all = stream.stored.columns();
        let found = bounds(&scope, stream.stored_rows, all.len())?;
        Ok(Self {
            columns: projected_columns(all, found.columns.as_deref()),
            projection: found.columns,
            next: found.rows.start,
            stored_end: found.rows.end,
            shown: matches!(scope, ExportScope::Range { .. }),
            stored: stream.stored,
            tail: stream.tail,
            truncated: stream.truncated,
        })
    }

    /// The first `limit` rows of what an export of `scope` writes, for the preview.
    pub fn preview(
        runner: &QueryRunner,
        result_id: u32,
        scope: ExportScope,
        limit: usize,
    ) -> Result<(Vec<ColumnMeta>, Vec<Vec<Value>>), YadbeError> {
        let stored = runner.store().get(result_id)?;
        let shown = matches!(scope, ExportScope::Range { .. });
        let loaded = if shown {
            stored.display_row_count()
        } else {
            stored.row_count()
        };
        let found = bounds(&scope, loaded, stored.columns().len())?;
        let count = limit.min(found.rows.len());
        let rows = if shown {
            stored.display_rows(found.rows.start, count)
        } else {
            stored.kept_rows(found.rows.start, count)
        }
        .into_iter()
        .map(|row| project(row, found.columns.as_deref()))
        .collect();
        Ok((
            projected_columns(stored.columns(), found.columns.as_deref()),
            rows,
        ))
    }
}

impl ExportSource for QueryResultSource {
    fn columns(&self) -> &[ColumnMeta] {
        &self.columns
    }

    async fn next_batch(&mut self) -> Result<Option<Vec<Vec<Value>>>, YadbeError> {
        if self.next < self.stored_end {
            let count = STORE_BATCH.min(self.stored_end - self.next);
            let rows = if self.shown {
                self.stored.display_rows(self.next, count)
            } else {
                self.stored.kept_rows(self.next, count)
            };
            self.next += count;
            let columns = self.projection.as_deref();
            return Ok(Some(
                rows.into_iter().map(|row| project(row, columns)).collect(),
            ));
        }
        let Some(tail) = self.tail.as_mut() else {
            return Ok(None);
        };
        match tail.recv().await {
            Some(TapMsg::Rows(rows)) => {
                let columns = self.projection.as_deref();
                Ok(Some(
                    rows.into_iter().map(|row| project(row, columns)).collect(),
                ))
            }
            Some(TapMsg::End(TapEnd::Complete)) => {
                self.tail = None;
                Ok(None)
            }
            Some(TapMsg::End(TapEnd::Cancelled)) => Err(YadbeError::cancelled()),
            Some(TapMsg::End(TapEnd::Failed)) => Err(YadbeError::query_failed(
                "The statement failed while its rows were being exported.",
            )),
            None => Err(YadbeError::internal(
                "the result stream closed unexpectedly",
            )),
        }
    }

    fn truncated(&self) -> bool {
        self.truncated
    }
}

impl ExportSource for TableExportRows {
    fn columns(&self) -> &[ColumnMeta] {
        TableExportRows::columns(self)
    }

    async fn next_batch(&mut self) -> Result<Option<Vec<Vec<Value>>>, YadbeError> {
        TableExportRows::next_batch(self).await
    }
}
