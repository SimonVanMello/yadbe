//! Reading and writing the SQL script files of the editor (F-045).
//!
//! The paths come from the native open / save dialogs (SPEC §9: file access only through
//! explicit dialogs). The dialogs let the user type any name, so the backend does not trust the
//! webview with arbitrary file access either: only script-like extensions are served, and reads
//! are bounded.

use std::io::ErrorKind;
use std::path::Path;

use super::blocking;
use crate::db::errors::{ErrorCode, YadbeError};

/// Extensions the editor opens and saves.
const SCRIPT_EXTENSIONS: &[&str] = &["sql", "ddl", "dml", "psql", "pgsql", "tsql", "txt"];

/// Largest script read into an editor tab (a tab saved with the session holds at most 8 MiB).
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;

fn checked_path(path: &str) -> Result<&Path, YadbeError> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err(YadbeError::invalid_argument(
            "The file path must be absolute.",
            "Le chemin du fichier doit être absolu.",
        ));
    }
    let allowed = candidate
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            SCRIPT_EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(ext))
        });
    if !allowed {
        return Err(YadbeError::invalid_argument(
            format!(
                "Only script files can be opened or saved here ({}).",
                SCRIPT_EXTENSIONS.join(", ")
            ),
            format!(
                "Seuls les fichiers de script peuvent être ouverts ou enregistrés ici ({}).",
                SCRIPT_EXTENSIONS.join(", ")
            ),
        ));
    }
    Ok(candidate)
}

fn io_failure(path: &str, writing: bool, error: &std::io::Error) -> YadbeError {
    if !writing && error.kind() == ErrorKind::NotFound {
        return YadbeError::file_not_found(path);
    }
    let (en, fr) = if writing {
        (
            format!("The file \"{path}\" could not be written."),
            format!("Le fichier « {path} » n'a pas pu être écrit."),
        )
    } else {
        (
            format!("The file \"{path}\" could not be read."),
            format!("Le fichier « {path} » n'a pas pu être lu."),
        )
    };
    YadbeError::new(ErrorCode::Internal, en, fr).with_detail(error.to_string())
}

fn read_script(path: &str) -> Result<String, YadbeError> {
    let file = checked_path(path)?;
    let size = std::fs::metadata(file)
        .map_err(|error| io_failure(path, false, &error))?
        .len();
    if size > MAX_READ_BYTES {
        return Err(YadbeError::invalid_argument(
            "This file is larger than 16 MiB: it is too big for the editor.",
            "Ce fichier dépasse 16 Mio : il est trop gros pour l'éditeur.",
        ));
    }
    let bytes = std::fs::read(file).map_err(|error| io_failure(path, false, &error))?;
    let text = String::from_utf8(bytes).map_err(|_| {
        YadbeError::invalid_argument(
            "This file is not UTF-8 text.",
            "Ce fichier n'est pas du texte UTF-8.",
        )
    })?;
    // Windows editors often write a byte order mark: it is not part of the script.
    if let Some(rest) = text.strip_prefix('\u{feff}') {
        return Ok(rest.to_owned());
    }
    Ok(text)
}

fn write_script(path: &str, text: &str) -> Result<(), YadbeError> {
    let file = checked_path(path)?;
    std::fs::write(file, text).map_err(|error| io_failure(path, true, &error))
}

/// Reads a script file as UTF-8 text (a byte order mark is dropped).
#[tauri::command]
#[specta::specta]
pub async fn read_text_file(path: String) -> Result<String, YadbeError> {
    blocking(move || read_script(&path)).await
}

/// Writes `text` to a script file, replacing its content.
#[tauri::command]
#[specta::specta]
pub async fn write_text_file(path: String, text: String) -> Result<(), YadbeError> {
    blocking(move || write_script(&path, &text)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("yadbe-files-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create the temp folder");
        dir
    }

    #[test]
    fn writes_then_reads_back_a_script() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("report.sql");
        let path = path.to_str().expect("utf-8 path");
        write_script(path, "select 'é';\n").expect("write");
        assert_eq!(read_script(path).expect("read"), "select 'é';\n");
        std::fs::remove_dir_all(dir).expect("clean up");
    }

    #[test]
    fn drops_a_byte_order_mark() {
        let dir = temp_dir("bom");
        let path = dir.join("bom.sql");
        std::fs::write(&path, "\u{feff}select 1;").expect("write");
        let text = read_script(path.to_str().expect("utf-8 path")).expect("read");
        assert_eq!(text, "select 1;");
        std::fs::remove_dir_all(dir).expect("clean up");
    }

    #[test]
    fn a_missing_file_is_a_typed_not_found() {
        let dir = temp_dir("missing");
        let path = dir.join("gone.sql");
        let error = read_script(path.to_str().expect("utf-8 path")).expect_err("missing");
        assert_eq!(error.code, ErrorCode::FileNotFound);
        std::fs::remove_dir_all(dir).expect("clean up");
    }

    #[test]
    fn refuses_relative_paths_and_other_file_types() {
        assert_eq!(
            read_script("notes.sql").expect_err("relative").code,
            ErrorCode::InvalidArgument
        );
        let dir = temp_dir("types");
        let secret = dir.join("id_rsa");
        std::fs::write(&secret, "key").expect("write");
        let error = read_script(secret.to_str().expect("utf-8 path")).expect_err("extension");
        assert_eq!(error.code, ErrorCode::InvalidArgument);
        let error = write_script(secret.to_str().expect("utf-8 path"), "x").expect_err("extension");
        assert_eq!(error.code, ErrorCode::InvalidArgument);
        std::fs::remove_dir_all(dir).expect("clean up");
    }

    #[test]
    fn refuses_text_that_is_not_utf8() {
        let dir = temp_dir("binary");
        let path = dir.join("latin1.sql");
        std::fs::write(&path, [0x73, 0xe9, 0x6c]).expect("write");
        let error = read_script(path.to_str().expect("utf-8 path")).expect_err("not utf-8");
        assert_eq!(error.code, ErrorCode::InvalidArgument);
        std::fs::remove_dir_all(dir).expect("clean up");
    }
}
