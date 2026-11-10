//! Engine differences expressed as data: identifier quoting, placeholders and capabilities.
//! Services and the frontend ask the dialect; they never `match` on the engine.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::split::{BlockRule, Separator, SqlSyntax};

/// Database engines yadbe knows. Every engine has a dialect; drivers arrive one by one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    Postgres,
    Mssql,
    Mysql,
    Sqlite,
}

impl Engine {
    pub const ALL: [Engine; 4] = [
        Engine::Postgres,
        Engine::Mssql,
        Engine::Mysql,
        Engine::Sqlite,
    ];

    /// Stable identifier, as stored in the app database.
    pub fn id(self) -> &'static str {
        match self {
            Engine::Postgres => "postgres",
            Engine::Mssql => "mssql",
            Engine::Mysql => "mysql",
            Engine::Sqlite => "sqlite",
        }
    }

    pub fn from_id(id: &str) -> Option<Engine> {
        Engine::ALL.into_iter().find(|engine| engine.id() == id)
    }

    pub fn dialect(self) -> &'static dyn Dialect {
        match self {
            Engine::Postgres => &PostgresDialect,
            Engine::Mssql => &MssqlDialect,
            Engine::Mysql => &MysqlDialect,
            Engine::Sqlite => &SqliteDialect,
        }
    }
}

/// What an engine supports, as data the services and the UI can branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// The database is a local file (no host, port or user).
    pub uses_file: bool,
    /// Default TCP port, for server engines.
    pub default_port: Option<u16>,
    /// The engine supports TLS and the connection form shows the TLS settings.
    pub supports_tls: bool,
    /// A server hosts several databases that can be listed and switched.
    pub multiple_databases: bool,
    /// Schemas exist between the database and its tables.
    pub schemas: bool,
    /// A running statement can be cancelled with a native mechanism.
    pub native_cancel: bool,
    /// The session can be put in read-only mode by the engine itself.
    pub read_only_session: bool,
}

pub trait Dialect: Send + Sync {
    fn engine(&self) -> Engine;

    /// Human-readable engine name (not translated: product names).
    fn label(&self) -> &'static str;

    fn capabilities(&self) -> Capabilities;

    /// Quotes an identifier so it is taken literally (case, spaces, keywords).
    fn quote_identifier(&self, ident: &str) -> String;

    /// The placeholder of the `index`-th bound parameter, 1-based.
    fn placeholder(&self, index: usize) -> String;

    /// User name the connection form suggests.
    fn default_username(&self) -> Option<&'static str> {
        None
    }

    /// Lexical rules for splitting scripts and classifying statements.
    fn syntax(&self) -> SqlSyntax;

    /// The statement that opens a transaction (manual transaction mode, F-047).
    fn begin_transaction(&self) -> &'static str {
        "BEGIN"
    }

    /// A failed statement leaves the open transaction failed: only a rollback ends it.
    fn error_aborts_transaction(&self) -> bool {
        false
    }
}

/// Doubles the closing quote inside the identifier, then wraps it.
fn quote_with(ident: &str, open: char, close: char) -> String {
    let mut out = String::with_capacity(ident.len() + 2);
    out.push(open);
    for c in ident.chars() {
        if c == close {
            out.push(close);
        }
        out.push(c);
    }
    out.push(close);
    out
}

pub struct PostgresDialect;

impl Dialect for PostgresDialect {
    fn engine(&self) -> Engine {
        Engine::Postgres
    }
    fn label(&self) -> &'static str {
        "PostgreSQL"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            uses_file: false,
            default_port: Some(5432),
            supports_tls: true,
            multiple_databases: true,
            schemas: true,
            native_cancel: true,
            read_only_session: true,
        }
    }
    fn quote_identifier(&self, ident: &str) -> String {
        quote_with(ident, '"', '"')
    }
    fn placeholder(&self, index: usize) -> String {
        format!("${index}")
    }
    fn default_username(&self) -> Option<&'static str> {
        Some("postgres")
    }
    fn syntax(&self) -> SqlSyntax {
        SqlSyntax {
            dollar_quotes: true,
            e_strings: true,
            backslash_strings: false,
            nested_comments: true,
            hash_comments: false,
            dash_comment_needs_space: false,
            backtick_idents: false,
            bracket_idents: false,
            executable_comments: false,
            separator: Separator::Semicolon,
            blocks: BlockRule::BeginAtomic,
        }
    }
    fn error_aborts_transaction(&self) -> bool {
        true
    }
}

pub struct MssqlDialect;

