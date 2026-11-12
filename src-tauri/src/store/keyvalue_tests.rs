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
