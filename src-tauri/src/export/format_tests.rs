//! The SQL, Markdown and Excel writers (M3-12).

use std::io::Read;

use flate2::read::DeflateDecoder;

use super::encode::{RowEncoder, encoder};
use super::model::{
    BinaryEncoding, ExcelOptions, ExportFormat, LineEnding, MarkdownOptions, SqlOptions,
};
use crate::db::dialect::Engine;
use crate::db::value::{ColumnMeta, Value, ValueKind};

fn meta(name: &str, kind: ValueKind) -> ColumnMeta {
    ColumnMeta {
        name: name.into(),
        type_name: String::new(),
        kind,
    }
}

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

fn encode(format: ExportFormat, columns: &[ColumnMeta], rows: &[Vec<Value>]) -> Vec<u8> {
    let mut encoder: Box<dyn RowEncoder> = encoder(&format);
    let mut out = Vec::new();
    encoder.begin(columns, &mut out);
    for row in rows {
        encoder.row(row, &mut out);
    }
    encoder.end(&mut out);
    out
}

fn sql_options(engine: Engine) -> SqlOptions {
    SqlOptions {
        engine,
        schema: "shop".into(),
        table: "orders".into(),
        rows_per_statement: 2,
        line_ending: LineEnding::Lf,
    }
}

fn sql(options: SqlOptions, names: &[&str], rows: &[Vec<Value>]) -> String {
    let columns: Vec<_> = names.iter().map(|n| meta(n, ValueKind::Text)).collect();
    String::from_utf8(encode(ExportFormat::Sql { options }, &columns, rows)).expect("utf-8")
}

#[test]
fn sql_writes_multi_row_inserts_quoted_for_postgres() {
    let rows = [
        vec![
            Value::int(1),
            text("O'Brien"),
            Value::Decimal("12.50".into()),
        ],
        vec![Value::int(2), Value::Null, Value::Float("NaN".into())],
        vec![Value::int(3), text("a\\b\nc"), Value::Bool(true)],
    ];
    let out = sql(
        sql_options(Engine::Postgres),
        &["id", "na\"me", "total"],
        &rows,
    );
    let head = "INSERT INTO \"shop\".\"orders\" (\"id\", \"na\"\"me\", \"total\") VALUES\n";
    assert_eq!(
        out,
        format!(
            "{head}  (1, 'O''Brien', 12.50),\n  (2, NULL, 'NaN');\n{head}  (3, 'a\\b\nc', TRUE);\n"
        )
    );
}

#[test]
fn sql_follows_each_engines_quoting_and_literals() {
    let rows = [vec![
        text("it's"),
        Value::Bool(true),
        Value::bytes(&[0, 255]),
        text("a\\b"),
    ]];
    let one = |engine| {
        let mut options = sql_options(engine);
        options.rows_per_statement = 1;
        sql(options, &["a", "b", "c", "d"], &rows)
    };
    assert_eq!(
        one(Engine::Mssql),
        "INSERT INTO [shop].[orders] ([a], [b], [c], [d]) VALUES\n  (N'it''s', 1, 0x00FF, N'a\\b');\n"
    );
    assert_eq!(
        one(Engine::Mysql),
        "INSERT INTO `shop`.`orders` (`a`, `b`, `c`, `d`) VALUES\n  ('it''s', 1, X'00FF', 'a\\\\b');\n"
    );
    assert_eq!(
        one(Engine::Sqlite),
        "INSERT INTO \"shop\".\"orders\" (\"a\", \"b\", \"c\", \"d\") VALUES\n  ('it''s', 1, X'00FF', 'a\\b');\n"
    );
}

#[test]
fn sql_options_schema_line_ending_and_row_count() {
    let mut options = sql_options(Engine::Postgres);
    options.schema = String::new();
    options.rows_per_statement = 500;
    options.line_ending = LineEnding::Crlf;
    let out = sql(
        options,
        &["id"],
        &[vec![Value::int(1)], vec![Value::int(2)]],
    );
    assert_eq!(
        out,
        "INSERT INTO \"orders\" (\"id\") VALUES\r\n  (1),\r\n  (2);\r\n"
    );
    // No rows: nothing to insert.
    assert_eq!(sql(sql_options(Engine::Postgres), &["id"], &[]), "");
}

fn markdown(options: MarkdownOptions, columns: &[ColumnMeta], rows: &[Vec<Value>]) -> String {
    String::from_utf8(encode(ExportFormat::Markdown { options }, columns, rows)).expect("utf-8")
}

