//! PostgreSQL introspection on `pg_catalog` (12+): exact type names with modifiers,
//! overloads, identity and generated columns, which `information_schema` loses or reads
//! slowly. Names are always bound parameters; independent queries are pipelined on the
//! connection.

use std::collections::HashMap;

use futures_util::future::{try_join, try_join3, try_join4};
use tokio_postgres::Row;
use tokio_postgres::types::{FromSql, ToSql, Type};

use super::decode::kind_of;
use super::{PgConnection, classify_query};
use crate::db::driver::recorded;
use crate::db::errors::YadbeError;
use crate::db::introspect::{Introspector, MetaFuture, TypeInterner, index_u32};
use crate::db::meta::{
    CatalogForeignKey, CatalogRelation, CatalogRoutine, CatalogSchema, CheckConstraint, ColumnInfo,
    ColumnRef, CompletionCatalog, DatabaseInfo, ForeignKey, ForeignKeyAction, Generated, Identity,
    IncomingForeignKey, IncomingForeignKeys, IndexInfo, KeyConstraint, ObjectCount, ObjectDetail,
    ObjectInfo, ObjectKind, ObjectRef, RelationSummary, RoutineSignature, SchemaInfo,
    SequenceSummary, TableDetails, TriggerEvent, TriggerInfo, TriggerTiming, TypeAttribute,
    TypeCategory, TypeSummary,
};
use crate::db::value::ValueKind;

const DATABASES_SQL: &str = "\
SELECT d.datname::text, d.datname = current_database(), d.datistemplate,
       has_database_privilege(d.oid, 'CONNECT'), shobj_description(d.oid, 'pg_database')
FROM pg_database d
WHERE d.datallowconn
ORDER BY d.datname";

const SCHEMAS_SQL: &str = r"
SELECT n.nspname::text, n.nspname IN ('pg_catalog', 'information_schema', 'pg_toast'),
       pg_get_userbyid(n.nspowner)::text, obj_description(n.oid, 'pg_namespace')
FROM pg_namespace n
WHERE n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast\_temp\_%'
ORDER BY n.nspname";

/// User-visible types: enums, domains, ranges, standalone composites, base types (not
/// arrays, not the row types of tables).
const TYPE_FILTER: &str = "\
(t.typtype IN ('e', 'd', 'r')
 OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class tc WHERE tc.oid = t.typrelid AND tc.relkind = 'c'))
 OR (t.typtype = 'b' AND t.typcategory <> 'A'))";

const RELATION_LIST_SQL: &str = "\
SELECT c.relname::text, c.relkind::text, d.description, c.reltuples::float8
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_description d
  ON d.objoid = c.oid AND d.classoid = 'pg_class'::regclass AND d.objsubid = 0
WHERE n.nspname = $1 AND c.relkind::text = ANY($2) AND NOT c.relispartition
ORDER BY c.relname";

const ROUTINE_LIST_SQL: &str = "\
SELECT p.proname::text, pg_get_function_identity_arguments(p.oid),
       pg_get_function_arguments(p.oid),
       CASE WHEN p.prokind <> 'p' THEN pg_get_function_result(p.oid) END,
       l.lanname::text, p.prokind = 'a', d.description
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_language l ON l.oid = p.prolang
LEFT JOIN pg_description d
  ON d.objoid = p.oid AND d.classoid = 'pg_proc'::regclass AND d.objsubid = 0
WHERE n.nspname = $1 AND (p.prokind = 'p') = $2
ORDER BY p.proname, 2";

const SEQUENCE_LIST_SQL: &str = "\
SELECT c.relname::text, format_type(s.seqtypid, NULL), s.seqstart::text, s.seqincrement::text,
       s.seqmin::text, s.seqmax::text, s.seqcycle, d.description,
       tn.nspname::text, tc.relname::text, a.attname::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_sequence s ON s.seqrelid = c.oid
LEFT JOIN pg_description d
  ON d.objoid = c.oid AND d.classoid = 'pg_class'::regclass AND d.objsubid = 0
LEFT JOIN pg_depend dep
  ON dep.classid = 'pg_class'::regclass AND dep.objid = c.oid
 AND dep.refclassid = 'pg_class'::regclass AND dep.refobjsubid > 0 AND dep.deptype IN ('a', 'i')
