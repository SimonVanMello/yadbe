//! Read-only classification of user statements (F-008), the first of the two guards of a
//! read-only connection; the second is the engine's own read-only session where it has one
//! (PostgreSQL `default_transaction_read_only`, SQLite read-only open + `query_only`).
//!
//! Conservative by design: a statement passes only when its tokens prove it reads. Anything
//! else is refused, including reads this cannot tell apart from writes.
//!
//! Known limits (the engine guard covers them where it exists):
//! - A function with side effects called from a `SELECT` cannot be seen. PostgreSQL and
//!   SQLite refuse its writes in their read-only session; SQL Server has no such session.
//! - Words are matched, not parsed: a column named like a write keyword (`copy`, `lock`…)
//!   is refused unless the statement avoids it.
//! - `EXECUTE`, `CALL`, `DO`, `PREPARE` and engine-executed comments (`/*! … */`) are refused:
//!   their body cannot be checked.

use crate::db::split::{SqlSyntax, TokenKind, tokenize};

/// Statements that may start a read-only statement. Their remaining words are checked.
const READ_STARTS: &[&str] = &[
    "select",
    "with",
    "values",
    "table",
    "show",
    "describe",
    "desc",
    "explain",
    "pragma",
    "set",
    "reset",
    "begin",
    "start",
    "commit",
    "end",
    "rollback",
    "abort",
    "savepoint",
    "release",
    "fetch",
    "move",
    "close",
    "declare",
    "use",
    "print",
    "if",
    "waitfor",
];

/// Words that write, take write locks, or run code yadbe cannot check, wherever they appear.
const WRITE_WORDS: &[&str] = &[
    "insert",
    "update",
    "delete",
    "merge",
    "upsert",
    "into",
    "truncate",
    "create",
    "drop",
    "alter",
    "rename",
    "grant",
    "revoke",
    "deny",
    "copy",
    "call",
    "exec",
    "execute",
    "do",
    "prepare",
    "vacuum",
    "reindex",
    "cluster",
    "refresh",
    "lock",
    "unlock",
    "load",
    "import",
    "attach",
    "detach",
    "notify",
    "analyze",
    "analyse",
    "checkpoint",
    "handler",
    "kill",
    "shutdown",
    "flush",
    "purge",
    "install",
    "uninstall",
    "restore",
    "backup",
    "dbcc",
    "bulk",
    "openrowset",
    "opendatasource",
    "openquery",
];

/// Functions with side effects outside what the engine's read-only session stops (or that
/// would switch it off).
const WRITE_FUNCTIONS: &[&str] = &[
    "nextval",
    "setval",
    "set_config",
    "dblink",
    "dblink_exec",
    "dblink_connect",
    "lo_import",
    "lo_export",
    "lo_unlink",
    "lo_create",
    "lo_creat",
    "lo_put",
    "lo_from_bytea",
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_switch_wal",
    "pg_create_restore_point",
    "pg_backup_start",
    "pg_backup_stop",
    "pg_start_backup",
    "pg_stop_backup",
    "pg_promote",
    "pg_notify",
    "pg_logical_emit_message",
    "pg_create_physical_replication_slot",
    "pg_create_logical_replication_slot",
    "pg_drop_replication_slot",
    "pg_replication_origin_create",
    "pg_file_write",
    "pg_file_unlink",
    "pg_file_rename",
    "pg_advisory_lock",
    "pg_advisory_xact_lock",
    "pg_try_advisory_lock",
    "pg_try_advisory_xact_lock",
    "pg_import_system_collations",
    "load_extension",
    "writefile",
    "get_lock",
    "release_lock",
    "release_all_locks",
    "sys_exec",
    "sys_eval",
    "xp_cmdshell",
];

/// Settings a read-only session must not change.
const GUARD_SETTINGS: &[&str] = &[
    "default_transaction_read_only",
    "transaction_read_only",
    // MariaDB's name for it (MySQL 5.7 too).
    "tx_read_only",
    "query_only",
    "global",
    "persist",
    "persist_only",
    "sql_log_bin",
    "write",
];

/// Words allowed after `BEGIN` / `START`: a transaction start, nothing else.
const TRANSACTION_WORDS: &[&str] = &[
    "transaction",
    "tran",
    "work",
    "isolation",
    "level",
    "read",
    "only",
    "committed",
    "uncommitted",
    "repeatable",
    "serializable",
    "snapshot",
    "deferrable",
    "not",
    "deferred",
    "immediate",
    "exclusive",
    "distributed",
    "consistent",
    "with",
];

