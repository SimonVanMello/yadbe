//! The engine-neutral metadata model the explorer, the autocomplete and the palette read
//! (F-020 to F-023, F-043, F-120), and the dialect data introspection depends on.
//!
//! Shaped for lazy loading: databases → schemas → object counts → objects of one kind →
//! one table's details, plus one bulk [`CompletionCatalog`] per database. Engines without
//! schemas (SQLite, MySQL) use `schema: null` everywhere; engines with one database per
//! file (SQLite) list a single database.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::dialect::{
    Capabilities, Dialect, MssqlDialect, MysqlDialect, PostgresDialect, SqliteDialect,
};
use crate::db::value::ValueKind;

/// A database object, addressed the same way on every engine.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub database: String,
    /// `null` on engines without schemas.
    pub schema: Option<String>,
    pub name: String,
}

/// Kinds of objects the explorer groups under a schema (or a database without schemas).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ObjectKind {
    /// Tables, partitioned tables and foreign tables (partitions are not listed).
    Table,
    View,
    MaterializedView,
    /// Functions, aggregates and window functions.
    Function,
    Procedure,
    Sequence,
    /// User-defined types: enums, composites, domains, ranges, base types.
    Type,
}

impl ObjectKind {
    /// Kinds whose details are a [`TableDetails`].
    pub fn is_relation(self) -> bool {
        matches!(
            self,
            ObjectKind::Table | ObjectKind::View | ObjectKind::MaterializedView
        )
    }
}

