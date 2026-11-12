//! Excel writer (`.xlsx`), streamed. A workbook is a ZIP of XML parts; the worksheet is the
//! only large one, so it is written as a deflated ZIP entry with a data descriptor while the
//! rows arrive, and the small fixed parts are stored first. Nothing is kept in memory but the
//! compressor's buffer.
//!
//! Cells: integers and decimals a spreadsheet reproduces exactly (at most 15 significant
//! digits, integers within 2^53) are numbers, the others text (nothing is rounded); dates and
//! timestamps without a zone and with at most millisecond digits are real dates; booleans are
//! booleans; everything else is text. A worksheet holds 1 048 575 rows below its header: the
//! export stops there and says so (`ExportFinished::limited`).

use std::io::Write;

use flate2::Compression;
use flate2::write::DeflateEncoder;

use super::csv::cell_text;
use super::encode::RowEncoder;
use super::json::{int_is_exact, is_json_number, significant_digits};
use super::model::ExcelOptions;
use crate::db::value::{ColumnMeta, Value, ValueKind};

/// Rows below the header an Excel worksheet holds.
pub const MAX_DATA_ROWS: u64 = 1_048_575;
/// Columns of an Excel worksheet.
pub const MAX_COLUMNS: usize = 16_384;
/// Characters of a cell.
const MAX_CELL_CHARS: usize = 32_767;
/// The ZIP entries here have 32-bit sizes: the worksheet stops well before 4 GiB.
const MAX_SHEET_BYTES: u64 = 3_500_000_000;

const STYLE_DATE: u8 = 1;
const STYLE_TIMESTAMP: u8 = 2;
const STYLE_HEADER: u8 = 3;

const XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
const NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// Column letters of a zero-based index: 0 → `A`, 26 → `AA`, 16383 → `XFD`.
fn column_name(mut index: usize) -> String {
    let mut letters = Vec::new();
    loop {
        letters.push(b'A' + u8::try_from(index % 26).unwrap_or(0));
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    letters.reverse();
    String::from_utf8(letters).unwrap_or_default()
}

fn escape_xml(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // Control characters XML 1.0 cannot carry.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            '\u{fffe}' | '\u{ffff}' => {}
            c => out.push(c),
        }
    }
}

/// A worksheet name Excel accepts: at most 31 characters, none of `[]:*?/\`, not empty.
pub fn sheet_name(requested: &str) -> String {
    let cleaned: String = requested
        .trim()
        .chars()
        .map(|c| {
            if matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\') {
                '_'
            } else {
                c
            }
        })
        .take(31)
        .collect();
    let cleaned = cleaned.trim_matches('\'').trim().to_owned();
    if cleaned.is_empty() {
        "Result".to_owned()
    } else {
        cleaned
    }
}

