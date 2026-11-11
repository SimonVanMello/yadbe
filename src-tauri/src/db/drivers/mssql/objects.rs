//! SQL Server object tools (M3-8): definitions from `sys.sql_modules`, table facts from the
//! catalog views, what depends on an object from `sys.sql_expression_dependencies` and the
//! foreign keys. Names are bound as RPC parameters; the database is quoted into `{db}`.

use super::MssqlConnection;
use super::introspect::{Param, ROW_COUNT, big, description, estimate, schema_of, text, text_req};
use crate::db::errors::YadbeError;
use crate::db::meta::ObjectKind;
use crate::db::meta::ObjectRef;
use crate::db::object_model::{
    DdlSource, DdlTarget, Dependent, ObjectDdl, ObjectDependents, ObjectProperties,
};

const DEFINITION_SQL: &str = "\
SELECT m.definition
FROM {db}.sys.objects o
JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id
JOIN {db}.sys.sql_modules m ON m.object_id = o.object_id
WHERE s.name = @P1 AND o.name = @P2 AND o.type IN ";

const VIEW_TYPES: &str = "('V')";
const FUNCTION_TYPES: &str = "('FN', 'IF', 'TF', 'FS', 'FT', 'AF')";
const PROCEDURE_TYPES: &str = "('P', 'PC', 'X', 'RF')";

fn properties_sql() -> String {
    format!(
        "SELECT o.object_id, dp.name, CONVERT(varchar(19), o.create_date, 120),
       CONVERT(varchar(19), o.modify_date, 120), CAST(ep.value AS nvarchar(max)),
       CAST({ROW_COUNT} AS bigint)
FROM {{db}}.sys.objects o
JOIN {{db}}.sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN {{db}}.sys.database_principals dp ON dp.principal_id = ISNULL(o.principal_id, s.principal_id)
{}
WHERE s.name = @P1 AND o.name = @P2 AND o.type IN ('U', 'V')",
        description("ep", 1, "o.object_id", "0")
    )
}

/// Pages in use by the table's data (heap or clustered index) and by its other indexes.
const SIZES_SQL: &str = "\
SELECT CAST(CASE WHEN p.index_id IN (0, 1) THEN 1 ELSE 0 END AS bit),
       CAST(SUM(au.used_pages) AS bigint)
FROM {db}.sys.partitions p
JOIN {db}.sys.allocation_units au
  ON (au.type IN (1, 3) AND au.container_id = p.hobt_id)
  OR (au.type = 2 AND au.container_id = p.partition_id)
WHERE p.object_id = @P1
GROUP BY CASE WHEN p.index_id IN (0, 1) THEN 1 ELSE 0 END";

/// `STATS_DATE` reads the current database: it runs inside the table's own.
const STATS_SQL: &str = "\
EXEC {db}.sys.sp_executesql
  N'SELECT CONVERT(varchar(19), MAX(STATS_DATE(object_id, stats_id)), 120) FROM sys.stats WHERE object_id = @id',
  N'@id int', @id = @P1";

const REFERENCING_SQL: &str = "\
SELECT DISTINCT o.type, s.name, o.name
FROM {db}.sys.sql_expression_dependencies d
JOIN {db}.sys.objects o ON o.object_id = d.referencing_id
JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id
WHERE d.referenced_database_name IS NULL AND d.referenced_schema_name = @P1
  AND d.referenced_entity_name = @P2 AND o.type IN ('V', 'FN', 'IF', 'TF', 'P', 'U')
ORDER BY 2, 3";

const REFERENCING_KEYS_SQL: &str = "\
SELECT s.name, o.name, fk.name
FROM {db}.sys.foreign_keys fk
JOIN {db}.sys.objects o ON o.object_id = fk.parent_object_id
JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id
JOIN {db}.sys.objects ro ON ro.object_id = fk.referenced_object_id
JOIN {db}.sys.schemas rs ON rs.schema_id = ro.schema_id
WHERE rs.name = @P1 AND ro.name = @P2 AND fk.parent_object_id <> fk.referenced_object_id
ORDER BY 1, 2, 3";

const PAGE_BYTES: f64 = 8192.0;

fn dependent_kind(object_type: &str) -> ObjectKind {
    match object_type.trim() {
        "V" => ObjectKind::View,
        "FN" | "IF" | "TF" => ObjectKind::Function,
        "P" => ObjectKind::Procedure,
        _ => ObjectKind::Table,
    }
}