/// A node of the explorer tree, for refreshes and `meta-refreshed` events. A node covers
/// everything below it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "level", rename_all = "camelCase")]
pub enum MetaNode {
    /// The whole connection: databases and everything in them.
    Connection,
    Database {
        database: String,
    },
    /// One schema (or, without schemas, the database's objects).
    Schema {
        database: String,
        schema: Option<String>,
    },
    /// The objects of one kind in a schema, and the details of those objects.
    Objects {
        database: String,
        schema: Option<String>,
        kind: ObjectKind,
    },
    /// One table, view or materialized view.
    Table {
        table: ObjectRef,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    /// The database the connection was opened on.
    pub current: bool,
    /// Engine-provided database (templates…), hidden by default.
    pub system: bool,
    /// The user may connect to it (otherwise expanding it fails).
    pub accessible: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    /// Engine catalog (`pg_catalog`, `information_schema`, `sys`…), hidden by default.
    pub system: bool,
    pub owner: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectCount {
    pub kind: ObjectKind,
    /// Every object of this kind, system ones included.
    pub count: u32,
    /// How many of them are flagged `system` (hidden by default).
    pub system_count: u32,
}

/// One entry of an object list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInfo {
    pub kind: ObjectKind,
    pub name: String,
    /// Unique within its schema and kind: the name, or `name(argument types)` for routines
    /// (overloads share a name).
    pub id: String,
    /// Engine-internal object (`sqlite_sequence`, FTS shadow tables…), hidden by default.
    pub system: bool,
    pub comment: Option<String>,
    /// Kind-specific summary.
    pub detail: ObjectDetail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ObjectDetail {
    Relation(RelationSummary),
    Routine(RoutineSignature),
    Sequence(SequenceSummary),
    Type(TypeSummary),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RelationSummary {
    /// The planner's estimate (statistics), when the engine has one.
    pub row_estimate: Option<f64>,
    /// Partitioned table (its partitions are not listed).
    pub partitioned: bool,
    /// Foreign table (data lives elsewhere).
    pub foreign: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSignature {
    /// Full argument list as the engine prints it (`p_id integer, p_note text DEFAULT ''`).
    pub arguments: String,
    /// Argument types only, which identify an overload (`integer, text`).
    pub identity_arguments: String,
    /// Return type (`numeric`, `SETOF orders`, `TABLE(id integer)`); `null` for procedures.
    pub return_type: Option<String>,
    pub language: Option<String>,
    pub aggregate: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SequenceSummary {
    pub data_type: String,
    /// 64-bit values cross as strings.
    pub start: String,
    pub increment: String,
    pub min: String,
    pub max: String,
    pub cycle: bool,
    /// The column this sequence belongs to (`serial`, identity).
    pub owned_by: Option<ColumnRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnRef {
    pub table: ObjectRef,
    pub column: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TypeCategory {
    Enum,
    Composite,
    Domain,
    Range,
    Base,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TypeSummary {
    pub category: TypeCategory,
    /// Labels of an enum, in their sort order.
    pub enum_values: Vec<String>,
    /// Base type of a domain, subtype of a range.
    pub base_type: Option<String>,
    /// Attributes of a composite type.
    pub attributes: Vec<TypeAttribute>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TypeAttribute {
    pub name: String,
    pub type_name: String,
}

/// Everything the explorer shows below a table, view or materialized view (F-021), and
/// what script generation and editing need.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    pub table: ObjectRef,
    pub kind: ObjectKind,
    pub comment: Option<String>,
    pub row_estimate: Option<f64>,
    /// In ordinal order.
    pub columns: Vec<ColumnInfo>,
    pub primary_key: Option<KeyConstraint>,
    pub unique_keys: Vec<KeyConstraint>,
    /// Outgoing foreign keys.
    pub foreign_keys: Vec<ForeignKey>,
    pub checks: Vec<CheckConstraint>,
    pub indexes: Vec<IndexInfo>,
    pub triggers: Vec<TriggerInfo>,
}

impl TableDetails {
    /// Sets `primaryKey` / `foreignKey` on the columns from the keys.
    pub fn mark_key_columns(&mut self) {
        for column in &mut self.columns {
            column.primary_key = self
                .primary_key
                .as_ref()
                .is_some_and(|pk| pk.columns.contains(&column.name));
            column.foreign_key = self
                .foreign_keys
                .iter()
                .any(|fk| fk.columns.contains(&column.name));
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// 1-based position among the visible columns.
    pub ordinal: u32,
    /// Type as the engine prints it, with modifiers (`character varying(100)`,
    /// `numeric(10,2)`).
    pub type_name: String,
    /// Logical family, as result columns report it.
    pub kind: ValueKind,
    pub nullable: bool,
    /// Default expression, as written in the catalog.
    pub default: Option<String>,
    pub identity: Option<Identity>,
    pub generated: Option<Generated>,
    pub comment: Option<String>,
    /// Part of the primary key (key icon).
    pub primary_key: bool,
    /// Part of an outgoing foreign key (link icon).
    pub foreign_key: bool,
}

/// How an identity / auto-increment column gets its value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Identity {
    /// Values cannot be supplied in a plain `INSERT` (`GENERATED ALWAYS`, SQL Server
    /// `IDENTITY`).
    Always,
    /// Generated when omitted (`GENERATED BY DEFAULT`, SQLite rowid alias, MySQL
    /// `AUTO_INCREMENT`).
    ByDefault,
}

/// A computed column: never written by yadbe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
    /// Stored on disk (otherwise computed on read).
    pub stored: bool,
    /// `null` when the engine does not expose it.
    pub expression: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeyConstraint {
    /// `null` when the engine does not name it (SQLite).
    pub name: Option<String>,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ForeignKeyAction {
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub referenced_table: ObjectRef,
    /// Same length and order as `columns`.
    pub referenced_columns: Vec<String>,
    pub on_update: ForeignKeyAction,
    pub on_delete: ForeignKeyAction,
    pub deferrable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckConstraint {
    pub name: Option<String>,
    /// The condition, without the `CHECK` keyword.
    pub expression: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    /// Key columns in order; an expression key is given as its text.
    pub columns: Vec<String>,
    pub unique: bool,
    /// Backs the primary key.
    pub primary: bool,
    /// Access method (`btree`, `gin`…), when the engine has several.
    pub method: Option<String>,
    /// `WHERE` condition of a partial index.
    pub predicate: Option<String>,
    /// The `CREATE INDEX` statement, when the engine keeps or rebuilds it.
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TriggerTiming {
    Before,
    After,
    InsteadOf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TriggerEvent {
    Insert,
    Update,
    Delete,
    Truncate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    pub timing: TriggerTiming,
    pub events: Vec<TriggerEvent>,
    /// `FOR EACH ROW` (otherwise per statement).
    pub for_each_row: bool,
    pub enabled: bool,
    /// The trigger function, qualified, when the engine has one.
    pub function: Option<String>,
    /// The `CREATE TRIGGER` statement.
    pub definition: Option<String>,
}

/// Everything the autocomplete (M2-5) and the palette (M2-6) need for one database, in one
/// call. Flat and compact: relations carry their columns as parallel arrays, type names
/// are interned in `typeNames`, and references are indices into these arrays.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompletionCatalog {
    pub database: String,
    /// Empty on engines without schemas.
    pub schemas: Vec<CatalogSchema>,
    /// Schemas searched for unqualified names, first match wins (`search_path`).
    pub search_path: Vec<String>,
    /// Distinct column type names; `CatalogRelation.columnTypes` indexes into it.
    pub type_names: Vec<String>,
    pub relations: Vec<CatalogRelation>,
    pub routines: Vec<CatalogRoutine>,
    pub foreign_keys: Vec<CatalogForeignKey>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSchema {
    pub name: String,
    pub system: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRelation {
    /// Index into `schemas`; `null` on engines without schemas.
    pub schema: Option<u32>,
    pub name: String,
    /// `table`, `view` or `materializedView`.
    pub kind: ObjectKind,
    /// Column names in ordinal order.
    pub columns: Vec<String>,
    /// Same length as `columns`: indices into `typeNames`.
    pub column_types: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRoutine {
    pub schema: Option<u32>,
    pub name: String,
    /// `function` or `procedure`.
    pub kind: ObjectKind,
    pub arguments: String,
    pub return_type: Option<String>,
}

/// A foreign key between two relations of the catalog (join suggestions).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogForeignKey {
    /// Index into `relations`.
    pub from: u32,
    /// Indices into `relations[from].columns`.
    pub from_columns: Vec<u32>,
    /// Index into `relations`.
    pub to: u32,
    /// Indices into `relations[to].columns`.
    pub to_columns: Vec<u32>,
}

/// How a `SELECT` is limited to its first rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowLimitSyntax {
    /// `… LIMIT n`
    Limit,
    /// `SELECT TOP (n) …`
    Top,
}

/// What introspection and script generation need to know about an engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetaCapabilities {
    /// Object kinds the engine has, in explorer order.
    pub object_kinds: &'static [ObjectKind],
    /// A connection only sees its own database: browsing another one opens a metadata
    /// connection to it (PostgreSQL). Otherwise any database is reachable from one
    /// connection (SQL Server, MySQL).
    pub connection_per_database: bool,
    pub row_limit: RowLimitSyntax,
}

/// How object names are qualified in generated SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Qualifier {
    /// `schema.name`
    Schema,
    /// `database.name` (MySQL: databases are the namespaces)
    Database,
    /// `name` (one namespace per file)
    None,
}

impl Qualifier {
    pub fn of(capabilities: &Capabilities) -> Qualifier {
        if capabilities.schemas {
            Qualifier::Schema
        } else if capabilities.multiple_databases {
            Qualifier::Database
        } else {
            Qualifier::None
        }
    }
}

/// The metadata half of a dialect. A supertrait of [`Dialect`], implemented here so the
/// model and the data it depends on stay together.
pub trait MetaDialect {
    fn meta_capabilities(&self) -> MetaCapabilities;
}

const ALL_KINDS: &[ObjectKind] = &[
    ObjectKind::Table,
    ObjectKind::View,
    ObjectKind::MaterializedView,
    ObjectKind::Function,
    ObjectKind::Procedure,
    ObjectKind::Sequence,
    ObjectKind::Type,
];

impl MetaDialect for PostgresDialect {
    fn meta_capabilities(&self) -> MetaCapabilities {
        MetaCapabilities {
            object_kinds: ALL_KINDS,
            connection_per_database: true,
            row_limit: RowLimitSyntax::Limit,
        }
    }
}

impl MetaDialect for MssqlDialect {
    fn meta_capabilities(&self) -> MetaCapabilities {
        MetaCapabilities {
            object_kinds: &[
                ObjectKind::Table,
                ObjectKind::View,
                ObjectKind::Function,
                ObjectKind::Procedure,
                ObjectKind::Sequence,
                ObjectKind::Type,
            ],
            connection_per_database: false,
            row_limit: RowLimitSyntax::Top,
        }
    }
}

impl MetaDialect for MysqlDialect {
    fn meta_capabilities(&self) -> MetaCapabilities {
        MetaCapabilities {
            object_kinds: &[
                ObjectKind::Table,
                ObjectKind::View,
                ObjectKind::Function,
                ObjectKind::Procedure,
            ],
            connection_per_database: false,
            row_limit: RowLimitSyntax::Limit,
        }
    }
}

impl MetaDialect for SqliteDialect {
    fn meta_capabilities(&self) -> MetaCapabilities {
        MetaCapabilities {
            object_kinds: &[ObjectKind::Table, ObjectKind::View],
            connection_per_database: false,
            row_limit: RowLimitSyntax::Limit,
        }
    }
}

/// The qualified, quoted name of an object (`"shop"."orders"`, `orders`).
pub fn qualified_name(dialect: &dyn Dialect, object: &ObjectRef) -> String {
    let name = dialect.quote_identifier(&object.name);
    match Qualifier::of(&dialect.capabilities()) {
        Qualifier::Schema => match &object.schema {
            Some(schema) => format!("{}.{name}", dialect.quote_identifier(schema)),
            None => name,
        },
        Qualifier::Database if !object.database.is_empty() => {
            format!("{}.{name}", dialect.quote_identifier(&object.database))
        }
        Qualifier::Database | Qualifier::None => name,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::dialect::Engine;

    fn obj(schema: Option<&str>, name: &str) -> ObjectRef {
        ObjectRef {
            database: "shop".into(),
            schema: schema.map(str::to_owned),
            name: name.into(),
        }
    }

    #[test]
    fn qualifies_names_per_engine() {
        let orders = obj(Some("sales"), "Order \"Lines\"");
        assert_eq!(
            qualified_name(Engine::Postgres.dialect(), &orders),
            "\"sales\".\"Order \"\"Lines\"\"\""
        );
        assert_eq!(
            qualified_name(Engine::Mssql.dialect(), &orders),
            "[sales].[Order \"Lines\"]"
        );
        assert_eq!(
            qualified_name(Engine::Mysql.dialect(), &obj(None, "orders")),
            "`shop`.`orders`"
        );
        assert_eq!(
            qualified_name(Engine::Sqlite.dialect(), &obj(None, "orders")),
            "\"orders\""
        );
    }

    #[test]
    fn every_engine_lists_tables_and_views_first() {
        for engine in Engine::ALL {
            let kinds = engine.dialect().meta_capabilities().object_kinds;
            assert_eq!(&kinds[..2], &[ObjectKind::Table, ObjectKind::View]);
        }
    }

    #[test]
    fn nodes_serialize_with_a_level() {
        let node = MetaNode::Objects {
            database: "shop".into(),
            schema: None,
            kind: ObjectKind::MaterializedView,
        };
        let json = serde_json::to_value(&node).expect("serializes");
        assert_eq!(
            json,
            serde_json::json!({
                "level": "objects", "database": "shop", "schema": null, "kind": "materializedView"
            })
        );
    }
}
