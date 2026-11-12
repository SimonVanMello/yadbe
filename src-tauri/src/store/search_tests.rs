//! Search settings (v13): saved with a search connection only, read back as saved, absent from
//! the rows written before the column existed.

use super::*;
use crate::db::config::sample_definition;
use crate::db::search::settings::{SearchAuth, SearchSettings};

#[test]
fn search_settings_round_trip_and_stay_with_their_family() {
    let store = Store::open_in_memory().expect("store");
    let mut es = sample_definition(Engine::Elasticsearch);
    es.database = "ignored".into();
    es.search = Some(SearchSettings {
        auth: SearchAuth::ApiKey,
        path_prefix: Some("es/".into()),
    });
    let saved = store
        .create_connection(&es.normalized().expect("valid"))
        .expect("save");
    let read = store.connection(&saved.id).expect("read").definition;
    assert_eq!(
        read.search,
        Some(SearchSettings {
            auth: SearchAuth::ApiKey,
            path_prefix: Some("/es".into()),
        })
    );
    assert_eq!(read.database, "", "a search connection has no database");
    assert_eq!(read.auth, AuthMethod::Password, "an API key is a secret");
    assert_eq!(read.tls_mode, TlsMode::Disable, "prefer is plain http");

    // No authentication: no secret to ask for.
    let mut open = read.clone();
    open.search = Some(SearchSettings {
        auth: SearchAuth::None,
        path_prefix: None,
    });
    store
        .update_connection(&saved.id, &open.normalized().expect("valid"))
        .expect("update");
    let updated = store.connection(&saved.id).expect("read").definition;
    assert_eq!(updated.auth, AuthMethod::None);
    assert_eq!(updated.search.map(|s| s.auth), Some(SearchAuth::None));

    // Another family keeps none.
    let mut pg = sample_definition(Engine::Postgres);
    pg.search = Some(SearchSettings::default());
    let pg = store
        .create_connection(&pg.normalized().expect("valid"))
        .expect("save pg");
    assert_eq!(
        store.connection(&pg.id).expect("read").definition.search,
        None
    );
}

#[test]
fn connections_saved_before_v13_have_no_search_settings() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(DB_FILE);
    {
        let mut conn = Connection::open(&path).expect("open");
        migrations::apply_through(&mut conn, 12).expect("v12");
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
    assert_eq!(
        store.connection("c1").expect("read").definition.search,
        None
    );
}
