//! The object tools of the metadata service (M3-8): DDL of an object (F-024), properties
//! (F-025) and drop / truncate / rename (F-026). A child module of `meta_cache`: it uses the
//! service's connections (one per database where the engine needs it) and its cache.
//!
//! Reads are not cached (a DDL view or a properties panel shows the server as it is now); an
//! action runs on the connection that sees the object's database, is recorded in the
//! statement log by the driver, and ends by dropping what the cache holds about the schema
//! and saying so (`meta-refreshed`, reason `ddl`).

use super::*;
use crate::db::ddl;
use crate::db::dialect::Dialect;
use crate::db::meta::ObjectDetail;
use crate::db::object_model::{
    DdlSource, DdlTarget, ObjectAction, ObjectActionOutcome, ObjectActionPlan, ObjectActionRequest,
    ObjectDdl, ObjectDependents, ObjectProperties,
};
use crate::db::object_ops::action_statement;

impl MetaService {
    /// The entry of an object in its list, whose details the dialect needs (a routine's
    /// signature, whether a table is foreign…).
    async fn info_of(
        &self,
        manager: &ConnectionManager,
        connection_id: &str,
        object: &ObjectRef,
        kind: ObjectKind,
        id: &str,
    ) -> Result<ObjectInfo, YadbeError> {
        let list = self
            .objects(
                manager,
                None,
                connection_id,
                &object.database,
                object.schema.as_deref(),
                kind,
            )
            .await?;
        list.into_iter()
            .find(|o| o.id == id)
            .ok_or_else(|| YadbeError::object_not_found(&display_name(object, id)))
    }

    /// The user-defined types of an object's schema, for the type names of its columns (none
    /// where the engine has no such kind, or when they cannot be listed).
    async fn schema_types(
        &self,
        manager: &ConnectionManager,
        connection_id: &str,
        object: &ObjectRef,
    ) -> Vec<ObjectRef> {
        let listed = self
            .objects(
                manager,
                None,
                connection_id,
                &object.database,
                object.schema.as_deref(),
                ObjectKind::Type,
            )
            .await
            .unwrap_or_default();
        listed
            .into_iter()
            .map(|t| ObjectRef {
                name: t.name,
                ..object.clone()
            })
            .collect()
    }

    /// The DDL of a table, view, routine, sequence, type, trigger or index.
    pub async fn object_ddl(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        target: &DdlTarget,
    ) -> Result<ObjectDdl, YadbeError> {
        let session = Self::session(manager, connection_id)?;
        let dialect = session.dialect()?;
        match target {
            DdlTarget::Object { object, kind, id } => {
                Self::check_database(&object.database)?;
                Self::check_schema(&session, object.schema.as_deref())?;
                let info = if kind.is_relation() {
                    None
                } else {
                    Some(
                        self.info_of(manager, connection_id, object, *kind, id)
                            .await?,
                    )
                };
                let native = self
                    .native_ddl(
                        &session,
                        request_id,
                        &object.database,
                        target,
                        info.as_ref(),
                    )
                    .await?;
                if let Some(native) = native {
                    return Ok(self
                        .with_triggers(manager, connection_id, object, *kind, native, dialect)
                        .await);
                }
                match kind {
                    ObjectKind::Table => {
                        let details = self
                            .table_details(manager, request_id, connection_id, object)
                            .await?;
                        let types = self.schema_types(manager, connection_id, object).await;
                        Ok(reconstructed(ddl::table_ddl(dialect, &details, &types)))
                    }
                    _ => info
                        .and_then(|info| ddl::object_ddl(dialect, object, &info))
                        .map(reconstructed)
                        .ok_or_else(|| no_ddl(dialect, object)),
                }
            }
            DdlTarget::Trigger { table, name } => {
                let details = self
                    .table_details(manager, request_id, connection_id, table)
                    .await?;
                let trigger = details
                    .triggers
                    .iter()
                    .find(|t| &t.name == name)
                    .ok_or_else(|| YadbeError::object_not_found(name))?;
                match &trigger.definition {
                    Some(text) => Ok(ObjectDdl {
                        sql: format!("{}\n", ddl::script_statement(dialect, text)),
                        source: DdlSource::Catalog,
                    }),
                    None => self
                        .native_ddl(&session, request_id, &table.database, target, None)
                        .await?
                        .ok_or_else(|| no_ddl(dialect, table)),
                }
            }
            DdlTarget::Index { table, name } => {
                let details = self
                    .table_details(manager, request_id, connection_id, table)
                    .await?;
                let index = details
                    .indexes
                    .iter()
                    .find(|i| &i.name == name)
                    .ok_or_else(|| YadbeError::object_not_found(name))?;
                Ok(match &index.definition {
                    Some(text) => ObjectDdl {
                        sql: format!("{}\n", ddl::script_statement(dialect, text)),
                        source: DdlSource::Catalog,
                    },
                    None => {
                        let text = format!(
                            "-- Reconstructed by yadbe from the catalog: {} keeps no definition text for an index.\n{}\n",
                            dialect.label(),
                            ddl::index_ddl(dialect, table, index)
                        );
                        reconstructed(text)
                    }
                })
            }
        }
    }

