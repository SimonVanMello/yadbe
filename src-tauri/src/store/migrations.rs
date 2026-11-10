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