LEFT JOIN pg_class tc ON tc.oid = dep.refobjid
LEFT JOIN pg_namespace tn ON tn.oid = tc.relnamespace
LEFT JOIN pg_attribute a ON a.attrelid = dep.refobjid AND a.attnum = dep.refobjsubid
WHERE n.nspname = $1 AND c.relkind = 'S'
ORDER BY c.relname";

const RELATION_SQL: &str = "\
SELECT c.oid, c.relkind::text, d.description, c.reltuples::float8
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_description d
  ON d.objoid = c.oid AND d.classoid = 'pg_class'::regclass AND d.objsubid = 0
WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'f', 'v', 'm')";

const COLUMNS_SQL: &str = "\
SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
       pg_get_expr(ad.adbin, ad.adrelid), a.attidentity::text, a.attgenerated::text,
       col_description(a.attrelid, a.attnum),
       COALESCE(bt.oid, t.oid), COALESCE(bt.typtype, t.typtype)::text,
       COALESCE(bt.typcategory, t.typcategory)::text
FROM pg_attribute a
JOIN pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_type bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum";

const CONSTRAINTS_SQL: &str = "\
SELECT con.conname::text, con.contype::text,
       ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o),
       fn.nspname::text, fc.relname::text,
       ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
             JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o),
       con.confupdtype::text, con.confdeltype::text, con.condeferrable,
       CASE WHEN con.contype = 'c' THEN pg_get_expr(con.conbin, con.conrelid, true) END
FROM pg_constraint con
LEFT JOIN pg_class fc ON fc.oid = con.confrelid
LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'f', 'c')
ORDER BY con.conname";

/// Foreign keys referencing a table, partition clones left out (`conparentid`).
const INCOMING_FOREIGN_KEYS_SQL: &str = "\
SELECT n.nspname::text, c.relname::text, con.conname::text,
       ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
             JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o),
       ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
             JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o),
       con.confupdtype::text, con.confdeltype::text, con.condeferrable
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_class rc ON rc.oid = con.confrelid
JOIN pg_namespace rn ON rn.oid = rc.relnamespace
WHERE con.contype = 'f' AND con.conparentid = 0 AND rn.nspname = $1 AND rc.relname = $2
ORDER BY n.nspname, c.relname, con.conname";

const INDEXES_SQL: &str = "\
SELECT ic.relname::text, i.indisunique, i.indisprimary, am.amname::text,
       ARRAY(SELECT CASE WHEN i.indkey[k.n - 1] <> 0
                         THEN (SELECT a.attname::text FROM pg_attribute a
                               WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[k.n - 1])
                         ELSE pg_get_indexdef(i.indexrelid, k.n, true) END
             FROM generate_series(1, i.indnkeyatts::int) k(n) ORDER BY k.n),
       pg_get_expr(i.indpred, i.indrelid, true), pg_get_indexdef(i.indexrelid)
FROM pg_index i
JOIN pg_class ic ON ic.oid = i.indexrelid
JOIN pg_am am ON am.oid = ic.relam
WHERE i.indrelid = $1
ORDER BY ic.relname";

const TRIGGERS_SQL: &str = "\
SELECT t.tgname::text, t.tgtype::int4, t.tgenabled::text,
       quote_ident(pn.nspname) || '.' || quote_ident(p.proname),
       pg_get_triggerdef(t.oid, true)
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
JOIN pg_namespace pn ON pn.oid = p.pronamespace
WHERE t.tgrelid = $1 AND NOT t.tgisinternal
ORDER BY t.tgname";

const SEARCH_PATH_SQL: &str = "SELECT current_schemas(false)::text[]";

/// Relations of the catalog; shared by the relation and column queries.
macro_rules! catalog_relations {
    () => {
        r"c.relkind IN ('r', 'p', 'f', 'v', 'm') AND NOT c.relispartition
  AND n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast\_temp\_%'
  AND n.nspname <> 'pg_toast'
  AND ($1 OR n.nspname NOT IN ('pg_catalog', 'information_schema'))"
    };
}

// The catalog is read flat (no aggregation, no per-row lookups): on 10k relations the
// server answers in a fraction of the time `array_agg` / correlated subqueries take.
const CATALOG_RELATIONS_SQL: &str = concat!(
    "SELECT c.oid, n.nspname::text, c.relname::text, c.relkind::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE ",
    catalog_relations!(),
    "
ORDER BY 2, 3"
);