/// `PRAGMA`s that only read, with or without an argument.
const READ_PRAGMAS_WITH_ARGUMENT: &[&str] = &[
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "foreign_key_check",
    "integrity_check",
    "quick_check",
];

/// `PRAGMA`s that only read when called without an argument (with one, most set a value).
const READ_PRAGMAS: &[&str] = &[
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "foreign_key_check",
    "integrity_check",
    "quick_check",
    "database_list",
    "collation_list",
    "function_list",
    "module_list",
    "pragma_list",
    "compile_options",
    "encoding",
    "user_version",
    "schema_version",
    "application_id",
    "page_size",
    "page_count",
    "freelist_count",
    "foreign_keys",
    "query_only",
    "data_version",
    "busy_timeout",
    "cache_size",
    "auto_vacuum",
    "synchronous",
    "temp_store",
    "recursive_triggers",
    "case_sensitive_like",
    "journal_mode",
    "max_page_count",
];

/// Statement keywords `EXPLAIN` options end at.
const EXPLAINED: &[&str] = &[
    "select", "with", "values", "table", "insert", "update", "delete", "merge", "create",
    "execute", "declare", "replace", "do", "call",
];

#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    /// Lowercased word, or quoted identifier content.
    Word(String),
    Punct(char),
    Literal,
    Opaque,
}

fn significant(sql: &str, syntax: &SqlSyntax) -> Vec<Tok> {
    tokenize(sql, syntax)
        .into_iter()
        .filter_map(|t| {
            let text = &sql[t.start..t.end];
            match t.kind {
                TokenKind::Whitespace | TokenKind::Comment => None,
                TokenKind::Word => Some(Tok::Word(text.to_ascii_lowercase())),
                TokenKind::QuotedIdent => {
                    let inner = text
                        .get(1..text.len().saturating_sub(1))
                        .unwrap_or_default();
                    Some(Tok::Word(inner.to_ascii_lowercase()))
                }
                TokenKind::String => Some(Tok::Literal),
                TokenKind::CodeComment => Some(Tok::Opaque),
                TokenKind::Punct => text.chars().next().map(Tok::Punct),
            }
        })
        .collect()
}

fn word(tok: &Tok) -> Option<&str> {
    match tok {
        Tok::Word(w) => Some(w),
        _ => None,
    }
}

/// Why `sql` is refused on a read-only connection: the keyword to name (`UPDATE`,
/// `SELECT … INTO`…), or an empty string when yadbe cannot prove it reads. `None`: it
/// only reads.
pub fn read_only_refusal(sql: &str, syntax: &SqlSyntax) -> Option<String> {
    let tokens = significant(sql, syntax);
    refusal(&tokens)
}

fn upper(word: &str) -> String {
    word.to_ascii_uppercase()
}

fn refusal(tokens: &[Tok]) -> Option<String> {
    if tokens.contains(&Tok::Opaque) {
        return Some(String::new());
    }
    let Some(first) = tokens.first().and_then(word) else {
        // `(SELECT …)` and other forms not starting with a keyword.
        return Some(String::new());
    };
    if !READ_STARTS.contains(&first) {
        return Some(upper(first));
    }
    if first == "explain" {
        let rest = tokens
            .iter()
            .position(|t| word(t).is_some_and(|w| EXPLAINED.contains(&w)));
        // Without a statement, MySQL's `EXPLAIN table` describes a table.
        return rest.and_then(|i| refusal(&tokens[i..]));
    }
    let words = || tokens.iter().filter_map(word);
    // Row locks (`FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`).
    let pairs = || {
        tokens
            .windows(2)
            .filter_map(|w| Some((word(&w[0])?, word(&w[1])?)))
    };
    if let Some((_, lock)) =
        pairs().find(|(a, b)| *a == "for" && matches!(*b, "update" | "share" | "no" | "key"))
    {
        let share = lock == "share" || (lock == "key" && words().any(|w| w == "share"));
        return Some(if share { "FOR SHARE" } else { "FOR UPDATE" }.to_owned());
    }
    if let Some(write) = words().find(|w| WRITE_WORDS.contains(w)) {
        return Some(match write {
            "into" => format!("{} … INTO", upper(first)),
            other => upper(other),
        });
    }
    if let Some(function) = words().find(|w| WRITE_FUNCTIONS.contains(w)) {
        return Some(format!("{}()", function));
    }
    match first {
        "set" => words()
            .skip(1)
            .find(|w| GUARD_SETTINGS.contains(w))
            .map(|_| "SET".to_owned()),
        "reset" => words()
            .nth(1)
            .filter(|w| matches!(*w, "master" | "slave" | "replica" | "binary" | "persist"))
            .map(|_| "RESET".to_owned()),
        "begin" | "start" => words()
            .skip(1)
            .find(|w| !TRANSACTION_WORDS.contains(w))
            .map(|_| upper(first)),
        "commit" | "end" | "rollback" | "abort" | "release" | "savepoint" => words()
            .any(|w| w == "prepared")
            .then(|| format!("{} PREPARED", upper(first))),
        "pragma" => pragma_refusal(tokens),
        _ => None,
    }
}

