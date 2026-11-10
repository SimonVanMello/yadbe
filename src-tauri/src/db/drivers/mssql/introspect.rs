//! SQL Server introspection on the `sys` catalog views (2017+, Azure SQL). One connection
//! sees every database: queries name theirs as `[db].sys.…` (quoted through the dialect),
//! and bind every other name as an RPC parameter.

use std::collections::HashMap;

use tiberius::{Query, Row};

use super::MssqlConnection;
use crate::db::dialect::{Dialect, MssqlDialect};
use crate::db::driver::recorded;
use crate::db::errors::YadbeError;
use crate::db::introspect::{Introspector, MetaFuture, TypeInterner, index_u32};
use crate::db::meta::{
    CatalogForeignKey, CatalogRelation, CatalogRoutine, CatalogSchema, CheckConstraint, ColumnInfo,
    CompletionCatalog, DatabaseInfo, ForeignKey, ForeignKeyAction, Generated, Identity, IndexInfo,
    KeyConstraint, ObjectCount, ObjectDetail, ObjectInfo, ObjectKind, ObjectRef, RelationSummary,
    RoutineSignature, SchemaInfo, SequenceSummary, TableDetails, TriggerEvent, TriggerInfo,
    TriggerTiming, TypeAttribute, TypeCategory, TypeSummary,
};
use crate::db::value::ValueKind;

/// A bound parameter.
#[derive(Debug, Clone)]
enum Param {
    Text(String),
    Int(i32),
    Bool(bool),
}

impl From<&str> for Param {
    fn from(value: &str) -> Self {
        Param::Text(value.to_owned())
    }
}

/// The type of a column (`c`) of type `t` as SQL Server writes it: `nvarchar(200)`,
/// `decimal(10,2)`, `datetime2(3)`; alias and CLR types by name.
fn type_expr(c: &str, t: &str) -> String {
    format!(
        "CASE WHEN {t}.is_user_defined = 1 THEN {t}.name \
WHEN {t}.name IN ('varchar', 'char', 'varbinary', 'binary') THEN {t}.name + '(' + \
CASE WHEN {c}.max_length = -1 THEN 'max' ELSE CAST({c}.max_length AS varchar(10)) END + ')' \
WHEN {t}.name IN ('nvarchar', 'nchar') THEN {t}.name + '(' + \
CASE WHEN {c}.max_length = -1 THEN 'max' ELSE CAST({c}.max_length / 2 AS varchar(10)) END + ')' \
WHEN {t}.name IN ('decimal', 'numeric') THEN {t}.name + '(' + CAST({c}.precision AS varchar(3)) \
+ ',' + CAST({c}.scale AS varchar(3)) + ')' \
WHEN {t}.name IN ('datetime2', 'time', 'datetimeoffset') THEN {t}.name + '(' + \
CAST({c}.scale AS varchar(3)) + ')' \
ELSE {t}.name END"
    )
}

/// The system type behind a type `t` (alias types resolve to their base), for its family.
fn base_type_expr(t: &str, base: &str) -> String {
    format!("CASE WHEN {t}.is_assembly_type = 1 THEN 'udt' ELSE {base}.name END")
}

/// `MS_Description` of an object (`class` 1), a column, or a schema (`class` 3).
fn description(alias: &str, class: u8, major: &str, minor: &str) -> String {
    format!(
        "LEFT JOIN {{db}}.sys.extended_properties {alias} ON {alias}.class = {class} \
AND {alias}.major_id = {major} AND {alias}.minor_id = {minor} AND {alias}.name = 'MS_Description'"
    )
}

const DATABASES_SQL: &str = "\
SELECT d.name, CAST(CASE WHEN d.name = DB_NAME() THEN 1 ELSE 0 END AS bit),
       CAST(CASE WHEN d.database_id <= 4 THEN 1 ELSE 0 END AS bit),
       CAST(CASE WHEN d.state = 0 AND HAS_DBACCESS(d.name) = 1 THEN 1 ELSE 0 END AS bit)
FROM sys.databases d
ORDER BY d.name";

const DATABASE_EXISTS_SQL: &str =
    "SELECT CAST(CASE WHEN DB_ID(@P1) IS NULL THEN 0 ELSE 1 END AS bit)";

/// Engine schemas: the catalogs, `guest` and the fixed database roles' schemas.
const SYSTEM_SCHEMA: &str =
    "(s.name IN ('sys', 'INFORMATION_SCHEMA', 'guest') OR s.schema_id >= 16384)";

fn schemas_sql() -> String {
    format!(
        "SELECT s.name, CAST(CASE WHEN {SYSTEM_SCHEMA} THEN 1 ELSE 0 END AS bit), p.name,
       CAST(ep.value AS nvarchar(max))
FROM {{db}}.sys.schemas s
LEFT JOIN {{db}}.sys.database_principals p ON p.principal_id = s.principal_id
{}
ORDER BY s.name",
        description("ep", 3, "s.schema_id", "0")
    )
}

/// Object types per kind.
const TABLE_TYPES: &str = "('U', 'ET')";
const VIEW_TYPES: &str = "('V')";
const FUNCTION_TYPES: &str = "('FN', 'IF', 'TF', 'FS', 'FT', 'AF')";
const PROCEDURE_TYPES: &str = "('P', 'PC', 'X', 'RF')";

