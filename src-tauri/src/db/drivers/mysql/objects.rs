//! MySQL / MariaDB object tools (M3-8): definitions from `SHOW CREATE …`, table facts from
//! `information_schema.TABLES`, and what depends on a table from the foreign keys and, where
//! the server has them, `VIEW_TABLE_USAGE`. Names in `SHOW CREATE` cannot be bound: they are
//! quoted through the dialect.

use super::MysqlConnection;
use super::introspect::{comment, estimate, text};
use crate::db::dialect::{Dialect, MysqlDialect};
use crate::db::errors::YadbeError;
use crate::db::meta::{ObjectKind, ObjectRef};
use crate::db::object_model::{
    DdlSource, DdlTarget, DependencyLink, Dependent, ObjectDdl, ObjectDependents, ObjectProperties,
};

const PROPERTIES_SQL: &str = "\
SELECT ENGINE, TABLE_COLLATION, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH,
       DATE_FORMAT(CREATE_TIME, '%Y-%m-%d %H:%i:%s'), DATE_FORMAT(UPDATE_TIME, '%Y-%m-%d %H:%i:%s'),
       TABLE_COMMENT
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";

const REFERENCING_KEYS_SQL: &str = "\
SELECT DISTINCT TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?
  AND NOT (TABLE_SCHEMA = REFERENCED_TABLE_SCHEMA AND TABLE_NAME = REFERENCED_TABLE_NAME)
ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME";

/// MySQL 8.0.13+ lists the tables and views a view reads.
const DEPENDENT_VIEWS_SQL: &str = "\
SELECT DISTINCT VIEW_SCHEMA, VIEW_NAME
FROM information_schema.VIEW_TABLE_USAGE
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY VIEW_SCHEMA, VIEW_NAME";

impl MysqlConnection {
    pub(super) async fn native_definition(
        &self,
        target: &DdlTarget,
    ) -> Result<Option<ObjectDdl>, YadbeError> {
        let (object, word, column) = match target {
            DdlTarget::Object { object, kind, .. } => match kind {
                ObjectKind::Table => (object, "TABLE", 1),
                ObjectKind::View => (object, "VIEW", 1),
                ObjectKind::Function => (object, "FUNCTION", 2),
                ObjectKind::Procedure => (object, "PROCEDURE", 2),
                _ => return Ok(None),
            },
            DdlTarget::Trigger { table, name } => {
                let trigger = ObjectRef {
                    name: name.clone(),
                    ..table.clone()
                };
                return self.show_create(&trigger, "TRIGGER", 2).await;
            }
            DdlTarget::Index { .. } => return Ok(None),
        };
        self.show_create(object, word, column).await
    }

    async fn show_create(
        &self,
        object: &ObjectRef,
        word: &str,
        column: usize,
    ) -> Result<Option<ObjectDdl>, YadbeError> {
        let sql = format!(
            "SHOW CREATE {word} {}.{}",
            MysqlDialect.quote_identifier(&object.database),
            MysqlDialect.quote_identifier(&object.name)
        );
        let rows = self.meta(&sql, &[]).await?;
        let Some(row) = rows.first() else {
            return Err(YadbeError::object_not_found(&format!(
                "{}.{}",
                object.database, object.name
            )));
        };
        // A routine whose body the user may not read comes back without text.
        Ok(text(row, column).map(|definition| ObjectDdl {
            sql: format!(
                "{}\n",
                crate::db::ddl::script_statement(&MysqlDialect, &definition)
            ),
            source: DdlSource::Catalog,
        }))
    }

    pub(super) async fn object_properties(
        &self,
        object: &ObjectRef,
        kind: ObjectKind,
    ) -> Result<ObjectProperties, YadbeError> {
        let (db, name) = (object.database.as_str(), object.name.as_str());
        let rows = self.meta(PROPERTIES_SQL, &[db, name]).await?;
        let Some(row) = rows.first() else {
            return Err(YadbeError::object_not_found(&format!("{db}.{name}")));
        };
        let mut facts = ObjectProperties::empty(object, kind);
        if kind == ObjectKind::View {
            // A view has no storage of its own; its `TABLE_COMMENT` says "VIEW".
            facts.modified = None;
            return Ok(facts);
        }
        facts.storage_engine = text(row, 0);
        facts.collation = text(row, 1);
        facts.row_estimate = estimate(row, 2);
        let data = estimate(row, 3);
        let index = estimate(row, 4);
        facts.data_bytes = data;
        facts.index_bytes = index;
        facts.total_bytes = match (data, index) {
            (None, None) => None,
            (d, i) => Some(d.unwrap_or(0.0) + i.unwrap_or(0.0)),
        };
        facts.created = text(row, 5);
        facts.modified = text(row, 6);
        facts.comment = comment(row, 7);
        Ok(facts)
    }

    pub(super) async fn object_dependents(
        &self,
        object: &ObjectRef,
        kind: ObjectKind,
    ) -> Result<ObjectDependents, YadbeError> {
        let (db, name) = (object.database.as_str(), object.name.as_str());
        if !matches!(kind, ObjectKind::Table | ObjectKind::View) {
            return Ok(ObjectDependents::unknown());
        }
        let in_db = |database: String, name: String| ObjectRef {
            database,
            schema: None,
            name,
        };
        let mut items = Vec::new();
        if kind == ObjectKind::Table {
            for row in &self.meta(REFERENCING_KEYS_SQL, &[db, name]).await? {
                items.push(Dependent {
                    kind: ObjectKind::Table,
                    via: Some(DependencyLink::ForeignKey {
                        name: text(row, 2).unwrap_or_default(),
                    }),
                    object: in_db(
                        text(row, 0).unwrap_or_default(),
                        text(row, 1).unwrap_or_default(),
                    ),
                });
            }
        }
        let flavor = self.inner.flavor();
        let views_listed = !flavor.mariadb && flavor.at_least(8, 0, 13);
        if views_listed {
            for row in &self.meta(DEPENDENT_VIEWS_SQL, &[db, name]).await? {
                items.push(Dependent {
                    kind: ObjectKind::View,
                    via: None,
                    object: in_db(
                        text(row, 0).unwrap_or_default(),
                        text(row, 1).unwrap_or_default(),
                    ),
                });
            }
        }
        Ok(ObjectDependents {
            complete: views_listed,
            items,
        })
    }
}
