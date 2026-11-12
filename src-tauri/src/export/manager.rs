//! `ExportManager`: starts exports as background jobs, reports their progress with
//! `export-progress` / `export-finished` and cancels them.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::encode::{RowEncoder, encoder};
use super::model::{
    CsvDelimiter, CsvOptions, ExportFinished, ExportFormat, ExportProgress, ExportRequest,
    ExportSourceSpec, ExportStarted, ExportStatus,
};
use super::run::run_export;
use super::source::{ExportSource, QueryResultSource};
use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::value::ColumnMeta;
use crate::events::{BackendEvent, EventSink};
use crate::session::QueryRunner;
use crate::session::table_data::TableDataService;

/// Extensions each format may be saved as.
const CSV_EXTENSIONS: &[&str] = &["csv", "tsv", "txt"];
const JSON_EXTENSIONS: &[&str] = &["json", "ndjson", "jsonl", "txt"];
const SQL_EXTENSIONS: &[&str] = &["sql", "txt"];
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "txt"];
const EXCEL_EXTENSIONS: &[&str] = &["xlsx"];

/// Longest preview a caller can ask for.
const MAX_PREVIEW_ROWS: u32 = 100;

fn to_u32(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// The path comes from the native save dialog, which lets the user type any name: like the
/// other file commands, only an absolute path with an extension that fits the format is
/// written (SPEC §9).
pub fn checked_path<'a>(path: &'a str, format: &ExportFormat) -> Result<&'a Path, YadbeError> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err(YadbeError::invalid_argument(
            "The file path must be absolute.",
            "Le chemin du fichier doit être absolu.",
        ));
    }
    let allowed = match format {
        ExportFormat::Csv { .. } => CSV_EXTENSIONS,
        ExportFormat::Json { .. } => JSON_EXTENSIONS,
        ExportFormat::Sql { .. } => SQL_EXTENSIONS,
        ExportFormat::Markdown { .. } => MARKDOWN_EXTENSIONS,
        ExportFormat::Excel { .. } => EXCEL_EXTENSIONS,
    };
    let fits = candidate
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| allowed.iter().any(|known| known.eq_ignore_ascii_case(ext)));
    if !fits || candidate.file_name().is_none() {
        let list = allowed.join(", ");
        return Err(YadbeError::invalid_argument(
            format!("This format can only be saved as one of these file types: {list}."),
            format!(
                "Ce format ne peut être enregistré que dans l'un de ces types de fichier : {list}."
            ),
        ));
    }
    Ok(candidate)
}

/// What a format cannot write, found before anything is created: a worksheet has 16 384
/// columns at most, a SQL script needs a table to insert into.
fn check_format(format: &ExportFormat, columns: &[ColumnMeta]) -> Result<(), YadbeError> {
    match format {
        ExportFormat::Excel { .. } if columns.len() > super::xlsx::MAX_COLUMNS => {
            Err(YadbeError::invalid_argument(
                format!(
                    "An Excel worksheet has at most {} columns.",
                    super::xlsx::MAX_COLUMNS
                ),
                format!(
                    "Une feuille Excel compte au plus {} colonnes.",
                    super::xlsx::MAX_COLUMNS
                ),
            ))
        }
        ExportFormat::Sql { options } if options.table.trim().is_empty() => {
            Err(YadbeError::invalid_argument(
                "Name the table the INSERT statements go into.",
                "Nommez la table dans laquelle vont les instructions INSERT.",
            ))
        }
        _ => Ok(()),
    }
}

pub struct ExportManager {
    runner: Arc<QueryRunner>,
    tables: Arc<TableDataService>,
    sink: Arc<dyn EventSink>,
    jobs: Mutex<HashMap<u32, CancellationToken>>,
    next_id: AtomicU32,
    progress_interval: Duration,
}