fn counts_sql() -> String {
    let objects = |types: &str, system: bool| {
        format!(
            "(SELECT COUNT(*) FROM {{db}}.sys.objects o WHERE o.schema_id = s.schema_id \
AND o.type IN {types}{})",
            if system {
                " AND o.is_ms_shipped = 1"
            } else {
                ""
            }
        )
    };
    format!(
        "SELECT {}, {}, {}, {}, {}, {}, {}, {},
       (SELECT COUNT(*) FROM {{db}}.sys.sequences q WHERE q.schema_id = s.schema_id),
       (SELECT COUNT(*) FROM {{db}}.sys.types t WHERE t.schema_id = s.schema_id AND t.is_user_defined = 1)
FROM {{db}}.sys.schemas s
WHERE s.name = @P1",
        objects(TABLE_TYPES, false),
        objects(TABLE_TYPES, true),
        objects(VIEW_TYPES, false),
        objects(VIEW_TYPES, true),
        objects(FUNCTION_TYPES, false),
        objects(FUNCTION_TYPES, true),
        objects(PROCEDURE_TYPES, false),
        objects(PROCEDURE_TYPES, true),
    )
}

/// Rows of a table (heap or clustered index), from the partition metadata.
const ROW_COUNT: &str = "(SELECT SUM(p.rows) FROM {db}.sys.partitions p \
WHERE p.object_id = o.object_id AND p.index_id IN (0, 1))";

fn relations_sql(types: &str) -> String {
    format!(
        "SELECT o.name, o.type, CAST(o.is_ms_shipped AS bit), CAST(ep.value AS nvarchar(max)),
       {ROW_COUNT},
       CAST(CASE WHEN EXISTS (SELECT 1 FROM {{db}}.sys.indexes i
            JOIN {{db}}.sys.partition_schemes ps ON ps.data_space_id = i.data_space_id
            WHERE i.object_id = o.object_id AND i.index_id IN (0, 1)) THEN 1 ELSE 0 END AS bit)
FROM {{db}}.sys.objects o
JOIN {{db}}.sys.schemas s ON s.schema_id = o.schema_id
{}
WHERE s.name = @P1 AND o.type IN {types}
ORDER BY o.name",
        description("ep", 1, "o.object_id", "0")
    )
}

