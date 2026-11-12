//! PostgreSQL object tools (M3-8): definitions from `pg_get_viewdef` / `pg_get_functiondef`,
//! table facts from the statistics views, and what depends on an object from `pg_depend`.
//! Names are bound parameters.

use super::PgConnection;
use super::introspect::{estimate, get, relation_kind};
use crate::db::dialect::PostgresDialect;
use crate::db::errors::YadbeError;
use crate::db::meta::{ObjectDetail, ObjectInfo, ObjectKind, ObjectRef, qualified_name};
use crate::db::object_model::{
    DdlSource, DdlTarget, DependencyLink, Dependent, ObjectDdl, ObjectDependents, ObjectProperties,
};

const VIEW_DEFINITION_SQL: &str = "\
SELECT pg_get_viewdef(c.oid, true)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind::text = ANY($3)";

const FUNCTION_DEFINITION_SQL: &str = "\
SELECT pg_get_functiondef(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = $1 AND p.proname = $2
  AND pg_get_function_identity_arguments(p.oid) = $3
  AND (p.prokind = 'p') = $4 AND p.prokind <> 'a'";

/// A domain: base type, `NOT NULL`, default and its constraints as the server prints them.
const DOMAIN_SQL: &str = "\
SELECT format_type(t.typbasetype, t.typtypmod), t.typnotnull, pg_get_expr(t.typdefaultbin, 0),
       ARRAY(SELECT 'CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid, true)
             FROM pg_constraint c WHERE c.contypid = t.oid ORDER BY c.conname)
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = $1 AND t.typname = $2 AND t.typtype = 'd'";

const PROPERTIES_SQL: &str = "\
SELECT pg_get_userbyid(c.relowner)::text, obj_description(c.oid, 'pg_class'), c.reltuples::float8,
       CASE WHEN c.relkind IN ('r', 'm', 'p') THEN pg_relation_size(c.oid) END,
       CASE WHEN c.relkind IN ('r', 'm', 'p') THEN pg_indexes_size(c.oid) END,
       CASE WHEN c.relkind IN ('r', 'm', 'p') THEN pg_total_relation_size(c.oid) END,
       to_char(GREATEST(s.last_analyze, s.last_autoanalyze), 'YYYY-MM-DD HH24:MI:SS'),
       to_char(GREATEST(s.last_vacuum, s.last_autovacuum), 'YYYY-MM-DD HH24:MI:SS')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'f', 'v', 'm')";

/// Views and materialized views whose query reads the relation.
const DEPENDENT_VIEWS_SQL: &str = "\
SELECT DISTINCT vc.relkind::text, vn.nspname::text, vc.relname::text
FROM pg_depend d
JOIN pg_rewrite r ON r.oid = d.objid
JOIN pg_class vc ON vc.oid = r.ev_class
JOIN pg_namespace vn ON vn.oid = vc.relnamespace
JOIN pg_class t ON t.oid = d.refobjid
JOIN pg_namespace tn ON tn.oid = t.relnamespace
WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
  AND d.deptype = 'n' AND vc.oid <> t.oid AND tn.nspname = $1 AND t.relname = $2
ORDER BY 2, 3";

/// Columns of a table or view declared with the type.
const TYPE_USERS_SQL: &str = "\
SELECT DISTINCT c.relkind::text, cn.nspname::text, c.relname::text, a.attname::text
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace cn ON cn.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
JOIN pg_namespace tn ON tn.oid = t.typnamespace
WHERE tn.nspname = $1 AND t.typname = $2 AND a.attnum > 0 AND NOT a.attisdropped
  AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
ORDER BY 2, 3, 4";

fn schema_of(object: &ObjectRef) -> Result<&str, YadbeError> {
    object.schema.as_deref().ok_or_else(|| {
        YadbeError::invalid_argument(
            "This engine needs a schema name.",
            "Ce moteur a besoin d'un nom de schéma.",
        )
    })
}

fn bytes(value: Option<i64>) -> Option<f64> {
    #[allow(clippy::cast_precision_loss)]
    value.map(|n| n as f64)
}