const CATALOG_COLUMNS_SQL: &str = concat!(
    "SELECT a.attrelid, a.attnum, a.attname::text, a.atttypid, a.atttypmod
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE a.attnum > 0 AND NOT a.attisdropped AND ",
    catalog_relations!()
);

/// Names of the distinct (type, modifier) pairs the columns use.
const CATALOG_TYPE_NAMES_SQL: &str = "\
SELECT t.id, t.modifier, format_type(t.id, t.modifier)
FROM unnest($1::oid[], $2::int4[]) AS t(id, modifier)";

const CATALOG_ROUTINES_SQL: &str = r"
SELECT n.nspname::text, p.proname::text, p.prokind = 'p', pg_get_function_arguments(p.oid),
       CASE WHEN p.prokind <> 'p' THEN pg_get_function_result(p.oid) END
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname <> 'pg_toast'
  AND ($1 OR n.nspname NOT IN ('pg_catalog', 'information_schema'))
ORDER BY 1, 2";

const CATALOG_FOREIGN_KEYS_SQL: &str = "\
SELECT con.conrelid, con.confrelid, con.conkey, con.confkey
FROM pg_constraint con
WHERE con.contype = 'f'";

/// A catalog column: attnum, name, (type oid, type modifier).
type Attribute = (i16, String, (u32, i32));

fn get<'a, T: FromSql<'a>>(row: &'a Row, index: usize) -> Result<T, YadbeError> {
    row.try_get(index)
        .map_err(|e| YadbeError::internal(format!("metadata column {index}: {e}")))
}

fn counts_sql() -> String {
    let ns = "(SELECT oid FROM ns)";
    let rel = |kinds: &str| {
        format!(
            "(SELECT count(*) FROM pg_class c WHERE c.relnamespace = {ns} \
             AND c.relkind IN ({kinds}) AND NOT c.relispartition)::int4"
        )
    };
    let proc = |op: &str| {
        format!(
            "(SELECT count(*) FROM pg_proc p WHERE p.pronamespace = {ns} \
             AND p.prokind {op} 'p')::int4"
        )
    };
    format!(
        "WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = $1)\n\
         SELECT EXISTS (SELECT 1 FROM ns), {}, {}, {}, {}, {}, {},\n\
         (SELECT count(*) FROM pg_type t WHERE t.typnamespace = {ns} AND {TYPE_FILTER})::int4",
        rel("'r', 'p', 'f'"),
        rel("'v'"),
        rel("'m'"),
        proc("<>"),
        proc("="),
        rel("'S'"),
    )
}

fn types_sql() -> String {
    format!(
        "SELECT t.typname::text, t.typtype::text, d.description,
       CASE WHEN t.typtype = 'e' THEN ARRAY(SELECT e.enumlabel::text FROM pg_enum e
            WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) END,
       CASE t.typtype WHEN 'd' THEN format_type(t.typbasetype, t.typtypmod)
            WHEN 'r' THEN (SELECT format_type(r.rngsubtype, NULL) FROM pg_range r
                           WHERE r.rngtypid = t.oid) END,
       CASE WHEN t.typtype = 'c' THEN ARRAY(SELECT a.attname::text FROM pg_attribute a
            WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum) END,
       CASE WHEN t.typtype = 'c' THEN ARRAY(SELECT format_type(a.atttypid, a.atttypmod)
            FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0
            AND NOT a.attisdropped ORDER BY a.attnum) END
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
LEFT JOIN pg_description d
  ON d.objoid = t.oid AND d.classoid = 'pg_type'::regclass AND d.objsubid = 0
WHERE n.nspname = $1 AND {TYPE_FILTER}
ORDER BY t.typname"
    )
}

/// `count(*)` as `u32` (never negative).
fn count(value: i32) -> u32 {
    u32::try_from(value).unwrap_or(0)
}

/// `reltuples`: negative (PG 14+) or zero (before) when never analyzed.
fn estimate(reltuples: f64) -> Option<f64> {
    (reltuples > 0.0).then_some(reltuples)
}

fn relation_kind(relkind: &str) -> ObjectKind {
    match relkind {
        "v" => ObjectKind::View,
        "m" => ObjectKind::MaterializedView,
        _ => ObjectKind::Table,
    }
}

