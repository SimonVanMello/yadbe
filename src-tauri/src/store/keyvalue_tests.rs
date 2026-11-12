//! v11: the settings of key-value connections.

use super::*;
use crate::db::config::{KeyValueSettings, sample_definition};

#[test]
fn key_value_settings_round_trip_and_stay_with_their_family() {
    let store = Store::open_in_memory().expect("store");
    let mut redis = sample_definition(Engine::Redis);
    redis.database = "3".into();
    redis.key_value = Some(KeyValueSettings {
        key_delimiter: Some("/".into()),
    });
    let saved = store
        .create_connection(&redis.normalized().expect("valid"))
        .expect("save");
    let read = store.connection(&saved.id).expect("read");
    assert_eq!(
        read.definition
            .key_value
            .clone()
            .and_then(|kv| kv.key_delimiter)
            .as_deref(),
        Some("/")
    );
    assert_eq!(read.definition.database, "3");

    // Another family keeps none, and an update clears an empty delimiter.
    let mut pg = sample_definition(Engine::Postgres);
    pg.key_value = Some(KeyValueSettings::default());
    let pg = store
        .create_connection(&pg.normalized().expect("valid"))
        .expect("save");
    assert_eq!(
        store.connection(&pg.id).expect("read").definition.key_value,
        None
    );
    let mut edited = read.definition.clone();
    edited.key_value = Some(KeyValueSettings {
        key_delimiter: Some(String::new()),
    });
    store
        .update_connection(&saved.id, &edited.normalized().expect("valid"))
        .expect("update");
    assert_eq!(
        store
            .connection(&saved.id)
            .expect("read")
            .definition
            .key_value,
        Some(KeyValueSettings::default())
    );

    // A Redis database is an index.
    let mut named = sample_definition(Engine::Redis);
    named.database = "app".into();
    assert!(named.normalized().is_err());
}

#[test]
fn connections_saved_before_v11_have_no_key_value_settings() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(DB_FILE);
    {
        let mut conn = Connection::open(&path).expect("open");
        migrations::apply_through(&mut conn, 9).expect("v9");
        conn.execute(
            "INSERT INTO connections (id, name, engine, position, host, auth, tls_mode, created_at,
                updated_at) VALUES ('c1', 'old', 'postgres', 0, 'db', 'password', 'prefer', 1, 1)",
            [],
        )
        .expect("insert");
    }
    let store = Store::open(&path).expect("reopen");
    assert_eq!(
        store.schema_version().expect("version"),
        Store::latest_schema_version()
    );
    let old = store.connection("c1").expect("read");
    assert_eq!(old.definition.key_value, None);
}

#[test]
fn sql_journal_entries_written_before_v12_stay_readable_and_revertible() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(DB_FILE);
    {
        let mut conn = Connection::open(&path).expect("open");
        migrations::apply_through(&mut conn, 11).expect("v11");
        conn.execute(
            "INSERT INTO change_journal (connection_id, connection_name, engine, database_name,
                schema_name, table_name, applied_at, duration_ms, updated, inserted, deleted,
                statements, inverse, inverse_statements)
             VALUES ('c1', 'Local', 'postgres', 'shop', 'public', 'orders', 1000, 1.5, 1, 0, 0,
                '[{\"sql\":\"UPDATE orders SET a = 1\",\"rowsAffected\":1.0}]', '{\"inverse\":1}',
                '[\"UPDATE orders SET a = 0\"]')",
            [],
        )
        .expect("insert");
    }
    let store = Store::open(&path).expect("reopen");
    assert_eq!(store.schema_version().expect("version"), 12);
    let page = store
        .search_journal(&JournalQuery::default())
        .expect("search");
    let entry = &page.entries[0];
    assert_eq!(entry.family, crate::db::engine::EngineFamily::Sql);
    assert_eq!(entry.target_kind, JournalTargetKind::Table);
    assert_eq!(entry.table.name, "orders");
    assert_eq!(entry.revert_blocker, None);
    let inverse = store
        .journal_inverse(entry.id)
        .expect("inverse")
        .expect("found");
    assert_eq!(inverse.inverse.as_deref(), Some("{\"inverse\":1}"));
    let detail = store
        .journal_entry(entry.id)
        .expect("detail")
        .expect("found");
    assert_eq!(detail.statements[0].sql, "UPDATE orders SET a = 1");
    assert_eq!(detail.inverse_statements, ["UPDATE orders SET a = 0"]);

    // A key-value entry next to it keeps its family and target.
    let id = store
        .insert_journal(&NewJournalEntry {
            connection_id: "r1".into(),
            connection_name: "Cache".into(),
            engine: Engine::Redis,
            target_kind: JournalTargetKind::Key,
            table: crate::db::meta::ObjectRef {
                database: "0".into(),
                schema: None,
                name: "user:1".into(),
            },
            applied_at_ms: 2_000,
            duration_ms: 0.5,
            updated: 1,
            inserted: 0,
            deleted: 0,
            statements: vec![JournalStatement {
                sql: "HSET user:1 name Ada".into(),
                rows_affected: Some(0.0),
            }],
            inverse: Some("{}".into()),
            inverse_statements: vec!["HSET user:1 name Grace".into()],
            blocker: None,
            reverts: None,
        })
        .expect("insert");
    let kv = store
        .journal_entry(u32::try_from(id).expect("id"))
        .expect("detail")
        .expect("found");
    assert_eq!(kv.entry.family, crate::db::engine::EngineFamily::KeyValue);
    assert_eq!(kv.entry.target_kind, JournalTargetKind::Key);
}
