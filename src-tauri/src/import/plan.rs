//! From a mapping to the statements: which table columns are written from where, how a
//! record becomes a row of values, the multi-row `INSERT`, and the type check over the first
//! rows of a file.

use std::path::Path;

use super::convert::Converter;
use super::model::{
    ImportAnalysis, ImportBadValue, ImportColumnCheck, ImportIssueKind, ImportRequest,
    ImportTarget, ImportTargetColumn, ImportValueSource,
};
use super::parse::{self, Record};
use crate::db::dialect::Dialect;
use crate::db::driver::BoundStatement;
use crate::db::errors::YadbeError;
use crate::db::meta::{ColumnInfo, ObjectKind, ObjectRef, TableDetails, qualified_name};
use crate::db::value::Value;
use crate::session::table_shape::column_reason;

/// Rows of a multi-row `INSERT` at most (SQL Server accepts 1 000 row constructors).
pub const MAX_BATCH_ROWS: usize = 1000;
/// Rows read by the type check; the dry run reads all of them.
pub const ANALYZE_ROWS: usize = 10_000;
const SAMPLES_PER_COLUMN: usize = 5;
const VALUE_CHARS: usize = 80;

#[derive(Debug, Clone)]
pub enum PlanSource {
    File(usize),
    Null,
    /// Converted once, written for every row.
    Constant(Value),
}

#[derive(Debug, Clone)]
pub struct PlanColumn {
    pub column: ColumnInfo,
    pub source: PlanSource,
    pub converter: Converter,
}

#[derive(Debug, Clone)]
pub struct ImportPlan {
    pub table: ObjectRef,
    pub columns: Vec<PlanColumn>,
    pub rows_per_batch: usize,
    /// `NOT NULL` columns without a default that nothing writes.
    pub missing_required: Vec<String>,
}

/// A value of a record that does not convert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellIssue {
    pub column: Option<String>,
    pub value: Option<String>,
    pub kind: ImportIssueKind,
}

