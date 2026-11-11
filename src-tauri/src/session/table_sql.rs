//! The statements of table browsing (F-080, F-081): a page, a count, an estimate, rows by
//! key. Identifiers are quoted and values bound through the dialect; the raw `WHERE` typed by
//! the user is the only text sent as written.

use crate::db::bound::SqlBuilder;
use crate::db::classify::read_only_refusal;
use crate::db::dialect::Dialect;
use crate::db::driver::BoundStatement;
use crate::db::edit_dialect::{PagingSyntax, plain_text};
use crate::db::errors::YadbeError;
use crate::db::meta::{ObjectRef, qualified_name};
use crate::db::split::{SqlSyntax, TokenKind, split, tokenize};
use crate::db::value::Value;
use crate::session::table_model::{
    ColumnFilter, FilterOp, RowKey, SortDirection, SortKey, TableFilter,
};
use crate::session::table_shape::TableShape;

/// The order of a page: the requested keys (or the default order), then the row identity
/// columns not covered yet, so that pages do not overlap.
pub fn resolve_order(shape: &TableShape, sort: &[SortKey]) -> Result<Vec<SortKey>, YadbeError> {
    for key in sort {
        shape.require(&key.column)?;
    }
    let mut keys = if sort.is_empty() {
        shape.info.default_order.clone()
    } else {
        sort.to_vec()
    };
    for &index in &shape.identity {
        let name = &shape.details.columns[index].name;
        if !keys.iter().any(|k| &k.column == name) {
            keys.push(SortKey {
                column: name.clone(),
                direction: SortDirection::Asc,
            });
        }
    }
    Ok(keys)
}

fn arity_error(column: &str) -> YadbeError {
    YadbeError::invalid_argument(
        format!("The filter on \"{column}\" has the wrong number of values."),
        format!("Le filtre sur « {column} » n'a pas le bon nombre de valeurs."),
    )
}

/// `%`, `_`, `[` and the escape character itself, escaped for `LIKE … ESCAPE '<escape>'`.
pub(crate) fn escape_like(text: &str, escape: char) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c == escape || matches!(c, '%' | '_' | '[') {
            out.push(escape);
        }
        out.push(c);
    }
    out
}

fn push_condition(
    b: &mut SqlBuilder<'_>,
    shape: &TableShape,
    filter: &ColumnFilter,
) -> Result<(), YadbeError> {
    let (_, column) = shape.require(&filter.column)?;
    let dialect = b.dialect();
    let quoted = dialect.quote_identifier(&column.name);
    let values = &filter.values;
    let count = |n: usize| {
        if values.len() == n {
            Ok(())
        } else {
            Err(arity_error(&column.name))
        }
    };
    let comparison = |b: &mut SqlBuilder<'_>, op: &str| {
        b.push(&quoted).push(" ").push(op).push(" ");
        b.value(&values[0], Some(column));
    };
    match filter.op {
        FilterOp::Eq | FilterOp::Ne | FilterOp::Lt | FilterOp::Le | FilterOp::Gt | FilterOp::Ge => {
            count(1)?;
            let op = match filter.op {
                FilterOp::Eq => "=",
                FilterOp::Ne => "<>",
                FilterOp::Lt => "<",
                FilterOp::Le => "<=",
                FilterOp::Gt => ">",
                _ => ">=",
            };
            comparison(b, op);
        }
        FilterOp::Contains | FilterOp::StartsWith | FilterOp::EndsWith => {
            count(1)?;
            let escape = dialect.like_escape();
            let text = escape_like(&plain_text(&values[0]).unwrap_or_default(), escape);
            let pattern = match filter.op {
                FilterOp::Contains => format!("%{text}%"),
                FilterOp::StartsWith => format!("{text}%"),
                _ => format!("%{text}"),
            };
            b.push(&dialect.text_expression(&quoted))
                .push(" ")
                .push(dialect.like_operator())
                .push(" ")
                .value(&Value::Text(pattern), None)
                .push(&format!(" ESCAPE '{escape}'"));
        }
        FilterOp::In => {
            if values.is_empty() {
                return Err(arity_error(&column.name));
            }
            b.push(&quoted).push(" IN (");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    b.push(", ");
                }
                b.value(value, Some(column));
            }
            b.push(")");
        }
        FilterOp::IsNull | FilterOp::IsNotNull => {
            count(0)?;
            b.push(&quoted).push(if filter.op == FilterOp::IsNull {
                " IS NULL"
            } else {
                " IS NOT NULL"
            });
        }
        FilterOp::Between => {
            count(2)?;
            b.push(&quoted).push(" BETWEEN ");
            b.value(&values[0], Some(column))
                .push(" AND ")
                .value(&values[1], Some(column));
        }
    }
    Ok(())
}

