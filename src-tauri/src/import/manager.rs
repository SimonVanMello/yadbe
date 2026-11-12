//! `ImportManager`: previews files, checks a mapping, and runs imports as cancellable
//! background jobs on a connection of their own (like a table tab), with `import-progress` /
//! `import-finished` events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use super::model::{
    ImportAnalysis, ImportCommit, ImportFinished, ImportParseOptions, ImportPreview,
    ImportProgress, ImportRequest, ImportStarted, ImportStatus, ImportTarget,
};
use super::parse;
use super::plan::{self, ImportPlan};
use super::rejects::RejectsFile;
use super::run::{Job, Outcome, Progress, run_import};
use crate::db::dialect::Dialect;
use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::meta::{ObjectRef, TableDetails};
use crate::events::{BackendEvent, EventSink, TableDataChanged};
use crate::session::ConnectionManager;
use crate::session::meta_cache::MetaService;

/// Extensions an import file may have.
const IMPORT_EXTENSIONS: &[&str] = &["csv", "tsv", "txt", "json", "jsonl", "ndjson"];
const REJECTS_EXTENSIONS: &[&str] = &["csv", "txt"];

fn to_u32(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn checked(path: &str, allowed: &[&str], what: &str) -> Result<PathBuf, YadbeError> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err(YadbeError::invalid_argument(
            "The file path must be absolute.",
            "Le chemin du fichier doit être absolu.",
        ));
    }
    let fits = candidate
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| allowed.iter().any(|known| known.eq_ignore_ascii_case(ext)))
        && candidate.file_name().is_some();
    if !fits {
        let list = allowed.join(", ");
        return Err(YadbeError::invalid_argument(
            format!("{what} must be one of these file types: {list}."),
            format!("{what} doit être de l'un de ces types de fichier : {list}."),
        ));
    }
    Ok(candidate.to_path_buf())
}

/// The path comes from the native open dialog, which lets the user type any name: only an
/// absolute path with a data-file extension is read (SPEC §9).
pub fn checked_import_path(path: &str) -> Result<PathBuf, YadbeError> {
    checked(path, IMPORT_EXTENSIONS, "An import file")
}

pub fn checked_rejects_path(path: &str) -> Result<PathBuf, YadbeError> {
    checked(path, REJECTS_EXTENSIONS, "The file of rejected rows")
}

async fn blocking<T, F>(work: F) -> Result<T, YadbeError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| YadbeError::internal(format!("background task failed: {e}")))
}

struct Resolved {
    dialect: &'static dyn Dialect,
    details: TableDetails,
    read_only: bool,
    database: Option<String>,
}

pub struct ImportManager {
    manager: Arc<ConnectionManager>,
    meta: Arc<MetaService>,
    sink: Arc<dyn EventSink>,
    jobs: Mutex<HashMap<u32, CancellationToken>>,
    next_id: AtomicU32,
    progress_interval: Duration,
}

