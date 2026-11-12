//! SQL writer: `INSERT` statements for the rows, quoted and written for an engine's dialect
//! (F-066). Identifiers go through `Dialect::quote_identifier` and values through the same
//! literal writer the edit preview uses, so a script reads back the values it was written from.

use super::encode::RowEncoder;
use super::model::SqlOptions;
use crate::db::dialect::Dialect;
use crate::db::errors::YadbeError;
use crate::db::value::{ColumnMeta, Value};

pub struct SqlEncoder {
    options: SqlOptions,
    dialect: &'static dyn Dialect,
    /// `INSERT INTO "t" ("a", "b") VALUES`, built from the columns.
    head: String,
    /// Rows written in the statement being built.
    in_statement: u32,
    eol: &'static str,
}

impl SqlEncoder {
    pub fn new(options: SqlOptions) -> Result<Self, YadbeError> {
        let dialect = options
            .engine
            .sql_dialect()
            .ok_or_else(YadbeError::sql_only)?;
        let eol = match options.line_ending.bytes() {
            b"\r\n" => "\r\n",
            _ => "\n",
        };
        Ok(Self {
            options,
            dialect,
            head: String::new(),
            in_statement: 0,
            eol,
        })
    }

    fn target(&self) -> String {
        let quote = |name: &str| self.dialect.quote_identifier(name);
        let table = self.options.table.trim();
        let table = if table.is_empty() { "table" } else { table };
        let schema = self.options.schema.trim();
        if schema.is_empty() {
            quote(table)
        } else {
            format!("{}.{}", quote(schema), quote(table))
        }
    }

    fn rows_per_statement(&self) -> u32 {
        self.options
            .rows_per_statement
            .clamp(1, SqlOptions::MAX_ROWS_PER_STATEMENT)
    }
}

impl RowEncoder for SqlEncoder {
    fn begin(&mut self, columns: &[ColumnMeta], _out: &mut Vec<u8>) {
        let names: Vec<String> = columns
            .iter()
            .map(|column| self.dialect.quote_identifier(&column.name))
            .collect();
        self.head = format!(
            "INSERT INTO {} ({}) VALUES",
            self.target(),
            names.join(", ")
        );
    }

    fn row(&mut self, row: &[Value], out: &mut Vec<u8>) {
        let mut text = String::new();
        if self.in_statement == 0 {
            text.push_str(&self.head);
        } else {
            text.push(',');
        }
        text.push_str(self.eol);
        text.push_str("  (");
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                text.push_str(", ");
            }
            text.push_str(&self.dialect.literal(value));
        }
        text.push(')');
        self.in_statement += 1;
        if self.in_statement >= self.rows_per_statement() {
            text.push(';');
            text.push_str(self.eol);
            self.in_statement = 0;
        }
        out.extend_from_slice(text.as_bytes());
    }

    fn end(&mut self, out: &mut Vec<u8>) {
        if self.in_statement > 0 {
            out.push(b';');
            out.extend_from_slice(self.eol.as_bytes());
            self.in_statement = 0;
        }
    }
}
