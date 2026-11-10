//! The table-data half of a dialect (M2-1, M2-2): paging, value binding and display, how
//! inserted rows come back, what cannot be written. A supertrait of `Dialect`, kept here so
//! the engine differences of browsing and editing stay together.

use crate::db::dialect::{MssqlDialect, MysqlDialect, PostgresDialect, SqliteDialect};
use crate::db::meta::ColumnInfo;
use crate::db::value::{Value, ValueKind};
use crate::session::table_model::ColumnReadOnlyReason;

/// How a page is cut out of the ordered rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PagingSyntax {
    /// `… LIMIT n OFFSET m`
    LimitOffset,
    /// `… ORDER BY … OFFSET m ROWS FETCH NEXT n ROWS ONLY` (an `ORDER BY` is mandatory).
    OffsetFetch,
}

/// How an `INSERT` returns the row it created.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertReturning {
    /// `INSERT … RETURNING <columns>`
    Returning,
    /// `INSERT … OUTPUT INSERTED.<column>, … VALUES …`; refused by SQL Server on a table with
    /// enabled triggers, which then reads the row back like `ReadBack`.
    Output,
    /// A plain `INSERT`, then the row read back by its key in the same statement, the
    /// identity column matched with [`EditDialect::last_identity`].
    ReadBack,
}

/// Where a fast row estimate comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowEstimateSource {
    /// The engine keeps none.
    None,
    /// `EXPLAIN (FORMAT JSON)` of the filtered query: the planner's `Plan Rows`.
    ExplainJson,
    /// A catalog query returning one number, unfiltered; `{p}` stands for the bound
    /// qualified name of the table.
    Catalog(&'static str),
}

pub trait EditDialect {
    fn paging(&self) -> PagingSyntax;

    fn insert_returning(&self) -> InsertReturning;

    /// `OUTPUT` without `INTO` is refused on a table with enabled triggers.
    fn output_conflicts_with_triggers(&self) -> bool {
        false
    }

    /// The identity value the same statement just generated (`SCOPE_IDENTITY()`), to read
    /// an inserted row back.
    fn last_identity(&self) -> Option<&'static str> {
        None
    }

    /// The SQL of a bound value written into `column` or compared with it: the placeholder,
    /// or a conversion of it when the engine cannot convert the text form implicitly and
    /// exactly.
    fn bind_expression(&self, column: Option<&ColumnInfo>, placeholder: &str) -> String {
        let _ = column;
        placeholder.to_owned()
    }

    /// `Some(expression)` when a page reads the column through another expression (its text
    /// form, for types the driver cannot decode exactly).
    fn select_expression(&self, column: &ColumnInfo, quoted: &str) -> Option<String> {
        let _ = (column, quoted);
        None
    }

    /// A column as text, for the text filters (`contains`…).
    fn text_expression(&self, quoted: &str) -> String;

    /// Case-insensitive `LIKE` (`ILIKE` where `LIKE` is case-sensitive).
    fn like_operator(&self) -> &'static str {
        "LIKE"
    }

    /// `value` written as a SQL literal, for reading only (preview, statement log).
    fn literal(&self, value: &Value) -> String;

    /// A column type that cannot be written back exactly.
    fn column_read_only(&self, column: &ColumnInfo) -> Option<ColumnReadOnlyReason> {
        let _ = column;
        None
    }

    fn count_expression(&self) -> &'static str {
        "COUNT(*)"
    }

    fn row_estimate(&self) -> RowEstimateSource {
        RowEstimateSource::None
    }

    /// The labels of the enum columns of a table, as `(column, label)` rows in column then
    /// label order; `{p}` stands for the bound qualified name of the table.
    fn enum_labels_sql(&self) -> Option<&'static str> {
        None
    }

    fn commit(&self) -> &'static str {
        "COMMIT"
    }

    fn rollback(&self) -> &'static str {
        "ROLLBACK"
    }
}

