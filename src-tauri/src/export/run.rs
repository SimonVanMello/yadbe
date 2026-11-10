//! The export loop: batches from an `ExportSource` through a `RowEncoder` to a temporary
//! file, renamed over the target only once everything is written.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use super::encode::RowEncoder;
use super::source::ExportSource;
use crate::db::errors::YadbeError;

/// Bytes gathered before a write to disk.
const FLUSH_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunOutcome {
    pub rows: u64,
    pub bytes: u64,
    pub truncated: bool,
}

/// A sibling of the target: same folder (so the rename stays on one volume), never a name the
/// user would pick.
fn temp_path(target: &Path, export_id: u32) -> PathBuf {
    let name = target
        .file_name()
        .map_or_else(|| "export".into(), |n| n.to_string_lossy().into_owned());
    target.with_file_name(format!(".{name}.yadbe-{export_id}.tmp"))
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

struct TempFile {
    file: Option<std::fs::File>,
    path: PathBuf,
    target: PathBuf,
}

impl TempFile {
    async fn create(path: PathBuf, target: PathBuf) -> Result<Self, YadbeError> {
        let opened = {
            let path = path.clone();
            blocking(move || {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
            })
            .await?
        };
        let file = opened.map_err(|e| YadbeError::file_write_failed(&display(&target), &e))?;
        Ok(Self {
            file: Some(file),
            path,
            target,
        })
    }

    /// Writes `buffer` and gives it back emptied.
    async fn write(&mut self, buffer: Vec<u8>) -> Result<Vec<u8>, YadbeError> {
        let Some(mut file) = self.file.take() else {
            return Err(YadbeError::internal("the export file is closed"));
        };
        let (file, buffer, written) = blocking(move || {
            let mut buffer = buffer;
            let written = file.write_all(&buffer);
            buffer.clear();
            (file, buffer, written)
        })
        .await?;
        self.file = Some(file);
        written.map_err(|e| YadbeError::file_write_failed(&display(&self.target), &e))?;
        Ok(buffer)
    }

    /// Flushes to disk and renames over the target.
    async fn commit(mut self) -> Result<(), YadbeError> {
        let file = self.file.take();
        let (path, target) = (self.path.clone(), self.target.clone());
        let done = blocking(move || {
            if let Some(file) = file {
                file.sync_all()?;
            }
            std::fs::rename(&path, &target)
        })
        .await?;
        done.map_err(|e| YadbeError::file_write_failed(&display(&self.target), &e))
    }

    async fn discard(mut self) {
        self.file = None;
        let path = self.path.clone();
        let _ = blocking(move || std::fs::remove_file(path)).await;
    }
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

/// Writes the whole source to `target`. `progress(rows, bytes)` is called at most once per
/// `interval`. On any failure or cancel the temporary file is removed and `target` is left
/// as it was.
pub async fn run_export<S: ExportSource>(
    source: &mut S,
    mut encoder: Box<dyn RowEncoder>,
    target: &Path,
    export_id: u32,
    cancel: &CancellationToken,
    interval: Duration,
    mut progress: impl FnMut(u64, u64) + Send,
) -> Result<RunOutcome, YadbeError> {
    let mut file = TempFile::create(temp_path(target, export_id), target.to_path_buf()).await?;
    let outcome = write_all(
        source,
        &mut *encoder,
        &mut file,
        cancel,
        interval,
        &mut progress,
    )
    .await;
    match outcome {
        Ok(outcome) => match file.commit().await {
            Ok(()) => Ok(outcome),
            Err(error) => Err(error),
        },
        Err(error) => {
            file.discard().await;
            Err(error)
        }
    }
}

async fn write_all<S: ExportSource>(
    source: &mut S,
    encoder: &mut dyn RowEncoder,
    file: &mut TempFile,
    cancel: &CancellationToken,
    interval: Duration,
    progress: &mut (impl FnMut(u64, u64) + Send),
) -> Result<RunOutcome, YadbeError> {
    let columns = source.columns().to_vec();
    let mut buffer = Vec::with_capacity(FLUSH_BYTES + 4096);
    encoder.begin(&columns, &mut buffer);
    let (mut rows, mut bytes) = (0_u64, 0_u64);
    let mut last_progress = Instant::now();
    loop {
        let batch = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(YadbeError::cancelled()),
            batch = source.next_batch() => batch?,
        };
        let Some(batch) = batch else { break };
        // Batches from the store are ready at once: let the other tasks run.
        tokio::task::yield_now().await;
        for row in &batch {
            encoder.row(row, &mut buffer);
            rows += 1;
        }
        if buffer.len() >= FLUSH_BYTES {
            bytes += buffer.len() as u64;
            buffer = file.write(buffer).await?;
        }
        if last_progress.elapsed() >= interval {
            progress(rows, bytes + buffer.len() as u64);
            last_progress = Instant::now();
        }
    }
    encoder.end(&mut buffer);
    bytes += buffer.len() as u64;
    file.write(buffer).await?;
    Ok(RunOutcome {
        rows,
        bytes,
        truncated: source.truncated(),
    })
}
