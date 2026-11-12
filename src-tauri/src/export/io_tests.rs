//! The writing side: atomic rename, cleanup on failure and cancel, typed I/O errors, paths.

use std::path::Path;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::encode::encoder;
use super::manager::checked_path;
use super::model::{CsvOptions, ExportFormat, JsonOptions};
use super::run::{RunOutcome, run_export};
use super::source::ExportSource;
use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::value::{ColumnMeta, Value, ValueKind};

/// `batches` batches of 500 rows; fails or waits forever once `stop_after` batches were sent.
struct Counting {
    columns: Vec<ColumnMeta>,
    batches: usize,
    sent: usize,
    stop_after: Option<(usize, bool)>,
}

impl Counting {
    fn new(batches: usize) -> Self {
        Self {
            columns: vec![ColumnMeta {
                name: "n".into(),
                type_name: String::new(),
                kind: ValueKind::Int,
            }],
            batches,
            sent: 0,
            stop_after: None,
        }
    }
}

impl ExportSource for Counting {
    fn columns(&self) -> &[ColumnMeta] {
        &self.columns
    }

    async fn next_batch(&mut self) -> Result<Option<Vec<Vec<Value>>>, YadbeError> {
        if let Some((at, fail)) = self.stop_after
            && self.sent == at
        {
            if fail {
                return Err(YadbeError::query_failed("boom"));
            }
            std::future::pending::<()>().await;
        }
        if self.sent == self.batches {
            return Ok(None);
        }
        self.sent += 1;
        Ok(Some(
            (0..500)
                .map(|i| vec![Value::int(self.sent * 500 + i)])
                .collect(),
        ))
    }
}

fn files(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .expect("read dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

async fn run_to(
    source: &mut Counting,
    target: &Path,
    cancel: &CancellationToken,
) -> Result<RunOutcome, YadbeError> {
    run_export(
        source,
        encoder(&ExportFormat::Csv {
            options: CsvOptions::default(),
        })?,
        target,
        1,
        cancel,
        Duration::from_millis(1),
        |_, _| {},
    )
    .await
}

#[tokio::test]
async fn writes_through_a_temp_file_renamed_at_the_end() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("out.csv");
    std::fs::write(&target, "old").expect("seed");
    let outcome = run_to(&mut Counting::new(3), &target, &CancellationToken::new())
        .await
        .expect("export");
    assert_eq!(outcome.rows, 1500);
    let text = std::fs::read_to_string(&target).expect("read");
    assert_eq!(text.lines().count(), 1501);
    assert_eq!(outcome.bytes, text.len() as u64);
    assert_eq!(files(dir.path()), ["out.csv"], "no temp file left");
}

#[tokio::test]
async fn a_failure_removes_the_partial_file_and_keeps_the_old_target() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("out.csv");
    std::fs::write(&target, "old").expect("seed");
    let mut source = Counting::new(10);
    source.stop_after = Some((4, true));
    let error = run_to(&mut source, &target, &CancellationToken::new())
        .await
        .expect_err("fails");
    assert_eq!(error.code, ErrorCode::QueryFailed);
    assert_eq!(std::fs::read_to_string(&target).expect("read"), "old");
    assert_eq!(files(dir.path()), ["out.csv"]);
}

#[tokio::test]
async fn cancelling_a_blocked_export_removes_the_partial_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("out.csv");
    let cancel = CancellationToken::new();
    let mut source = Counting::new(10);
    source.stop_after = Some((2, false));
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        trigger.cancel();
    });
    let error = run_to(&mut source, &target, &cancel)
        .await
        .expect_err("cancelled");
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(files(dir.path()).is_empty(), "{:?}", files(dir.path()));
}

#[tokio::test]
async fn a_missing_folder_is_a_typed_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let target = dir.path().join("gone").join("out.csv");
    let error = run_to(&mut Counting::new(1), &target, &CancellationToken::new())
        .await
        .expect_err("no folder");
    assert_eq!(error.code, ErrorCode::FileNotFound);
}

#[test]
fn io_errors_map_to_typed_codes() {
    use std::io::{Error, ErrorKind};
    let code = |kind| YadbeError::file_write_failed("/x/out.csv", &Error::from(kind)).code;
    assert_eq!(code(ErrorKind::StorageFull), ErrorCode::DiskFull);
    assert_eq!(
        code(ErrorKind::PermissionDenied),
        ErrorCode::PermissionDenied
    );
    assert_eq!(code(ErrorKind::Other), ErrorCode::Internal);
}

#[test]
fn only_absolute_paths_with_a_matching_extension_pass() {
    let csv = ExportFormat::Csv {
        options: CsvOptions::default(),
    };
    let json = ExportFormat::Json {
        options: JsonOptions::default(),
    };
    let dir = std::env::temp_dir();
    let at = |name: &str| dir.join(name).to_str().expect("utf-8").to_owned();
    assert!(checked_path(&at("a.CSV"), &csv).is_ok());
    assert!(checked_path(&at("a.ndjson"), &json).is_ok());
    for (path, format) in [
        ("a.csv".to_owned(), &csv),
        (at("a.json"), &csv),
        (at(".bashrc"), &csv),
        (at("a.csv"), &json),
    ] {
        let error = checked_path(&path, format).expect_err(&path);
        assert_eq!(error.code, ErrorCode::InvalidArgument, "{path}");
    }
}