/// `'text'`, quotes doubled.
fn quoted(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Digits stay bare; `NaN`, `Infinity` and anything unexpected are quoted.
fn number(text: &str) -> String {
    let plain = !text.is_empty()
        && text
            .trim_start_matches('-')
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
        && text
            .trim_start_matches('-')
            .starts_with(|c: char| c.is_ascii_digit());
    if plain { text.to_owned() } else { quoted(text) }
}

/// The text of a non-null value as bound (and shown) by the engines that take text.
pub fn plain_text(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => return None,
        Value::Bool(b) => if *b { "true" } else { "false" }.to_owned(),
        Value::Array(items) => serde_json::to_string(items).unwrap_or_default(),
        Value::Int(s)
        | Value::Decimal(s)
        | Value::Float(s)
        | Value::Text(s)
        | Value::Bytes(s)
        | Value::Date(s)
        | Value::Time(s)
        | Value::Timestamp(s)
        | Value::TimestampTz(s)
        | Value::Interval(s)
        | Value::Uuid(s)
        | Value::Json(s)
        | Value::Other(s) => s.clone(),
    })
}

/// A PostgreSQL array literal (`{1,NULL,"a b"}`) of nested values.
pub fn pg_array_literal(items: &[Value]) -> String {
    let mut out = String::from("{");
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        match item {
            Value::Null => out.push_str("NULL"),
            Value::Array(inner) => out.push_str(&pg_array_literal(inner)),
            other => {
                let text = pg_text(other).unwrap_or_default();
                out.push('"');
                for c in text.chars() {
                    if c == '"' || c == '\\' {
                        out.push('\\');
                    }
                    out.push(c);
                }
                out.push('"');
            }
        }
    }
    out.push('}');
    out
}

/// The text form PostgreSQL's input functions read for a value.
pub fn pg_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(if *b { "t" } else { "f" }.to_owned()),
        Value::Bytes(hex) => Some(format!("\\x{hex}")),
        Value::Array(items) => Some(pg_array_literal(items)),
        other => plain_text(other),
    }
}

impl EditDialect for PostgresDialect {
    fn paging(&self) -> PagingSyntax {
        PagingSyntax::LimitOffset
    }
    fn insert_returning(&self) -> InsertReturning {
        InsertReturning::Returning
    }
    fn select_expression(&self, column: &ColumnInfo, quoted: &str) -> Option<String> {
        // Extension and geometric types arrive in their binary form: their text form is
        // exact and goes back through the type's input function.
        (column.kind == ValueKind::Other).then(|| format!("CAST({quoted} AS text)"))
    }
    fn text_expression(&self, quoted: &str) -> String {
        format!("CAST({quoted} AS text)")
    }
    fn like_operator(&self) -> &'static str {
        "ILIKE"
    }
    fn literal(&self, value: &Value) -> String {
        match value {
            Value::Null => "NULL".to_owned(),
            Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_owned(),
            Value::Int(s) | Value::Decimal(s) | Value::Float(s) => number(s),
            other => quoted(&pg_text(other).unwrap_or_default()),
        }
    }
    fn row_estimate(&self) -> RowEstimateSource {
        RowEstimateSource::ExplainJson
    }
    fn enum_labels_sql(&self) -> Option<&'static str> {
        Some(
            "SELECT a.attname::text, e.enumlabel::text
FROM pg_attribute a
JOIN pg_type t ON t.oid = a.atttypid
JOIN pg_enum e ON e.enumtypid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
WHERE a.attrelid = to_regclass({p}) AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum, e.enumsortorder",
        )
    }
}

/// SQL Server system date and time types, for their exact conversion.
const MSSQL_DATE_TYPES: [&str; 6] = [
    "date",
    "time",
    "datetime",
    "datetime2",
    "smalldatetime",
    "datetimeoffset",
];

