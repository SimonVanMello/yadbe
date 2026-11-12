//! Drop, truncate and rename statements (F-026), written through the dialect: identifiers are
//! quoted, names are never concatenated unquoted, and no statement carries `CASCADE`.
//! The dialect also says which actions an engine offers on which kind of object, and how the
//! DDL of a table is written when the engine keeps no text for it (see [`crate::db::ddl`]).

use crate::db::dialect::{Dialect, MssqlDialect, MysqlDialect, PostgresDialect, SqliteDialect};
use crate::db::edit_dialect::EditDialect as _;
use crate::db::errors::YadbeError;
use crate::db::meta::{
    ObjectDetail, ObjectInfo, ObjectKind, ObjectRef, TypeCategory, qualified_name,
};
use crate::db::object_model::{ObjectAction, ObjectActionSupport};
use crate::db::value::Value;

/// How an identity column is written in a `CREATE TABLE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityStyle {
    /// `GENERATED ALWAYS AS IDENTITY`
    GeneratedAsIdentity,
    /// `IDENTITY(1,1)`
    Identity,
    /// `AUTO_INCREMENT`
    AutoIncrement,
    /// Nothing to write (SQLite rowid alias).
    None,
}

/// How a computed column is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeneratedStyle {
    /// `type GENERATED ALWAYS AS (expr) STORED`
    Standard,
    /// `AS (expr) [PERSISTED]`, without a type.
    Computed,
}

/// What the DDL reconstruction needs to write a `CREATE TABLE` the engine accepts.
#[derive(Debug, Clone, Copy)]
pub struct DdlStyle {
    pub identity: IdentityStyle,
    pub generated: GeneratedStyle,
    /// Printed in the header of a reconstructed text: what the catalog does not tell.
    pub note: Option<&'static str>,
}

/// The object-tool half of a dialect: supertrait of [`Dialect`].
pub trait ObjectDialect {
    /// Which actions the engine offers on `kind`.
    fn object_support(&self, kind: ObjectKind) -> ObjectActionSupport;

    /// The name an object is written with in a statement run on any connection of the server.
    fn ddl_name(&self, object: &ObjectRef) -> String;

    fn ddl_style(&self) -> DdlStyle;

    /// `DROP …` of a supported kind.
    fn drop_statement(&self, object: &ObjectRef, info: &ObjectInfo) -> String;

    /// Removes every row of a table.
    fn truncate_statement(&self, object: &ObjectRef) -> String;

    /// Renames an object; `new_name` is one unqualified name.
    fn rename_statement(&self, object: &ObjectRef, info: &ObjectInfo, new_name: &str) -> String;
}

fn support(kind: ObjectKind, drop: bool, truncate: bool, rename: bool) -> ObjectActionSupport {
    ObjectActionSupport {
        kind,
        drop,
        truncate,
        rename,
    }
}

/// Actions of every kind the engine has, for the menus (they hide what is not offered).
pub fn support_of(dialect: &dyn Dialect) -> Vec<ObjectActionSupport> {
    dialect
        .meta_capabilities()
        .object_kinds
        .iter()
        .map(|kind| dialect.object_support(*kind))
        .collect()
}

fn routine_arguments(info: &ObjectInfo) -> (String, bool) {
    match &info.detail {
        ObjectDetail::Routine(routine) => (routine.identity_arguments.clone(), routine.aggregate),
        _ => (String::new(), false),
    }
}

fn type_category(info: &ObjectInfo) -> Option<TypeCategory> {
    match &info.detail {
        ObjectDetail::Type(summary) => Some(summary.category),
        _ => None,
    }
}

fn is_foreign(info: &ObjectInfo) -> bool {
    matches!(&info.detail, ObjectDetail::Relation(relation) if relation.foreign)
}

impl ObjectDialect for PostgresDialect {
    fn object_support(&self, kind: ObjectKind) -> ObjectActionSupport {
        let table = kind == ObjectKind::Table;
        support(kind, true, table, true)
    }

    fn ddl_name(&self, object: &ObjectRef) -> String {
        qualified_name(self, object)
    }