/// What a successful statement does to the session's transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionEffect {
    Begin,
    End,
    None,
}

/// Tracks the transaction for engines that do not report it (`BEGIN`, `COMMIT`, `ROLLBACK`
/// without savepoint, `END`, `ABORT`, `PREPARE TRANSACTION`).
pub fn transaction_effect(sql: &str, syntax: &SqlSyntax) -> TransactionEffect {
    let tokens = significant(sql, syntax);
    let mut words = tokens.iter().filter_map(word);
    let first = words.next();
    let second = words.next();
    let any = |target: &str| tokens.iter().filter_map(word).any(|w| w == target);
    match (first, second) {
        (Some("begin"), None) => TransactionEffect::Begin,
        (Some("begin"), Some(next)) if TRANSACTION_WORDS.contains(&next) => {
            TransactionEffect::Begin
        }
        (Some("start"), Some("transaction")) => TransactionEffect::Begin,
        (Some("commit" | "end" | "abort" | "rollback"), _) if any("prepared") => {
            TransactionEffect::None
        }
        (Some("rollback"), _) if any("to") => TransactionEffect::None,
        (Some("commit" | "end" | "abort" | "rollback"), _) => TransactionEffect::End,
        (Some("prepare"), Some("transaction")) => TransactionEffect::End,
        _ => TransactionEffect::None,
    }
}

/// Whether a statement's row count means "rows affected" (DML): engines also report a count
/// for DDL (`0`), which is noise.
pub fn reports_row_count(sql: &str, syntax: &SqlSyntax) -> bool {
    const DML: &[&str] = &["insert", "update", "delete", "merge", "replace", "upsert"];
    let tokens = significant(sql, syntax);
    let mut words = tokens.iter().filter_map(word);
    match words.next() {
        Some(first) if DML.contains(&first) => true,
        Some("with") => words.any(|w| DML.contains(&w)),
        _ => false,
    }
}

/// Whether a statement changes the schema (what the explorer and the autocomplete show):
/// `CREATE`, `ALTER`, `DROP`, `RENAME`, `COMMENT`, and SQL Server's `sp_rename`. `TRUNCATE`
/// changes data only.
pub fn changes_schema(sql: &str, syntax: &SqlSyntax) -> bool {
    const DDL: &[&str] = &["create", "alter", "drop", "rename", "comment"];
    let tokens = significant(sql, syntax);
    let mut words = tokens.iter().filter_map(word);
    match words.next() {
        Some(first) if DDL.contains(&first) => true,
        Some("exec" | "execute") => words.take(3).any(|w| w == "sp_rename"),
        _ => false,
    }
}

/// Whether a statement ends a transaction by discarding it (`ROLLBACK`, `ABORT`, without
/// savepoint).
pub fn rolls_back(sql: &str, syntax: &SqlSyntax) -> bool {
    let tokens = significant(sql, syntax);
    let mut words = tokens.iter().filter_map(word);
    matches!(words.next(), Some("rollback" | "abort")) && !words.any(|w| w == "to")
}

