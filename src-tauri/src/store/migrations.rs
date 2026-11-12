//! Versioned schema migrations, tracked with `PRAGMA user_version`.

use rusqlite::Connection;

/// Each entry upgrades the schema from version `index` to `index + 1`. Never edit a
/// released migration: append a new one.
const MIGRATIONS: &[&str] = &[
    // v1: connections (no secret column: secrets live in the keychain), groups, tabs,
    // preferences, misc key/value.
    "CREATE TABLE connection_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES connection_groups(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        collapsed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        engine TEXT NOT NULL,
        group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL,
        position INTEGER NOT NULL,
        host TEXT NOT NULL DEFAULT '',
        port INTEGER,
        database_name TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL DEFAULT '',
        auth TEXT NOT NULL,
        tls_mode TEXT NOT NULL,
        ca_cert_path TEXT,
        connect_timeout_secs INTEGER,
        options TEXT NOT NULL DEFAULT '[]',
        environment TEXT NOT NULL DEFAULT 'none',
        environment_label TEXT,
        environment_color TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        read_only INTEGER NOT NULL DEFAULT 0,
        remember_password INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_connected_at INTEGER
    );
    CREATE INDEX connections_by_group ON connections(group_id, position);
    CREATE TABLE tabs (
        position INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
        database_name TEXT,
        content TEXT NOT NULL,
        cursor_anchor INTEGER,
        cursor_head INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        file_path TEXT,
        table_schema TEXT,
        table_name TEXT,
        ui_state TEXT
    );
    CREATE TABLE preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );",
    // v2: history (F-100) with a full-text index on the statement text, and the per-connection
    // opt-out (F-104). `history` has no foreign key on connections: entries outlive a deleted
    // connection, with the name it had.
    // The id of an entry is derived from its start time (see `store::history`), so ordering
    // and range filters use the primary key.
    "ALTER TABLE connections ADD COLUMN history_enabled INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE history (
        id INTEGER PRIMARY KEY,
        connection_id TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        engine TEXT NOT NULL,
        database_name TEXT,
        sql TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        duration_ms REAL NOT NULL,
        rows INTEGER,
        outcome TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT
    );
    CREATE INDEX history_by_connection ON history(connection_id, id);
    CREATE VIRTUAL TABLE history_fts USING fts5(
        sql, content='history', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2', prefix='2 3'
    );
    CREATE TRIGGER history_after_insert AFTER INSERT ON history BEGIN
        INSERT INTO history_fts(rowid, sql) VALUES (new.id, new.sql);
    END;
    CREATE TRIGGER history_after_delete AFTER DELETE ON history BEGIN
        INSERT INTO history_fts(history_fts, rowid, sql) VALUES ('delete', old.id, old.sql);
    END;",
    // v3: saved queries and snippets (F-050). A query bound to a connection keeps living (as
    // a global one) when that connection is deleted: the library never loses a query. The
    // `seq` integer is the FTS5 rowid (a TEXT primary key has no stable rowid). A folder
    // deletes what it holds, after a confirmation that counts it.
    "CREATE TABLE saved_query_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES saved_query_folders(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX saved_query_folders_by_parent ON saved_query_folders(parent_id);
    CREATE TABLE saved_queries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        folder_id TEXT REFERENCES saved_query_folders(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sql TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
        database_name TEXT,
        snippet_trigger TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
    );
    CREATE INDEX saved_queries_by_folder ON saved_queries(folder_id);
    CREATE INDEX saved_queries_by_connection ON saved_queries(connection_id);
    CREATE VIRTUAL TABLE saved_queries_fts USING fts5(
        name, sql, description, tags, content='saved_queries', content_rowid='seq',
        tokenize='unicode61 remove_diacritics 2', prefix='2 3'
    );
    CREATE TRIGGER saved_queries_after_insert AFTER INSERT ON saved_queries BEGIN
        INSERT INTO saved_queries_fts(rowid, name, sql, description, tags)
        VALUES (new.seq, new.name, new.sql, new.description, new.tags);
    END;
    CREATE TRIGGER saved_queries_after_delete AFTER DELETE ON saved_queries BEGIN
        INSERT INTO saved_queries_fts(saved_queries_fts, rowid, name, sql, description, tags)
        VALUES ('delete', old.seq, old.name, old.sql, old.description, old.tags);
    END;
    -- Not on `last_used_at`: using a query must not rewrite its text in the index.
    CREATE TRIGGER saved_queries_after_update AFTER UPDATE OF name, sql, description, tags
    ON saved_queries BEGIN
        INSERT INTO saved_queries_fts(saved_queries_fts, rowid, name, sql, description, tags)
        VALUES ('delete', old.seq, old.name, old.sql, old.description, old.tags);
        INSERT INTO saved_queries_fts(rowid, name, sql, description, tags)
        VALUES (new.seq, new.name, new.sql, new.description, new.tags);
    END;",
    // v4: SSH tunnels (F-010). The tunnel of a connection is a JSON column (no secret in it:
    // passwords and passphrases live in the keychain); host keys the user accepted are kept
    // by fingerprint, one row per host, port and key type.
    "ALTER TABLE connections ADD COLUMN ssh_tunnel TEXT;
    CREATE TABLE ssh_known_hosts (
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        key_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (host, port, key_type)
    );",
    // v5: change journal (F-090). One row per applied change set: the statements as run
    // (values written as literals, like the SQL preview), and its inverse as a JSON change set
    // (`NULL` with `revert_blocker` when it cannot be reverted faithfully). No foreign key on
    // connections: entries outlive a deleted connection, with the name it had.
    "CREATE TABLE change_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL,
        connection_name TEXT NOT NULL,
        engine TEXT NOT NULL,
        database_name TEXT NOT NULL,
        schema_name TEXT,
        table_name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        duration_ms REAL NOT NULL,
        updated INTEGER NOT NULL,
        inserted INTEGER NOT NULL,
        deleted INTEGER NOT NULL,
        statements TEXT NOT NULL,
        inverse TEXT,
        inverse_statements TEXT NOT NULL,
        revert_blocker TEXT,
        reverts INTEGER,
        reverted_by INTEGER
    );
    CREATE INDEX change_journal_by_connection ON change_journal(connection_id, id);
    CREATE INDEX change_journal_by_table ON change_journal(table_name, id);",
    // v6: pinned objects and schemas (F-027), per connection. They go with the connection.
    // `schema_name` is '' on engines without schemas (a NULL would break the key) and the
    // schema itself for a pinned schema, whose `kind` is 'schema'.
    "CREATE TABLE pinned_objects (
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        database_name TEXT NOT NULL,
        schema_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        object_id TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        pinned_at INTEGER NOT NULL,
        PRIMARY KEY (connection_id, database_name, schema_name, kind, object_id)
    );",
    // v7: per-tab history (F-102): the editor tab a statement ran in. Entries written before
    // have none. No foreign key: the history outlives the tab.
    "ALTER TABLE history ADD COLUMN tab_id TEXT;
    CREATE INDEX history_by_tab ON history(tab_id, id);",
    // v8: statement timeout and keep-alive per connection (F-014). NULL: no timeout / the
    // default interval; connections saved before have neither.
    "ALTER TABLE connections ADD COLUMN statement_timeout_secs INTEGER;
    ALTER TABLE connections ADD COLUMN keep_alive_secs INTEGER;",
    // v9: TLS client certificate and key files of a connection (F-009). Paths only: the key's
    // passphrase is a secret and lives in the keychain.
    "ALTER TABLE connections ADD COLUMN tls_client_cert_path TEXT;
    ALTER TABLE connections ADD COLUMN tls_client_key_path TEXT;",
    // v10: the fields of a MongoDB connection (M4-2), as JSON: SRV, replica set, auth source
    // and mechanism, direct connection. NULL for the other families and older rows.
    "ALTER TABLE connections ADD COLUMN mongo_settings TEXT;",
    // v11: settings of key-value connections (Redis, Valkey) as JSON (`KeyValueSettings`);
    // NULL for the other families and for connections saved before.
    "ALTER TABLE connections ADD COLUMN key_value TEXT;",
];

pub fn apply(conn: &mut Connection) -> rusqlite::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    for (version, sql) in (1_i64..).zip(MIGRATIONS) {
        if version <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
        tracing::info!(version, "applied store migration");
    }
    Ok(())
}

/// Schema version after all migrations.
pub fn latest_version() -> i64 {
    i64::try_from(MIGRATIONS.len()).unwrap_or(i64::MAX)
}

/// An older database for a test: the schema as it was after `version` migrations (those not
/// applied yet).
#[cfg(test)]
pub fn apply_through(conn: &mut Connection, version: usize) -> rusqlite::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    for (number, sql) in (1_i64..).zip(MIGRATIONS.iter().take(version)) {
        if number <= current {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", number)?;
        tx.commit()?;
    }
    Ok(())
}

/// The schema of version 1, to build older databases in tests.
#[cfg(test)]
pub fn first_migration() -> &'static str {
    MIGRATIONS[0]
}