    fn ddl_style(&self) -> DdlStyle {
        DdlStyle {
            identity: IdentityStyle::GeneratedAsIdentity,
            generated: GeneratedStyle::Standard,
            note: None,
        }
    }

    fn drop_statement(&self, object: &ObjectRef, info: &ObjectInfo) -> String {
        let name = self.ddl_name(object);
        let (arguments, aggregate) = routine_arguments(info);
        let signature = if aggregate && arguments.is_empty() {
            "(*)".to_owned()
        } else {
            format!("({arguments})")
        };
        match info.kind {
            ObjectKind::Table if is_foreign(info) => format!("DROP FOREIGN TABLE {name}"),
            ObjectKind::Table => format!("DROP TABLE {name}"),
            ObjectKind::View => format!("DROP VIEW {name}"),
            ObjectKind::MaterializedView => format!("DROP MATERIALIZED VIEW {name}"),
            ObjectKind::Function if aggregate => format!("DROP AGGREGATE {name}{signature}"),
            ObjectKind::Function => format!("DROP FUNCTION {name}{signature}"),
            ObjectKind::Procedure => format!("DROP PROCEDURE {name}{signature}"),
            ObjectKind::Sequence => format!("DROP SEQUENCE {name}"),
            ObjectKind::Type if type_category(info) == Some(TypeCategory::Domain) => {
                format!("DROP DOMAIN {name}")
            }
            ObjectKind::Type => format!("DROP TYPE {name}"),
        }
    }

    fn truncate_statement(&self, object: &ObjectRef) -> String {
        format!("TRUNCATE TABLE {}", self.ddl_name(object))
    }

    fn rename_statement(&self, object: &ObjectRef, info: &ObjectInfo, new_name: &str) -> String {
        let name = self.ddl_name(object);
        let new = self.quote_identifier(new_name);
        let (arguments, aggregate) = routine_arguments(info);
        let signature = if aggregate && arguments.is_empty() {
            "(*)".to_owned()
        } else {
            format!("({arguments})")
        };
        let head = match info.kind {
            ObjectKind::Table => format!("ALTER TABLE {name}"),
            ObjectKind::View => format!("ALTER VIEW {name}"),
            ObjectKind::MaterializedView => format!("ALTER MATERIALIZED VIEW {name}"),
            ObjectKind::Function if aggregate => format!("ALTER AGGREGATE {name}{signature}"),
            ObjectKind::Function => format!("ALTER FUNCTION {name}{signature}"),
            ObjectKind::Procedure => format!("ALTER PROCEDURE {name}{signature}"),
            ObjectKind::Sequence => format!("ALTER SEQUENCE {name}"),
            ObjectKind::Type if type_category(info) == Some(TypeCategory::Domain) => {
                format!("ALTER DOMAIN {name}")
            }
            ObjectKind::Type => format!("ALTER TYPE {name}"),
        };
        format!("{head} RENAME TO {new}")
    }
}

impl MssqlDialect {
    /// `EXEC [db].sys.sp_executesql N'…'`: runs `statement` in another database without
    /// switching the connection to it (statements that take no database-qualified name).
    fn in_database(&self, database: &str, statement: &str) -> String {
        let literal = self.literal(&Value::Text(statement.to_owned()));
        format!(
            "EXEC {}.sys.sp_executesql {literal}",
            self.quote_identifier(database)
        )
    }

    fn schema_name(&self, object: &ObjectRef) -> String {
        match &object.schema {
            Some(schema) => format!(
                "{}.{}",
                self.quote_identifier(schema),
                self.quote_identifier(&object.name)
            ),
            None => self.quote_identifier(&object.name),
        }
    }
}

impl ObjectDialect for MssqlDialect {
    fn object_support(&self, kind: ObjectKind) -> ObjectActionSupport {
        // `sp_rename` leaves the text of a view, function or procedure with its old name:
        // those are recreated, not renamed.
        let rename = matches!(kind, ObjectKind::Table | ObjectKind::Sequence);
        support(kind, true, kind == ObjectKind::Table, rename)
    }