    async fn native_ddl(
        &self,
        session: &Arc<ConnectionSession>,
        request_id: Option<&str>,
        database: &str,
        target: &DdlTarget,
        info: Option<&ObjectInfo>,
    ) -> Result<Option<ObjectDdl>, YadbeError> {
        let cache = self.cache(session);
        let conn = self.connection_for(session, &cache, Some(database)).await?;
        let work = async { Self::introspector(&*conn)?.native_ddl(target, info).await };
        self.run(request_id, &conn, work).await
    }

    /// A table's own text, followed by the triggers it does not hold (`SHOW CREATE TABLE`
    /// keeps the indexes in the table, not the triggers).
    async fn with_triggers(
        &self,
        manager: &ConnectionManager,
        connection_id: &str,
        object: &ObjectRef,
        kind: ObjectKind,
        native: ObjectDdl,
        dialect: &dyn Dialect,
    ) -> ObjectDdl {
        let mut sql = native.sql;
        if kind == ObjectKind::Table
            && let Ok(details) = self
                .table_details(manager, None, connection_id, object)
                .await
        {
            let extras = ddl::table_extras(dialect, &details, &sql, false);
            sql.push_str(&extras);
        }
        ObjectDdl {
            sql,
            source: native.source,
        }
    }

    /// Size, owner, dates and the like of a table, view or materialized view (F-025).
    pub async fn properties(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        object: &ObjectRef,
        kind: ObjectKind,
    ) -> Result<ObjectProperties, YadbeError> {
        Self::check_database(&object.database)?;
        let session = Self::session(manager, connection_id)?;
        Self::check_schema(&session, object.schema.as_deref())?;
        if !kind.is_relation() {
            return Err(YadbeError::not_supported(
                "Only tables and views have properties.",
                "Seuls les tables et les vues ont des propriétés.",
            ));
        }
        let cache = self.cache(&session);
        let conn = self
            .connection_for(&session, &cache, Some(&object.database))
            .await?;
        let work = async { Self::introspector(&*conn)?.properties(object, kind).await };
        self.run(request_id, &conn, work).await
    }

