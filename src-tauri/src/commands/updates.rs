use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use super::blocking;
use crate::db::errors::YadbeError;
use crate::events::UpdateProgress;
use crate::updates::{self, PackageUpgrade, UpdateInfo, UpdateStatus};

fn emit_progress(app: &AppHandle, percent: Option<u8>) {
    if let Err(err) = (UpdateProgress { percent }).emit(app) {
        tracing::warn!(error = %err, "failed to emit update progress");
    }
}

/// Whether this build can update itself and how it was installed. No network call.
#[tauri::command]
#[specta::specta]
pub async fn update_status(app: AppHandle) -> Result<UpdateStatus, YadbeError> {
    Ok(updates::status(&app))
}

/// Newer published version, `None` when this one is the newest. The `checkUpdates` preference
/// is the frontend's to honor: a check asked from the palette runs whatever it says. Refused
/// (`updatesNotConfigured`, no request) by a build without the updater public key.
#[tauri::command]
#[specta::specta]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, YadbeError> {
    updates::check(&app).await
}

/// Downloads, verifies and installs the newest version, then restarts the app (returns on
/// failure, and on macOS while the app exits). Progress comes as `update-progress` events.
#[tauri::command]
#[specta::specta]
pub async fn install_update(app: AppHandle) -> Result<(), YadbeError> {
    let emitter = app.clone();
    updates::install(&app, move |percent| emit_progress(&emitter, percent)).await
}

/// Gets the upgrade of a copy owned by a Linux package manager ready: downloads and checks the
/// new `.deb` / `.rpm` (progress as `update-progress` events), then returns the command the user
/// runs in a terminal. The command is chosen here, never by the frontend, and never run here.
#[tauri::command]
#[specta::specta]
pub async fn prepare_package_upgrade(app: AppHandle) -> Result<PackageUpgrade, YadbeError> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| YadbeError::internal(format!("cache folder: {err}")))?;
    let emitter = app.clone();
    updates::prepare_package_upgrade(&app, &cache_dir, move |percent| {
        emit_progress(&emitter, percent)
    })
    .await
}

/// Opens the page of the newest release, for the installs that are upgraded by hand.
#[tauri::command]
#[specta::specta]
pub async fn open_release_page() -> Result<(), YadbeError> {
    blocking(updates::open_release_page).await
}

/// Restarts the app, on the version a package manager just installed.
#[tauri::command]
#[specta::specta]
pub fn restart_app(app: AppHandle) {
    tracing::info!("restarting after an upgrade");
    updates::restart(&app);
}