impl Dialect for MssqlDialect {
    fn engine(&self) -> Engine {
        Engine::Mssql
    }
    fn label(&self) -> &'static str {
        "SQL Server"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            uses_file: false,
            default_port: Some(1433),
            supports_tls: true,
            multiple_databases: true,
            schemas: true,
            native_cancel: true,
            read_only_session: false,
        }
    }
    fn quote_identifier(&self, ident: &str) -> String {
        quote_with(ident, '[', ']')
    }
    fn placeholder(&self, index: usize) -> String {
        format!("@P{index}")
    }
    fn default_username(&self) -> Option<&'static str> {
        Some("sa")
    }
    fn syntax(&self) -> SqlSyntax {
        SqlSyntax {
            dollar_quotes: false,
            e_strings: false,
            backslash_strings: false,
            nested_comments: true,
            hash_comments: false,
            dash_comment_needs_space: false,
            backtick_idents: false,
            bracket_idents: true,
            executable_comments: false,
            separator: Separator::GoBatches,
            blocks: BlockRule::None,
        }
    }
    fn begin_transaction(&self) -> &'static str {
        "BEGIN TRANSACTION"
    }
}

pub struct MysqlDialect;

impl Dialect for MysqlDialect {
    fn engine(&self) -> Engine {
        Engine::Mysql
    }
    fn label(&self) -> &'static str {
        "MySQL / MariaDB"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            uses_file: false,
            default_port: Some(3306),
            supports_tls: true,
            multiple_databases: true,
            schemas: false,
            native_cancel: true,
            read_only_session: true,
        }
    }
    fn quote_identifier(&self, ident: &str) -> String {
        quote_with(ident, '`', '`')
    }
    fn placeholder(&self, _index: usize) -> String {
        "?".to_owned()
    }
    fn default_username(&self) -> Option<&'static str> {
        Some("root")
    }
    fn syntax(&self) -> SqlSyntax {
        SqlSyntax {
            dollar_quotes: false,
            e_strings: false,
            backslash_strings: true,
            nested_comments: false,
            hash_comments: true,
            dash_comment_needs_space: true,
            backtick_idents: true,
            bracket_idents: false,
            executable_comments: true,
            separator: Separator::MysqlDelimiter,
            blocks: BlockRule::None,
        }
    }
    fn begin_transaction(&self) -> &'static str {
        "START TRANSACTION"
    }
}

pub struct SqliteDialect;

impl Dialect for SqliteDialect {
    fn engine(&self) -> Engine {
        Engine::Sqlite
    }
    fn label(&self) -> &'static str {
        "SQLite"
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            uses_file: true,
            default_port: None,
            supports_tls: false,
            multiple_databases: false,
            schemas: false,
            native_cancel: true,
            read_only_session: true,
        }
    }
    fn quote_identifier(&self, ident: &str) -> String {
        quote_with(ident, '"', '"')
    }
    fn placeholder(&self, index: usize) -> String {
        format!("?{index}")
    }
    fn syntax(&self) -> SqlSyntax {
        SqlSyntax {
            dollar_quotes: false,
            e_strings: false,
            backslash_strings: false,
            nested_comments: false,
            hash_comments: false,
            dash_comment_needs_space: false,
            backtick_idents: true,
            bracket_idents: true,
            executable_comments: false,
            separator: Separator::Semicolon,
            blocks: BlockRule::SqliteTrigger,
        }
    }
}

/// An engine as the connection form sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine: Engine,
    pub label: String,
    pub capabilities: Capabilities,
    pub default_username: Option<String>,
    /// A driver for this engine ships in this build; otherwise connecting fails with
    /// `engineNotSupported`.
    pub available: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers_per_engine() {
        assert_eq!(
            Engine::Postgres.dialect().quote_identifier("a\"b"),
            "\"a\"\"b\""
        );
        assert_eq!(Engine::Mssql.dialect().quote_identifier("a]b"), "[a]]b]");
        assert_eq!(Engine::Mysql.dialect().quote_identifier("a`b"), "`a``b`");
        assert_eq!(
            Engine::Sqlite.dialect().quote_identifier("Order"),
            "\"Order\""
        );
    }

    #[test]
    fn placeholders_per_engine() {
        assert_eq!(Engine::Postgres.dialect().placeholder(2), "$2");
        assert_eq!(Engine::Mssql.dialect().placeholder(2), "@P2");
        assert_eq!(Engine::Mysql.dialect().placeholder(2), "?");
        assert_eq!(Engine::Sqlite.dialect().placeholder(2), "?2");
    }

    #[test]
    fn ids_round_trip() {
        for engine in Engine::ALL {
            assert_eq!(Engine::from_id(engine.id()), Some(engine));
            assert_eq!(engine.dialect().engine(), engine);
            let json = serde_json::to_value(engine).expect("serializes");
            assert_eq!(json, engine.id());
        }
    }
}