    fn ddl_name(&self, object: &ObjectRef) -> String {
        let name = self.schema_name(object);
        if object.database.is_empty() {
            name
        } else {
            format!("{}.{name}", self.quote_identifier(&object.database))
        }
    }

    fn ddl_style(&self) -> DdlStyle {
        DdlStyle {
            identity: IdentityStyle::Identity,
            generated: GeneratedStyle::Computed,
            note: Some("Identity seed and increment are not read: IDENTITY(1,1) is written."),
        }
    }

    fn drop_statement(&self, object: &ObjectRef, info: &ObjectInfo) -> String {
        let word = match info.kind {
            // These take a database-qualified name.
            ObjectKind::Table => "TABLE",
            ObjectKind::Sequence => "SEQUENCE",
            ObjectKind::View | ObjectKind::MaterializedView => "VIEW",
            ObjectKind::Function => "FUNCTION",
            ObjectKind::Procedure => "PROCEDURE",
            ObjectKind::Type => "TYPE",
        };
        if matches!(info.kind, ObjectKind::Table | ObjectKind::Sequence) {
            return format!("DROP {word} {}", self.ddl_name(object));
        }
        // The others refuse a database prefix: they run inside the database instead.
        self.in_database(
            &object.database,
            &format!("DROP {word} {}", self.schema_name(object)),
        )
    }

    fn truncate_statement(&self, object: &ObjectRef) -> String {
        format!("TRUNCATE TABLE {}", self.ddl_name(object))
    }

    fn rename_statement(&self, object: &ObjectRef, _info: &ObjectInfo, new_name: &str) -> String {
        let old = self.literal(&Value::Text(self.schema_name(object)));
        let new = self.literal(&Value::Text(new_name.to_owned()));
        format!(
            "EXEC {}.sys.sp_rename {old}, {new}",
            self.quote_identifier(&object.database)
        )
    }
}

impl ObjectDialect for MysqlDialect {
    fn object_support(&self, kind: ObjectKind) -> ObjectActionSupport {
        let relation = matches!(kind, ObjectKind::Table | ObjectKind::View);
        support(kind, true, kind == ObjectKind::Table, relation)
    }

    fn ddl_name(&self, object: &ObjectRef) -> String {
        qualified_name(self, object)
    }

    fn ddl_style(&self) -> DdlStyle {
        DdlStyle {
            identity: IdentityStyle::AutoIncrement,
            generated: GeneratedStyle::Standard,
            note: None,
        }
    }

    fn drop_statement(&self, object: &ObjectRef, info: &ObjectInfo) -> String {
        let word = match info.kind {
            ObjectKind::View | ObjectKind::MaterializedView => "VIEW",
            ObjectKind::Function => "FUNCTION",
            ObjectKind::Procedure => "PROCEDURE",
            _ => "TABLE",
        };
        format!("DROP {word} {}", self.ddl_name(object))
    }

    fn truncate_statement(&self, object: &ObjectRef) -> String {
        format!("TRUNCATE TABLE {}", self.ddl_name(object))
    }

    fn rename_statement(&self, object: &ObjectRef, _info: &ObjectInfo, new_name: &str) -> String {
        let renamed = ObjectRef {
            name: new_name.to_owned(),
            ..object.clone()
        };
        format!(
            "RENAME TABLE {} TO {}",
            self.ddl_name(object),
            self.ddl_name(&renamed)
        )
    }
}

impl ObjectDialect for SqliteDialect {
    fn object_support(&self, kind: ObjectKind) -> ObjectActionSupport {
        let table = kind == ObjectKind::Table;
        support(kind, true, table, table)
    }

    fn ddl_name(&self, object: &ObjectRef) -> String {
        qualified_name(self, object)
    }

    fn ddl_style(&self) -> DdlStyle {
        DdlStyle {
            identity: IdentityStyle::None,
            generated: GeneratedStyle::Standard,
            note: None,
        }
    }

    fn drop_statement(&self, object: &ObjectRef, info: &ObjectInfo) -> String {
        let word = if info.kind == ObjectKind::View {
            "VIEW"
        } else {
            "TABLE"
        };
        format!("DROP {word} {}", self.ddl_name(object))
    }