/// Days from 1970-01-01 to a civil date (proleptic Gregorian).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn digits(text: &str, len: usize) -> Option<i64> {
    (text.len() == len && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// The Excel serial number of `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS[.fff]` (also with `T`),
/// `None` when the text is anything else, before 1901 (Excel's calendar starts in 1900 with a
/// leap-year bug), or finer than a millisecond.
fn excel_serial(text: &str, with_time: bool) -> Option<String> {
    let (date, time) = match text.split_once([' ', 'T']) {
        Some((date, time)) if with_time => (date, Some(time)),
        None if !with_time => (text, None),
        _ => return None,
    };
    let mut parts = date.split('-');
    let year = digits(parts.next()?, 4)?;
    let month = digits(parts.next()?, 2)?;
    let day = digits(parts.next()?, 2)?;
    if parts.next().is_some() || !(1901..=9999).contains(&year) {
        return None;
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day) + 25_569;
    let Some(time) = time else {
        return Some(days.to_string());
    };
    let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
    let mut fields = clock.split(':');
    let hours = digits(fields.next()?, 2)?;
    let minutes = digits(fields.next()?, 2)?;
    let seconds = digits(fields.next()?, 2)?;
    if fields.next().is_some() || hours > 23 || minutes > 59 || seconds > 59 {
        return None;
    }
    if !fraction.bytes().all(|b| b.is_ascii_digit()) || fraction.trim_end_matches('0').len() > 3 {
        return None;
    }
    let millis: i64 = format!("{:0<3}", fraction.trim_end_matches('0'))
        .parse()
        .unwrap_or(0);
    let total = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
    #[allow(clippy::cast_precision_loss)]
    let serial = days as f64 + total as f64 / 86_400_000.0;
    Some(format!("{serial}"))
}

/// Offsets and checksums of the parts written so far, for the central directory.
struct Entry {
    name: &'static str,
    offset: u64,
    crc: u32,
    compressed: u64,
    size: u64,
    streamed: bool,
}

struct Sheet {
    encoder: DeflateEncoder<Vec<u8>>,
    crc: crc32fast::Hasher,
    size: u64,
}

pub struct XlsxEncoder {
    options: ExcelOptions,
    width: usize,
    kinds: Vec<ValueKind>,
    entries: Vec<Entry>,
    /// Bytes handed to the caller so far: the offset of the next ZIP record.
    written: u64,
    sheet: Option<Sheet>,
    sheet_offset: u64,
    rows: u64,
    /// Data rows after which the worksheet is full (`MAX_DATA_ROWS`; lower in tests).
    row_limit: u64,
}

impl XlsxEncoder {
    pub fn new(options: ExcelOptions) -> Self {
        Self {
            options,
            width: 0,
            kinds: Vec::new(),
            entries: Vec::new(),
            written: 0,
            sheet: None,
            sheet_offset: 0,
            rows: 0,
            row_limit: MAX_DATA_ROWS,
        }
    }

    #[cfg(test)]
    pub(super) fn with_row_limit(mut self, rows: u64) -> Self {
        self.row_limit = rows;
        self
    }

    fn push(&mut self, out: &mut Vec<u8>, bytes: &[u8]) {
        out.extend_from_slice(bytes);
        self.written += bytes.len() as u64;
    }

    /// A small part, stored (not compressed).
    fn stored(&mut self, out: &mut Vec<u8>, name: &'static str, content: &str) {
        let bytes = content.as_bytes();
        let mut crc = crc32fast::Hasher::new();
        crc.update(bytes);
        let crc = crc.finalize();
        let offset = self.written;
        let size = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
        let mut header = local_header(name, 0x0800, 0);
        header[14..18].copy_from_slice(&crc.to_le_bytes());
        header[18..22].copy_from_slice(&size.to_le_bytes());
        header[22..26].copy_from_slice(&size.to_le_bytes());
        self.push(out, &header);
        self.push(out, bytes);
        self.entries.push(Entry {
            name,
            offset,
            crc,
            compressed: u64::from(size),
            size: u64::from(size),
            streamed: false,
        });
    }

    /// Text for the worksheet entry: checksummed, deflated, and what the compressor has ready
    /// is handed to the caller.
    fn sheet_write(&mut self, out: &mut Vec<u8>, text: &str) {
        let Some(sheet) = self.sheet.as_mut() else {
            return;
        };
        let bytes = text.as_bytes();
        sheet.crc.update(bytes);
        sheet.size += bytes.len() as u64;
        // Writing to a `Vec` cannot fail.
        let _ = sheet.encoder.write_all(bytes);
        let ready = std::mem::take(sheet.encoder.get_mut());
        self.push(out, &ready);
    }

    fn cell(&self, row: u64, column: usize, value: &Value, out: &mut String) {
        let reference = format!("{}{}", column_name(column), row);
        let text_cell = |text: &str, style: Option<u8>, out: &mut String| {
            out.push_str("<c r=\"");
            out.push_str(&reference);
            out.push('"');
            if let Some(style) = style {
                out.push_str(&format!(" s=\"{style}\""));
            }
            out.push_str(" t=\"inlineStr\"><is><t xml:space=\"preserve\">");
            let shown: String = text.chars().take(MAX_CELL_CHARS).collect();
            escape_xml(&shown, out);
            out.push_str("</t></is></c>");
        };
        let number_cell = |number: &str, style: Option<u8>, out: &mut String| {
            out.push_str("<c r=\"");
            out.push_str(&reference);
            out.push('"');
            if let Some(style) = style {
                out.push_str(&format!(" s=\"{style}\""));
            }
            out.push_str("><v>");
            out.push_str(number);
            out.push_str("</v></c>");
        };
        match value {
            Value::Null => {}
            Value::Bool(flag) => {
                out.push_str(&format!(
                    "<c r=\"{reference}\" t=\"b\"><v>{}</v></c>",
                    u8::from(*flag)
                ));
            }
            Value::Int(n) if int_is_exact(n) => number_cell(n, None, out),
            Value::Decimal(n) | Value::Float(n)
                if is_json_number(n) && significant_digits(n) <= 15 =>
            {
                number_cell(n, None, out);
            }
            Value::Date(text) => match excel_serial(text, false) {
                Some(serial) => number_cell(&serial, Some(STYLE_DATE), out),
                None => text_cell(text, None, out),
            },
            Value::Timestamp(text) => match excel_serial(text, true) {
                Some(serial) => number_cell(&serial, Some(STYLE_TIMESTAMP), out),
                None => text_cell(text, None, out),
            },
            other => text_cell(&cell_text(other, self.options.binary), None, out),
        }
    }

    fn column_widths(&self) -> String {
        let mut cols = String::from("<cols>");
        for (index, kind) in self.kinds.iter().enumerate() {
            let width = match kind {
                ValueKind::Bool => 8,
                ValueKind::Int | ValueKind::Decimal | ValueKind::Float => 14,
                ValueKind::Date | ValueKind::Time => 12,
                ValueKind::Timestamp | ValueKind::TimestampTz | ValueKind::Uuid => 24,
                _ => 20,
            };
            let n = index + 1;
            cols.push_str(&format!(
                "<col min=\"{n}\" max=\"{n}\" width=\"{width}\" customWidth=\"1\"/>"
            ));
        }
        cols.push_str("</cols>");
        cols
    }
}

/// A local file header with the checksum and sizes left to the caller (offsets 14..26).
fn local_header(name: &str, flags: u16, method: u16) -> Vec<u8> {
    let mut header = Vec::with_capacity(30 + name.len());
    header.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
    header.extend_from_slice(&20_u16.to_le_bytes());
    header.extend_from_slice(&flags.to_le_bytes());
    header.extend_from_slice(&method.to_le_bytes());
    // 1980-01-01 00:00:00.
    header.extend_from_slice(&0_u16.to_le_bytes());
    header.extend_from_slice(&0x0021_u16.to_le_bytes());
    header.extend_from_slice(&[0; 12]);
    header.extend_from_slice(&u16::try_from(name.len()).unwrap_or(0).to_le_bytes());
    header.extend_from_slice(&0_u16.to_le_bytes());
    header.extend_from_slice(name.as_bytes());
    header
}

fn content_types() -> String {
    format!(
        "{XML}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>\
<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>\
</Types>"
    )
}

fn root_rels() -> String {
    format!(
        "{XML}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"{REL_NS}/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>"
    )
}

fn workbook(name: &str) -> String {
    let mut escaped = String::new();
    escape_xml(name, &mut escaped);
    format!(
        "{XML}<workbook xmlns=\"{NS}\" xmlns:r=\"{REL_NS}\"><sheets>\
<sheet name=\"{escaped}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"
    )
}

fn workbook_rels() -> String {
    format!(
        "{XML}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"{REL_NS}/worksheet\" Target=\"worksheets/sheet1.xml\"/>\
<Relationship Id=\"rId2\" Type=\"{REL_NS}/styles\" Target=\"styles.xml\"/></Relationships>"
    )
}

fn styles() -> String {
    format!(
        "{XML}<styleSheet xmlns=\"{NS}\">\
<numFmts count=\"2\"><numFmt numFmtId=\"164\" formatCode=\"yyyy\\-mm\\-dd\"/>\
<numFmt numFmtId=\"165\" formatCode=\"yyyy\\-mm\\-dd\\ hh:mm:ss\"/></numFmts>\
<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font>\
<font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>\
<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill>\
<fill><patternFill patternType=\"gray125\"/></fill></fills>\
<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>\
<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>\
<cellXfs count=\"4\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>\
<xf numFmtId=\"164\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>\
<xf numFmtId=\"165\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>\
<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/></cellXfs>\
<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>"
    )
}

impl RowEncoder for XlsxEncoder {
    fn begin(&mut self, columns: &[ColumnMeta], out: &mut Vec<u8>) {
        self.width = columns.len().min(MAX_COLUMNS);
        self.kinds = columns.iter().take(MAX_COLUMNS).map(|c| c.kind).collect();
        self.stored(out, "[Content_Types].xml", &content_types());
        self.stored(out, "_rels/.rels", &root_rels());
        self.stored(
            out,
            "xl/workbook.xml",
            &workbook(&sheet_name(&self.options.sheet_name)),
        );
        self.stored(out, "xl/_rels/workbook.xml.rels", &workbook_rels());
        self.stored(out, "xl/styles.xml", &styles());

        // The worksheet: flags 0x0808 (UTF-8 names, sizes after the data), method 8 (deflate).
        self.sheet_offset = self.written;
        let header = local_header("xl/worksheets/sheet1.xml", 0x0808, 8);
        self.push(out, &header);
        self.sheet = Some(Sheet {
            encoder: DeflateEncoder::new(Vec::new(), Compression::fast()),
            crc: crc32fast::Hasher::new(),
            size: 0,
        });
        let mut text = format!(
            "{XML}<worksheet xmlns=\"{NS}\"><sheetViews><sheetView workbookViewId=\"0\">\
<pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/>\
</sheetView></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/>{}<sheetData>",
            self.column_widths()
        );
        text.push_str("<row r=\"1\">");
        for (index, column) in columns.iter().take(MAX_COLUMNS).enumerate() {
            let reference = format!("{}1", column_name(index));
            text.push_str(&format!(
                "<c r=\"{reference}\" s=\"{STYLE_HEADER}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">"
            ));
            let shown: String = column.name.chars().take(MAX_CELL_CHARS).collect();
            escape_xml(&shown, &mut text);
            text.push_str("</t></is></c>");
        }
        text.push_str("</row>");
        self.sheet_write(out, &text);
    }

    fn row(&mut self, row: &[Value], out: &mut Vec<u8>) {
        if self.is_full() {
            return;
        }
        self.rows += 1;
        let number = self.rows + 1;
        let mut text = format!("<row r=\"{number}\">");
        for (column, value) in row.iter().take(self.width).enumerate() {
            self.cell(number, column, value, &mut text);
        }
        text.push_str("</row>");
        self.sheet_write(out, &text);
    }

    fn end(&mut self, out: &mut Vec<u8>) {
        let last = format!(
            "{}{}",
            column_name(self.width.saturating_sub(1)),
            self.rows + 1
        );
        let tail = format!("</sheetData><autoFilter ref=\"A1:{last}\"/></worksheet>");
        self.sheet_write(out, &tail);
        let Some(sheet) = self.sheet.take() else {
            return;
        };
        let size = sheet.size;
        let crc = sheet.crc.finalize();
        // Finishing the compressor yields its last block.
        let rest = sheet.encoder.finish().unwrap_or_default();
        self.push(out, &rest);
        let compressed =
            self.written - self.sheet_offset - local_header_len("xl/worksheets/sheet1.xml");
        // The data descriptor: checksum, then the sizes the header left out.
        let mut descriptor = Vec::with_capacity(16);
        descriptor.extend_from_slice(&0x0807_4b50_u32.to_le_bytes());
        descriptor.extend_from_slice(&crc.to_le_bytes());
        descriptor.extend_from_slice(&u32::try_from(compressed).unwrap_or(u32::MAX).to_le_bytes());
        descriptor.extend_from_slice(&u32::try_from(size).unwrap_or(u32::MAX).to_le_bytes());
        self.push(out, &descriptor);
        self.entries.push(Entry {
            name: "xl/worksheets/sheet1.xml",
            offset: self.sheet_offset,
            crc,
            compressed,
            size,
            streamed: true,
        });

        // The central directory and the end of it.
        let directory_offset = self.written;
        let mut directory = Vec::new();
        for entry in &self.entries {
            directory.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
            directory.extend_from_slice(&20_u16.to_le_bytes());
            directory.extend_from_slice(&20_u16.to_le_bytes());
            directory.extend_from_slice(
                &(if entry.streamed { 0x0808_u16 } else { 0x0800 }).to_le_bytes(),
            );
            directory.extend_from_slice(&(if entry.streamed { 8_u16 } else { 0 }).to_le_bytes());
            directory.extend_from_slice(&0_u16.to_le_bytes());
            directory.extend_from_slice(&0x0021_u16.to_le_bytes());
            directory.extend_from_slice(&entry.crc.to_le_bytes());
            directory.extend_from_slice(
                &u32::try_from(entry.compressed)
                    .unwrap_or(u32::MAX)
                    .to_le_bytes(),
            );
            directory
                .extend_from_slice(&u32::try_from(entry.size).unwrap_or(u32::MAX).to_le_bytes());
            directory
                .extend_from_slice(&u16::try_from(entry.name.len()).unwrap_or(0).to_le_bytes());
            directory.extend_from_slice(&[0; 12]);
            directory.extend_from_slice(
                &u32::try_from(entry.offset)
                    .unwrap_or(u32::MAX)
                    .to_le_bytes(),
            );
            directory.extend_from_slice(entry.name.as_bytes());
        }
        let count = u16::try_from(self.entries.len()).unwrap_or(u16::MAX);
        let directory_size = u32::try_from(directory.len()).unwrap_or(u32::MAX);
        self.push(out, &directory);
        let mut end = Vec::with_capacity(22);
        end.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
        end.extend_from_slice(&[0; 4]);
        end.extend_from_slice(&count.to_le_bytes());
        end.extend_from_slice(&count.to_le_bytes());
        end.extend_from_slice(&directory_size.to_le_bytes());
        end.extend_from_slice(
            &u32::try_from(directory_offset)
                .unwrap_or(u32::MAX)
                .to_le_bytes(),
        );
        end.extend_from_slice(&0_u16.to_le_bytes());
        self.push(out, &end);
    }

    fn is_full(&self) -> bool {
        self.rows >= self.row_limit
            || self
                .sheet
                .as_ref()
                .is_some_and(|sheet| sheet.size >= MAX_SHEET_BYTES)
    }
}

fn local_header_len(name: &str) -> u64 {
    30 + name.len() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_columns_like_a_spreadsheet() {
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_name(27), "AB");
        assert_eq!(column_name(701), "ZZ");
        assert_eq!(column_name(702), "AAA");
        assert_eq!(column_name(16_383), "XFD");
    }

    #[test]
    fn converts_dates_to_excel_serials() {
        assert_eq!(excel_serial("1970-01-01", false).as_deref(), Some("25569"));
        assert_eq!(excel_serial("2000-01-01", false).as_deref(), Some("36526"));
        assert_eq!(excel_serial("2024-02-29", false).as_deref(), Some("45351"));
        assert_eq!(
            excel_serial("2000-01-01 12:00:00", true).as_deref(),
            Some("36526.5")
        );
        assert_eq!(
            excel_serial("2000-01-01T06:00:00.000", true).as_deref(),
            Some("36526.25")
        );
        // Finer than a millisecond, before 1901, malformed or out of range: text instead.
        assert_eq!(excel_serial("2000-01-01 12:00:00.123456", true), None);
        assert_eq!(excel_serial("1899-12-31", false), None);
        assert_eq!(excel_serial("0001-12-31 BC", false), None);
        assert_eq!(excel_serial("2000-13-01", false), None);
        assert_eq!(excel_serial("2000-01-01 25:00:00", true), None);
        assert_eq!(excel_serial("2000-01-01", true), None);
    }

    #[test]
    fn worksheet_names_are_made_valid() {
        assert_eq!(sheet_name("  Result 1  "), "Result 1");
        assert_eq!(sheet_name("a/b\\c[d]e:f*g?h"), "a_b_c_d_e_f_g_h");
        assert_eq!(sheet_name(""), "Result");
        assert_eq!(sheet_name(&"x".repeat(60)).chars().count(), 31);
    }

    #[test]
    fn escapes_xml_and_drops_what_it_cannot_carry() {
        let mut out = String::new();
        escape_xml("a<b>&\"c\u{1}\u{8}\td\u{ffff}", &mut out);
        assert_eq!(out, "a&lt;b&gt;&amp;&quot;c\td");
    }
}