impl PgConnection {
    pub(super) async fn native_definition(
        &self,
        target: &DdlTarget,
        info: Option<&ObjectInfo>,
    ) -> Result<Option<ObjectDdl>, YadbeError> {
        let DdlTarget::Object { object, kind, .. } = target else {
            return Ok(None);
        };
        let schema = schema_of(object)?;
        let name = qualified_name(&PostgresDialect, object);
        let catalog = |sql: String| ObjectDdl {
            sql,
            source: DdlSource::Catalog,
        };
        match kind {
            ObjectKind::View | ObjectKind::MaterializedView => {
                let relkind: &[&str] = if *kind == ObjectKind::View {
                    &["v"]
                } else {
                    &["m"]
                };
                let rows = self
                    .meta(VIEW_DEFINITION_SQL, &[&schema, &object.name, &relkind])
                    .await?;
                let Some(row) = rows.first() else {
                    return Err(YadbeError::object_not_found(&format!(
                        "{schema}.{}",
                        object.name
                    )));
                };
                let query: String = get(row, 0)?;
                let word = if *kind == ObjectKind::View {
                    "VIEW"
                } else {
                    "MATERIALIZED VIEW"
                };
                Ok(Some(catalog(format!(
                    "CREATE {word} {name} AS\n{}\n",
                    query.trim_end()
                ))))
            }
            ObjectKind::Function | ObjectKind::Procedure => {
                let Some(ObjectDetail::Routine(routine)) = info.map(|i| &i.detail) else {
                    return Ok(None);
                };
                let procedure = *kind == ObjectKind::Procedure;
                let rows = self
                    .meta(
                        FUNCTION_DEFINITION_SQL,
                        &[
                            &schema,
                            &object.name,
                            &routine.identity_arguments,
                            &procedure,
                        ],
                    )
                    .await?;
                match rows.first() {
                    Some(row) => {
                        let text: String = get(row, 0)?;
                        Ok(Some(catalog(format!("{};\n", text.trim_end()))))
                    }
                    // An aggregate has no function body to print.
                    None => Ok(None),
                }
            }
            ObjectKind::Type => {
                let rows = self.meta(DOMAIN_SQL, &[&schema, &object.name]).await?;
                let Some(row) = rows.first() else {
                    return Ok(None);
                };
                let base: String = get(row, 0)?;
                let not_null: bool = get(row, 1)?;
                let default: Option<String> = get(row, 2)?;
                let constraints: Vec<String> = get(row, 3)?;
                let mut sql = format!(
                    "-- Reconstructed by yadbe from the catalog: PostgreSQL keeps no definition text for a type.\nCREATE DOMAIN {name} AS {base}"
                );
                if let Some(default) = default {
                    sql.push_str(&format!("\n  DEFAULT {default}"));
                }
                if not_null {
                    sql.push_str("\n  NOT NULL");
                }
                for constraint in constraints {
                    sql.push_str(&format!("\n  {constraint}"));
                }
                sql.push_str(";\n");
                Ok(Some(ObjectDdl {
                    sql,
                    source: DdlSource::Reconstructed,
                }))
            }
            ObjectKind::Table | ObjectKind::Sequence => Ok(None),
        }
    }

    pub(super) async fn object_properties(
        &self,
        object: &ObjectRef,
        kind: ObjectKind,
    ) -> Result<ObjectProperties, YadbeError> {
        let schema = schema_of(object)?;
        let rows = self.meta(PROPERTIES_SQL, &[&schema, &object.name]).await?;
        let Some(row) = rows.first() else {
            return Err(YadbeError::object_not_found(&format!(
                "{schema}.{}",
                object.name
            )));
        };
        let mut facts = ObjectProperties::empty(object, kind);
        facts.owner = get(row, 0)?;
        facts.comment = get(row, 1)?;
        if kind != ObjectKind::View {
            facts.row_estimate = estimate(get(row, 2)?);
        }
        facts.data_bytes = bytes(get(row, 3)?);
        facts.index_bytes = bytes(get(row, 4)?);
        facts.total_bytes = bytes(get(row, 5)?);
        facts.last_analyzed = get(row, 6)?;
        facts.last_vacuumed = get(row, 7)?;
        Ok(facts)
    }

    pub(super) async fn object_dependents(
        &self,
        object: &ObjectRef,
        kind: ObjectKind,
    ) -> Result<ObjectDependents, YadbeError> {
        let schema = schema_of(object)?;
        let at = |schema: String, name: String| ObjectRef {
            database: object.database.clone(),
            schema: Some(schema),
            name,
        };
        let mut items = Vec::new();
        match kind {
            ObjectKind::Table | ObjectKind::View | ObjectKind::MaterializedView => {
                let views = self
                    .meta(DEPENDENT_VIEWS_SQL, &[&schema, &object.name])
                    .await?;
                for row in &views {
                    items.push(Dependent {
                        kind: relation_kind(&get::<String>(row, 0)?),
                        object: at(get(row, 1)?, get(row, 2)?),
                        via: None,
                    });
                }
                if kind == ObjectKind::Table {
                    for key in self.incoming(object).await?.keys {
                        // A table that references itself does not block its own drop.
                        if key.table.schema.as_deref() == Some(schema)
                            && key.table.name == object.name
                        {
                            continue;
                        }
                        items.push(Dependent {
                            kind: ObjectKind::Table,
                            via: Some(DependencyLink::ForeignKey {
                                name: key
                                    .foreign_key
                                    .name
                                    .unwrap_or_else(|| key.foreign_key.columns.join(", ")),
                            }),
                            object: key.table,
                        });
                    }
                }
            }
            ObjectKind::Type => {
                for row in &self.meta(TYPE_USERS_SQL, &[&schema, &object.name]).await? {
                    items.push(Dependent {
                        kind: relation_kind(&get::<String>(row, 0)?),
                        object: at(get(row, 1)?, get(row, 2)?),
                        via: Some(DependencyLink::Column { name: get(row, 3)? }),
                    });
                }
            }
            // Routines and sequences are used by defaults, bodies and triggers that the
            // catalog does not list reliably.
            ObjectKind::Function | ObjectKind::Procedure | ObjectKind::Sequence => {
                return Ok(ObjectDependents::unknown());
            }
        }
        Ok(ObjectDependents {
            complete: true,
            items,
        })
    }
}