    fn truncate_statement(&self, object: &ObjectRef) -> String {
        // SQLite has no `TRUNCATE`: deleting every row is its way (and it truncates itself).
        format!("DELETE FROM {}", self.ddl_name(object))
    }

    fn rename_statement(&self, object: &ObjectRef, _info: &ObjectInfo, new_name: &str) -> String {
        format!(
            "ALTER TABLE {} RENAME TO {}",
            self.ddl_name(object),
            self.quote_identifier(new_name)
        )
    }
}

/// Longest name an engine accepts (SQL Server's 128 is the shortest of the four).
pub const MAX_NAME_CHARS: usize = 128;

/// Checks a name typed for a rename: one non-empty name, different from the current one.
pub fn check_new_name(old: &str, new_name: &str) -> Result<(), YadbeError> {
    let bad = |en: &str, fr: &str| Err(YadbeError::invalid_argument(en, fr));
    if new_name.trim().is_empty() {
        return bad("The new name is empty.", "Le nouveau nom est vide.");
    }
    if new_name == old {
        return bad(
            "The new name is the current one.",
            "Le nouveau nom est le nom actuel.",
        );
    }
    if new_name.chars().count() > MAX_NAME_CHARS {
        return bad(
            "The new name is longer than 128 characters.",
            "Le nouveau nom dépasse 128 caractères.",
        );
    }
    if new_name.chars().any(char::is_control) {
        return bad(
            "A name cannot contain control characters.",
            "Un nom ne peut pas contenir de caractères de contrôle.",
        );
    }
    Ok(())
}