/// Checks the filter: known columns, value counts, a raw `WHERE` of one statement at most.
pub fn check_filter(
    dialect: &dyn Dialect,
    shape: &TableShape,
    filter: &TableFilter,
) -> Result<(), YadbeError> {
    let mut scratch = SqlBuilder::new(dialect);
    push_where(&mut scratch, shape, filter)
}

/// More than one statement in a raw `WHERE`: the splitter sees several, or a `;` outside
/// strings and comments (T-SQL batches split on `GO`, not on `;`).
fn several_statements(raw: &str, syntax: &SqlSyntax) -> bool {
    split(raw, syntax).len() > 1
        || tokenize(raw, syntax)
            .iter()
            .any(|t| t.kind == TokenKind::Punct && &raw[t.start..t.end] == ";")
}

/// Refuses a raw `WHERE` on a read-only connection unless yadbe can prove it only reads.
pub fn check_read_only(dialect: &dyn Dialect, filter: &TableFilter) -> Result<(), YadbeError> {
    let Some(raw) = filter.raw_where.as_deref().filter(|r| !r.trim().is_empty()) else {
        return Ok(());
    };
    match read_only_refusal(&format!("SELECT 1 WHERE {raw}"), &dialect.syntax()) {
        None => Ok(()),
        Some(statement) => Err(YadbeError::read_only_violation(&statement)),
    }
}

/// ` WHERE …` for the filter, or nothing.
fn push_where(
    b: &mut SqlBuilder<'_>,
    shape: &TableShape,
    filter: &TableFilter,
) -> Result<(), YadbeError> {
    push_where_after(b, shape, filter, None)
}

/// ` WHERE …` for the filter and, for keyset paging, the rows after `after` (the values of
/// the order's columns, in the order's sequence).
fn push_where_after(
    b: &mut SqlBuilder<'_>,
    shape: &TableShape,
    filter: &TableFilter,
    after: Option<(&[SortKey], &[Value])>,
) -> Result<(), YadbeError> {
    let raw = filter
        .raw_where
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty());
    if let Some(raw) = raw
        && several_statements(raw, &b.dialect().syntax())
    {
        return Err(YadbeError::invalid_argument(
            "The WHERE condition holds more than one statement.",
            "La condition WHERE contient plus d'une instruction.",
        ));
    }
    if filter.conditions.is_empty() && raw.is_none() && after.is_none() {
        return Ok(());
    }
    b.push(" WHERE ");
    for (index, condition) in filter.conditions.iter().enumerate() {
        if index > 0 {
            b.push(" AND ");
        }
        push_condition(b, shape, condition)?;
    }
    if let Some(raw) = raw {
        if !filter.conditions.is_empty() {
            b.push(" AND ");
        }
        // On lines of its own: a trailing `--` comment cannot swallow the parenthesis.
        b.push("(\n").push(raw).push("\n)");
    }
    if let Some((order, last)) = after {
        if !filter.conditions.is_empty() || raw.is_some() {
            b.push(" AND ");
        }
        push_after(b, shape, order, last);
    }
    Ok(())
}

/// `(k1 > $1) OR (k1 = $1 AND k2 > $2) …`: the rows after `last` in `order` (`<` for a
/// descending key). Row values are not used: SQL Server has no tuple comparison.
fn push_after(b: &mut SqlBuilder<'_>, shape: &TableShape, order: &[SortKey], last: &[Value]) {
    let column_of = |key: &SortKey| shape.details.columns.iter().find(|c| c.name == key.column);
    b.push("(");
    for (n, key) in order.iter().enumerate() {
        if n > 0 {
            b.push(" OR ");
        }
        b.push("(");
        for (earlier, value) in order.iter().zip(last).take(n) {
            b.ident(&earlier.column)
                .push(" = ")
                .value(value, column_of(earlier));
            b.push(" AND ");
        }
        if let Some(value) = last.get(n) {
            b.ident(&key.column)
                .push(match key.direction {
                    SortDirection::Asc => " > ",
                    SortDirection::Desc => " < ",
                })
                .value(value, column_of(key));
        }
        b.push(")");
    }
    b.push(")");
}