impl EditDialect for MssqlDialect {
    fn paging(&self) -> PagingSyntax {
        PagingSyntax::OffsetFetch
    }
    fn insert_returning(&self) -> InsertReturning {
        InsertReturning::Output
    }
    fn output_conflicts_with_triggers(&self) -> bool {
        true
    }
    fn last_identity(&self) -> Option<&'static str> {
        Some("SCOPE_IDENTITY()")
    }
    fn bind_expression(&self, column: Option<&ColumnInfo>, placeholder: &str) -> String {
        // Values are bound as nvarchar text; most types convert implicitly and exactly.
        let Some(column) = column else {
            return placeholder.to_owned();
        };
        let type_name = column.type_name.to_ascii_lowercase();
        let base = type_name.split('(').next().unwrap_or_default().trim();
        match column.kind {
            // Style 2: hexadecimal without `0x`.
            ValueKind::Bytes => format!("CONVERT(varbinary(max), {placeholder}, 2)"),
            ValueKind::Date | ValueKind::Time | ValueKind::Timestamp | ValueKind::TimestampTz => {
                // The column's own type: comparing a `datetime` with a `datetime2` converts
                // the column and misses equal values. Style 121 (ODBC canonical) does not
                // depend on the session's language.
                let target = if MSSQL_DATE_TYPES.contains(&base) {
                    type_name.clone()
                } else {
                    match column.kind {
                        ValueKind::Date => "date".to_owned(),
                        ValueKind::Time => "time(7)".to_owned(),
                        ValueKind::TimestampTz => "datetimeoffset(7)".to_owned(),
                        _ => "datetime2(7)".to_owned(),
                    }
                };
                format!("CONVERT({target}, {placeholder}, 121)")
            }
            // Comparing a varchar key with nvarchar would convert the column (no seek).
            ValueKind::Text if matches!(base, "varchar" | "char" | "text") => {
                format!("CAST({placeholder} AS varchar(max))")
            }
            _ => placeholder.to_owned(),
        }
    }
    fn text_expression(&self, quoted: &str) -> String {
        format!("CAST({quoted} AS nvarchar(max))")
    }
    fn literal(&self, value: &Value) -> String {
        match value {
            Value::Null => "NULL".to_owned(),
            Value::Bool(b) => if *b { "1" } else { "0" }.to_owned(),
            Value::Int(s) | Value::Decimal(s) | Value::Float(s) => number(s),
            Value::Bytes(hex) => format!("0x{}", hex.to_ascii_uppercase()),
            other => format!("N{}", quoted(&plain_text(other).unwrap_or_default())),
        }
    }
    fn column_read_only(&self, column: &ColumnInfo) -> Option<ColumnReadOnlyReason> {
        let type_name = column.type_name.to_ascii_lowercase();
        if type_name == "timestamp" || type_name == "rowversion" {
            Some(ColumnReadOnlyReason::RowVersion)
        } else if column.kind == ValueKind::Other {
            // sql_variant and CLR types (geography, hierarchyid…) are shown as text only.
            Some(ColumnReadOnlyReason::UnsupportedType)
        } else {
            None
        }
    }
    fn count_expression(&self) -> &'static str {
        "COUNT_BIG(*)"
    }
    fn row_estimate(&self) -> RowEstimateSource {
        RowEstimateSource::Catalog(
            "SELECT CAST(SUM(p.rows) AS float) FROM sys.partitions p \
WHERE p.object_id = OBJECT_ID({p}) AND p.index_id IN (0, 1)",
        )
    }
}

impl EditDialect for MysqlDialect {
    fn paging(&self) -> PagingSyntax {
        PagingSyntax::LimitOffset
    }
    fn insert_returning(&self) -> InsertReturning {
        InsertReturning::ReadBack
    }
    fn last_identity(&self) -> Option<&'static str> {
        Some("LAST_INSERT_ID()")
    }
    fn text_expression(&self, quoted: &str) -> String {
        format!("CAST({quoted} AS CHAR)")
    }
    fn literal(&self, value: &Value) -> String {
        match value {
            Value::Null => "NULL".to_owned(),
            Value::Bool(b) => if *b { "1" } else { "0" }.to_owned(),
            Value::Int(s) | Value::Decimal(s) | Value::Float(s) => number(s),
            Value::Bytes(hex) => format!("X'{}'", hex.to_ascii_uppercase()),
            other => quoted(&plain_text(other).unwrap_or_default()).replace('\\', "\\\\"),
        }
    }
}

