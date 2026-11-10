//! Tauri command handlers. Keep them thin: validate, call a service, map errors.

pub mod app;
pub mod connections;
pub mod meta;
pub mod query;
pub mod secrets;
pub mod sessions;
pub mod store;

use crate::db::errors::YadbeError;

/// Runs blocking work (SQLite store, keychain) off the async threads.
pub(crate) async fn blocking<T, F>(work: F) -> Result<T, YadbeError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, YadbeError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| YadbeError::internal(format!("background task failed: {err}")))?
}