/// Arguments of every routine: (object id, full list, types only).
fn arguments_sql(filter: &str) -> String {
    format!(
        "SELECT pr.object_id,
       STRING_AGG(CAST(pr.name + ' ' + {} + CASE WHEN pr.is_output = 1 THEN ' OUTPUT' ELSE '' END
                  AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY pr.parameter_id),
       STRING_AGG(CAST({} AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY pr.parameter_id)
FROM {{db}}.sys.parameters pr
JOIN {{db}}.sys.types t ON t.user_type_id = pr.user_type_id
JOIN {{db}}.sys.objects o ON o.object_id = pr.object_id
JOIN {{db}}.sys.schemas s ON s.schema_id = o.schema_id
WHERE pr.parameter_id > 0 AND {filter}
GROUP BY pr.object_id",
        type_expr("pr", "t"),
        type_expr("pr", "t"),
    )
}

fn routines_sql(types: &str) -> String {
    format!(
        "SELECT o.object_id, o.name, o.type, CAST(o.is_ms_shipped AS bit),
       CAST(ep.value AS nvarchar(max)),
       CASE WHEN o.type IN ('IF', 'TF', 'FT') THEN 'TABLE'
            ELSE (SELECT {} FROM {{db}}.sys.parameters pr
                  JOIN {{db}}.sys.types t ON t.user_type_id = pr.user_type_id
                  WHERE pr.object_id = o.object_id AND pr.parameter_id = 0) END
FROM {{db}}.sys.objects o
JOIN {{db}}.sys.schemas s ON s.schema_id = o.schema_id
{}
WHERE s.name = @P1 AND o.type IN {types}
ORDER BY o.name",
        type_expr("pr", "t"),
        description("ep", 1, "o.object_id", "0")
    )
}

fn sequences_sql() -> String {
    format!(
        "SELECT q.name, {}, CAST(q.start_value AS nvarchar(40)), CAST(q.increment AS nvarchar(40)),
       CAST(q.minimum_value AS nvarchar(40)), CAST(q.maximum_value AS nvarchar(40)),
       q.is_cycling, CAST(ep.value AS nvarchar(max))
FROM {{db}}.sys.sequences q
JOIN {{db}}.sys.schemas s ON s.schema_id = q.schema_id
JOIN {{db}}.sys.types t ON t.user_type_id = q.user_type_id
{}
WHERE s.name = @P1
ORDER BY q.name",
        // Sequences are integers or decimals: no length to print.
        "CASE WHEN t.name IN ('decimal', 'numeric') THEN t.name + '(' + \
CAST(q.precision AS varchar(3)) + ',' + CAST(q.scale AS varchar(3)) + ')' ELSE t.name END",
        description("ep", 1, "q.object_id", "0")
    )
}

fn types_sql() -> String {
    format!(
        "SELECT t.name, t.is_table_type, t.is_assembly_type, CAST(ep.value AS nvarchar(max)),
       CASE WHEN t.is_table_type = 0 AND t.is_assembly_type = 0 THEN {} END
FROM {{db}}.sys.types t
JOIN {{db}}.sys.schemas s ON s.schema_id = t.schema_id
LEFT JOIN {{db}}.sys.types b ON b.user_type_id = t.system_type_id
{}
WHERE s.name = @P1 AND t.is_user_defined = 1
ORDER BY t.name",
        type_expr("t", "b"),
        description("ep", 7, "t.user_type_id", "0")
    )
}

fn table_type_columns_sql() -> String {
    format!(
        "SELECT tt.name, c.name, {}
FROM {{db}}.sys.table_types tt
JOIN {{db}}.sys.schemas s ON s.schema_id = tt.schema_id
JOIN {{db}}.sys.columns c ON c.object_id = tt.type_table_object_id
JOIN {{db}}.sys.types t ON t.user_type_id = c.user_type_id
WHERE s.name = @P1
ORDER BY tt.name, c.column_id",
        type_expr("c", "t")
    )
}

fn relation_sql() -> String {
    format!(
        "SELECT o.object_id, o.type, CAST(ep.value AS nvarchar(max)), {ROW_COUNT}
FROM {{db}}.sys.objects o
JOIN {{db}}.sys.schemas s ON s.schema_id = o.schema_id
{}
WHERE s.name = @P1 AND o.name = @P2 AND o.type IN ('U', 'ET', 'V')",
        description("ep", 1, "o.object_id", "0")
    )
}

fn columns_sql() -> String {
    format!(
        "SELECT c.name, {}, c.is_nullable, dc.definition, c.is_identity, c.is_computed,
       cc.definition, CAST(ISNULL(cc.is_persisted, 0) AS bit), CAST(ep.value AS nvarchar(max)),
       {}, CAST(c.generated_always_type AS int)
FROM {{db}}.sys.columns c
JOIN {{db}}.sys.types t ON t.user_type_id = c.user_type_id
JOIN {{db}}.sys.types b ON b.user_type_id = t.system_type_id
LEFT JOIN {{db}}.sys.default_constraints dc ON dc.object_id = c.default_object_id
LEFT JOIN {{db}}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
{}
WHERE c.object_id = @P1
ORDER BY c.column_id",
        type_expr("c", "t"),
        base_type_expr("t", "b"),
        description("ep", 1, "c.object_id", "c.column_id")
    )
}

const KEYS_SQL: &str = "\
SELECT kc.name, kc.type, col.name
FROM {db}.sys.key_constraints kc
JOIN {db}.sys.index_columns ic
  ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
JOIN {db}.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
WHERE kc.parent_object_id = @P1 AND ic.is_included_column = 0
ORDER BY kc.name, ic.key_ordinal";

const FOREIGN_KEYS_SQL: &str = "\
SELECT fk.name, pc.name, rs.name, rt.name, rc.name,
       CAST(fk.update_referential_action AS int), CAST(fk.delete_referential_action AS int)
FROM {db}.sys.foreign_keys fk
JOIN {db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN {db}.sys.columns pc
  ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN {db}.sys.objects rt ON rt.object_id = fk.referenced_object_id
JOIN {db}.sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN {db}.sys.columns rc
  ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
WHERE fk.parent_object_id = @P1
ORDER BY fk.name, fkc.constraint_column_id";

const CHECKS_SQL: &str = "\
SELECT cc.name, cc.definition
FROM {db}.sys.check_constraints cc
WHERE cc.parent_object_id = @P1
ORDER BY cc.name";

/// Key columns in order (included columns are not part of the key).
const INDEXES_SQL: &str = "\
SELECT i.name, i.is_unique, i.is_primary_key, LOWER(i.type_desc), i.filter_definition,
       col.name, ic.is_descending_key
FROM {db}.sys.indexes i
LEFT JOIN {db}.sys.index_columns ic
  ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal > 0
LEFT JOIN {db}.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
WHERE i.object_id = @P1 AND i.type > 0 AND i.is_hypothetical = 0
ORDER BY i.name, ic.key_ordinal";

const TRIGGERS_SQL: &str = "\
SELECT tr.name, tr.is_instead_of_trigger, tr.is_disabled, te.type_desc, m.definition
FROM {db}.sys.triggers tr
JOIN {db}.sys.trigger_events te ON te.object_id = tr.object_id
LEFT JOIN {db}.sys.sql_modules m ON m.object_id = tr.object_id
WHERE tr.parent_id = @P1
ORDER BY tr.name, te.type";

const SEARCH_PATH_SQL: &str = "SELECT SCHEMA_NAME()";

/// Relations of the catalog: user objects, plus the engine's with `include_system`.
fn catalog_relations_sql() -> String {
    format!(
        "SELECT o.object_id, s.name, o.name, o.type
FROM {{db}}.sys.all_objects o
JOIN {{db}}.sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('U', 'ET', 'V') AND (@P1 = 1 OR (o.is_ms_shipped = 0 AND NOT {SYSTEM_SCHEMA}))
ORDER BY s.name, o.name"
    )
}

fn catalog_columns_sql() -> String {
    format!(
        "SELECT c.object_id, c.column_id, c.name, {}
FROM {{db}}.sys.all_columns c
JOIN {{db}}.sys.all_objects o ON o.object_id = c.object_id
JOIN {{db}}.sys.schemas s ON s.schema_id = o.schema_id
JOIN {{db}}.sys.types t ON t.user_type_id = c.user_type_id
WHERE o.type IN ('U', 'ET', 'V') AND (@P1 = 1 OR (o.is_ms_shipped = 0 AND NOT {SYSTEM_SCHEMA}))",
        type_expr("c", "t")
    )
}

fn catalog_routines_sql() -> String {
    format!(
        "SELECT o.object_id, s.name, o.name, CAST(CASE WHEN o.type IN {PROCEDURE_TYPES} THEN 1 ELSE 0 END AS bit),
       CASE WHEN o.type IN ('IF', 'TF', 'FT') THEN 'TABLE'
            WHEN o.type IN {PROCEDURE_TYPES} THEN NULL
            ELSE (SELECT {} FROM {{db}}.sys.parameters pr
                  JOIN {{db}}.sys.types t ON t.user_type_id = pr.user_type_id
                  WHERE pr.object_id = o.object_id AND pr.parameter_id = 0) END
FROM {{db}}.sys.objects o
JOIN {{db}}.sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('FN', 'IF', 'TF', 'FS', 'FT', 'AF', 'P', 'PC', 'X', 'RF')
  AND (@P1 = 1 OR (o.is_ms_shipped = 0 AND NOT {SYSTEM_SCHEMA}))
ORDER BY s.name, o.name",
        type_expr("pr", "t")
    )
}

const CATALOG_FOREIGN_KEYS_SQL: &str = "\
SELECT fkc.constraint_object_id, fkc.parent_object_id, fkc.parent_column_id,
       fkc.referenced_object_id, fkc.referenced_column_id
FROM {db}.sys.foreign_key_columns fkc
ORDER BY fkc.constraint_object_id, fkc.constraint_column_id";

fn text(row: &Row, index: usize) -> Result<Option<String>, YadbeError> {
    row.try_get::<&str, _>(index)
        .map(|v| v.map(str::to_owned))
        .map_err(|e| YadbeError::internal(format!("metadata column {index}: {e}")))
}

fn text_req(row: &Row, index: usize) -> Result<String, YadbeError> {
    Ok(text(row, index)?.unwrap_or_default())
}

fn flag(row: &Row, index: usize) -> Result<bool, YadbeError> {
    row.try_get::<bool, _>(index)
        .map(Option::unwrap_or_default)
        .map_err(|e| YadbeError::internal(format!("metadata column {index}: {e}")))
}

fn int(row: &Row, index: usize) -> Result<i32, YadbeError> {
    row.try_get::<i32, _>(index)
        .map(Option::unwrap_or_default)
        .map_err(|e| YadbeError::internal(format!("metadata column {index}: {e}")))
}

fn big(row: &Row, index: usize) -> Result<Option<i64>, YadbeError> {
    row.try_get::<i64, _>(index)
        .map_err(|e| YadbeError::internal(format!("metadata column {index}: {e}")))
}

fn count(row: &Row, index: usize) -> Result<u32, YadbeError> {
    Ok(u32::try_from(int(row, index)?).unwrap_or(0))
}

/// The logical family of a system type name.
fn kind_of_name(name: &str) -> ValueKind {
    match name {
        "bit" => ValueKind::Bool,
        "tinyint" | "smallint" | "int" | "bigint" => ValueKind::Int,
        "decimal" | "numeric" | "money" | "smallmoney" => ValueKind::Decimal,
        "real" | "float" => ValueKind::Float,
        "char" | "varchar" | "nchar" | "nvarchar" | "text" | "ntext" | "xml" | "sysname" => {
            ValueKind::Text
        }
        "binary" | "varbinary" | "image" | "timestamp" => ValueKind::Bytes,
        "date" => ValueKind::Date,
        "time" => ValueKind::Time,
        "datetime" | "datetime2" | "smalldatetime" => ValueKind::Timestamp,
        "datetimeoffset" => ValueKind::TimestampTz,
        "uniqueidentifier" => ValueKind::Uuid,
        _ => ValueKind::Other,
    }
}

fn fk_action(code: i32) -> ForeignKeyAction {
    match code {
        1 => ForeignKeyAction::Cascade,
        2 => ForeignKeyAction::SetNull,
        3 => ForeignKeyAction::SetDefault,
        _ => ForeignKeyAction::NoAction,
    }
}

fn relation_kind(object_type: &str) -> ObjectKind {
    if object_type.trim() == "V" {
        ObjectKind::View
    } else {
        ObjectKind::Table
    }
}

fn schema_of(schema: Option<&str>) -> Result<&str, YadbeError> {
    schema.ok_or_else(|| {
        YadbeError::invalid_argument(
            "This engine needs a schema name.",
            "Ce moteur a besoin d'un nom de schéma.",
        )
    })
}

/// `count` as a row estimate; `None` for views and unknown counts.
#[allow(clippy::cast_precision_loss)]
fn estimate(rows: Option<i64>) -> Option<f64> {
    rows.map(|r| r as f64)
}

impl MssqlConnection {
    /// Runs one metadata query on `database`, recorded in the statement log.
    async fn meta(
        &self,
        database: &str,
        sql: &str,
        params: &[Param],
    ) -> Result<Vec<Row>, YadbeError> {
        let sql = sql.replace("{db}", &MssqlDialect.quote_identifier(database));
        recorded(
            &*self.recorder,
            &sql,
            |rows: &Vec<Row>| u64::try_from(rows.len()).ok(),
            async {
                let mut query = Query::new(sql.as_str());
                for param in params {
                    match param {
                        Param::Text(value) => query.bind(value.as_str()),
                        Param::Int(value) => query.bind(*value),
                        Param::Bool(value) => query.bind(*value),
                    }
                }
                let mut guard = self.client.lock().await;
                let client = guard.as_mut().ok_or_else(|| self.closed())?;
                let rows = query
                    .query(client)
                    .await
                    .map_err(|e| self.failed(&e))?
                    .into_first_result()
                    .await
                    .map_err(|e| self.failed(&e))?;
                Ok(rows)
            },
        )
        .await
    }

    async fn ensure_database(&self, database: &str) -> Result<(), YadbeError> {
        let rows = self
            .meta("master", DATABASE_EXISTS_SQL, &[database.into()])
            .await?;
        match rows.first() {
            Some(row) if flag(row, 0)? => Ok(()),
            _ => Err(YadbeError::unknown_database(database)),
        }
    }

    async fn list_schemas(&self, database: &str) -> Result<Vec<SchemaInfo>, YadbeError> {
        self.ensure_database(database).await?;
        self.meta(database, &schemas_sql(), &[])
            .await?
            .iter()
            .map(|row| {
                Ok(SchemaInfo {
                    name: text_req(row, 0)?,
                    system: flag(row, 1)?,
                    owner: text(row, 2)?,
                    comment: text(row, 3)?,
                })
            })
            .collect()
    }

    async fn relations(
        &self,
        database: &str,
        schema: &str,
        kind: ObjectKind,
    ) -> Result<Vec<ObjectInfo>, YadbeError> {
        let types = if kind == ObjectKind::View {
            VIEW_TYPES
        } else {
            TABLE_TYPES
        };
        self.meta(database, &relations_sql(types), &[schema.into()])
            .await?
            .iter()
            .map(|row| {
                let name = text_req(row, 0)?;
                let object_type = text_req(row, 1)?;
                Ok(ObjectInfo {
                    kind,
                    id: name.clone(),
                    name,
                    system: flag(row, 2)?,
                    comment: text(row, 3)?,
                    detail: ObjectDetail::Relation(RelationSummary {
                        row_estimate: if kind == ObjectKind::View {
                            None
                        } else {
                            estimate(big(row, 4)?)
                        },
                        partitioned: flag(row, 5)?,
                        foreign: object_type.trim() == "ET",
                    }),
                })
            })
            .collect()
    }

    async fn routines(
        &self,
        database: &str,
        schema: &str,
        kind: ObjectKind,
    ) -> Result<Vec<ObjectInfo>, YadbeError> {
        let types = if kind == ObjectKind::Procedure {
            PROCEDURE_TYPES
        } else {
            FUNCTION_TYPES
        };
        let routines = self
            .meta(database, &routines_sql(types), &[schema.into()])
            .await?;
        let arguments = self
            .arguments(database, "s.name = @P1", &[schema.into()])
            .await?;
        routines
            .iter()
            .map(|row| {
                let name = text_req(row, 1)?;
                let object_type = text_req(row, 2)?;
                let object_type = object_type.trim();
                let (full, types) = arguments.get(&int(row, 0)?).cloned().unwrap_or_default();
                Ok(ObjectInfo {
                    kind,
                    id: name.clone(),
                    name,
                    system: flag(row, 3)?,
                    comment: text(row, 4)?,
                    detail: ObjectDetail::Routine(RoutineSignature {
                        arguments: full,
                        identity_arguments: types,
                        return_type: if kind == ObjectKind::Procedure {
                            None
                        } else {
                            text(row, 5)?
                        },
                        language: Some(
                            if matches!(object_type, "FS" | "FT" | "AF" | "PC") {
                                "CLR"
                            } else {
                                "SQL"
                            }
                            .to_owned(),
                        ),
                        aggregate: object_type == "AF",
                    }),
                })
            })
            .collect()
    }

    /// Arguments of the routines `filter` selects, by object id: (full list, types only).
    async fn arguments(
        &self,
        database: &str,
        filter: &str,
        params: &[Param],
    ) -> Result<HashMap<i32, (String, String)>, YadbeError> {
        let mut out = HashMap::new();
        for row in self.meta(database, &arguments_sql(filter), params).await? {
            out.insert(int(&row, 0)?, (text_req(&row, 1)?, text_req(&row, 2)?));
        }
        Ok(out)
    }

    async fn sequences(&self, database: &str, schema: &str) -> Result<Vec<ObjectInfo>, YadbeError> {
        self.meta(database, &sequences_sql(), &[schema.into()])
            .await?
            .iter()
            .map(|row| {
                let name = text_req(row, 0)?;
                Ok(ObjectInfo {
                    kind: ObjectKind::Sequence,
                    id: name.clone(),
                    name,
                    system: false,
                    comment: text(row, 7)?,
                    detail: ObjectDetail::Sequence(SequenceSummary {
                        data_type: text_req(row, 1)?,
                        start: text_req(row, 2)?,
                        increment: text_req(row, 3)?,
                        min: text_req(row, 4)?,
                        max: text_req(row, 5)?,
                        cycle: flag(row, 6)?,
                        owned_by: None,
                    }),
                })
            })
            .collect()
    }

    async fn types(&self, database: &str, schema: &str) -> Result<Vec<ObjectInfo>, YadbeError> {
        let types = self.meta(database, &types_sql(), &[schema.into()]).await?;
        let mut attributes: HashMap<String, Vec<TypeAttribute>> = HashMap::new();
        for row in self
            .meta(database, &table_type_columns_sql(), &[schema.into()])
            .await?
        {
            attributes
                .entry(text_req(&row, 0)?)
                .or_default()
                .push(TypeAttribute {
                    name: text_req(&row, 1)?,
                    type_name: text_req(&row, 2)?,
                });
        }
        types
            .iter()
            .map(|row| {
                let name = text_req(row, 0)?;
                let table = flag(row, 1)?;
                let assembly = flag(row, 2)?;
                Ok(ObjectInfo {
                    kind: ObjectKind::Type,
                    id: name.clone(),
                    system: false,
                    comment: text(row, 3)?,
                    detail: ObjectDetail::Type(TypeSummary {
                        category: if table {
                            TypeCategory::Composite
                        } else if assembly {
                            TypeCategory::Base
                        } else {
                            TypeCategory::Domain
                        },
                        enum_values: Vec::new(),
                        base_type: text(row, 4)?,
                        attributes: attributes.remove(&name).unwrap_or_default(),
                    }),
                    name,
                })
            })
            .collect()
    }

    async fn details(&self, table: &ObjectRef) -> Result<TableDetails, YadbeError> {
        let db = table.database.as_str();
        let schema = table.schema.as_deref().unwrap_or_default();
        let relation = self
            .meta(
                db,
                &relation_sql(),
                &[schema.into(), table.name.as_str().into()],
            )
            .await?;
        let Some(relation) = relation.first() else {
            return Err(YadbeError::object_not_found(&format!(
                "{schema}.{}",
                table.name
            )));
        };
        let id = Param::Int(int(relation, 0)?);
        let kind = relation_kind(&text_req(relation, 1)?);
        let ids = std::slice::from_ref(&id);
        let columns = self.meta(db, &columns_sql(), ids).await?;
        let keys = self.meta(db, KEYS_SQL, ids).await?;
        let foreign_keys = self.meta(db, FOREIGN_KEYS_SQL, ids).await?;
        let checks = self.meta(db, CHECKS_SQL, ids).await?;
        let indexes = self.meta(db, INDEXES_SQL, ids).await?;
        let triggers = self.meta(db, TRIGGERS_SQL, ids).await?;

        let mut details = TableDetails {
            table: table.clone(),
            kind,
            comment: text(relation, 2)?,
            row_estimate: if kind == ObjectKind::View {
                None
            } else {
                estimate(big(relation, 3)?)
            },
            columns: Vec::with_capacity(columns.len()),
            primary_key: None,
            unique_keys: Vec::new(),
            foreign_keys: Vec::new(),
            checks: Vec::with_capacity(checks.len()),
            indexes: Vec::new(),
            triggers: Vec::new(),
        };
        for (index, row) in columns.iter().enumerate() {
            let computed = flag(row, 5)?;
            let period = int(row, 10)?;
            details.columns.push(ColumnInfo {
                name: text_req(row, 0)?,
                ordinal: index_u32(index + 1),
                type_name: text_req(row, 1)?,
                kind: kind_of_name(&text_req(row, 9)?),
                nullable: flag(row, 2)?,
                default: text(row, 3)?,
                identity: flag(row, 4)?.then_some(Identity::Always),
                generated: if computed {
                    Some(Generated {
                        stored: flag(row, 7)?,
                        expression: text(row, 6)?,
                    })
                } else if period != 0 {
                    // System-versioned period columns (`GENERATED ALWAYS AS ROW START`).
                    Some(Generated {
                        stored: true,
                        expression: None,
                    })
                } else {
                    None
                },
                comment: text(row, 8)?,
                primary_key: false,
                foreign_key: false,
            });
        }
        let mut current: Option<(String, String, Vec<String>)> = None;
        let flush_key = |key: Option<(String, String, Vec<String>)>, details: &mut TableDetails| {
            if let Some((name, key_type, columns)) = key {
                let key = KeyConstraint {
                    name: Some(name),
                    columns,
                };
                if key_type.trim() == "PK" {
                    details.primary_key = Some(key);
                } else {
                    details.unique_keys.push(key);
                }
            }
        };
        for row in &keys {
            let name = text_req(row, 0)?;
            let column = text_req(row, 2)?;
            match &mut current {
                Some((current_name, _, columns)) if *current_name == name => columns.push(column),
                _ => {
                    flush_key(current.take(), &mut details);
                    current = Some((name, text_req(row, 1)?, vec![column]));
                }
            }
        }
        flush_key(current.take(), &mut details);

        for row in &foreign_keys {
            let name = text_req(row, 0)?;
            let column = text_req(row, 1)?;
            let referenced_column = text_req(row, 4)?;
            match details.foreign_keys.last_mut() {
                Some(fk) if fk.name.as_deref() == Some(name.as_str()) => {
                    fk.columns.push(column);
                    fk.referenced_columns.push(referenced_column);
                }
                _ => details.foreign_keys.push(ForeignKey {
                    name: Some(name),
                    columns: vec![column],
                    referenced_table: ObjectRef {
                        database: table.database.clone(),
                        schema: text(row, 2)?,
                        name: text_req(row, 3)?,
                    },
                    referenced_columns: vec![referenced_column],
                    on_update: fk_action(int(row, 5)?),
                    on_delete: fk_action(int(row, 6)?),
                    deferrable: false,
                }),
            }
        }
        for row in &checks {
            details.checks.push(CheckConstraint {
                name: text(row, 0)?,
                expression: text_req(row, 1)?,
            });
        }
        details.mark_key_columns();
        for row in &indexes {
            let name = text_req(row, 0)?;
            let column = text(row, 5)?.map(|c| {
                if flag(row, 6).unwrap_or(false) {
                    format!("{c} DESC")
                } else {
                    c
                }
            });
            match details.indexes.last_mut() {
                Some(index) if index.name == name => index.columns.extend(column),
                _ => details.indexes.push(IndexInfo {
                    name,
                    columns: column.into_iter().collect(),
                    unique: flag(row, 1)?,
                    primary: flag(row, 2)?,
                    method: text(row, 3)?,
                    predicate: text(row, 4)?,
                    definition: None,
                }),
            }
        }
        for row in &triggers {
            let name = text_req(row, 0)?;
            let event = match text_req(row, 3)?.as_str() {
                "INSERT" => TriggerEvent::Insert,
                "DELETE" => TriggerEvent::Delete,
                _ => TriggerEvent::Update,
            };
            match details.triggers.last_mut() {
                Some(trigger) if trigger.name == name => trigger.events.push(event),
                _ => details.triggers.push(TriggerInfo {
                    name,
                    timing: if flag(row, 1)? {
                        TriggerTiming::InsteadOf
                    } else {
                        TriggerTiming::After
                    },
                    events: vec![event],
                    for_each_row: false,
                    enabled: !flag(row, 2)?,
                    function: None,
                    definition: text(row, 4)?,
                }),
            }
        }
        Ok(details)
    }

    async fn catalog(
        &self,
        database: &str,
        include_system: bool,
    ) -> Result<CompletionCatalog, YadbeError> {
        let system = [Param::Bool(include_system)];
        let schemas = self.list_schemas(database).await?;
        let search_path = self.meta(database, SEARCH_PATH_SQL, &[]).await?;
        let relations = self
            .meta(database, &catalog_relations_sql(), &system)
            .await?;
        let columns = self.meta(database, &catalog_columns_sql(), &system).await?;
        let routines = self
            .meta(database, &catalog_routines_sql(), &system)
            .await?;
        let arguments = self
            .arguments(
                database,
                &format!("(@P1 = 1 OR (o.is_ms_shipped = 0 AND NOT {SYSTEM_SCHEMA}))"),
                &system,
            )
            .await?;
        let foreign_keys = self.meta(database, CATALOG_FOREIGN_KEYS_SQL, &[]).await?;

        let schemas: Vec<CatalogSchema> = schemas
            .into_iter()
            .filter(|s| include_system || !s.system)
            .map(|s| CatalogSchema {
                name: s.name,
                system: s.system,
            })
            .collect();
        let schema_index: HashMap<&str, u32> = schemas
            .iter()
            .enumerate()
            .map(|(i, s)| (s.name.as_str(), index_u32(i)))
            .collect();

        let mut catalog_relations = Vec::with_capacity(relations.len());
        let mut by_id: HashMap<i32, usize> = HashMap::with_capacity(relations.len());
        for row in &relations {
            let schema = text_req(row, 1)?;
            let Some(&schema) = schema_index.get(schema.as_str()) else {
                continue;
            };
            by_id.insert(int(row, 0)?, catalog_relations.len());
            catalog_relations.push(CatalogRelation {
                schema: Some(schema),
                name: text_req(row, 2)?,
                kind: relation_kind(&text_req(row, 3)?),
                columns: Vec::new(),
                column_types: Vec::new(),
            });
        }
        // (column id, name, type) per relation, sorted by column id afterwards.
        let mut attributes: Vec<Vec<(i32, String, u32)>> =
            vec![Vec::new(); catalog_relations.len()];
        let mut types = TypeInterner::default();
        for row in &columns {
            let Some(&relation) = by_id.get(&int(row, 0)?) else {
                continue;
            };
            let type_id = types.intern(&text_req(row, 3)?);
            attributes[relation].push((int(row, 1)?, text_req(row, 2)?, type_id));
        }
        let mut column_ids: Vec<Vec<i32>> = Vec::with_capacity(attributes.len());
        for (relation, mut attrs) in catalog_relations.iter_mut().zip(attributes) {
            attrs.sort_unstable_by_key(|a| a.0);
            column_ids.push(attrs.iter().map(|a| a.0).collect());
            relation.column_types = attrs.iter().map(|a| a.2).collect();
            relation.columns = attrs.into_iter().map(|a| a.1).collect();
        }

        let mut catalog_routines = Vec::with_capacity(routines.len());
        for row in &routines {
            let schema = text_req(row, 1)?;
            let Some(&schema) = schema_index.get(schema.as_str()) else {
                continue;
            };
            let procedure = flag(row, 3)?;
            catalog_routines.push(CatalogRoutine {
                schema: Some(schema),
                name: text_req(row, 2)?,
                kind: if procedure {
                    ObjectKind::Procedure
                } else {
                    ObjectKind::Function
                },
                arguments: arguments
                    .get(&int(row, 0)?)
                    .map(|a| a.0.clone())
                    .unwrap_or_default(),
                return_type: text(row, 4)?,
            });
        }

        // Rows come by constraint, in column order: (from, from column, to, to column).
        let mut constraints: Vec<(i32, Vec<[i32; 4]>)> = Vec::new();
        for row in &foreign_keys {
            let id = int(row, 0)?;
            let pair = [int(row, 1)?, int(row, 2)?, int(row, 3)?, int(row, 4)?];
            match constraints.last_mut() {
                Some((last, pairs)) if *last == id => pairs.push(pair),
                _ => constraints.push((id, vec![pair])),
            }
        }
        let position = |relation: usize, column: i32| {
            column_ids
                .get(relation)
                .and_then(|ids| ids.binary_search(&column).ok())
                .map(index_u32)
        };
        let mut catalog_fks = Vec::with_capacity(constraints.len());
        for (_, pairs) in constraints {
            let (Some(&from), Some(&to)) = (by_id.get(&pairs[0][0]), by_id.get(&pairs[0][2]))
            else {
                continue;
            };
            let from_columns: Option<Vec<u32>> =
                pairs.iter().map(|p| position(from, p[1])).collect();
            let to_columns: Option<Vec<u32>> = pairs.iter().map(|p| position(to, p[3])).collect();
            if let (Some(from_columns), Some(to_columns)) = (from_columns, to_columns) {
                catalog_fks.push(CatalogForeignKey {
                    from: index_u32(from),
                    from_columns,
                    to: index_u32(to),
                    to_columns,
                });
            }
        }

        let search_path = match search_path.first() {
            Some(row) => text(row, 0)?.into_iter().collect(),
            None => Vec::new(),
        };
        Ok(CompletionCatalog {
            database: database.to_owned(),
            schemas,
            search_path,
            type_names: types.into_names(),
            relations: catalog_relations,
            routines: catalog_routines,
            foreign_keys: catalog_fks,
        })
    }
}

impl Introspector for MssqlConnection {
    fn databases(&self) -> MetaFuture<'_, Vec<DatabaseInfo>> {
        Box::pin(async move {
            self.meta("master", DATABASES_SQL, &[])
                .await?
                .iter()
                .map(|row| {
                    Ok(DatabaseInfo {
                        name: text_req(row, 0)?,
                        current: flag(row, 1)?,
                        system: flag(row, 2)?,
                        accessible: flag(row, 3)?,
                        comment: None,
                    })
                })
                .collect()
        })
    }

    fn schemas<'a>(&'a self, database: &'a str) -> MetaFuture<'a, Vec<SchemaInfo>> {
        Box::pin(self.list_schemas(database))
    }

    fn object_counts<'a>(
        &'a self,
        database: &'a str,
        schema: Option<&'a str>,
    ) -> MetaFuture<'a, Vec<ObjectCount>> {
        Box::pin(async move {
            let schema = schema_of(schema)?;
            let rows = self.meta(database, &counts_sql(), &[schema.into()]).await?;
            let Some(row) = rows.first() else {
                return Err(YadbeError::object_not_found(schema));
            };
            Ok(vec![
                ObjectCount {
                    kind: ObjectKind::Table,
                    count: count(row, 0)?,
                    system_count: count(row, 1)?,
                },
                ObjectCount {
                    kind: ObjectKind::View,
                    count: count(row, 2)?,
                    system_count: count(row, 3)?,
                },
                ObjectCount {
                    kind: ObjectKind::Function,
                    count: count(row, 4)?,
                    system_count: count(row, 5)?,
                },
                ObjectCount {
                    kind: ObjectKind::Procedure,
                    count: count(row, 6)?,
                    system_count: count(row, 7)?,
                },
                ObjectCount {
                    kind: ObjectKind::Sequence,
                    count: count(row, 8)?,
                    system_count: 0,
                },
                ObjectCount {
                    kind: ObjectKind::Type,
                    count: count(row, 9)?,
                    system_count: 0,
                },
            ])
        })
    }

    fn objects<'a>(
        &'a self,
        database: &'a str,
        schema: Option<&'a str>,
        kind: ObjectKind,
    ) -> MetaFuture<'a, Vec<ObjectInfo>> {
        Box::pin(async move {
            let schema = schema_of(schema)?;
            match kind {
                ObjectKind::Table | ObjectKind::View | ObjectKind::MaterializedView => {
                    self.relations(database, schema, kind).await
                }
                ObjectKind::Function | ObjectKind::Procedure => {
                    self.routines(database, schema, kind).await
                }
                ObjectKind::Sequence => self.sequences(database, schema).await,
                ObjectKind::Type => self.types(database, schema).await,
            }
        })
    }

    fn table_details<'a>(&'a self, table: &'a ObjectRef) -> MetaFuture<'a, TableDetails> {
        Box::pin(async move {
            schema_of(table.schema.as_deref())?;
            self.details(table).await
        })
    }

    fn completion_catalog<'a>(
        &'a self,
        database: &'a str,
        include_system: bool,
    ) -> MetaFuture<'a, CompletionCatalog> {
        Box::pin(self.catalog(database, include_system))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_type_families() {
        assert_eq!(kind_of_name("nvarchar"), ValueKind::Text);
        assert_eq!(kind_of_name("money"), ValueKind::Decimal);
        assert_eq!(kind_of_name("datetimeoffset"), ValueKind::TimestampTz);
        assert_eq!(kind_of_name("udt"), ValueKind::Other);
        assert_eq!(fk_action(1), ForeignKeyAction::Cascade);
        assert_eq!(relation_kind("V "), ObjectKind::View);
    }

    #[test]
    fn qualifies_catalog_views_with_the_database() {
        let sql = relations_sql(TABLE_TYPES).replace("{db}", "[x]]y]");
        assert!(sql.contains("FROM [x]]y].sys.objects o"), "{sql}");
        assert!(!sql.contains("{db}"));
    }
}
