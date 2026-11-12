//! How the engines of the SQL family write SQL: identifier quoting, placeholders, lexical
//! rules. Services ask the dialect; they never `match` on the engine. Engines of the other
//! families have no dialect (`Engine::sql_dialect` is `None`).

use crate::db::engine::{Capabilities, Engine};
use crate::db::params::ParamBinding;
use crate::db::split::{BlockRule, Separator, SqlSyntax};

pub trait Dialect:
    Send
    + Sync
    + crate::db::meta::MetaDialect
    + crate::db::edit_dialect::EditDialect
    + crate::db::object_ops::ObjectDialect
    + crate::db::dotnet::DotnetDialect
{
    fn engine(&self) -> Engine;

    /// Human-readable engine name (not translated: product names).
    fn label(&self) -> &'static str {
        self.engine().label()
    }

    /// The capabilities of the dialect's engine.
    fn capabilities(&self) -> Capabilities {
        self.engine().capabilities()
    }

    /// Quotes an identifier so it is taken literally (case, spaces, keywords).
    fn quote_identifier(&self, ident: &str) -> String;

    /// The placeholder of the `index`-th bound parameter, 1-based.
    fn placeholder(&self, index: usize) -> String;

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

    /// How query parameters reach the engine (F-048).
    fn param_binding(&self) -> ParamBinding;
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
    fn quote_identifier(&self, ident: &str) -> String {
        quote_with(ident, '"', '"')
    }
    fn placeholder(&self, index: usize) -> String {
        format!("${index}")
    }
    fn param_binding(&self) -> ParamBinding {
        ParamBinding::DollarNumbers
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
    fn quote_identifier(&self, ident: &str) -> String {
        quote_with(ident, '[', ']')
    }
    fn placeholder(&self, index: usize) -> String {
        format!("@P{index}")
    }
    fn param_binding(&self) -> ParamBinding {
        ParamBinding::AsWritten
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
    fn quote_identifier(&self, ident: &str) -> String {
        quote_with(ident, '`', '`')
    }
    fn placeholder(&self, _index: usize) -> String {
        "?".to_owned()
    }
    fn param_binding(&self) -> ParamBinding {
        ParamBinding::QuestionMarks
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
    fn quote_identifier(&self, ident: &str) -> String {
        quote_with(ident, '"', '"')
    }
    fn placeholder(&self, index: usize) -> String {
        format!("?{index}")
    }
    fn param_binding(&self) -> ParamBinding {
        ParamBinding::AsWritten
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
}
