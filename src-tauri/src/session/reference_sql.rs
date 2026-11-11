//! The statements of foreign key navigation (F-088): a referenced row by its key, a bounded
//! count of the rows holding a key, a page of a referenced table searched as text. Built like
//! table browsing: identifiers quoted and values bound through the dialect.

use crate::db::bound::SqlBuilder;
use crate::db::dialect::Dialect;
use crate::db::driver::BoundStatement;
use crate::db::edit_dialect::PagingSyntax;
use crate::db::errors::YadbeError;
use crate::db::meta::RowLimitSyntax;
use crate::db::value::Value;
use crate::session::reference_model::{KeyValue, LookupRequest, MAX_LOOKUP_ROWS};
use crate::session::table_shape::TableShape;
use crate::session::table_sql::escape_like;

/// Checks a key: at least one column, known columns, each once, no `NULL` (a `NULL` foreign
/// key value references nothing).
fn check_key(shape: &TableShape, key: &[KeyValue]) -> Result<(), YadbeError> {
    if key.is_empty() {
        return Err(YadbeError::invalid_argument(
            "A key needs at least one column.",
            "Une clé demande au moins une colonne.",
        ));
    }
    for (index, part) in key.iter().enumerate() {
        shape.require(&part.column)?;
        if key[..index].iter().any(|p| p.column == part.column) {
            return Err(YadbeError::invalid_argument(
                format!("The column \"{}\" appears twice in the key.", part.column),
                format!(
                    "La colonne « {} » figure deux fois dans la clé.",
                    part.column
                ),
            ));
        }
        if part.value == Value::Null {
            return Err(YadbeError::invalid_argument(
                "A NULL value references no row.",
                "Une valeur NULL ne référence aucune ligne.",
            ));
        }
    }
    Ok(())
}

/// `"a" = $1 AND "b" = $2`
fn push_key(b: &mut SqlBuilder<'_>, shape: &TableShape, key: &[KeyValue]) {
    for (n, part) in key.iter().enumerate() {
        if n > 0 {
            b.push(" AND ");
        }
        let column = shape.column(&part.column).map(|(_, c)| c);
        b.ident(&part.column).push(" = ").value(&part.value, column);
    }
}

/// `SELECT [TOP (n)] ` or `SELECT ` (the limit then comes last).
fn select_limited(b: &mut SqlBuilder<'_>, limit: u32) {
    b.push("SELECT ");
    if b.dialect().meta_capabilities().row_limit == RowLimitSyntax::Top {
        b.push(&format!("TOP ({limit}) "));
    }
}

fn end_limited(b: &mut SqlBuilder<'_>, limit: u32) {
    if b.dialect().meta_capabilities().row_limit == RowLimitSyntax::Limit {
        b.push(&format!(" LIMIT {limit}"));
    }
}

/// The rows whose `key` matches, two at most (the second one tells a non-unique key).
pub fn referenced_row(
    dialect: &dyn Dialect,
    shape: &TableShape,
    key: &[KeyValue],
) -> Result<BoundStatement, YadbeError> {
    check_key(shape, key)?;
    let mut b = SqlBuilder::new(dialect);
    select_limited(&mut b, 2);
    shape.select_list(&mut b, "");
    b.push(" FROM ").table(&shape.details.table).push(" WHERE ");
    push_key(&mut b, shape, key);
    end_limited(&mut b, 2);
    Ok(b.finish(true))
}

/// `SELECT COUNT(*) FROM (SELECT 1 … WHERE <key> LIMIT n)`: stops reading at `limit` rows,
/// so a key held by millions of rows costs no more than `limit` of them.
pub fn bounded_count(
    dialect: &dyn Dialect,
    shape: &TableShape,
    key: &[KeyValue],
    limit: u32,
) -> Result<BoundStatement, YadbeError> {
    check_key(shape, key)?;
    let mut b = SqlBuilder::new(dialect);
    b.push("SELECT ")
        .push(dialect.count_expression())
        .push(" FROM (");
    select_limited(&mut b, limit);
    b.push("1 AS ")
        .ident("one")
        .push(" FROM ")
        .table(&shape.details.table)
        .push(" WHERE ");
    push_key(&mut b, shape, key);
    end_limited(&mut b, limit);
    b.push(") ").ident("limited");
    Ok(b.finish(true))
}

/// The indices of a lookup's columns: the key, then the display columns not in the key.
pub fn lookup_columns(
    shape: &TableShape,
    request: &LookupRequest,
) -> Result<Vec<usize>, YadbeError> {
    if request.key_columns.is_empty() {
        return Err(YadbeError::invalid_argument(
            "A lookup needs the referenced key columns.",
            "Une recherche demande les colonnes de la clé référencée.",
        ));
    }
    let mut indices: Vec<usize> = Vec::new();
    for name in request.key_columns.iter().chain(&request.display_columns) {
        let (index, _) = shape.require(name)?;
        if !indices.contains(&index) {
            indices.push(index);
        }
    }
    Ok(indices)
}