/// The statement of `action` on `object`, or `notSupported` when the engine does not offer it
/// for this kind. `info` is the object's entry of its list.
pub fn action_statement(
    dialect: &dyn Dialect,
    object: &ObjectRef,
    info: &ObjectInfo,
    action: &ObjectAction,
) -> Result<String, YadbeError> {
    let support = dialect.object_support(info.kind);
    let unsupported = |what: &str, fr: &str| {
        Err(YadbeError::not_supported(
            format!("{} cannot {what} this object.", dialect.label()),
            format!("{} ne peut pas {fr} cet objet.", dialect.label()),
        ))
    };
    match action {
        ObjectAction::Drop if support.drop => Ok(dialect.drop_statement(object, info)),
        ObjectAction::Drop => unsupported("drop", "supprimer"),
        ObjectAction::Truncate if support.truncate => Ok(dialect.truncate_statement(object)),
        ObjectAction::Truncate => unsupported("truncate", "vider"),
        ObjectAction::Rename { new_name } if support.rename => {
            check_new_name(&object.name, new_name)?;
            Ok(dialect.rename_statement(object, info, new_name))
        }
        ObjectAction::Rename { .. } => unsupported("rename", "renommer"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::engine::Engine;
    use crate::db::meta::{RelationSummary, RoutineSignature};

    fn relation(kind: ObjectKind, name: &str) -> ObjectInfo {
        ObjectInfo {
            kind,
            name: name.into(),
            id: name.into(),
            system: false,
            comment: None,
            detail: ObjectDetail::Relation(RelationSummary {
                row_estimate: None,
                partitioned: false,
                foreign: false,
            }),
        }
    }

    fn at(schema: Option<&str>, name: &str) -> ObjectRef {
        ObjectRef {
            database: "shop".into(),
            schema: schema.map(str::to_owned),
            name: name.into(),
        }
    }

    fn statement(engine: Engine, kind: ObjectKind, action: ObjectAction) -> String {
        let schema = engine.dialect().capabilities().schemas.then_some("sales");
        let object = at(schema, "Order \"Lines\"");
        let info = relation(kind, &object.name);
        action_statement(engine.dialect(), &object, &info, &action).expect("supported")
    }

    #[test]
    fn writes_quoted_drop_truncate_and_rename_per_engine() {
        let rename = || ObjectAction::Rename {
            new_name: "New one".into(),
        };
        assert_eq!(
            statement(Engine::Postgres, ObjectKind::Table, ObjectAction::Drop),
            "DROP TABLE \"sales\".\"Order \"\"Lines\"\"\""
        );
        assert_eq!(
            statement(Engine::Postgres, ObjectKind::Table, rename()),
            "ALTER TABLE \"sales\".\"Order \"\"Lines\"\"\" RENAME TO \"New one\""
        );
        assert_eq!(
            statement(Engine::Mssql, ObjectKind::Table, ObjectAction::Truncate),
            "TRUNCATE TABLE [shop].[sales].[Order \"Lines\"]"
        );
        assert_eq!(
            statement(Engine::Mssql, ObjectKind::Table, rename()),
            "EXEC [shop].sys.sp_rename N'[sales].[Order \"Lines\"]', N'New one'"
        );
        assert_eq!(
            statement(Engine::Mysql, ObjectKind::Table, rename()),
            "RENAME TABLE `shop`.`Order \"Lines\"` TO `shop`.`New one`"
        );
        assert_eq!(
            statement(Engine::Sqlite, ObjectKind::Table, ObjectAction::Truncate),
            "DELETE FROM \"Order \"\"Lines\"\"\""
        );
        assert_eq!(
            statement(Engine::Sqlite, ObjectKind::View, ObjectAction::Drop),
            "DROP VIEW \"Order \"\"Lines\"\"\""
        );
    }

    #[test]
    fn no_statement_carries_cascade() {
        for (_, dialect) in Engine::sql_dialects() {
            for kind in dialect.meta_capabilities().object_kinds {
                let schema = dialect.capabilities().schemas.then_some("s");
                let object = at(schema, "x");
                let info = relation(*kind, "x");
                let sql = dialect.drop_statement(&object, &info);
                assert!(!sql.to_ascii_uppercase().contains("CASCADE"), "{sql}");
            }
        }
    }

    #[test]
    fn routines_are_dropped_by_signature_on_postgres() {
        let object = at(Some("sales"), "order_total");
        let info = ObjectInfo {
            kind: ObjectKind::Function,
            name: "order_total".into(),
            id: "order_total(integer, boolean)".into(),
            system: false,
            comment: None,
            detail: ObjectDetail::Routine(RoutineSignature {
                arguments: "p integer, q boolean".into(),
                identity_arguments: "integer, boolean".into(),
                return_type: Some("numeric".into()),
                language: Some("sql".into()),
                aggregate: false,
            }),
        };
        let dialect = Engine::Postgres.dialect();
        assert_eq!(
            dialect.drop_statement(&object, &info),
            "DROP FUNCTION \"sales\".\"order_total\"(integer, boolean)"
        );
        assert_eq!(
            dialect.rename_statement(&object, &info, "total"),
            "ALTER FUNCTION \"sales\".\"order_total\"(integer, boolean) RENAME TO \"total\""
        );
    }

    #[test]
    fn refuses_what_the_engine_does_not_offer() {
        let object = at(None, "v");
        let info = relation(ObjectKind::View, "v");
        let err = action_statement(
            Engine::Sqlite.dialect(),
            &object,
            &info,
            &ObjectAction::Truncate,
        )
        .expect_err("views cannot be truncated");
        assert_eq!(err.code, crate::db::errors::ErrorCode::NotSupported);
        let err = action_statement(
            Engine::Mysql.dialect(),
            &object,
            &relation(ObjectKind::Function, "f"),
            &ObjectAction::Rename {
                new_name: "g".into(),
            },
        )
        .expect_err("routines cannot be renamed on MySQL");
        assert_eq!(err.code, crate::db::errors::ErrorCode::NotSupported);
    }

    #[test]
    fn validates_new_names() {
        assert!(check_new_name("a", "b").is_ok());
        assert!(check_new_name("a", "").is_err());
        assert!(check_new_name("a", "  ").is_err());
        assert!(check_new_name("a", "a").is_err());
        assert!(check_new_name("a", "line\nbreak").is_err());
        assert!(check_new_name("a", &"x".repeat(129)).is_err());
    }
}
