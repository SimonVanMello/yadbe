//! What a driver implements to read metadata. Every query it runs is a statement yadbe
//! authors: it goes through the connection's [`StatementRecorder`](crate::db::driver::StatementRecorder),
//! binds every name as a parameter and never concatenates one into SQL.

use crate::db::driver::BoxFuture;
use crate::db::errors::YadbeError;
use crate::db::meta::{
    CompletionCatalog, DatabaseInfo, IncomingForeignKeys, ObjectCount, ObjectInfo, ObjectKind,
    ObjectRef, SchemaInfo, TableDetails,
};
use crate::db::object_model::{DdlTarget, ObjectDependents, ObjectProperties};

pub type MetaFuture<'a, T> = BoxFuture<'a, Result<T, YadbeError>>;

/// Metadata reads on one connection. On engines whose connections see a single database
/// ([`MetaCapabilities::connection_per_database`](crate::db::meta::MetaCapabilities)),
/// `database` is always the connection's own: the metadata cache routes other databases
/// to connections of their own.
///
/// `schema` is `None` exactly on engines without schemas. A missing object fails with
/// `objectNotFound`.
pub trait Introspector: Send + Sync {
    /// Databases of the server (a single one for file engines).
    fn databases(&self) -> MetaFuture<'_, Vec<DatabaseInfo>>;

    /// Schemas of a database; empty on engines without schemas.
    fn schemas<'a>(&'a self, database: &'a str) -> MetaFuture<'a, Vec<SchemaInfo>>;

    /// One count per object kind the engine has, in explorer order.
    fn object_counts<'a>(
        &'a self,
        database: &'a str,
        schema: Option<&'a str>,
    ) -> MetaFuture<'a, Vec<ObjectCount>>;

    /// The objects of one kind, by name.
    fn objects<'a>(
        &'a self,
        database: &'a str,
        schema: Option<&'a str>,
        kind: ObjectKind,
    ) -> MetaFuture<'a, Vec<ObjectInfo>>;

    /// Columns, keys, indexes, constraints and triggers of a table, view or materialized
    /// view.
    fn table_details<'a>(&'a self, table: &'a ObjectRef) -> MetaFuture<'a, TableDetails>;

    /// The bulk catalog of a database; objects of system schemas only with `include_system`.
    fn completion_catalog<'a>(
        &'a self,
        database: &'a str,
        include_system: bool,
    ) -> MetaFuture<'a, CompletionCatalog>;

    /// The foreign keys of every table of `table`'s database that reference `table`
    /// (F-088). A driver that cannot list them answers `supported: false`.
    fn incoming_foreign_keys<'a>(
        &'a self,
        _table: &'a ObjectRef,
    ) -> MetaFuture<'a, IncomingForeignKeys> {
        Box::pin(async { Ok(IncomingForeignKeys::unsupported()) })
    }

    /// The engine's own definition text of an object (F-024): a view, a routine, a trigger, a
    /// table on engines that keep one. `None` when the engine keeps none (the caller then
    /// reconstructs it from the catalog). `info` is the object's entry of its list, for the
    /// kinds that have one.
    fn native_ddl<'a>(
        &'a self,
        _target: &'a DdlTarget,
        _info: Option<&'a ObjectInfo>,
    ) -> MetaFuture<'a, Option<String>> {
        Box::pin(async { Ok(None) })
    }

    /// Size, owner, dates and other facts of a table, view or materialized view (F-025).
    fn properties<'a>(
        &'a self,
        object: &'a ObjectRef,
        kind: ObjectKind,
    ) -> MetaFuture<'a, ObjectProperties> {
        Box::pin(async move { Ok(ObjectProperties::empty(object, kind)) })
    }

    /// What depends on `object` and would break or block a drop (F-026): foreign keys of other
    /// tables, views reading it. Complete only where the engine can tell.
    fn dependents<'a>(
        &'a self,
        _object: &'a ObjectRef,
        _kind: ObjectKind,
    ) -> MetaFuture<'a, ObjectDependents> {
        Box::pin(async { Ok(ObjectDependents::unknown()) })
    }
}

/// Interns column type names for a [`CompletionCatalog`].
#[derive(Default)]
pub struct TypeInterner {
    names: Vec<String>,
    index: std::collections::HashMap<String, u32>,
}

impl TypeInterner {
    pub fn intern(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.index.get(name) {
            return id;
        }
        let id = u32::try_from(self.names.len()).unwrap_or(u32::MAX);
        self.names.push(name.to_owned());
        self.index.insert(name.to_owned(), id);
        id
    }

    pub fn into_names(self) -> Vec<String> {
        self.names
    }
}

/// `usize` → `u32` for counts and indices sent to the frontend (never above 2^32 in practice).
pub fn index_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