#[test]
fn markdown_escapes_pipes_and_breaks_lines_and_aligns_numbers() {
    let columns = [
        meta("id", ValueKind::Int),
        meta("note | text", ValueKind::Text),
    ];
    let rows = [
        vec![Value::int(1), text("a|b\nc\r\nd\\e")],
        vec![Value::int(2), Value::Null],
        vec![Value::int(3), text("")],
    ];
    assert_eq!(
        markdown(MarkdownOptions::default(), &columns, &rows),
        "| id | note \\| text |\n| ---: | --- |\n| 1 | a\\|b<br>c<br>d\\\\e |\n| 2 | NULL |\n| 3 |  |\n"
    );
    let plain = MarkdownOptions {
        null_text: String::new(),
        align_numbers: false,
        line_ending: LineEnding::Crlf,
        ..MarkdownOptions::default()
    };
    assert_eq!(
        markdown(plain, &columns, &rows[1..2]),
        "| id | note \\| text |\r\n| --- | --- |\r\n| 2 |  |\r\n"
    );
}

// ---------------------------------------------------------------------------------------------
// Excel: the workbook is read back through its ZIP structure.

/// The parts of a ZIP file, checked against their sizes and checksums: `(name, bytes)`.
pub(super) fn unzip(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let u16_at = |at: usize| usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    let u32_at =
        |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    // End of central directory: the last 22 bytes (no comment).
    let end = bytes.len() - 22;
    assert_eq!(u32_at(end), 0x0605_4b50, "end of central directory");
    let count = u16_at(end + 10);
    let mut at = u32_at(end + 16) as usize;
    let mut parts = Vec::new();
    for _ in 0..count {
        assert_eq!(u32_at(at), 0x0201_4b50, "central directory entry");
        let method = u16_at(at + 10);
        let crc = u32_at(at + 16);
        let compressed = u32_at(at + 20) as usize;
        let size = u32_at(at + 24) as usize;
        let name_len = u16_at(at + 28);
        let extra_len = u16_at(at + 30);
        let comment_len = u16_at(at + 32);
        let local = u32_at(at + 42) as usize;
        let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).expect("name");
        assert_eq!(u32_at(local), 0x0403_4b50, "local header of {name}");
        let data = local + 30 + u16_at(local + 26) + u16_at(local + 28);
        let stored = &bytes[data..data + compressed];
        let content = match method {
            0 => stored.to_vec(),
            8 => {
                let mut inflated = Vec::new();
                DeflateDecoder::new(stored)
                    .read_to_end(&mut inflated)
                    .expect("inflate");
                inflated
            }
            other => panic!("method {other}"),
        };
        assert_eq!(content.len(), size, "size of {name}");
        let mut hasher = crc32fast::Hasher::new();
        hasher.update(&content);
        assert_eq!(hasher.finalize(), crc, "checksum of {name}");
        parts.push((name, content));
        at += 46 + name_len + extra_len + comment_len;
    }
    parts
}

fn excel(options: ExcelOptions, columns: &[ColumnMeta], rows: &[Vec<Value>]) -> Vec<u8> {
    encode(ExportFormat::Excel { options }, columns, rows)
}

fn part(parts: &[(String, Vec<u8>)], name: &str) -> String {
    let (_, bytes) = parts
        .iter()
        .find(|(candidate, _)| candidate == name)
        .unwrap_or_else(|| panic!("no part {name}"));
    String::from_utf8(bytes.clone()).expect("utf-8")
}