impl EditDialect for SqliteDialect {
    fn paging(&self) -> PagingSyntax {
        PagingSyntax::LimitOffset
    }
    fn insert_returning(&self) -> InsertReturning {
        InsertReturning::Returning
    }
    fn text_expression(&self, quoted: &str) -> String {
        format!("CAST({quoted} AS TEXT)")
    }
    fn literal(&self, value: &Value) -> String {
        match value {
            Value::Null => "NULL".to_owned(),
            Value::Bool(b) => if *b { "1" } else { "0" }.to_owned(),
            Value::Int(s) | Value::Decimal(s) | Value::Float(s) => number(s),
            Value::Bytes(hex) => format!("X'{}'", hex.to_ascii_uppercase()),
            other => quoted(&plain_text(other).unwrap_or_default()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::dialect::Engine;

    fn column(type_name: &str, kind: ValueKind) -> ColumnInfo {
        ColumnInfo {
            name: "c".into(),
            ordinal: 1,
            type_name: type_name.into(),
            kind,
            nullable: true,
            default: None,
            identity: None,
            generated: None,
            comment: None,
            primary_key: false,
            foreign_key: false,
        }
    }

    #[test]
    fn literals_per_engine() {
        let text = Value::Text("it's".into());
        let bytes = Value::bytes(&[0xde, 0xad]);
        assert_eq!(Engine::Postgres.dialect().literal(&text), "'it''s'");
        assert_eq!(Engine::Mssql.dialect().literal(&text), "N'it''s'");
        assert_eq!(Engine::Postgres.dialect().literal(&bytes), "'\\xdead'");
        assert_eq!(Engine::Mssql.dialect().literal(&bytes), "0xDEAD");
        assert_eq!(Engine::Sqlite.dialect().literal(&bytes), "X'DEAD'");
        assert_eq!(
            Engine::Postgres.dialect().literal(&Value::Bool(true)),
            "TRUE"
        );
        assert_eq!(Engine::Sqlite.dialect().literal(&Value::Bool(false)), "0");
        assert_eq!(
            Engine::Postgres
                .dialect()
                .literal(&Value::Decimal("-12.50".into())),
            "-12.50"
        );
        assert_eq!(
            Engine::Postgres
                .dialect()
                .literal(&Value::Float("NaN".into())),
            "'NaN'"
        );
        assert_eq!(
            Engine::Postgres
                .dialect()
                .literal(&Value::Int("1; DROP".into())),
            "'1; DROP'"
        );
        assert_eq!(Engine::Mssql.dialect().literal(&Value::Null), "NULL");
    }

    #[test]
    fn postgres_array_literals_quote_elements() {
        let array = Value::Array(vec![
            Value::Text("a \"b\"".into()),
            Value::Null,
            Value::Array(vec![Value::int(1), Value::int(2)]),
        ]);
        assert_eq!(
            pg_text(&array).as_deref(),
            Some(r#"{"a \"b\"",NULL,{"1","2"}}"#)
        );
        assert_eq!(pg_text(&Value::Bool(true)).as_deref(), Some("t"));
        assert_eq!(
            pg_text(&Value::bytes(&[1, 255])).as_deref(),
            Some("\\x01ff")
        );
    }

    #[test]
    fn sql_server_converts_what_is_not_implicit() {
        let d = Engine::Mssql.dialect();
        assert_eq!(
            d.bind_expression(Some(&column("varbinary(16)", ValueKind::Bytes)), "@P1"),
            "CONVERT(varbinary(max), @P1, 2)"
        );
        assert_eq!(
            d.bind_expression(Some(&column("datetime", ValueKind::Timestamp)), "@P2"),
            "CONVERT(datetime, @P2, 121)"
        );
        assert_eq!(
            d.bind_expression(Some(&column("dbo.when_t", ValueKind::Timestamp)), "@P2"),
            "CONVERT(datetime2(7), @P2, 121)"
        );
        assert_eq!(
            d.bind_expression(Some(&column("varchar(20)", ValueKind::Text)), "@P3"),
            "CAST(@P3 AS varchar(max))"
        );
        assert_eq!(
            d.bind_expression(Some(&column("int", ValueKind::Int)), "@P4"),
            "@P4"
        );
        assert_eq!(
            d.column_read_only(&column("timestamp", ValueKind::Bytes)),
            Some(ColumnReadOnlyReason::RowVersion)
        );
        assert_eq!(
            d.column_read_only(&column("sql_variant", ValueKind::Other)),
            Some(ColumnReadOnlyReason::UnsupportedType)
        );
        assert_eq!(
            Engine::Postgres
                .dialect()
                .column_read_only(&column("point", ValueKind::Other)),
            None
        );
    }
}