/// A page of the referenced table: its key and display columns, rows whose columns contain
/// the search text, ordered by the key, plus one row to know whether more follow.
pub fn lookup(
    dialect: &dyn Dialect,
    shape: &TableShape,
    request: &LookupRequest,
) -> Result<BoundStatement, YadbeError> {
    if request.limit == 0 || request.limit > MAX_LOOKUP_ROWS {
        return Err(YadbeError::invalid_argument(
            format!("A lookup page has 1 to {MAX_LOOKUP_ROWS} rows."),
            format!("Une page de recherche compte de 1 à {MAX_LOOKUP_ROWS} lignes."),
        ));
    }
    let indices = lookup_columns(shape, request)?;
    let mut b = SqlBuilder::new(dialect);
    b.push("SELECT ");
    for (n, &index) in indices.iter().enumerate() {
        if n > 0 {
            b.push(", ");
        }
        let column = &shape.details.columns[index];
        let quoted = dialect.quote_identifier(&column.name);
        match dialect.select_expression(column, &quoted) {
            Some(expression) => {
                b.push(&expression).push(" AS ").ident(&column.name);
            }
            None => {
                b.push(&quoted);
            }
        }
    }
    b.push(" FROM ").table(&shape.details.table);
    let search = request
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(search) = search {
        let escape = dialect.like_escape();
        let pattern = Value::Text(format!("%{}%", escape_like(search, escape)));
        b.push(" WHERE ");
        for (n, &index) in indices.iter().enumerate() {
            if n > 0 {
                b.push(" OR ");
            }
            let quoted = dialect.quote_identifier(&shape.details.columns[index].name);
            b.push(&dialect.text_expression(&quoted))
                .push(" ")
                .push(dialect.like_operator())
                .push(" ")
                .value(&pattern, None)
                .push(&format!(" ESCAPE '{escape}'"));
        }
    }
    for (n, name) in request.key_columns.iter().enumerate() {
        b.push(if n == 0 { " ORDER BY " } else { ", " });
        b.ident(name).push(" ASC");
    }
    let fetch = u64::from(request.limit) + 1;
    let offset = request.offset;
    match dialect.paging() {
        PagingSyntax::LimitOffset => {
            b.push(&format!(" LIMIT {fetch} OFFSET {offset}"));
        }
        PagingSyntax::OffsetFetch => {
            b.push(&format!(
                " OFFSET {offset} ROWS FETCH NEXT {fetch} ROWS ONLY"
            ));
        }
    }
    Ok(b.finish(true))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::db::dialect::Engine;
    use crate::db::errors::ErrorCode;
    use crate::db::meta::{ColumnInfo, KeyConstraint, ObjectKind, ObjectRef, TableDetails};
    use crate::db::value::ValueKind;

    fn column(name: &str, kind: ValueKind) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            ordinal: 1,
            type_name: "t".into(),
            kind,
            nullable: false,
            default: None,
            identity: None,
            generated: None,
            comment: None,
            primary_key: false,
            foreign_key: false,
        }
    }

    fn parents(engine: Engine) -> TableShape {
        let details = TableDetails {
            table: ObjectRef {
                database: "shop".into(),
                schema: (engine != Engine::Sqlite).then(|| "Odd \"s\"".into()),
                name: "Parent".into(),
            },
            kind: ObjectKind::Table,
            comment: None,
            row_estimate: None,
            columns: vec![
                column("Key A", ValueKind::Int),
                column("key b", ValueKind::Text),
                column("name", ValueKind::Text),
            ],
            primary_key: Some(KeyConstraint {
                name: None,
                columns: vec!["Key A".into(), "key b".into()],
            }),
            unique_keys: vec![],
            foreign_keys: vec![],
            checks: vec![],
            indexes: vec![],
            triggers: vec![],
        };
        TableShape::new(engine.dialect(), details, false, &HashMap::new())
    }

    fn key() -> Vec<KeyValue> {
        vec![
            KeyValue {
                column: "Key A".into(),
                value: Value::int(7),
            },
            KeyValue {
                column: "key b".into(),
                value: Value::Text("x' OR 1=1 --".into()),
            },
        ]
    }

    #[test]
    fn reads_a_row_by_a_composite_key() {
        let shape = parents(Engine::Postgres);
        let s = referenced_row(Engine::Postgres.dialect(), &shape, &key()).expect("sql");
        assert_eq!(
            s.sql,
            "SELECT \"Key A\", \"key b\", \"name\" FROM \"Odd \"\"s\"\"\".\"Parent\" \
WHERE \"Key A\" = $1 AND \"key b\" = $2 LIMIT 2"
        );
        assert_eq!(
            s.params,
            [Value::int(7), Value::Text("x' OR 1=1 --".into())]
        );
        let shape = parents(Engine::Mssql);
        let s = referenced_row(Engine::Mssql.dialect(), &shape, &key()).expect("sql");
        assert!(s.sql.starts_with("SELECT TOP (2) [Key A]"), "{}", s.sql);
        assert!(s.sql.ends_with("WHERE [Key A] = @P1 AND [key b] = @P2"));
    }

    #[test]
    fn counts_up_to_a_bound() {
        let shape = parents(Engine::Sqlite);
        let s = bounded_count(Engine::Sqlite.dialect(), &shape, &key(), 1001).expect("sql");
        assert_eq!(
            s.sql,
            "SELECT COUNT(*) FROM (SELECT 1 AS \"one\" FROM \"Parent\" \
WHERE \"Key A\" = ?1 AND \"key b\" = ?2 LIMIT 1001) \"limited\""
        );
        let shape = parents(Engine::Mssql);
        let s = bounded_count(Engine::Mssql.dialect(), &shape, &key(), 10).expect("sql");
        assert_eq!(
            s.sql,
            "SELECT COUNT_BIG(*) FROM (SELECT TOP (10) 1 AS [one] FROM [Odd \"s\"].[Parent] \
WHERE [Key A] = @P1 AND [key b] = @P2) [limited]"
        );
    }

    #[test]
    fn refuses_bad_keys() {
        let shape = parents(Engine::Postgres);
        let d = Engine::Postgres.dialect();
        let null = vec![KeyValue {
            column: "Key A".into(),
            value: Value::Null,
        }];
        let unknown = vec![KeyValue {
            column: "nope".into(),
            value: Value::int(1),
        }];
        let twice = vec![key()[0].clone(), key()[0].clone()];
        for bad in [vec![], null, unknown, twice] {
            let err = referenced_row(d, &shape, &bad).expect_err("refused");
            assert_eq!(err.code, ErrorCode::InvalidArgument);
        }
    }

    #[test]
    fn searches_key_and_display_columns_as_text() {
        let request = LookupRequest {
            table: parents(Engine::Postgres).details.table.clone(),
            key_columns: vec!["Key A".into(), "key b".into()],
            display_columns: vec!["name".into(), "Key A".into()],
            search: Some(" 50%_off ".into()),
            offset: 40,
            limit: 20,
        };
        let shape = parents(Engine::Postgres);
        let s = lookup(Engine::Postgres.dialect(), &shape, &request).expect("sql");
        assert_eq!(
            s.sql,
            "SELECT \"Key A\", \"key b\", \"name\" FROM \"Odd \"\"s\"\"\".\"Parent\" \
WHERE CAST(\"Key A\" AS text) ILIKE $1 ESCAPE '\\' OR CAST(\"key b\" AS text) ILIKE $2 ESCAPE '\\' \
OR CAST(\"name\" AS text) ILIKE $3 ESCAPE '\\' ORDER BY \"Key A\" ASC, \"key b\" ASC LIMIT 21 OFFSET 40"
        );
        assert_eq!(s.params[0], Value::Text("%50\\%\\_off%".into()));
        // MySQL reads a backslash in a literal as an escape: its LIKE escape is `!`.
        let shape = parents(Engine::Mysql);
        let s = lookup(Engine::Mysql.dialect(), &shape, &request).expect("sql");
        assert!(
            s.sql.contains("CAST(`Key A` AS CHAR) LIKE ? ESCAPE '!' OR"),
            "{}",
            s.sql
        );
        assert!(!s.sql.contains('\\'), "{}", s.sql);
        assert_eq!(s.params[0], Value::Text("%50!%!_off%".into()));
        let shape = parents(Engine::Mssql);
        let s = lookup(Engine::Mssql.dialect(), &shape, &request).expect("sql");
        assert!(
            s.sql.ends_with(
                "ORDER BY [Key A] ASC, [key b] ASC OFFSET 40 ROWS FETCH NEXT 21 ROWS ONLY"
            ),
            "{}",
            s.sql
        );
        let blank = LookupRequest {
            search: Some("  ".into()),
            ..request.clone()
        };
        let s = lookup(
            Engine::Postgres.dialect(),
            &parents(Engine::Postgres),
            &blank,
        )
        .expect("sql");
        assert!(!s.sql.contains("WHERE"));
        for bad in [
            LookupRequest {
                limit: 0,
                ..request.clone()
            },
            LookupRequest {
                key_columns: vec![],
                ..request.clone()
            },
            LookupRequest {
                display_columns: vec!["nope".into()],
                ..request
            },
        ] {
            assert!(lookup(Engine::Postgres.dialect(), &parents(Engine::Postgres), &bad).is_err());
        }
    }
}
