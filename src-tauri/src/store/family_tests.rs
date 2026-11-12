//! Family columns (v10: MongoDB settings, v11: key-value settings) side by side, on a database
//! created before either of them.

use super::*;
use crate::db::config::{KeyValueSettings, sample_definition};
use crate::db::document::settings::{MongoAuthMechanism, MongoSettings};

fn mongo_settings() -> MongoSettings {
    MongoSettings {
        srv: false,
        replica_set: Some("rs0".into()),
        auth_source: Some("admin".into()),
        auth_mechanism: MongoAuthMechanism::ScramSha256,
        direct_connection: false,
    }
}

#[test]
fn a_v9_database_migrates_and_keeps_both_families_settings() {
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
    // v9 → v10 alone, then v10 → v11 when the store opens.
    {
        let mut conn = Connection::open(&path).expect("open");
        migrations::apply_through(&mut conn, 10).expect("v10");
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(version, 10);
    }
    let store = Store::open(&path).expect("reopen");
    assert_eq!(
        store.schema_version().expect("version"),
        Store::latest_schema_version()
    );
    let old = store.connection("c1").expect("read");
    assert_eq!(old.definition.mongo, None);
    assert_eq!(old.definition.key_value, None);

    let mut mongo = sample_definition(Engine::Mongodb);
    mongo.mongo = Some(mongo_settings());
    let mongo = store
        .create_connection(&mongo.normalized().expect("valid"))
        .expect("save mongo");
    let mut redis = sample_definition(Engine::Redis);
    redis.database = "2".into();
    redis.key_value = Some(KeyValueSettings {
        key_delimiter: Some("/".into()),
    });
    let redis = store
        .create_connection(&redis.normalized().expect("valid"))
        .expect("save redis");

    // Reopening reads both back, each on its own family only.
    drop(store);
    let store = Store::open(&path).expect("reopen");
    let read_mongo = store.connection(&mongo.id).expect("read mongo");
    assert_eq!(read_mongo.definition.mongo, Some(mongo_settings()));
    assert_eq!(read_mongo.definition.key_value, None);
    let read_redis = store.connection(&redis.id).expect("read redis");
    assert_eq!(read_redis.definition.mongo, None);
    assert_eq!(
        read_redis.definition.key_value,
        Some(KeyValueSettings {
            key_delimiter: Some("/".into()),
        })
    );

    // An update rewrites the family fields too.
    let mut edited = read_mongo.definition.clone();
    edited.mongo = Some(MongoSettings {
        replica_set: None,
        direct_connection: true,
        ..mongo_settings()
    });
    store
        .update_connection(&mongo.id, &edited.normalized().expect("valid"))
        .expect("update");
    let updated = store.connection(&mongo.id).expect("read");
    assert_eq!(
        updated
            .definition
            .mongo
            .map(|m| (m.replica_set, m.direct_connection)),
        Some((None, true))
    );
    let all = store.list_connections().expect("list");
    assert_eq!(all.len(), 3);
}