/// Whether an order can be paged by keyset: it only holds identity columns (whose values are
/// unique and never NULL), so that "after the last row" is exact.
pub fn keyset_pageable(shape: &TableShape, order: &[SortKey]) -> bool {
    !shape.identity.is_empty()
        && !order.is_empty()
        && order.iter().all(|key| {
            shape
                .identity
                .iter()
                .any(|&i| shape.details.columns[i].name == key.column)
        })
}

/// The values of `row` for the columns of `order`, to continue after it.
pub fn keyset_of(shape: &TableShape, order: &[SortKey], row: &[Value]) -> Option<Vec<Value>> {
    order
        .iter()
        .map(|key| {
            let at = shape
                .details
                .columns
                .iter()
                .position(|c| c.name == key.column)?;
            row.get(at).cloned()
        })
        .collect()
}

fn push_order(b: &mut SqlBuilder<'_>, order: &[SortKey]) {
    for (index, key) in order.iter().enumerate() {
        b.push(if index == 0 { " ORDER BY " } else { ", " });
        b.ident(&key.column).push(match key.direction {
            SortDirection::Asc => " ASC",
            SortDirection::Desc => " DESC",
        });
    }
}

/// One page plus one row, to know whether more follow. The paging numbers are yadbe's own
/// integers, written into the SQL; every filter value is bound.
pub fn page(
    dialect: &dyn Dialect,
    shape: &TableShape,
    filter: &TableFilter,
    order: &[SortKey],
    offset: u32,
    limit: u32,
) -> Result<BoundStatement, YadbeError> {
    page_after(dialect, shape, filter, order, None, offset, limit)
}

/// Like [`page`], for the rows after `after` (see [`keyset_pageable`]) instead of an offset:
/// the cost of a page does not grow with its position.
pub fn page_after(
    dialect: &dyn Dialect,
    shape: &TableShape,
    filter: &TableFilter,
    order: &[SortKey],
    after: Option<&[Value]>,
    offset: u32,
    limit: u32,
) -> Result<BoundStatement, YadbeError> {
    let offset = if after.is_some() { 0 } else { offset };
    let mut b = SqlBuilder::new(dialect);
    b.push("SELECT ");
    shape.select_list(&mut b, "");
    b.push(" FROM ").table(&shape.details.table);
    push_where_after(&mut b, shape, filter, after.map(|last| (order, last)))?;
    push_order(&mut b, order);
    let fetch = u64::from(limit) + 1;
    match dialect.paging() {
        PagingSyntax::LimitOffset => {
            b.push(&format!(" LIMIT {fetch} OFFSET {offset}"));
        }
        PagingSyntax::OffsetFetch => {
            if order.is_empty() {
                b.push(" ORDER BY (SELECT NULL)");
            }
            b.push(&format!(
                " OFFSET {offset} ROWS FETCH NEXT {fetch} ROWS ONLY"
            ));
        }
    }
    Ok(b.finish(true))
}

/// `SELECT COUNT(*) FROM … WHERE …`
pub fn count(
    dialect: &dyn Dialect,
    shape: &TableShape,
    filter: &TableFilter,
) -> Result<BoundStatement, YadbeError> {
    let mut b = SqlBuilder::new(dialect);
    b.push("SELECT ")
        .push(dialect.count_expression())
        .push(" FROM ")
        .table(&shape.details.table);
    push_where(&mut b, shape, filter)?;
    Ok(b.finish(true))
}

/// `EXPLAIN (FORMAT JSON) SELECT 1 FROM … WHERE …`: the planner's estimate.
pub fn explain(
    dialect: &dyn Dialect,
    shape: &TableShape,
    filter: &TableFilter,
) -> Result<BoundStatement, YadbeError> {
    let mut b = SqlBuilder::new(dialect);
    b.push("EXPLAIN (FORMAT JSON) SELECT 1 FROM ")
        .table(&shape.details.table);
    push_where(&mut b, shape, filter)?;
    Ok(b.finish(true))
}