fn fk_action(code: &str) -> ForeignKeyAction {
    match code {
        "r" => ForeignKeyAction::Restrict,
        "c" => ForeignKeyAction::Cascade,
        "n" => ForeignKeyAction::SetNull,
        "d" => ForeignKeyAction::SetDefault,
        _ => ForeignKeyAction::NoAction,
    }
}

/// The logical family of a column from its (domain-resolved) type.
fn column_kind(oid: u32, typtype: &str, category: &str) -> ValueKind {
    if let Some(ty) = Type::from_oid(oid) {
        return kind_of(&ty);
    }
    match (typtype, category) {
        ("e", _) => ValueKind::Text,
        (_, "A") => ValueKind::Array,
        (_, "S") => ValueKind::Text,
        _ => ValueKind::Other,
    }
}

/// Decodes `pg_trigger.tgtype` (see `pg_trigger.h`).
fn trigger_type(tgtype: i32) -> (TriggerTiming, Vec<TriggerEvent>, bool) {
    const ROW: i32 = 1 << 0;
    const BEFORE: i32 = 1 << 1;
    const INSERT: i32 = 1 << 2;
    const DELETE: i32 = 1 << 3;
    const UPDATE: i32 = 1 << 4;
    const TRUNCATE: i32 = 1 << 5;
    const INSTEAD: i32 = 1 << 6;
    let timing = if tgtype & INSTEAD != 0 {
        TriggerTiming::InsteadOf
    } else if tgtype & BEFORE != 0 {
        TriggerTiming::Before
    } else {
        TriggerTiming::After
    };
    let events = [
        (INSERT, TriggerEvent::Insert),
        (UPDATE, TriggerEvent::Update),
        (DELETE, TriggerEvent::Delete),
        (TRUNCATE, TriggerEvent::Truncate),
    ]
    .into_iter()
    .filter(|(bit, _)| tgtype & bit != 0)
    .map(|(_, event)| event)
    .collect();
    (timing, events, tgtype & ROW != 0)
}

