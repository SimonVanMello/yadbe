use serde::Serialize;
use specta::Type;

use crate::db::errors::YadbeError;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// yadbe version, from `Cargo.toml`.
    pub app_version: String,
    /// Operating system family (`linux`, `macos`, `windows`).
    pub os: String,
    /// CPU architecture (`x86_64`, `aarch64`…).
    pub arch: String,
}

pub fn current_app_info() -> AppInfo {
    AppInfo {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
    }
}

/// Returns the app version and the platform it runs on.
#[tauri::command]
#[specta::specta]
pub async fn app_info() -> Result<AppInfo, YadbeError> {
    Ok(current_app_info())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_crate_version_and_platform() {
        let info = current_app_info();
        assert_eq!(info.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.os, std::env::consts::OS);
        assert!(!info.arch.is_empty());
    }
}
