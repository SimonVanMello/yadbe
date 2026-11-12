//! EF Core awareness (F-143): the `__EFMigrationsHistory` table as a migrations timeline.
//!
//! EF Core names a migration `<yyyyMMddHHmmss>_<Name>` and records it with the version of the
//! tools that applied it. The table says what was applied, never what is pending: that needs
//! the application's assemblies.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::dialect::Dialect;
use crate::db::meta::ObjectRef;

/// The default name of the history table; an app can move it to another schema, never rename it
/// without code, so the explorer looks for this name in every schema.
pub const HISTORY_TABLE: &str = "__EFMigrationsHistory";

/// The history table's columns.
const ID_COLUMN: &str = "MigrationId";
const VERSION_COLUMN: &str = "ProductVersion";

/// Most migrations read: no real project has more, a bigger table is not a history.
pub const MAX_MIGRATIONS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EfMigration {
    /// The full id as recorded (`20231105134530_AddOrders`).
    pub id: String,
    /// The name part (`AddOrders`); the whole id when it has no timestamp prefix.
    pub name: String,
    /// The prefix as `YYYY-MM-DD HH:MM:SS` (as written by the developer's machine, UTC by
    /// EF Core's convention), when the id has one.
    pub timestamp: Option<String>,
    /// The EF Core version that applied it (`8.0.4`).
    pub product_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EfMigrations {
    pub table: ObjectRef,
    /// Oldest first: the order of the ids, which is the order they were created in.
    pub migrations: Vec<EfMigration>,
    /// The table held more rows than were read.
    pub truncated: bool,
}

/// Splits `20231105134530_AddOrders` into its timestamp and name. An id that does not start
/// with 14 digits forming a date (`00000000000000_…`, `Initial`) has no timestamp.
pub fn parse_migration_id(id: &str) -> (Option<String>, String) {
    let Some((prefix, name)) = id.split_once('_') else {
        return (None, id.to_owned());
    };
    match timestamp_of(prefix) {
        Some(timestamp) => (Some(timestamp), name.to_owned()),
        None => (None, id.to_owned()),
    }
}

fn timestamp_of(prefix: &str) -> Option<String> {
    if prefix.len() != 14 || !prefix.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let field = |range: std::ops::Range<usize>| prefix[range].parse::<u32>().ok();
    let (year, month, day) = (field(0..4)?, field(4..6)?, field(6..8)?);
    let (hour, minute, second) = (field(8..10)?, field(10..12)?, field(12..14)?);
    let valid = year >= 1
        && (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && hour < 24
        && minute < 60
        && second < 60;
    valid.then(|| {
        format!(
            "{}-{}-{} {}:{}:{}",
            &prefix[0..4],
            &prefix[4..6],
            &prefix[6..8],
            &prefix[8..10],
            &prefix[10..12],
            &prefix[12..14]
        )
    })
}

pub fn migration(id: String, product_version: Option<String>) -> EfMigration {
    let (timestamp, name) = parse_migration_id(&id);
    EfMigration {
        id,
        name,
        timestamp,
        product_version: product_version.filter(|v| !v.is_empty()),
    }
}

/// The statement that reads the history: identifiers quoted by the dialect, nothing bound
/// because nothing the user typed goes in.
pub fn history_statement(dialect: &dyn Dialect, table: &ObjectRef) -> String {
    format!(
        "SELECT {id}, {version} FROM {table} ORDER BY {id}",
        id = dialect.quote_identifier(ID_COLUMN),
        version = dialect.quote_identifier(VERSION_COLUMN),
        table = dialect.ddl_name(table),
    )
}

/// Whether a name is the history table's (case-insensitive: MySQL on a case-folding file
/// system may store it in lower case).
pub fn is_history_table(name: &str) -> bool {
    name.eq_ignore_ascii_case(HISTORY_TABLE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::engine::Engine;

    #[test]
    fn splits_the_timestamp_from_the_name() {
        assert_eq!(
            parse_migration_id("20231105134530_AddOrders"),
            (
                Some("2023-11-05 13:45:30".to_owned()),
                "AddOrders".to_owned()
            )
        );
        assert_eq!(
            parse_migration_id("20240229235959_Add_Soft_Delete"),
            (
                Some("2024-02-29 23:59:59".to_owned()),
                "Add_Soft_Delete".to_owned()
            )
        );
    }

    #[test]
    fn keeps_ids_without_a_real_timestamp_whole() {
        for id in [
            "Initial",
            "00000000000000_Seed",
            "20231305134530_BadMonth",
            "2023110513453_TooShort",
            "20231105134530",
            "abcdefghijklmn_X",
        ] {
            assert_eq!(parse_migration_id(id), (None, id.to_owned()), "{id}");
        }
    }

    #[test]
    fn builds_the_read_per_dialect() {
        let table = |schema: Option<&str>| ObjectRef {
            database: "shop".into(),
            schema: schema.map(str::to_owned),
            name: HISTORY_TABLE.into(),
        };
        assert_eq!(
            history_statement(Engine::Postgres.dialect(), &table(Some("public"))),
            "SELECT \"MigrationId\", \"ProductVersion\" FROM \"public\".\"__EFMigrationsHistory\" ORDER BY \"MigrationId\""
        );
        assert_eq!(
            history_statement(Engine::Mssql.dialect(), &table(Some("dbo"))),
            "SELECT [MigrationId], [ProductVersion] FROM [shop].[dbo].[__EFMigrationsHistory] ORDER BY [MigrationId]"
        );
        assert_eq!(
            history_statement(Engine::Mysql.dialect(), &table(None)),
            "SELECT `MigrationId`, `ProductVersion` FROM `shop`.`__EFMigrationsHistory` ORDER BY `MigrationId`"
        );
        assert_eq!(
            history_statement(Engine::Sqlite.dialect(), &table(None)),
            "SELECT \"MigrationId\", \"ProductVersion\" FROM \"__EFMigrationsHistory\" ORDER BY \"MigrationId\""
        );
        assert!(is_history_table("__efmigrationshistory"));
    }
}