impl PgConnection {
    /// Runs one metadata query, recorded in the statement log.
    async fn meta(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, YadbeError> {
        recorded(
            &*self.recorder,
            sql,
            |rows: &Vec<Row>| u64::try_from(rows.len()).ok(),
            async {
                self.client
                    .query(sql, params)
                    .await
                    .map_err(|e| classify_query(&e))
            },
        )
        .await
    }

    async fn list_schemas(&self) -> Result<Vec<SchemaInfo>, YadbeError> {
        self.meta(SCHEMAS_SQL, &[])
            .await?
            .iter()
            .map(|row| {
                Ok(SchemaInfo {
                    name: get(row, 0)?,
                    system: get(row, 1)?,
                    owner: get(row, 2)?,
                    comment: get(row, 3)?,
                })
            })
            .collect()
    }

    async fn relations(
        &self,
        schema: &str,
        kind: ObjectKind,
    ) -> Result<Vec<ObjectInfo>, YadbeError> {
        let relkinds: &[&str] = match kind {
            ObjectKind::View => &["v"],
            ObjectKind::MaterializedView => &["m"],
            _ => &["r", "p", "f"],
        };
        self.meta(RELATION_LIST_SQL, &[&schema, &relkinds])
            .await?
            .iter()
            .map(|row| {
                let name: String = get(row, 0)?;
                let relkind: String = get(row, 1)?;
                Ok(ObjectInfo {
                    kind,
                    id: name.clone(),
                    name,
                    system: false,
                    comment: get(row, 2)?,
                    detail: ObjectDetail::Relation(RelationSummary {
                        row_estimate: if kind == ObjectKind::View {
                            None
                        } else {
                            estimate(get(row, 3)?)
                        },
                        partitioned: relkind == "p",
                        foreign: relkind == "f",
                    }),
                })
            })
            .collect()
    }

    async fn routines(
        &self,
        schema: &str,
        kind: ObjectKind,
    ) -> Result<Vec<ObjectInfo>, YadbeError> {
        let procedures = kind == ObjectKind::Procedure;
        self.meta(ROUTINE_LIST_SQL, &[&schema, &procedures])
            .await?
            .iter()
            .map(|row| {
                let name: String = get(row, 0)?;
                let identity_arguments: String = get(row, 1)?;
                Ok(ObjectInfo {
                    kind,
                    id: format!("{name}({identity_arguments})"),
                    name,
                    system: false,
                    comment: get(row, 6)?,
                    detail: ObjectDetail::Routine(RoutineSignature {
                        arguments: get(row, 2)?,
                        identity_arguments,
                        return_type: get(row, 3)?,
                        language: get(row, 4)?,
                        aggregate: get(row, 5)?,
                    }),
                })
            })
            .collect()
    }

    async fn sequences(&self, database: &str, schema: &str) -> Result<Vec<ObjectInfo>, YadbeError> {
        self.meta(SEQUENCE_LIST_SQL, &[&schema])
            .await?
            .iter()
            .map(|row| {
                let name: String = get(row, 0)?;
                let owner_schema: Option<String> = get(row, 8)?;
                let owner_table: Option<String> = get(row, 9)?;
                let owner_column: Option<String> = get(row, 10)?;
                let owned_by = match (owner_schema, owner_table, owner_column) {
                    (Some(schema), Some(name), Some(column)) => Some(ColumnRef {
                        table: ObjectRef {
                            database: database.to_owned(),
                            schema: Some(schema),
                            name,
                        },
                        column,
                    }),
                    _ => None,
                };
                Ok(ObjectInfo {
                    kind: ObjectKind::Sequence,
                    id: name.clone(),
                    name,
                    system: false,
                    comment: get(row, 7)?,
                    detail: ObjectDetail::Sequence(SequenceSummary {
                        data_type: get(row, 1)?,
                        start: get(row, 2)?,
                        increment: get(row, 3)?,
                        min: get(row, 4)?,
                        max: get(row, 5)?,
                        cycle: get(row, 6)?,
                        owned_by,
                    }),
                })
            })
            .collect()
    }

    async fn types(&self, schema: &str) -> Result<Vec<ObjectInfo>, YadbeError> {
        self.meta(&types_sql(), &[&schema])
            .await?
            .iter()
            .map(|row| {
                let name: String = get(row, 0)?;
                let typtype: String = get(row, 1)?;
                let names: Option<Vec<String>> = get(row, 5)?;
                let types: Option<Vec<String>> = get(row, 6)?;
                let attributes = names
                    .unwrap_or_default()
                    .into_iter()
                    .zip(types.unwrap_or_default())
                    .map(|(name, type_name)| TypeAttribute { name, type_name })
                    .collect();
                Ok(ObjectInfo {
                    kind: ObjectKind::Type,
                    id: name.clone(),
                    name,
                    system: false,
                    comment: get(row, 2)?,
                    detail: ObjectDetail::Type(TypeSummary {
                        category: match typtype.as_str() {
                            "e" => TypeCategory::Enum,
                            "c" => TypeCategory::Composite,
                            "d" => TypeCategory::Domain,
                            "r" => TypeCategory::Range,
                            _ => TypeCategory::Base,
                        },
                        enum_values: get::<Option<Vec<String>>>(row, 3)?.unwrap_or_default(),
                        base_type: get(row, 4)?,
                        attributes,
                    }),
                })
            })
            .collect()
    }

    async fn details(&self, table: &ObjectRef) -> Result<TableDetails, YadbeError> {
        let schema = table.schema.as_deref().unwrap_or_default();
        let relation = self.meta(RELATION_SQL, &[&schema, &table.name]).await?;
        let Some(relation) = relation.first() else {
            return Err(YadbeError::object_not_found(&format!(
                "{schema}.{}",
                table.name
            )));
        };
        let oid: u32 = get(relation, 0)?;
        let kind = relation_kind(&get::<String>(relation, 1)?);
        let (columns, constraints, indexes, triggers) = try_join4(
            self.meta(COLUMNS_SQL, &[&oid]),
            self.meta(CONSTRAINTS_SQL, &[&oid]),
            self.meta(INDEXES_SQL, &[&oid]),
            self.meta(TRIGGERS_SQL, &[&oid]),
        )
        .await?;

        let mut details = TableDetails {
            table: table.clone(),
            kind,
            comment: get(relation, 2)?,
            row_estimate: if kind == ObjectKind::View {
                None
            } else {
                estimate(get(relation, 3)?)
            },
            columns: Vec::with_capacity(columns.len()),
            primary_key: None,
            unique_keys: Vec::new(),
            foreign_keys: Vec::new(),
            checks: Vec::new(),
            indexes: Vec::with_capacity(indexes.len()),
            triggers: Vec::with_capacity(triggers.len()),
        };
        for (index, row) in columns.iter().enumerate() {
            let identity: String = get(row, 4)?;
            let generated: String = get(row, 5)?;
            let default: Option<String> = get(row, 3)?;
            let typtype: String = get(row, 8)?;
            let category: String = get(row, 9)?;
            let is_generated = !generated.is_empty();
            details.columns.push(ColumnInfo {
                name: get(row, 0)?,
                ordinal: index_u32(index + 1),
                type_name: get(row, 1)?,
                kind: column_kind(get(row, 7)?, &typtype, &category),
                nullable: get(row, 2)?,
                identity: match identity.as_str() {
                    "a" => Some(Identity::Always),
                    "d" => Some(Identity::ByDefault),
                    _ => None,
                },
                generated: is_generated.then(|| Generated {
                    stored: generated == "s",
                    expression: default.clone(),
                }),
                default: if is_generated { None } else { default },
                comment: get(row, 6)?,
                primary_key: false,
                foreign_key: false,
            });
        }
        for row in &constraints {
            let name: Option<String> = get(row, 0)?;
            let contype: String = get(row, 1)?;
            let columns: Vec<String> = get(row, 2)?;
            match contype.as_str() {
                "p" => details.primary_key = Some(KeyConstraint { name, columns }),
                "u" => details.unique_keys.push(KeyConstraint { name, columns }),
                "f" => details.foreign_keys.push(ForeignKey {
                    name,
                    columns,
                    referenced_table: ObjectRef {
                        database: table.database.clone(),
                        schema: get(row, 3)?,
                        name: get::<Option<String>>(row, 4)?.unwrap_or_default(),
                    },
                    referenced_columns: get(row, 5)?,
                    on_update: fk_action(&get::<String>(row, 6)?),
                    on_delete: fk_action(&get::<String>(row, 7)?),
                    deferrable: get(row, 8)?,
                }),
                _ => details.checks.push(CheckConstraint {
                    name,
                    expression: get::<Option<String>>(row, 9)?.unwrap_or_default(),
                }),
            }
        }
        details.mark_key_columns();
        for row in &indexes {
            details.indexes.push(IndexInfo {
                name: get(row, 0)?,
                unique: get(row, 1)?,
                primary: get(row, 2)?,
                method: get(row, 3)?,
                columns: get(row, 4)?,
                predicate: get(row, 5)?,
                definition: get(row, 6)?,
            });
        }
        for row in &triggers {
            let (timing, events, for_each_row) = trigger_type(get(row, 1)?);
            details.triggers.push(TriggerInfo {
                name: get(row, 0)?,
                timing,
                events,
                for_each_row,
                enabled: get::<String>(row, 2)? != "D",
                function: get(row, 3)?,
                definition: get(row, 4)?,
            });
        }
        Ok(details)
    }

    async fn incoming(&self, table: &ObjectRef) -> Result<IncomingForeignKeys, YadbeError> {
        let schema = schema_of(table.schema.as_deref())?;
        let rows = self
            .meta(INCOMING_FOREIGN_KEYS_SQL, &[&schema, &table.name])
            .await?;
        let keys = rows
            .iter()
            .map(|row| {
                Ok(IncomingForeignKey {
                    table: ObjectRef {
                        database: table.database.clone(),
                        schema: get(row, 0)?,
                        name: get(row, 1)?,
                    },
                    foreign_key: ForeignKey {
                        name: get(row, 2)?,
                        columns: get(row, 3)?,
                        referenced_table: table.clone(),
                        referenced_columns: get(row, 4)?,
                        on_update: fk_action(&get::<String>(row, 5)?),
                        on_delete: fk_action(&get::<String>(row, 6)?),
                        deferrable: get(row, 7)?,
                    },
                })
            })
            .collect::<Result<_, YadbeError>>()?;
        Ok(IncomingForeignKeys {
            supported: true,
            keys,
        })
    }

    async fn catalog(
        &self,
        database: &str,
        include_system: bool,
    ) -> Result<CompletionCatalog, YadbeError> {
        let ((schemas, search_path, relations), (columns, routines, foreign_keys)) = try_join(
            try_join3(
                self.list_schemas(),
                self.meta(SEARCH_PATH_SQL, &[]),
                self.meta(CATALOG_RELATIONS_SQL, &[&include_system]),
            ),
            try_join3(
                self.meta(CATALOG_COLUMNS_SQL, &[&include_system]),
                self.meta(CATALOG_ROUTINES_SQL, &[&include_system]),
                self.meta(CATALOG_FOREIGN_KEYS_SQL, &[]),
            ),
        )
        .await?;
        let schemas: Vec<CatalogSchema> = schemas
            .into_iter()
            .filter(|s| (include_system || !s.system) && s.name != "pg_toast")
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
        let mut by_oid: HashMap<u32, usize> = HashMap::with_capacity(relations.len());
        for row in &relations {
            let schema: String = get(row, 1)?;
            let Some(&schema) = schema_index.get(schema.as_str()) else {
                continue;
            };
            by_oid.insert(get(row, 0)?, catalog_relations.len());
            catalog_relations.push(CatalogRelation {
                schema: Some(schema),
                name: get(row, 2)?,
                kind: relation_kind(&get::<String>(row, 3)?),
                columns: Vec::new(),
                column_types: Vec::new(),
            });
        }

        // Columns arrive unordered: (attnum, name, type) per relation, sorted afterwards.
        let mut attributes: Vec<Vec<Attribute>> = vec![Vec::new(); catalog_relations.len()];
        let mut pairs: HashMap<(u32, i32), u32> = HashMap::new();
        for row in &columns {
            let Some(&relation) = by_oid.get(&get::<u32>(row, 0)?) else {
                continue;
            };
            let pair = (get(row, 3)?, get(row, 4)?);
            let next = index_u32(pairs.len());
            pairs.entry(pair).or_insert(next);
            attributes[relation].push((get(row, 1)?, get(row, 2)?, pair));
        }
        let mut ids = vec![0_u32; pairs.len()];
        let mut modifiers = vec![0_i32; pairs.len()];
        for (&(id, modifier), &index) in &pairs {
            ids[index as usize] = id;
            modifiers[index as usize] = modifier;
        }
        let mut pair_names: HashMap<(u32, i32), String> = HashMap::with_capacity(pairs.len());
        for row in self
            .meta(CATALOG_TYPE_NAMES_SQL, &[&ids, &modifiers])
            .await?
        {
            pair_names.insert((get(&row, 0)?, get(&row, 1)?), get(&row, 2)?);
        }
        // Type names by pair index, interned once.
        let mut types = TypeInterner::default();
        let mut type_of_pair = vec![0_u32; pairs.len()];
        for (pair, &index) in &pairs {
            type_of_pair[index as usize] =
                types.intern(pair_names.get(pair).map_or("", String::as_str));
        }
        let mut attnums: Vec<Vec<i16>> = Vec::with_capacity(attributes.len());
        for (relation, mut attrs) in catalog_relations.iter_mut().zip(attributes) {
            attrs.sort_unstable_by_key(|a| a.0);
            attnums.push(attrs.iter().map(|a| a.0).collect());
            relation.column_types = attrs
                .iter()
                .map(|a| pairs.get(&a.2).map_or(0, |&i| type_of_pair[i as usize]))
                .collect();
            relation.columns = attrs.into_iter().map(|a| a.1).collect();
        }

        let mut catalog_routines = Vec::with_capacity(routines.len());
        for row in &routines {
            let schema: String = get(row, 0)?;
            let Some(&schema) = schema_index.get(schema.as_str()) else {
                continue;
            };
            catalog_routines.push(CatalogRoutine {
                schema: Some(schema),
                name: get(row, 1)?,
                kind: if get::<bool>(row, 2)? {
                    ObjectKind::Procedure
                } else {
                    ObjectKind::Function
                },
                arguments: get(row, 3)?,
                return_type: get(row, 4)?,
            });
        }

        let mut catalog_fks = Vec::new();
        for row in &foreign_keys {
            let (Some(&from), Some(&to)) = (
                by_oid.get(&get::<u32>(row, 0)?),
                by_oid.get(&get::<u32>(row, 1)?),
            ) else {
                continue;
            };
            // attnum → position among the relation's (sorted) columns.
            let positions = |relation: usize, keys: Vec<i16>| -> Option<Vec<u32>> {
                let sorted = attnums.get(relation)?;
                keys.iter()
                    .map(|n| sorted.binary_search(n).ok().map(index_u32))
                    .collect()
            };
            if let (Some(from_columns), Some(to_columns)) =
                (positions(from, get(row, 2)?), positions(to, get(row, 3)?))
            {
                catalog_fks.push(CatalogForeignKey {
                    from: index_u32(from),
                    from_columns,
                    to: index_u32(to),
                    to_columns,
                });
            }
        }
        let search_path: Vec<String> = match search_path.first() {
            Some(row) => get(row, 0)?,
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

fn schema_of(schema: Option<&str>) -> Result<&str, YadbeError> {
    schema.ok_or_else(|| {
        YadbeError::invalid_argument(
            "This engine needs a schema name.",
            "Ce moteur a besoin d'un nom de schéma.",
        )
    })
}

impl Introspector for PgConnection {
    fn databases(&self) -> MetaFuture<'_, Vec<DatabaseInfo>> {
        Box::pin(async move {
            self.meta(DATABASES_SQL, &[])
                .await?
                .iter()
                .map(|row| {
                    Ok(DatabaseInfo {
                        name: get(row, 0)?,
                        current: get(row, 1)?,
                        system: get(row, 2)?,
                        accessible: get(row, 3)?,
                        comment: get(row, 4)?,
                    })
                })
                .collect()
        })
    }

    fn schemas<'a>(&'a self, _database: &'a str) -> MetaFuture<'a, Vec<SchemaInfo>> {
        Box::pin(self.list_schemas())
    }

    fn object_counts<'a>(
        &'a self,
        _database: &'a str,
        schema: Option<&'a str>,
    ) -> MetaFuture<'a, Vec<ObjectCount>> {
        Box::pin(async move {
            let schema = schema_of(schema)?;
            let rows = self.meta(&counts_sql(), &[&schema]).await?;
            let row = rows
                .first()
                .ok_or_else(|| YadbeError::internal("object counts returned no row"))?;
            if !get::<bool>(row, 0)? {
                return Err(YadbeError::object_not_found(schema));
            }
            [
                ObjectKind::Table,
                ObjectKind::View,
                ObjectKind::MaterializedView,
                ObjectKind::Function,
                ObjectKind::Procedure,
                ObjectKind::Sequence,
                ObjectKind::Type,
            ]
            .into_iter()
            .enumerate()
            .map(|(i, kind)| {
                Ok(ObjectCount {
                    kind,
                    count: count(get(row, i + 1)?),
                    system_count: 0,
                })
            })
            .collect()
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
                    self.relations(schema, kind).await
                }
                ObjectKind::Function | ObjectKind::Procedure => self.routines(schema, kind).await,
                ObjectKind::Sequence => self.sequences(database, schema).await,
                ObjectKind::Type => self.types(schema).await,
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

    fn incoming_foreign_keys<'a>(
        &'a self,
        table: &'a ObjectRef,
    ) -> MetaFuture<'a, IncomingForeignKeys> {
        Box::pin(self.incoming(table))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_trigger_types() {
        // BEFORE UPDATE FOR EACH ROW
        assert_eq!(
            trigger_type(0b1_0011),
            (TriggerTiming::Before, vec![TriggerEvent::Update], true)
        );
        // AFTER INSERT OR DELETE FOR EACH STATEMENT
        assert_eq!(
            trigger_type(0b0_1100),
            (
                TriggerTiming::After,
                vec![TriggerEvent::Insert, TriggerEvent::Delete],
                false
            )
        );
        assert_eq!(trigger_type(0b100_0101).0, TriggerTiming::InsteadOf);
    }

    #[test]
    fn maps_column_kinds() {
        assert_eq!(column_kind(23, "b", "N"), ValueKind::Int);
        assert_eq!(column_kind(99_999, "e", "E"), ValueKind::Text);
        assert_eq!(column_kind(99_999, "b", "A"), ValueKind::Array);
        assert_eq!(column_kind(99_999, "b", "U"), ValueKind::Other);
    }
}
