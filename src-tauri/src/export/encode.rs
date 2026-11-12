//! The row encoders every export format implements, and what they share.

use std::borrow::Cow;

use super::model::{BinaryEncoding, ExportFormat};
use crate::db::errors::YadbeError;
use crate::db::value::{ColumnMeta, Value};

/// Turns rows into the bytes of one file format. Pure: no I/O, so it is tested on its own.
pub trait RowEncoder: Send {
    /// Before the first row (byte order mark, header, opening bracket).
    fn begin(&mut self, columns: &[ColumnMeta], out: &mut Vec<u8>);
    fn row(&mut self, row: &[Value], out: &mut Vec<u8>);
    /// After the last row.
    fn end(&mut self, out: &mut Vec<u8>);
    /// The format cannot hold another row (an Excel worksheet has a last row): the export
    /// stops there and says so.
    fn is_full(&self) -> bool {
        false
    }
}

/// The writer of a format; `sqlOnly` when SQL statements are asked for an engine outside the
/// SQL family.
pub fn encoder(format: &ExportFormat) -> Result<Box<dyn RowEncoder>, YadbeError> {
    Ok(match format {
        ExportFormat::Csv { options } => Box::new(super::csv::CsvEncoder::new(options.clone())),
        ExportFormat::Json { options } => Box::new(super::json::JsonEncoder::new(options.clone())),
        ExportFormat::JsonLines { options } => {
            Box::new(super::lines::JsonLinesEncoder::new(options.clone()))
        }
        ExportFormat::Sql { options } => Box::new(super::sql::SqlEncoder::new(options.clone())?),
        ExportFormat::Markdown { options } => {
            Box::new(super::markdown::MarkdownEncoder::new(options.clone()))
        }
        ExportFormat::Excel { options } => Box::new(super::xlsx::XlsxEncoder::new(options.clone())),
    })
}

/// The text of a binary value (held as lowercase hexadecimal) in the chosen encoding.
pub(super) fn binary_text(hex: &str, encoding: BinaryEncoding) -> Cow<'_, str> {
    match encoding {
        BinaryEncoding::Hex => Cow::Borrowed(hex),
        BinaryEncoding::Base64 => {
            let bytes: Vec<u8> = hex
                .as_bytes()
                .chunks(2)
                .filter_map(|pair| {
                    std::str::from_utf8(pair)
                        .ok()
                        .and_then(|digits| u8::from_str_radix(digits, 16).ok())
                })
                .collect();
            Cow::Owned(base64(&bytes))
        }
    }
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_pads_like_rfc_4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(binary_text("00ff10", BinaryEncoding::Base64), "AP8Q");
        assert_eq!(binary_text("00ff10", BinaryEncoding::Hex), "00ff10");
    }
}