/// The text cut for display.
pub fn shown(value: &str) -> String {
    let mut chars = value.chars();
    let head: String = chars.by_ref().take(VALUE_CHARS).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

fn unwritable(name: &str, why: impl std::fmt::Debug) -> YadbeError {
    YadbeError::invalid_argument(
        format!("The column \"{name}\" cannot be written ({why:?})."),
        format!("La colonne « {name} » ne peut pas être écrite ({why:?})."),
    )
}

/// Rows per statement under the engine's parameter limit.
fn rows_per_batch(dialect: &dyn Dialect, written: usize) -> usize {
    (dialect.max_bound_parameters() / written.max(1)).clamp(1, MAX_BATCH_ROWS)
}

fn filled_by_server(column: &ColumnInfo) -> bool {
    column.default.is_some() || column.identity.is_some() || column.generated.is_some()
}

/// What the import knows of the table's columns.
pub fn target(dialect: &dyn Dialect, details: &TableDetails, read_only: bool) -> ImportTarget {
    ImportTarget {
        table: details.table.clone(),
        columns: details
            .columns
            .iter()
            .map(|c| ImportTargetColumn {
                name: c.name.clone(),
                type_name: c.type_name.clone(),
                kind: c.kind,
                nullable: c.nullable,
                filled_by_server: filled_by_server(c),
                primary_key: c.primary_key,
                read_only_reason: column_reason(dialect, c),
            })
            .collect(),
        read_only,
        max_batch_rows: u32::try_from(rows_per_batch(dialect, details.columns.len()))
            .unwrap_or(u32::MAX),
    }
}

/// Checks the request against the table and builds the plan. `file_columns`: the width of
/// the file. Fails with `invalidArgument` (unknown or unwritable column, mapped twice, a
/// file column that does not exist, a constant that does not convert) or
/// `tableNotEditable` (a view).
pub fn build(
    dialect: &dyn Dialect,
    details: &TableDetails,
    request: &ImportRequest,
    file_columns: usize,
) -> Result<ImportPlan, YadbeError> {
    if details.kind != ObjectKind::Table {
        return Err(YadbeError::table_not_editable(
            "Rows can only be imported into a table, not a view.",
            "Des lignes ne peuvent être importées que dans une table, pas dans une vue.",
        ));
    }
    if request.mapping.is_empty() {
        return Err(YadbeError::invalid_argument(
            "Map at least one column.",
            "Associez au moins une colonne.",
        ));
    }
    let mut columns: Vec<PlanColumn> = Vec::new();
    for mapping in &request.mapping {
        let Some(column) = details.columns.iter().find(|c| c.name == mapping.column) else {
            return Err(YadbeError::invalid_argument(
                format!("The table has no column \"{}\".", mapping.column),
                format!("La table n'a pas de colonne « {} ».", mapping.column),
            ));
        };
        if let Some(why) = column_reason(dialect, column) {
            return Err(unwritable(&column.name, why));
        }
        if columns.iter().any(|c| c.column.name == column.name) {
            return Err(YadbeError::invalid_argument(
                format!("The column \"{}\" is mapped twice.", column.name),
                format!("La colonne « {} » est associée deux fois.", column.name),
            ));
        }
        let converter = Converter::new(column, &request.convert);
        let source = match &mapping.source {
            ImportValueSource::File { index } => {
                let index = *index as usize;
                if index >= file_columns {
                    return Err(YadbeError::invalid_argument(
                        format!("The file has no column number {}.", index + 1),
                        format!("Le fichier n'a pas de colonne numéro {}.", index + 1),
                    ));
                }
                PlanSource::File(index)
            }
            ImportValueSource::Null => {
                if converter.convert(None).is_err() {
                    return Err(YadbeError::invalid_argument(
                        format!("The column \"{}\" does not accept NULL.", column.name),
                        format!("La colonne « {} » n'accepte pas NULL.", column.name),
                    ));
                }
                PlanSource::Null
            }
            ImportValueSource::Constant { value } => {
                let converted = converter.convert(Some(value)).map_err(|kind| {
                    YadbeError::invalid_argument(
                        format!(
                            "The constant for \"{}\" is not a valid value of its type ({kind:?}).",
                            column.name
                        ),
                        format!(
                            "La constante de « {} » n'est pas une valeur valide pour son type ({kind:?}).",
                            column.name
                        ),
                    )
                })?;
                PlanSource::Constant(converted)
            }
        };
        columns.push(PlanColumn {
            column: column.clone(),
            source,
            converter,
        });
    }
    let missing_required = details
        .columns
        .iter()
        .filter(|c| {
            !c.nullable && !filled_by_server(c) && !columns.iter().any(|p| p.column.name == c.name)
        })
        .map(|c| c.name.clone())
        .collect();
    let rows_per_batch = rows_per_batch(dialect, columns.len());
    Ok(ImportPlan {
        table: details.table.clone(),
        columns,
        rows_per_batch,
        missing_required,
    })
}

/// A record as the values of the plan's columns, or everything wrong with it.
pub fn convert_record(plan: &ImportPlan, record: &Record) -> Result<Vec<Value>, Vec<CellIssue>> {
    if let Some(found) = record.ragged {
        return Err(vec![CellIssue {
            column: None,
            value: Some(format!("{found}")),
            kind: ImportIssueKind::FieldCount,
        }]);
    }
    let mut values = Vec::with_capacity(plan.columns.len());
    let mut issues = Vec::new();
    for column in &plan.columns {
        match &column.source {
            PlanSource::Constant(value) => values.push(value.clone()),
            PlanSource::Null => values.push(Value::Null),
            PlanSource::File(index) => {
                let cell = record.cells.get(*index).and_then(|c| c.as_deref());
                match column.converter.convert(cell) {
                    Ok(value) => values.push(value),
                    Err(kind) => issues.push(CellIssue {
                        column: Some(column.column.name.clone()),
                        value: cell.map(shown),
                        kind,
                    }),
                }
            }
        }
    }
    if issues.is_empty() {
        Ok(values)
    } else {
        Err(issues)
    }
}

/// `INSERT INTO t (a, b) VALUES (…), (…)` with every value bound. The statement log shows a
/// compact form: the row values are not written out. `label`: `batch 12` or `line 345`.
pub fn insert_statement(
    dialect: &dyn Dialect,
    plan: &ImportPlan,
    rows: &[&[Value]],
    label: &str,
) -> BoundStatement {
    let mut head = String::from("INSERT INTO ");
    head.push_str(&qualified_name(dialect, &plan.table));
    head.push_str(" (");
    for (n, column) in plan.columns.iter().enumerate() {
        if n > 0 {
            head.push_str(", ");
        }
        head.push_str(&dialect.quote_identifier(&column.column.name));
    }
    head.push_str(") VALUES ");
    let mut sql = head.clone();
    let mut params: Vec<Value> = Vec::with_capacity(rows.len() * plan.columns.len());
    for (r, row) in rows.iter().enumerate() {
        if r > 0 {
            sql.push_str(", ");
        }
        sql.push('(');
        for (c, value) in row.iter().enumerate() {
            if c > 0 {
                sql.push_str(", ");
            }
            params.push(value.clone());
            let placeholder = dialect.placeholder(params.len());
            sql.push_str(&dialect.bind_expression(Some(&plan.columns[c].column), &placeholder));
        }
        sql.push(')');
    }
    let count = rows.len();
    let display = format!(
        "{head}(…) /* import: {count} {}, {label} */",
        if count == 1 { "row" } else { "rows" }
    );
    BoundStatement {
        sql,
        params,
        display,
        returns_rows: false,
    }
}

/// The type check of a request over the first rows of the file.
pub fn analyze(
    dialect: &dyn Dialect,
    details: &TableDetails,
    request: &ImportRequest,
    path: &Path,
) -> Result<ImportAnalysis, YadbeError> {
    let display = path.display().to_string();
    let mut opened = parse::open(path, &request.parse)?;
    let plan = build(dialect, details, request, opened.source.columns().len())?;
    let mut checks: Vec<(usize, ImportColumnCheck)> = plan
        .columns
        .iter()
        .filter_map(|c| match c.source {
            PlanSource::File(index) => Some((
                index,
                ImportColumnCheck {
                    column: c.column.name.clone(),
                    type_name: c.column.type_name.clone(),
                    kind: c.column.kind,
                    nullable: c.column.nullable,
                    examined: 0,
                    nulls: 0,
                    invalid: 0,
                    samples: Vec::new(),
                },
            )),
            _ => None,
        })
        .collect();
    let converters: Vec<&PlanColumn> = plan
        .columns
        .iter()
        .filter(|c| matches!(c.source, PlanSource::File(_)))
        .collect();
    let mut examined = 0_usize;
    let mut ragged = 0_u32;
    let mut sampled = false;
    while let Some(record) = opened
        .source
        .next_record()
        .map_err(|e| e.into_yadbe(&display))?
    {
        if examined == ANALYZE_ROWS {
            sampled = true;
            break;
        }
        examined += 1;
        if record.ragged.is_some() {
            ragged += 1;
        }
        let line = u32::try_from(record.line).unwrap_or(u32::MAX);
        for ((index, check), plan_column) in checks.iter_mut().zip(&converters) {
            let cell = record.cells.get(*index).and_then(|c| c.as_deref());
            check.examined += 1;
            if cell.is_none() {
                check.nulls += 1;
            }
            if let Err(reason) = plan_column.converter.convert(cell) {
                check.invalid += 1;
                if check.samples.len() < SAMPLES_PER_COLUMN {
                    check.samples.push(ImportBadValue {
                        line,
                        value: cell.map(shown).unwrap_or_default(),
                        reason,
                    });
                }
            }
        }
    }
    Ok(ImportAnalysis {
        rows_examined: u32::try_from(examined).unwrap_or(u32::MAX),
        sampled,
        ragged_rows: ragged,
        columns: checks.into_iter().map(|(_, c)| c).collect(),
        missing_required: plan.missing_required.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::engine::Engine;
    use crate::db::value::ValueKind;
    use crate::import::model::{
        ImportCommit, ImportConvertOptions, ImportMapping, ImportOnError, ImportParseOptions,
    };

    fn column(name: &str, type_name: &str, kind: ValueKind, nullable: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            ordinal: 1,
            type_name: type_name.into(),
            kind,
            nullable,
            default: None,
            identity: None,
            generated: None,
            comment: None,
            primary_key: false,
            foreign_key: false,
        }
    }

    fn details() -> TableDetails {
        let mut id = column("id", "integer", ValueKind::Int, false);
        id.primary_key = true;
        let mut created = column("created", "datetime2", ValueKind::Timestamp, false);
        created.default = Some("now()".into());
        TableDetails {
            table: ObjectRef {
                database: "app".into(),
                schema: Some("public".into()),
                name: "Order Lines".into(),
            },
            kind: ObjectKind::Table,
            comment: None,
            row_estimate: None,
            columns: vec![
                id,
                column("label", "varchar(5)", ValueKind::Text, true),
                created,
            ],
            primary_key: None,
            unique_keys: Vec::new(),
            foreign_keys: Vec::new(),
            checks: Vec::new(),
            indexes: Vec::new(),
            triggers: Vec::new(),
        }
    }

    fn request(mapping: Vec<ImportMapping>) -> ImportRequest {
        ImportRequest {
            connection_id: "c".into(),
            table: details().table,
            path: "/x.csv".into(),
            parse: ImportParseOptions::default(),
            mapping,
            convert: ImportConvertOptions::default(),
            on_error: ImportOnError::Skip,
            commit: ImportCommit::Single,
            dry_run: false,
            rejects_path: None,
        }
    }

    fn file(column: &str, index: u32) -> ImportMapping {
        ImportMapping {
            column: column.into(),
            source: ImportValueSource::File { index },
        }
    }

    #[test]
    fn builds_a_plan_and_names_what_is_missing() {
        let dialect = Engine::Postgres.dialect();
        let plan = build(dialect, &details(), &request(vec![file("label", 0)]), 2).expect("plan");
        assert_eq!(plan.missing_required, ["id"], "created has a default");
        let plan = build(
            dialect,
            &details(),
            &request(vec![file("id", 0), file("label", 1)]),
            2,
        )
        .expect("plan");
        assert!(plan.missing_required.is_empty());
        assert_eq!(plan.rows_per_batch, MAX_BATCH_ROWS);
        let mssql = build(
            Engine::Mssql.dialect(),
            &details(),
            &request(vec![file("id", 0), file("label", 1)]),
            2,
        )
        .expect("plan");
        assert_eq!(mssql.rows_per_batch, 1000, "2000 parameters / 2 columns");
        let wide = build(
            Engine::Mssql.dialect(),
            &details(),
            &request(vec![file("id", 0), file("label", 1), file("created", 2)]),
            3,
        )
        .expect("plan");
        assert_eq!(wide.rows_per_batch, 666);
    }

    #[test]
    fn refuses_bad_mappings() {
        let dialect = Engine::Postgres.dialect();
        let d = details();
        assert!(build(dialect, &d, &request(vec![]), 1).is_err());
        assert!(build(dialect, &d, &request(vec![file("nope", 0)]), 1).is_err());
        assert!(build(dialect, &d, &request(vec![file("id", 0), file("id", 1)]), 2).is_err());
        assert!(build(dialect, &d, &request(vec![file("id", 3)]), 2).is_err());
        let null_id = ImportMapping {
            column: "id".into(),
            source: ImportValueSource::Null,
        };
        assert!(
            build(dialect, &d, &request(vec![null_id]), 1).is_err(),
            "NOT NULL"
        );
        let bad_constant = ImportMapping {
            column: "id".into(),
            source: ImportValueSource::Constant { value: "x".into() },
        };
        assert!(build(dialect, &d, &request(vec![bad_constant]), 1).is_err());
        let mut view = details();
        view.kind = ObjectKind::View;
        assert!(build(dialect, &view, &request(vec![file("id", 0)]), 1).is_err());
        let mut generated = details();
        generated.columns[1].generated = Some(crate::db::meta::Generated {
            stored: true,
            expression: None,
        });
        assert!(build(dialect, &generated, &request(vec![file("label", 0)]), 1).is_err());
    }

    #[test]
    fn converts_records_and_collects_every_issue() {
        let dialect = Engine::Postgres.dialect();
        let plan = build(
            dialect,
            &details(),
            &request(vec![file("id", 0), file("label", 1)]),
            2,
        )
        .expect("plan");
        let good = Record {
            line: 2,
            cells: vec![Some("7".into()), Some("abc".into())],
            ragged: None,
        };
        assert_eq!(
            convert_record(&plan, &good),
            Ok(vec![Value::int(7), Value::Text("abc".into())])
        );
        let bad = Record {
            line: 3,
            cells: vec![None, Some("toolong".into())],
            ragged: None,
        };
        let issues = convert_record(&plan, &bad).expect_err("two issues");
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].kind, ImportIssueKind::NullNotAllowed);
        assert_eq!(issues[1].kind, ImportIssueKind::TooLong);
        assert_eq!(issues[1].value.as_deref(), Some("toolong"));
        let ragged = Record {
            line: 4,
            cells: vec![Some("1".into())],
            ragged: Some(1),
        };
        assert_eq!(
            convert_record(&plan, &ragged).expect_err("ragged")[0].kind,
            ImportIssueKind::FieldCount
        );
    }

    #[test]
    fn writes_multi_row_inserts_with_bound_values_and_a_compact_log_form() {
        let rows: Vec<Vec<Value>> = vec![
            vec![Value::int(1), Value::Text("it's".into())],
            vec![Value::int(2), Value::Null],
        ];
        let refs: Vec<&[Value]> = rows.iter().map(Vec::as_slice).collect();
        for (engine, expected) in [
            (
                Engine::Postgres,
                r#"INSERT INTO "public"."Order Lines" ("id", "label") VALUES ($1, $2), ($3, $4)"#,
            ),
            (
                Engine::Mysql,
                "INSERT INTO `app`.`Order Lines` (`id`, `label`) VALUES (?, ?), (?, ?)",
            ),
        ] {
            let dialect = engine.dialect();
            let plan = build(
                dialect,
                &details(),
                &request(vec![file("id", 0), file("label", 1)]),
                2,
            )
            .expect("plan");
            let statement = insert_statement(dialect, &plan, &refs, "batch 1");
            assert_eq!(statement.sql, expected);
            assert_eq!(statement.params.len(), 4);
            assert!(
                statement
                    .display
                    .ends_with("(…) /* import: 2 rows, batch 1 */")
            );
            assert!(
                !statement.display.contains("it's"),
                "no row value in the log"
            );
        }
        let mssql = Engine::Mssql.dialect();
        let plan = build(
            mssql,
            &details(),
            &request(vec![file("id", 0), file("label", 1)]),
            2,
        )
        .expect("plan");
        let statement = insert_statement(mssql, &plan, &refs[..1], "line 9");
        assert!(statement.sql.contains("CAST(@P2 AS varchar(max))"));
        assert!(statement.display.ends_with("/* import: 1 row, line 9 */"));
    }

    #[test]
    fn analyzes_a_file_against_the_mapping() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("orders.csv");
        std::fs::write(&path, "id,label\n1,ok\nx,fine\n3,toolong\n,\n5,ok\n6\n").expect("writes");
        let mut req = request(vec![file("id", 0), file("label", 1)]);
        req.path = path.display().to_string();
        let analysis =
            analyze(Engine::Postgres.dialect(), &details(), &req, &path).expect("analysis");
        assert_eq!(analysis.rows_examined, 6);
        assert!(!analysis.sampled);
        assert_eq!(analysis.ragged_rows, 1);
        let id = &analysis.columns[0];
        assert_eq!(
            (id.nulls, id.invalid),
            (1, 2),
            "x, and the empty one (NOT NULL)"
        );
        assert_eq!(
            id.samples[0],
            ImportBadValue {
                line: 3,
                value: "x".into(),
                reason: ImportIssueKind::InvalidFormat
            }
        );
        let label = &analysis.columns[1];
        assert_eq!(label.invalid, 1);
        assert_eq!(label.samples[0].reason, ImportIssueKind::TooLong);
        assert!(analysis.missing_required.is_empty());
    }
}