impl ImportManager {
    pub fn new(
        manager: Arc<ConnectionManager>,
        meta: Arc<MetaService>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            manager,
            meta,
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

    async fn resolve(
        &self,
        connection_id: &str,
        table: &ObjectRef,
    ) -> Result<Resolved, YadbeError> {
        let session = self.manager.session(connection_id)?;
        session.sql()?;
        let details = self
            .meta
            .table_details(&self.manager, None, connection_id, table)
            .await?;
        let dialect = session.dialect()?;
        let database = (dialect.capabilities().multiple_databases && !table.database.is_empty())
            .then(|| table.database.clone());
        Ok(Resolved {
            dialect,
            details,
            read_only: session.read_only(),
            database,
        })
    }

    /// The first rows of a file; the options are detected when none are given.
    pub async fn preview(
        &self,
        path: &str,
        options: Option<ImportParseOptions>,
        limit: u32,
    ) -> Result<ImportPreview, YadbeError> {
        let path = checked_import_path(path)?;
        blocking(move || parse::preview(&path, options, limit)).await?
    }

    /// The columns of the table as an import sees them.
    pub async fn target(
        &self,
        connection_id: &str,
        table: &ObjectRef,
    ) -> Result<ImportTarget, YadbeError> {
        let resolved = self.resolve(connection_id, table).await?;
        Ok(plan::target(
            resolved.dialect,
            &resolved.details,
            resolved.read_only,
        ))
    }

    /// The type check of a mapping over the first rows of the file.
    pub async fn analyze(&self, request: ImportRequest) -> Result<ImportAnalysis, YadbeError> {
        let path = checked_import_path(&request.path)?;
        let resolved = self.resolve(&request.connection_id, &request.table).await?;
        blocking(move || plan::analyze(resolved.dialect, &resolved.details, &request, &path))
            .await?
    }

    /// Starts an import and returns once its connection is open; progress and the outcome
    /// arrive as events. Fails with `readOnlyViolation` on a read-only connection (nothing
    /// is opened), `invalidArgument` for a bad mapping or path.
    pub async fn start(
        self: &Arc<Self>,
        request: ImportRequest,
    ) -> Result<ImportStarted, YadbeError> {
        let path = checked_import_path(&request.path)?;
        let rejects_target = request
            .rejects_path
            .as_deref()
            .map(checked_rejects_path)
            .transpose()?;
        let resolved = self.resolve(&request.connection_id, &request.table).await?;
        if resolved.read_only {
            return Err(YadbeError::read_only_violation("INSERT"));
        }
        let opened = {
            let (path, parse_options) = (path.clone(), request.parse.clone());
            blocking(move || parse::open(&path, &parse_options)).await??
        };
        let file_columns: Vec<String> = opened.source.columns().to_vec();
        let plan: ImportPlan = plan::build(
            resolved.dialect,
            &resolved.details,
            &request,
            file_columns.len(),
        )?;
        if !plan.missing_required.is_empty() {
            let list = plan.missing_required.join(", ");
            return Err(YadbeError::invalid_argument(
                format!("These columns need a value and have no default: {list}."),
                format!(
                    "Ces colonnes exigent une valeur et n'ont pas de valeur par défaut : {list}."
                ),
            ));
        }
        let import_id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let rejects = match &rejects_target {
            Some(target) => Some(RejectsFile::create(target, import_id, &file_columns).await?),
            None => None,
        };
        let session = self.manager.session(&request.connection_id)?;
        let conn: Arc<dyn crate::db::driver::SqlConnection> = match session
            .open_dedicated_sql(resolved.database.as_deref())
            .await
        {
            Ok(conn) => conn,
            Err(error) => {
                if let Some(file) = rejects {
                    file.discard().await;
                }
                return Err(error);
            }
        };
        let cancel = CancellationToken::new();
        self.jobs().insert(import_id, cancel.clone());
        let job = Job {
            conn,
            dialect: resolved.dialect,
            plan,
            opened,
            on_error: request.on_error,
            commit: request.commit,
            dry_run: request.dry_run,
            rejects,
            path: request.path.clone(),
        };
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let started = Instant::now();
            let progress_sink = Arc::clone(&manager.sink);
            let (dry_run, commit) = (request.dry_run, request.commit);
            let total_bytes = job.opened.file_size;
            let outcome = run_import(
                job,
                &cancel,
                manager.progress_interval,
                move |p: Progress| {
                    #[allow(clippy::cast_precision_loss)]
                    progress_sink.emit(BackendEvent::ImportProgress(ImportProgress {
                        import_id,
                        rows_read: to_u32(p.rows_read),
                        inserted: to_u32(p.inserted),
                        rejected: to_u32(p.rejected),
                        bytes_read: p.bytes_read as f64,
                        total_bytes: total_bytes as f64,
                    }));
                },
            )
            .await;
            manager.jobs().remove(&import_id);
            if outcome.kept > 0 {
                manager
                    .sink
                    .emit(BackendEvent::TableDataChanged(TableDataChanged {
                        connection_id: request.connection_id.clone(),
                        table: request.table.clone(),
                        tab_id: String::new(),
                        updated: 0,
                        inserted: to_u32(outcome.kept),
                        deleted: 0,
                    }));
            }
            manager.sink.emit(BackendEvent::ImportFinished(finished(
                import_id,
                dry_run,
                commit,
                &request.rejects_path,
                started,
                outcome,
            )));
        });
        Ok(ImportStarted { import_id })
    }

    /// Cancels an import: a single-transaction import is rolled back, a per-batch one keeps
    /// the batches already committed. Does nothing for an unknown id.
    pub fn cancel(&self, import_id: u32) {
        if let Some(token) = self.jobs().get(&import_id) {
            token.cancel();
        }
    }
}

fn finished(
    import_id: u32,
    dry_run: bool,
    commit: ImportCommit,
    rejects_path: &Option<String>,
    started: Instant,
    outcome: Outcome,
) -> ImportFinished {
    let error = outcome
        .error
        .filter(|error| error.code != ErrorCode::Cancelled);
    ImportFinished {
        import_id,
        status: if error.is_some() && outcome.status == ImportStatus::Done {
            ImportStatus::Failed
        } else {
            outcome.status
        },
        dry_run,
        commit,
        rows_read: to_u32(outcome.rows_read),
        inserted: to_u32(outcome.inserted),
        kept: to_u32(outcome.kept),
        rejected: to_u32(outcome.rejected),
        batches: outcome.batches,
        duration_ms: (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0,
        reject_samples: outcome.reject_samples,
        rejects_path: rejects_path
            .clone()
            .filter(|_| outcome.status == ImportStatus::Done && error.is_none()),
        invalid_bytes: to_u32(outcome.invalid_bytes),
        dropped_keys: to_u32(outcome.dropped_keys),
        error,
    }
}
