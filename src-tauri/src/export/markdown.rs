//! Markdown writer: a GitHub-flavoured table. Pipes are escaped, line breaks become `<br>`,
//! numeric columns are right-aligned.

use super::csv::cell_text;
use super::encode::RowEncoder;
use super::model::MarkdownOptions;
use crate::db::value::{ColumnMeta, Value, ValueKind};

pub struct MarkdownEncoder {
    options: MarkdownOptions,
}

impl MarkdownEncoder {
    pub fn new(options: MarkdownOptions) -> Self {
        Self { options }
    }

    fn eol(&self) -> &'static [u8] {
        self.options.line_ending.bytes()
    }
}

/// A cell on one line: `|` escaped, a line break as `<br>`, a backslash kept literal.
fn escape(text: &str, out: &mut Vec<u8>) {
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '|' => out.extend_from_slice(b"\\|"),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.extend_from_slice(b"<br>");
            }
            '\n' => out.extend_from_slice(b"<br>"),
            _ => {
                let mut buffer = [0_u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }
}

fn numeric(kind: ValueKind) -> bool {
    matches!(kind, ValueKind::Int | ValueKind::Decimal | ValueKind::Float)
}

impl RowEncoder for MarkdownEncoder {
    fn begin(&mut self, columns: &[ColumnMeta], out: &mut Vec<u8>) {
        out.push(b'|');
        for column in columns {
            out.push(b' ');
            escape(&column.name, out);
            out.extend_from_slice(b" |");
        }
        out.extend_from_slice(self.eol());
        out.push(b'|');
        for column in columns {
            let right = self.options.align_numbers && numeric(column.kind);
            out.extend_from_slice(if right { b" ---: |" } else { b" --- |" });
        }
        out.extend_from_slice(self.eol());
    }

    fn row(&mut self, row: &[Value], out: &mut Vec<u8>) {
        out.push(b'|');
        for value in row {
            out.push(b' ');
            if matches!(value, Value::Null) {
                escape(&self.options.null_text, out);
            } else {
                escape(&cell_text(value, self.options.binary), out);
            }
            out.extend_from_slice(b" |");
        }
        out.extend_from_slice(self.eol());
    }

    fn end(&mut self, _out: &mut Vec<u8>) {}
}