#[test]
fn excel_writes_a_workbook_with_typed_cells() {
    let columns = [
        meta("id", ValueKind::Int),
        meta("na<me>", ValueKind::Text),
        meta("total", ValueKind::Decimal),
        meta("paid", ValueKind::Bool),
        meta("day", ValueKind::Date),
        meta("at", ValueKind::Timestamp),
        meta("blob", ValueKind::Bytes),
    ];
    let rows = [
        vec![
            Value::int(1),
            text("a & b\n\u{1}x"),
            Value::Decimal("12.50".into()),
            Value::Bool(true),
            Value::Date("2024-02-29".into()),
            Value::Timestamp("2000-01-01 12:00:00".into()),
            Value::bytes(&[0, 255]),
        ],
        vec![
            // Past 2^53 and past 15 digits: text, so nothing is rounded.
            Value::Int("9223372036854775807".into()),
            Value::Null,
            Value::Decimal("123456789012345678.25".into()),
            Value::Bool(false),
            Value::Date("0001-12-31 BC".into()),
            Value::Timestamp("2000-01-01 12:00:00.123456".into()),
            Value::Null,
        ],
    ];
    let bytes = excel(ExcelOptions::default(), &columns, &rows);
    let parts = unzip(&bytes);
    let names: Vec<_> = parts.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "[Content_Types].xml",
            "_rels/.rels",
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/styles.xml",
            "xl/worksheets/sheet1.xml"
        ]
    );
    assert!(part(&parts, "xl/workbook.xml").contains("<sheet name=\"Result\" sheetId=\"1\""));
    let sheet = part(&parts, "xl/worksheets/sheet1.xml");
    // Header: bold inline strings, names escaped.
    assert!(sheet.contains("<c r=\"B1\" s=\"3\" t=\"inlineStr\"><is><t xml:space=\"preserve\">na&lt;me&gt;</t></is></c>"));
    // Row 2: a number, escaped text (control character dropped), a decimal, a boolean, a date
    // and a timestamp as serial numbers with their styles, a hex blob.
    assert!(sheet.contains("<c r=\"A2\"><v>1</v></c>"), "{sheet}");
    assert!(sheet.contains("<t xml:space=\"preserve\">a &amp; b\nx</t>"));
    assert!(sheet.contains("<c r=\"C2\"><v>12.50</v></c>"));
    assert!(sheet.contains("<c r=\"D2\" t=\"b\"><v>1</v></c>"));
    assert!(sheet.contains("<c r=\"E2\" s=\"1\"><v>45351</v></c>"));
    assert!(sheet.contains("<c r=\"F2\" s=\"2\"><v>36526.5</v></c>"));
    assert!(sheet.contains("<t xml:space=\"preserve\">00ff</t>"));
    // Row 3: exact text for what a spreadsheet would round, NULL leaves the cell out.
    assert!(sheet.contains(
        "<c r=\"A3\" t=\"inlineStr\"><is><t xml:space=\"preserve\">9223372036854775807</t>"
    ));
    assert!(sheet.contains("<t xml:space=\"preserve\">123456789012345678.25</t>"));
    assert!(!sheet.contains("r=\"B3\""));
    assert!(sheet.contains("<t xml:space=\"preserve\">0001-12-31 BC</t>"));
    assert!(sheet.contains("<t xml:space=\"preserve\">2000-01-01 12:00:00.123456</t>"));
    assert!(!sheet.contains("r=\"G3\""));
    assert!(sheet.contains("<autoFilter ref=\"A1:G3\"/></worksheet>"));
}

#[test]
fn excel_names_the_sheet_and_encodes_binary_as_asked() {
    let options = ExcelOptions {
        sheet_name: "Q1 [draft]".into(),
        binary: BinaryEncoding::Base64,
    };
    let bytes = excel(
        options,
        &[meta("b", ValueKind::Bytes)],
        &[vec![Value::bytes(&[0, 255, 16])]],
    );
    let parts = unzip(&bytes);
    assert!(part(&parts, "xl/workbook.xml").contains("name=\"Q1 _draft_\""));
    assert!(part(&parts, "xl/worksheets/sheet1.xml").contains(">AP8Q</t>"));
}

#[test]
fn excel_with_no_rows_is_still_a_valid_workbook() {
    let bytes = excel(ExcelOptions::default(), &[meta("a", ValueKind::Int)], &[]);
    let parts = unzip(&bytes);
    let sheet = part(&parts, "xl/worksheets/sheet1.xml");
    assert!(sheet.contains("<row r=\"1\">"));
    assert!(sheet.contains("<autoFilter ref=\"A1:A1\"/>"));
}

#[test]
fn excel_of_many_rows_is_a_valid_zip_with_every_row() {
    let columns = [meta("n", ValueKind::Int), meta("s", ValueKind::Text)];
    let rows: Vec<Vec<Value>> = (0..20_000_i64)
        .map(|n| vec![Value::int(n), text(&format!("row {n} é"))])
        .collect();
    let bytes = excel(ExcelOptions::default(), &columns, &rows);
    let sheet = part(&unzip(&bytes), "xl/worksheets/sheet1.xml");
    assert_eq!(sheet.matches("<row ").count(), 20_001);
    assert!(sheet.contains("<c r=\"A20001\"><v>19999</v></c>"));
    assert!(sheet.contains("row 19999 é"));
    // Compressed: the repeated markup shrinks a lot.
    assert!(
        bytes.len() * 4 < sheet.len(),
        "{} vs {}",
        bytes.len(),
        sheet.len()
    );
}

#[test]
fn excel_stops_at_the_worksheet_limit_and_the_file_stays_valid() {
    assert_eq!(super::xlsx::MAX_DATA_ROWS, 1_048_575);
    let mut encoder = super::xlsx::XlsxEncoder::new(ExcelOptions::default()).with_row_limit(100);
    let mut out = Vec::new();
    encoder.begin(&[meta("n", ValueKind::Int)], &mut out);
    let mut written = 0;
    while !encoder.is_full() {
        encoder.row(&[Value::int(written)], &mut out);
        written += 1;
    }
    encoder.end(&mut out);
    assert_eq!(written, 100);
    let sheet = part(&unzip(&out), "xl/worksheets/sheet1.xml");
    assert_eq!(sheet.matches("<row ").count(), 101);
    assert!(sheet.contains("<autoFilter ref=\"A1:A101\"/>"));
}
