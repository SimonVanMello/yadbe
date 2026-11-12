//! What the object tools exchange with the frontend (M3-8): DDL of an object (F-024), table
//! properties (F-025), drop / truncate / rename with their confirmation data (F-026) and
//! pinned objects (F-027). The engine-neutral model only: the statements themselves come from
//! [`ObjectDialect`](crate::db::object_ops::ObjectDialect) and the drivers' introspectors.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::meta::{ObjectKind, ObjectRef};

/// What a DDL view is asked for. A table's DDL carries its indexes and triggers; an index or a
/// trigger can also be asked for alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DdlTarget {
    /// A table, view, materialized view, routine, sequence or type. `id` is the object's id in
    /// its list (the name, or `name(argument types)` for a routine: overloads share a name).
    Object {
        object: ObjectRef,
        kind: ObjectKind,
        id: String,
    },
    Trigger {
        table: ObjectRef,
        name: String,
    },
    Index {
        table: ObjectRef,
        name: String,
    },
}

/// Where the text of a DDL view comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DdlSource {
    /// The engine's own definition (`pg_get_viewdef`, `sys.sql_modules`, `SHOW CREATE …`,
    /// `sqlite_schema.sql`).
    Catalog,
    /// Built by yadbe from the catalog: the engine keeps no text for this object. The text
    /// starts with a comment that says so.
    Reconstructed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDdl {
    pub sql: String,
    pub source: DdlSource,
}

/// Facts about a table, view or materialized view that the engine exposes (F-025). Every fact
/// is optional: the ones the engine does not have, or the user may not read, are `null` and
/// not shown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectProperties {
    pub object: ObjectRef,
    pub kind: ObjectKind,
    pub owner: Option<String>,
    pub comment: Option<String>,
    /// The planner's statistics, not a count.
    pub row_estimate: Option<f64>,
    /// Sizes in bytes (a double holds an integer exactly up to 9 PB).
    pub data_bytes: Option<f64>,
    pub index_bytes: Option<f64>,
    /// Table, indexes and the engine's side storage (TOAST, LOBs).
    pub total_bytes: Option<f64>,
    /// `YYYY-MM-DD HH:MM:SS`, as the server prints it.
    pub created: Option<String>,
    pub modified: Option<String>,
    /// Storage engine (`InnoDB`).
    pub storage_engine: Option<String>,
    pub collation: Option<String>,
    /// Last statistics update (`ANALYZE`) and last `VACUUM`.
    pub last_analyzed: Option<String>,
    pub last_vacuumed: Option<String>,
}

impl ObjectProperties {
    pub fn empty(object: &ObjectRef, kind: ObjectKind) -> Self {
        Self {
            object: object.clone(),
            kind,
            owner: None,
            comment: None,
            row_estimate: None,
            data_bytes: None,
            index_bytes: None,
            total_bytes: None,
            created: None,
            modified: None,
            storage_engine: None,
            collation: None,
            last_analyzed: None,
            last_vacuumed: None,
        }
    }
}

/// An object that depends on another one: it would break, or block the action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Dependent {
    /// What the dependent object is (a view, a table with a foreign key…).
    pub kind: ObjectKind,
    pub object: ObjectRef,
    /// How it depends; `null` for a plain reference (a view reading a table).
    pub via: Option<DependencyLink>,
}

/// What ties a dependent object to the one it depends on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DependencyLink {
    /// A foreign key of the dependent table, by its name (its columns when it has none).
    ForeignKey { name: String },
    /// A column of the dependent table declared with the type.
    Column { name: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDependents {
    /// The list is complete. `false`: the engine cannot tell every dependency (`items` then
    /// holds the ones it can), so an empty list proves nothing.
    pub complete: bool,
    pub items: Vec<Dependent>,
}

impl ObjectDependents {
    pub fn unknown() -> Self {
        Self {
            complete: false,
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ObjectAction {
    Drop,
    /// Removes every row; tables only.
    Truncate,
    Rename {
        new_name: String,
    },
}

/// An action on one object of the tree. `id` is the object's id in its list (see
/// [`DdlTarget::Object`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectActionRequest {
    pub object: ObjectRef,
    pub kind: ObjectKind,
    pub id: String,
    pub action: ObjectAction,
}

/// What a confirmation shows before an action runs (F-026).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectActionPlan {
    /// The exact statement that will run. Never carries `CASCADE`.
    pub sql: String,
    /// Rows the object holds, as the last statistics say (tables).
    pub row_estimate: Option<f64>,
    pub dependents: ObjectDependents,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectActionOutcome {
    /// The statement that ran, as recorded in the statement log.
    pub sql: String,
    /// The object under its new name after a rename.
    pub renamed_to: Option<ObjectRef>,
}

/// Which actions an engine offers on one kind of object (the menus hide the rest).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectActionSupport {
    pub kind: ObjectKind,
    pub drop: bool,
    pub truncate: bool,
    pub rename: bool,
}

/// An object (or a schema) pinned at the top of its connection's tree (F-027).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PinnedObject {
    pub connection_id: String,
    pub database: String,
    /// `null` on engines without schemas.
    pub schema: Option<String>,
    /// `null`: the pin is the schema itself (`name`).
    pub kind: Option<ObjectKind>,
    pub name: String,
    /// The object's id in its list (see [`DdlTarget::Object`]); equal to `name` for a schema.
    pub id: String,
}