fn pragma_refusal(tokens: &[Tok]) -> Option<String> {
    if tokens.contains(&Tok::Punct('=')) {
        return Some("PRAGMA".to_owned());
    }
    // `PRAGMA [schema.]name[(argument)]`: the name is the word before `(` or the last one.
    let name = tokens
        .iter()
        .take_while(|t| **t != Tok::Punct('('))
        .filter_map(word)
        .last()?;
    let allowed = if tokens.contains(&Tok::Punct('(')) {
        READ_PRAGMAS_WITH_ARGUMENT
    } else {
        READ_PRAGMAS
    };
    (!allowed.contains(&name)).then(|| "PRAGMA".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::engine::Engine;

    fn check(engine: Engine, sql: &str) -> Option<String> {
        read_only_refusal(sql, &engine.dialect().syntax())
    }

    #[test]
    fn schema_changes() {
        let syntax = Engine::Postgres.dialect().syntax();
        for sql in [
            "CREATE TABLE t (a int)",
            "  -- c\n alter table t add b int",
            "drop index i",
            "COMMENT ON TABLE t IS 'x'",
            "RENAME TABLE a TO b",
            "EXEC sp_rename 'a', 'b'",
            "execute dbo.sp_rename 'a', 'b'",
        ] {
            assert!(changes_schema(sql, &syntax), "{sql}");
        }
        for sql in [
            "select 1",
            "TRUNCATE t",
            "insert into t values (1)",
            "exec sp_who",
        ] {
            assert!(!changes_schema(sql, &syntax), "{sql}");
        }
        assert!(rolls_back("ROLLBACK", &syntax));
        assert!(!rolls_back("rollback to savepoint s", &syntax));
        assert!(!rolls_back("commit", &syntax));
    }

    #[test]
    fn row_counts_of_dml_only() {
        let syntax = Engine::Postgres.dialect().syntax();
        assert!(reports_row_count("UPDATE t SET a = 1", &syntax));
        assert!(reports_row_count(
            "with x as (select 1) delete from t",
            &syntax
        ));
        assert!(!reports_row_count("CREATE TABLE t (a int)", &syntax));
        assert!(!reports_row_count("select 1", &syntax));
    }

    #[test]
    fn transaction_effects() {
        let syntax = Engine::Postgres.dialect().syntax();
        let effect = |sql| transaction_effect(sql, &syntax);
        assert_eq!(effect("BEGIN"), TransactionEffect::Begin);
        assert_eq!(
            effect("begin isolation level serializable"),
            TransactionEffect::Begin
        );
        assert_eq!(
            effect("START TRANSACTION READ ONLY"),
            TransactionEffect::Begin
        );
        assert_eq!(effect("commit"), TransactionEffect::End);
        assert_eq!(effect("END"), TransactionEffect::End);
        assert_eq!(effect("ROLLBACK"), TransactionEffect::End);
        assert_eq!(effect("rollback to savepoint a"), TransactionEffect::None);
        assert_eq!(effect("COMMIT PREPARED 'x'"), TransactionEffect::None);
        assert_eq!(effect("PREPARE TRANSACTION 'x'"), TransactionEffect::End);
        assert_eq!(effect("select 1"), TransactionEffect::None);
        let mssql = Engine::Mssql.dialect().syntax();
        assert_eq!(
            transaction_effect("BEGIN SELECT 1 END", &mssql),
            TransactionEffect::None
        );
        assert_eq!(
            transaction_effect("BEGIN TRAN", &mssql),
            TransactionEffect::Begin
        );
    }

    #[test]
    fn plain_reads_pass() {
        for sql in [
            "SELECT * FROM orders WHERE status = 'update'",
            "select \"comment\", replace(name, 'a', 'b') from t",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "VALUES (1), (2)",
            "TABLE orders",
            "SHOW search_path",
            "EXPLAIN SELECT 1",
            "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t",
            "SET search_path TO app, public",
            "SET ROLE reader",
            "RESET ALL",
            "BEGIN",
            "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
            "START TRANSACTION READ ONLY",
            "COMMIT",
            "ROLLBACK TO SAVEPOINT sp1",
            "SAVEPOINT sp1",
            "FETCH 10 FROM c",
            "-- comment\nselect 1 /* insert */",
        ] {
            assert_eq!(check(Engine::Postgres, sql), None, "{sql}");
        }
        for sql in [
            "PRAGMA table_info(orders)",
            "pragma main.index_list('t')",
            "PRAGMA user_version",
            "EXPLAIN QUERY PLAN SELECT * FROM t",
            "select [order] from `t`",
        ] {
            assert_eq!(check(Engine::Sqlite, sql), None, "{sql}");
        }
        assert_eq!(check(Engine::Mysql, "EXPLAIN orders"), None);
        assert_eq!(check(Engine::Mysql, "DESCRIBE orders"), None);
        assert_eq!(
            check(
                Engine::Mssql,
                "IF EXISTS (SELECT 1 FROM t) SELECT 1 ELSE SELECT 2"
            ),
            None
        );
    }

    #[test]
    fn writes_ddl_and_unknown_statements_are_refused() {
        let cases = [
            ("UPDATE t SET a = 1", "UPDATE"),
            ("delete from t", "DELETE"),
            ("insert into t values (1)", "INSERT"),
            ("CREATE TABLE t (a int)", "CREATE"),
            ("drop table t", "DROP"),
            ("truncate t", "TRUNCATE"),
            (
                "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
                "DELETE",
            ),
            ("SELECT * INTO new_table FROM t", "SELECT … INTO"),
            ("select * from t for update", "FOR UPDATE"),
            ("SELECT * FROM t FOR NO KEY UPDATE", "FOR UPDATE"),
            ("SELECT * FROM t FOR KEY SHARE", "FOR SHARE"),
            ("select nextval('s')", "nextval()"),
            (
                "SELECT pg_catalog.set_config('default_transaction_read_only', 'off', false)",
                "set_config()",
            ),
            ("select \"set_config\"('a', 'b', false)", "set_config()"),
            ("SET default_transaction_read_only = off", "SET"),
            (
                "set session characteristics as transaction read write",
                "SET",
            ),
            ("SET TRANSACTION READ WRITE", "SET"),
            ("BEGIN READ WRITE", "BEGIN"),
            ("START TRANSACTION READ WRITE", "START"),
            ("COMMIT PREPARED 'x'", "COMMIT PREPARED"),
            ("EXPLAIN ANALYZE DELETE FROM t", "DELETE"),
            ("CALL p()", "CALL"),
            ("DO $$ BEGIN PERFORM 1; END $$", "DO"),
            ("COPY t TO '/tmp/x'", "COPY"),
            ("VACUUM", "VACUUM"),
            ("GRANT SELECT ON t TO u", "GRANT"),
            ("LISTEN chan", "LISTEN"),
            ("selec 1", "SELEC"),
        ];
        for (sql, expected) in cases {
            assert_eq!(
                check(Engine::Postgres, sql).as_deref(),
                Some(expected),
                "{sql}"
            );
        }
        assert_eq!(check(Engine::Postgres, "(select 1)").as_deref(), Some(""));
        assert_eq!(
            check(Engine::Sqlite, "PRAGMA query_only = 0").as_deref(),
            Some("PRAGMA")
        );
        assert_eq!(
            check(Engine::Sqlite, "PRAGMA journal_mode(WAL)").as_deref(),
            Some("PRAGMA")
        );
        assert_eq!(
            check(Engine::Sqlite, "PRAGMA journal_mode").as_deref(),
            None
        );
        assert_eq!(
            check(Engine::Sqlite, "pragma wal_checkpoint").as_deref(),
            Some("PRAGMA")
        );
        assert_eq!(
            check(Engine::Sqlite, "ATTACH 'x.db' AS x").as_deref(),
            Some("ATTACH")
        );
        assert_eq!(
            check(Engine::Sqlite, "VACUUM INTO 'copy.db'").as_deref(),
            Some("VACUUM")
        );
        assert_eq!(
            check(Engine::Mysql, "/*!40101 SET NAMES utf8 */").as_deref(),
            Some("")
        );
        assert_eq!(
            check(Engine::Mysql, "SET GLOBAL max_connections = 10").as_deref(),
            Some("SET")
        );
        assert_eq!(
            check(Engine::Mysql, "/*M!100000 DELETE FROM t */").as_deref(),
            Some("")
        );
        assert_eq!(
            check(Engine::Mysql, "SET tx_read_only = 0").as_deref(),
            Some("SET")
        );
        assert_eq!(
            check(Engine::Mysql, "SET @@session.transaction_read_only = OFF").as_deref(),
            Some("SET")
        );
        assert_eq!(
            check(Engine::Mysql, "START TRANSACTION READ WRITE").as_deref(),
            Some("START")
        );
        assert_eq!(
            check(Engine::Mssql, "SELECT 1; EXEC sp_who").as_deref(),
            Some("EXEC")
        );
        assert_eq!(
            check(Engine::Mssql, "IF 1 = 1 BEGIN DELETE FROM t END").as_deref(),
            Some("DELETE")
        );
    }
}