impl MssqlConnection {
    pub(super) async fn native_definition(
        &self,
        target: &DdlTarget,
    ) -> Result<Option<ObjectDdl>, YadbeError> {
        let DdlTarget::Object { object, kind, .. } = target else {
            return Ok(None);
        };
        let types = match kind {
            ObjectKind::View => VIEW_TYPES,
            ObjectKind::Function => FUNCTION_TYPES,
            ObjectKind::Procedure => PROCEDURE_TYPES,
            _ => return Ok(None),
        };
        let schema = schema_of(object.schema.as_deref())?;
        let rows = self
            .meta(
                &object.database,
                &format!("{DEFINITION_SQL}{types}"),
                &[schema.into(), object.name.as_str().into()],
            )
            .await?;
        // An encrypted module has no text.
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        Ok(text(row, 0)?.map(|definition| ObjectDdl {
            sql: format!("{}\n", definition.trim_end()),
            source: DdlSource::Catalog,
        }))
    }

    pub(super) async fn object_properties(
        &self,
        object: &ObjectRef,
        kind: ObjectKind,
    ) -> Result<ObjectProperties, YadbeError> {
        let db = object.database.as_str();
        let schema = schema_of(object.schema.as_deref())?;
        let params = [Param::from(schema), Param::from(object.name.as_str())];
        let rows = self.meta(db, &properties_sql(), &params).await?;
        let Some(row) = rows.first() else {
            return Err(YadbeError::object_not_found(&format!(
                "{schema}.{}",
                object.name
            )));
        };
        let object_id = row
            .try_get::<i32, _>(0)
            .map_err(|e| YadbeError::internal(format!("metadata column 0: {e}")))?
            .unwrap_or_default();
        let mut facts = ObjectProperties::empty(object, kind);
        facts.owner = text(row, 1)?;
        facts.created = text(row, 2)?;
        facts.modified = text(row, 3)?;
        facts.comment = text(row, 4)?;
        if kind == ObjectKind::Table {
            facts.row_estimate = estimate(big(row, 5)?);
            let id = [Param::Int(object_id)];
            let (mut data, mut index) = (None, None);
            for row in self.meta(db, SIZES_SQL, &id).await? {
                let pages = big(&row, 1)?.unwrap_or(0);
                #[allow(clippy::cast_precision_loss)]
                let bytes = pages as f64 * PAGE_BYTES;
                let is_data = row.try_get::<bool, _>(0).ok().flatten().unwrap_or(false);
                if is_data {
                    data = Some(bytes);
                } else {
                    index = Some(bytes);
                }
            }
            facts.data_bytes = data;
            facts.index_bytes = index;
            facts.total_bytes = match (data, index) {
                (None, None) => None,
                (d, i) => Some(d.unwrap_or(0.0) + i.unwrap_or(0.0)),
            };
            // Needs a permission some users lack: the fact is then just missing.
            if let Ok(rows) = self.meta(db, STATS_SQL, &id).await {
                facts.last_analyzed = rows.first().map(|r| text(r, 0)).transpose()?.flatten();
            }
        }
        Ok(facts)
    }

    pub(super) async fn object_dependents(
        &self,
        object: &ObjectRef,
        kind: ObjectKind,
    ) -> Result<ObjectDependents, YadbeError> {
        let db = object.database.as_str();
        let schema = schema_of(object.schema.as_deref())?;
        let params = [Param::from(schema), Param::from(object.name.as_str())];
        let at = |schema: String, name: String| ObjectRef {
            database: object.database.clone(),
            schema: Some(schema),
            name,
        };
        let mut items = Vec::new();
        for row in &self.meta(db, REFERENCING_SQL, &params).await? {
            let object = at(text_req(row, 1)?, text_req(row, 2)?);
            items.push(Dependent {
                kind: dependent_kind(&text_req(row, 0)?),
                via: None,
                object,
            });
        }
        if kind == ObjectKind::Table {
            for row in &self.meta(db, REFERENCING_KEYS_SQL, &params).await? {
                items.push(Dependent {
                    kind: ObjectKind::Table,
                    via: Some(format!("foreign key {}", text_req(row, 2)?)),
                    object: at(text_req(row, 0)?, text_req(row, 1)?),
                });
            }
        }
        Ok(ObjectDependents {
            // Sequences and types are used from places the dependency views do not cover.
            complete: !matches!(kind, ObjectKind::Sequence | ObjectKind::Type),
            items,
        })
    }
}