/// A catalog query whose `{p}` stands for the table's qualified name, bound.
pub fn with_table_name(dialect: &dyn Dialect, table: &ObjectRef, template: &str) -> BoundStatement {
    let mut b = SqlBuilder::new(dialect);
    let name = Value::Text(qualified_name(dialect, table));
    let mut parts = template.split("{p}");
    if let Some(first) = parts.next() {
        b.push(first);
    }
    for part in parts {
        b.value(&name, None).push(part);
    }
    b.finish(true)
}

/// The rows of `keys`: `WHERE (k = $1) OR (k = $2)…`.
pub fn rows_by_key(dialect: &dyn Dialect, shape: &TableShape, keys: &[RowKey]) -> BoundStatement {
    let mut b = SqlBuilder::new(dialect);
    b.push("SELECT ");
    shape.select_list(&mut b, "");
    b.push(" FROM ").table(&shape.details.table).push(" WHERE ");
    for (index, key) in keys.iter().enumerate() {
        if index > 0 {
            b.push(" OR ");
        }
        b.push("(");
        shape.push_key(&mut b, key);
        b.push(")");
    }
    b.finish(true)
}

/// `Plan Rows` of the top plan node of an `EXPLAIN (FORMAT JSON)` output.
pub fn plan_rows(json: &str) -> Option<f64> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value.get(0)?.get("Plan")?.get("Plan Rows")?.as_f64()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::db::dialect::Engine;
    use crate::db::meta::{ColumnInfo, KeyConstraint, ObjectKind, TableDetails};
    use crate::db::value::ValueKind;

    fn column(name: &str, type_name: &str, kind: ValueKind) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            ordinal: 1,
            type_name: type_name.into(),
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

    pub(crate) fn orders(engine: Engine) -> TableShape {
        let details = TableDetails {
            table: ObjectRef {
                database: "shop".into(),
                schema: (engine != Engine::Sqlite).then(|| "shop".into()),
                name: "orders".into(),
            },
            kind: ObjectKind::Table,
            comment: None,
            row_estimate: None,
            columns: vec![
                column("id", "integer", ValueKind::Int),
                column("note", "varchar(20)", ValueKind::Text),
                column("at", "datetime", ValueKind::Timestamp),
                column("where", "point", ValueKind::Other),
            ],
            primary_key: Some(KeyConstraint {
                name: None,
                columns: vec!["id".into()],
            }),
            unique_keys: vec![],
            foreign_keys: vec![],
            checks: vec![],
            indexes: vec![],
            triggers: vec![],
        };
        TableShape::new(engine.dialect(), details, false, &HashMap::new())
    }

    fn filter(conditions: Vec<ColumnFilter>, raw: Option<&str>) -> TableFilter {
        TableFilter {
            conditions,
            raw_where: raw.map(str::to_owned),
        }
    }

    fn cond(column: &str, op: FilterOp, values: Vec<Value>) -> ColumnFilter {
        ColumnFilter {
            column: column.into(),
            op,
            values,
        }
    }

    #[test]
    fn pages_bind_filters_and_page_per_engine() {
        let f = filter(
            vec![
                cond(
                    "note",
                    FilterOp::Contains,
                    vec![Value::Text("50%_off".into())],
                ),
                cond("id", FilterOp::Between, vec![Value::int(1), Value::int(9)]),
                cond("id", FilterOp::In, vec![Value::int(3), Value::int(4)]),
                cond("at", FilterOp::IsNull, vec![]),
            ],
            Some("id > 2 -- mine"),
        );
        let shape = orders(Engine::Postgres);
        let order = resolve_order(
            &shape,
            &[SortKey {
                column: "note".into(),
                direction: SortDirection::Desc,
            }],
        )
        .expect("order");
        let pg = page(Engine::Postgres.dialect(), &shape, &f, &order, 100, 50).expect("page");
        assert_eq!(
            pg.sql,
            "SELECT \"id\", \"note\", \"at\", CAST(\"where\" AS text) AS \"where\" FROM \"shop\".\"orders\" \
WHERE CAST(\"note\" AS text) ILIKE $1 ESCAPE '\\' AND \"id\" BETWEEN $2 AND $3 \
AND \"id\" IN ($4, $5) AND \"at\" IS NULL AND (\nid > 2 -- mine\n) \
ORDER BY \"note\" DESC, \"id\" ASC LIMIT 51 OFFSET 100"
        );
        assert_eq!(pg.params[0], Value::Text("%50\\%\\_off%".into()));
        assert!(pg.display.contains("ILIKE '%50\\%\\_off%' ESCAPE"));
        assert!(pg.display.contains("BETWEEN 1 AND 9"));

        let shape = orders(Engine::Mssql);
        let order = resolve_order(&shape, &[]).expect("order");
        let ms = page(Engine::Mssql.dialect(), &shape, &f, &order, 0, 10).expect("page");
        assert!(
            ms.sql
                .ends_with("ORDER BY [id] ASC OFFSET 0 ROWS FETCH NEXT 11 ROWS ONLY"),
            "{}",
            ms.sql
        );
        assert!(
            ms.sql
                .contains("CAST([note] AS nvarchar(max)) LIKE @P1 ESCAPE '\\'")
        );
        assert!(ms.sql.contains("[id] BETWEEN @P2 AND @P3"));
    }

    #[test]
    fn rejects_bad_filters() {
        let shape = orders(Engine::Sqlite);
        let d = Engine::Sqlite.dialect();
        let bad = [
            filter(vec![cond("nope", FilterOp::IsNull, vec![])], None),
            filter(vec![cond("id", FilterOp::Eq, vec![])], None),
            filter(vec![cond("id", FilterOp::In, vec![])], None),
            filter(
                vec![cond("id", FilterOp::IsNull, vec![Value::int(1)])],
                None,
            ),
            filter(vec![], Some("1 = 1; DELETE FROM orders")),
            filter(vec![], Some("1 = 1; -- a comment")),
        ];
        for f in bad {
            let err = check_filter(d, &shape, &f).expect_err("refused");
            assert_eq!(err.code, crate::db::errors::ErrorCode::InvalidArgument);
        }
        check_filter(d, &shape, &filter(vec![], Some("  "))).expect("blank raw WHERE");
        check_filter(d, &shape, &filter(vec![], Some("note = ';'"))).expect("quoted ;");
        let ms = Engine::Mssql.dialect();
        let mssql = orders(Engine::Mssql);
        assert!(check_filter(ms, &mssql, &filter(vec![], Some("1 = 1; DELETE FROM x"))).is_err());
        assert!(check_read_only(ms, &filter(vec![], Some("id > 2"))).is_ok());
        let err = check_read_only(
            ms,
            &filter(vec![], Some("1 = 1) DELETE FROM x WHERE (1 = 1")),
        )
        .expect_err("write");
        assert_eq!(err.code, crate::db::errors::ErrorCode::ReadOnlyViolation);
        assert!(
            resolve_order(
                &shape,
                &[SortKey {
                    column: "nope".into(),
                    direction: SortDirection::Asc
                }]
            )
            .is_err()
        );
    }

    #[test]
    fn counts_estimates_and_rows_by_key() {
        let shape = orders(Engine::Mssql);
        let d = Engine::Mssql.dialect();
        let c = count(d, &shape, &TableFilter::default()).expect("count");
        assert_eq!(c.sql, "SELECT COUNT_BIG(*) FROM [shop].[orders]");
        let e = with_table_name(d, &shape.details.table, "SELECT OBJECT_ID({p})");
        assert_eq!(e.sql, "SELECT OBJECT_ID(@P1)");
        assert_eq!(e.display, "SELECT OBJECT_ID(N'[shop].[orders]')");
        let rows = rows_by_key(d, &shape, &[vec![Value::int(1)], vec![Value::int(2)]]);
        assert!(rows.sql.ends_with("WHERE ([id] = @P1) OR ([id] = @P2)"));
        assert_eq!(
            plan_rows(r#"[{"Plan": {"Node Type": "Seq Scan", "Plan Rows": 1234}}]"#),
            Some(1234.0)
        );
    }
}