impl ExportManager {
    pub fn new(
        runner: Arc<QueryRunner>,
        tables: Arc<TableDataService>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            runner,
            tables,
            sink,
            jobs: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(0),
            progress_interval: Duration::from_millis(100),
        }
    }

    pub fn with_progress_interval(mut self, interval: Duration) -> Self {
        self.progress_interval = interval;
        self
    }

    fn jobs(&self) -> std::sync::MutexGuard<'_, HashMap<u32, CancellationToken>> {
        self.jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Starts an export and returns once its source is open (a table export opens a server
    /// connection); progress and the outcome arrive as events.
    pub async fn start(
        self: &Arc<Self>,
        request: ExportRequest,
    ) -> Result<ExportStarted, YadbeError> {
        checked_path(&request.path, &request.format)?;
        match request.source {
            ExportSourceSpec::Result { result_id, scope } => {
                let source = QueryResultSource::open(&self.runner, result_id, scope)?;
                check_format(&request.format, source.columns())?;
                let encoder = encoder(&request.format)?;
                Ok(self.spawn(source, encoder, request.path))
            }
            ExportSourceSpec::Table {
                tab_id,
                filter,
                sort,
            } => {
                let source = self.tables.export_rows(&tab_id, filter, sort).await?;
                check_format(&request.format, source.columns())?;
                let encoder = encoder(&request.format)?;
                Ok(self.spawn(source, encoder, request.path))
            }
        }
    }

    fn spawn<S: ExportSource + 'static>(
        self: &Arc<Self>,
        mut source: S,
        encoder: Box<dyn RowEncoder>,
        path: String,
    ) -> ExportStarted {
        let export_id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let cancel = CancellationToken::new();
        self.jobs().insert(export_id, cancel.clone());
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let progress_sink = Arc::clone(&manager.sink);
            let outcome = run_export(
                &mut source,
                encoder,
                Path::new(&path),
                export_id,
                &cancel,
                manager.progress_interval,
                move |rows, bytes| {
                    #[allow(clippy::cast_precision_loss)]
                    progress_sink.emit(BackendEvent::ExportProgress(ExportProgress {
                        export_id,
                        rows: to_u32(rows),
                        bytes: bytes as f64,
                    }));
                },
            )
            .await;
            // The source goes first: dropping it tells the runner nobody reads the tail.
            drop(source);
            manager.jobs().remove(&export_id);
            let finished = match outcome {
                Ok(done) => ExportFinished {
                    export_id,
                    status: ExportStatus::Done,
                    rows: to_u32(done.rows),
                    bytes: done.bytes as f64,
                    path,
                    truncated: done.truncated,
                    limited: done.limited,
                    error: None,
                },
                Err(error) => ExportFinished {
                    export_id,
                    status: if error.code == ErrorCode::Cancelled {
                        ExportStatus::Cancelled
                    } else {
                        ExportStatus::Failed
                    },
                    rows: 0,
                    bytes: 0.0,
                    path,
                    truncated: false,
                    limited: false,
                    error: (error.code != ErrorCode::Cancelled).then_some(error),
                },
            };
            manager.sink.emit(BackendEvent::ExportFinished(finished));
        });
        ExportStarted { export_id }
    }

    /// Cancels an export; its partial file is removed. Does nothing for an unknown id.
    pub fn cancel(&self, export_id: u32) {
        if let Some(token) = self.jobs().get(&export_id) {
            token.cancel();
        }
    }

    /// The first rows of an export, exactly as they will be written (byte order mark left
    /// out).
    pub async fn preview(
        &self,
        source: &ExportSourceSpec,
        format: &ExportFormat,
        limit: u32,
    ) -> Result<String, YadbeError> {
        let limit = limit.min(MAX_PREVIEW_ROWS);
        let (columns, rows) = match source {
            ExportSourceSpec::Result { result_id, scope } => {
                QueryResultSource::preview(&self.runner, *result_id, scope.clone(), limit as usize)?
            }
            ExportSourceSpec::Table {
                tab_id,
                filter,
                sort,
            } => {
                self.tables
                    .export_preview(tab_id, filter, sort, limit)
                    .await?
            }
        };
        // An Excel file is binary: its preview shows the rows as tab-separated text.
        let shown;
        let format = match format {
            ExportFormat::Excel { options } => {
                shown = ExportFormat::Csv {
                    options: CsvOptions {
                        delimiter: CsvDelimiter::Tab,
                        binary: options.binary,
                        ..CsvOptions::default()
                    },
                };
                &shown
            }
            other => other,
        };
        let mut encoder = encoder(format)?;
        let mut out = Vec::new();
        encoder.begin(&columns, &mut out);
        for row in &rows {
            encoder.row(row, &mut out);
        }
        encoder.end(&mut out);
        let text = String::from_utf8_lossy(&out);
        Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
    }
}
