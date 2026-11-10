//! Saving a cell's value to a file (F-064, the grid's cell viewer).
//!
//! The path comes from the native save dialog (SPEC §9: file access only through explicit
//! dialogs). As for scripts (`files.rs`), the backend does not trust the webview with arbitrary
//! writes: the path must be absolute and end with one of the data extensions the viewer offers.

use serde::Deserialize;
use specta::Type;

use super::blocking;
use crate::db::errors::{ErrorCode, YadbeError};

/// Extensions a value can be saved as: what the viewer proposes, plus common binary formats a
/// `bytea` / `varbinary` often holds.
const DATA_EXTENSIONS: &[&str] = &[
    "txt", "json", "xml", "bin", "dat", "csv", "tsv", "sql", "html", "svg", "png", "jpg", "jpeg",
    "gif", "webp", "pdf", "zip", "gz",
];

/// How the `contents` string of `write_value_file` becomes bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ValueFileEncoding {
    /// Written as UTF-8 text.
    Utf8,
    /// Hexadecimal digits (the grid's form of binary values), written as the bytes they spell.
    Hex,
}

fn checked_path(path: &str) -> Result<&std::path::Path, YadbeError> {
    let candidate = std::path::Path::new(path);
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
            DATA_EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(ext))
        });
    if !allowed {
        return Err(YadbeError::invalid_argument(
            format!(
                "A value can only be saved as one of these file types: {}.",
                DATA_EXTENSIONS.join(", ")
            ),
            format!(
                "Une valeur ne peut être enregistrée que dans l'un de ces types de fichier : {}.",
                DATA_EXTENSIONS.join(", ")
            ),
        ));
    }
    Ok(candidate)
}

fn decode_hex(hex: &str) -> Result<Vec<u8>, YadbeError> {
    let invalid = || {
        YadbeError::invalid_argument(
            "The binary value is not valid hexadecimal.",
            "La valeur binaire n'est pas un hexadécimal valide.",
        )
    };
    if !hex.len().is_multiple_of(2) {
        return Err(invalid());
    }
    hex.as_bytes()
        .chunks(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|digits| u8::from_str_radix(digits, 16).ok())
                .ok_or_else(invalid)
        })
        .collect()
}

fn write_value(path: &str, contents: &str, encoding: ValueFileEncoding) -> Result<(), YadbeError> {
    let file = checked_path(path)?;
    let bytes = match encoding {
        ValueFileEncoding::Utf8 => contents.as_bytes().to_vec(),
        ValueFileEncoding::Hex => decode_hex(contents)?,
    };
    std::fs::write(file, bytes).map_err(|error| {
        YadbeError::new(
            ErrorCode::Internal,
            format!("The file \"{path}\" could not be written."),
            format!("Le fichier « {path} » n'a pas pu être écrit."),
        )
        .with_detail(error.to_string())
    })
}

/// Writes a value shown in the cell viewer to a file picked in the save dialog, replacing it.
#[tauri::command]
#[specta::specta]
pub async fn write_value_file(
    path: String,
    contents: String,
    encoding: ValueFileEncoding,
) -> Result<(), YadbeError> {
    blocking(move || write_value(&path, &contents, encoding)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("yadbe-value-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create the temp folder");
        dir
    }

    #[test]
    fn writes_text_and_binary_values() {
        let dir = temp_dir("write");
        let text = dir.join("payload.json");
        write_value(
            text.to_str().expect("utf-8 path"),
            "{\"a\": 1, \"é\": true}",
            ValueFileEncoding::Utf8,
        )
        .expect("write text");
        assert_eq!(
            std::fs::read_to_string(&text).expect("read"),
            "{\"a\": 1, \"é\": true}"
        );
        let blob = dir.join("blob.BIN");
        write_value(
            blob.to_str().expect("utf-8 path"),
            "00ff10cafe",
            ValueFileEncoding::Hex,
        )
        .expect("write bytes");
        assert_eq!(
            std::fs::read(&blob).expect("read"),
            vec![0x00, 0xff, 0x10, 0xca, 0xfe]
        );
        std::fs::remove_dir_all(dir).expect("clean up");
    }

    #[test]
    fn refuses_bad_hex_relative_paths_and_other_file_types() {
        let dir = temp_dir("refuse");
        let blob = dir.join("blob.bin");
        let blob = blob.to_str().expect("utf-8 path");
        for bad in ["abc", "zz", "0g"] {
            let error = write_value(blob, bad, ValueFileEncoding::Hex).expect_err(bad);
            assert_eq!(error.code, ErrorCode::InvalidArgument);
        }
        let error =
            write_value("value.txt", "x", ValueFileEncoding::Utf8).expect_err("relative path");
        assert_eq!(error.code, ErrorCode::InvalidArgument);
        let profile = dir.join(".bashrc");
        let error = write_value(
            profile.to_str().expect("utf-8 path"),
            "x",
            ValueFileEncoding::Utf8,
        )
        .expect_err("extension");
        assert_eq!(error.code, ErrorCode::InvalidArgument);
        assert!(!profile.exists());
        std::fs::remove_dir_all(dir).expect("clean up");
    }
}