    /// What a confirmation shows: the exact statement, the rows at stake and what depends on
    /// the object.
    pub async fn plan_action(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        request: &ObjectActionRequest,
    ) -> Result<ObjectActionPlan, YadbeError> {
        let (session, info, sql) = self.resolve_action(manager, connection_id, request).await?;
        let row_estimate = match &info.detail {
            ObjectDetail::Relation(relation) => relation.row_estimate,
            _ => None,
        };
        let cache = self.cache(&session);
        let conn = self
            .connection_for(&session, &cache, Some(&request.object.database))
            .await?;
        let work = async {
            Self::introspector(&*conn)?
                .dependents(&request.object, request.kind)
                .await
        };
        // Advisory: a user who cannot read the dependencies still gets the confirmation.
        let dependents = self
            .run(request_id, &conn, work)
            .await
            .unwrap_or_else(|err| {
                tracing::debug!(error = %err, "dependents not read");
                ObjectDependents::unknown()
            });
        Ok(ObjectActionPlan {
            sql,
            row_estimate,
            dependents,
        })
    }

    async fn resolve_action(
        &self,
        manager: &ConnectionManager,
        connection_id: &str,
        request: &ObjectActionRequest,
    ) -> Result<(Arc<ConnectionSession>, ObjectInfo, String), YadbeError> {
        Self::check_database(&request.object.database)?;
        let session = Self::session(manager, connection_id)?;
        Self::check_schema(&session, request.object.schema.as_deref())?;
        let info = self
            .info_of(
                manager,
                connection_id,
                &request.object,
                request.kind,
                &request.id,
            )
            .await?;
        let dialect = session.dialect()?;
        let sql = action_statement(dialect, &request.object, &info, &request.action)?;
        Ok((session, info, sql))
    }

    /// Runs a drop, truncate or rename, refused on a read-only connection. Afterwards the
    /// metadata of the schema is read again.
    pub async fn run_action(
        &self,
        manager: &ConnectionManager,
        request_id: Option<&str>,
        connection_id: &str,
        request: &ObjectActionRequest,
    ) -> Result<ObjectActionOutcome, YadbeError> {
        let session = Self::session(manager, connection_id)?;
        if session.read_only() {
            return Err(YadbeError::read_only_violation(match request.action {
                ObjectAction::Drop => "DROP",
                ObjectAction::Truncate => "TRUNCATE",
                ObjectAction::Rename { .. } => "RENAME",
            }));
        }
        let (session, _info, sql) = self.resolve_action(manager, connection_id, request).await?;
        let cache = self.cache(&session);
        let conn = self
            .connection_for(&session, &cache, Some(&request.object.database))
            .await?;
        session.align(&*conn).await?;
        let ran = self
            .run(request_id, &conn, async { conn.query(&sql, 0).await })
            .await;
        if ran.is_ok() {
            let node = if request.kind.is_relation() {
                MetaNode::Schema {
                    database: request.object.database.clone(),
                    schema: request.object.schema.clone(),
                }
            } else {
                MetaNode::Objects {
                    database: request.object.database.clone(),
                    schema: request.object.schema.clone(),
                    kind: request.kind,
                }
            };
            self.drop_cached(connection_id, &node);
            self.emit(connection_id, node, MetaRefreshReason::Ddl);
        }
        ran?;
        let renamed_to = match &request.action {
            ObjectAction::Rename { new_name } => Some(ObjectRef {
                name: new_name.clone(),
                ..request.object.clone()
            }),
            _ => None,
        };
        Ok(ObjectActionOutcome { sql, renamed_to })
    }
}

fn reconstructed(sql: String) -> ObjectDdl {
    ObjectDdl {
        sql,
        source: DdlSource::Reconstructed,
    }
}

fn display_name(object: &ObjectRef, id: &str) -> String {
    match &object.schema {
        Some(schema) => format!("{schema}.{id}"),
        None => id.to_owned(),
    }
}

fn no_ddl(dialect: &dyn Dialect, object: &ObjectRef) -> YadbeError {
    YadbeError::not_supported(
        format!(
            "{} keeps no definition for \"{}\" and yadbe cannot rebuild it.",
            dialect.label(),
            object.name
        ),
        format!(
            "{} ne garde pas de définition pour « {} » et yadbe ne peut pas la reconstruire.",
            dialect.label(),
            object.name
        ),
    )
}
