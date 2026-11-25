//! The engine family of a saved query (v14): backfilled from the connection's engine, recorded
//! when saving, checked against the connection a query is bound to, kept by copies, exports
//! and imports.

use super::*;
use crate::db::config::sample_definition;
use crate::db::engine::EngineFamily;
use crate::db::errors::ErrorCode;

fn store() -> Store {
    Store::open_in_memory().expect("store")
}

fn query(name: &str, family: EngineFamily) -> NewSavedQuery {
    NewSavedQuery {
        name: name.into(),
        sql: "db.orders.find({})".into(),
        family,
        ..NewSavedQuery::default()
    }
}

fn connection(store: &Store, engine: Engine) -> String {
    store
        .create_connection(&sample_definition(engine).normalized().expect("valid"))
        .expect("connection")
        .id
}

#[test]
fn a_v13_database_gets_each_query_the_family_of_its_connection() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(DB_FILE);
    {
        let mut conn = Connection::open(&path).expect("open");
        migrations::apply_through(&mut conn, 13).expect("v13");
        for (id, engine) in [
            ("c-pg", "postgres"),
            ("c-mongo", "mongodb"),
            ("c-redis", "redis"),
            ("c-es", "elasticsearch"),
        ] {
            conn.execute(
                "INSERT INTO connections (id, name, engine, position, host, auth, tls_mode,
                    created_at, updated_at)
                 VALUES (?1, ?1, ?2, 0, 'db', 'password', 'prefer', 1, 1)",
                [id, engine],
            )
            .expect("connection");
        }
        for (seq, (id, connection)) in [
            ("q-global", None),
            ("q-pg", Some("c-pg")),
            ("q-mongo", Some("c-mongo")),
            ("q-redis", Some("c-redis")),
            ("q-es", Some("c-es")),
        ]
        .into_iter()
        .enumerate()
        {
            conn.execute(
                "INSERT INTO saved_queries (seq, id, name, sql, connection_id, created_at,
                    updated_at) VALUES (?1, ?2, ?2, 'x', ?3, 1, 1)",
                rusqlite::params![seq as i64 + 1, id, connection],
            )
            .expect("query");
        }
        // A query whose connection was deleted stays global: SQL.
        conn.execute(
            "INSERT INTO saved_queries (seq, id, name, sql, created_at, updated_at)
             VALUES (10, 'q-orphan', 'q-orphan', 'x', 1, 1)",
            [],
        )
        .expect("orphan");
    }
    let store = Store::open(&path).expect("reopen");
    assert_eq!(
        store.schema_version().expect("version"),
        Store::latest_schema_version()
    );
    let families: std::collections::BTreeMap<String, EngineFamily> = store
        .saved_query_library()
        .expect("library")
        .queries
        .into_iter()
        .map(|q| (q.id, q.family))
        .collect();
    assert_eq!(families["q-global"], EngineFamily::Sql);
    assert_eq!(families["q-pg"], EngineFamily::Sql);
    assert_eq!(families["q-mongo"], EngineFamily::Document);
    assert_eq!(families["q-redis"], EngineFamily::KeyValue);
    assert_eq!(families["q-es"], EngineFamily::Search);
    assert_eq!(families["q-orphan"], EngineFamily::Sql);
}

#[test]
fn a_query_keeps_the_family_it_was_saved_with() {
    let store = store();
    for family in [
        EngineFamily::Sql,
        EngineFamily::Document,
        EngineFamily::KeyValue,
        EngineFamily::Search,
    ] {
        let saved = store
            .create_saved_query(&query(&format!("{family:?}"), family))
            .expect("save");
        assert_eq!(saved.family, family);
        assert_eq!(store.saved_query(&saved.id).expect("read"), Some(saved));
    }
    let library = store.saved_query_library().expect("library");
    assert_eq!(library.queries.len(), 4);
    let global_mongo = library
        .queries
        .iter()
        .find(|q| q.family == EngineFamily::Document)
        .expect("document query");
    assert_eq!(global_mongo.connection_id, None);

    // An update does not change it, and a copy has it too.
    let update = SavedQueryUpdate {
        name: "renamed".into(),
        sql: Some("db.users.find({})".into()),
        description: String::new(),
        tags: vec![],
        folder_id: None,
        connection_id: None,
        database: None,
        snippet_trigger: None,
    };
    let updated = store
        .update_saved_query(&global_mongo.id, &update)
        .expect("update");
    assert_eq!(updated.family, EngineFamily::Document);
    let copy = store
        .duplicate_saved_query(&global_mongo.id, "(copy)")
        .expect("copy");
    assert_eq!(copy.family, EngineFamily::Document);
}

#[test]
fn a_query_is_only_bound_to_a_connection_of_its_family() {
    let store = store();
    let pg = connection(&store, Engine::Postgres);
    let mongo = connection(&store, Engine::Mongodb);

    let mut wrong = query("script on pg", EngineFamily::Document);
    wrong.connection_id = Some(pg.clone());
    let error = store.create_saved_query(&wrong).expect_err("refused");
    assert_eq!(error.code, ErrorCode::InvalidArgument);
    assert!(store.saved_query_library().expect("lib").queries.is_empty());

    let mut right = query("script on mongo", EngineFamily::Document);
    right.connection_id = Some(mongo.clone());
    right.database = Some("shop".into());
    let saved = store.create_saved_query(&right).expect("saved");
    assert_eq!(saved.connection_id.as_deref(), Some(mongo.as_str()));

    // Rebinding to another family's connection is refused, to the same family's is fine.
    let update = |connection_id: Option<String>| SavedQueryUpdate {
        name: saved.name.clone(),
        sql: None,
        description: String::new(),
        tags: vec![],
        folder_id: None,
        connection_id,
        database: None,
        snippet_trigger: None,
    };
    let error = store
        .update_saved_query(&saved.id, &update(Some(pg)))
        .expect_err("refused");
    assert_eq!(error.code, ErrorCode::InvalidArgument);
    store
        .update_saved_query(&saved.id, &update(None))
        .expect("unbound");

    // Deleting the connection leaves the family as it was.
    let mut bound = query("again", EngineFamily::Document);
    bound.connection_id = Some(mongo.clone());
    let again = store.create_saved_query(&bound).expect("saved");
    store.delete_connection(&mongo).expect("delete");
    let orphan = store.saved_query(&again.id).expect("read").expect("there");
    assert_eq!(orphan.connection_id, None);
    assert_eq!(orphan.family, EngineFamily::Document);
}

#[test]
fn snippets_say_their_family() {
    let store = store();
    let mut sql = query("sql", EngineFamily::Sql);
    sql.snippet_trigger = Some("sel".into());
    let mut mongo = query("mongo", EngineFamily::Document);
    mongo.snippet_trigger = Some("fnd".into());
    store.create_saved_query(&sql).expect("sql");
    store.create_saved_query(&mongo).expect("mongo");
    let snippets = store.snippets().expect("snippets");
    let family_of = |trigger: &str| {
        snippets
            .iter()
            .find(|s| s.trigger == trigger)
            .map(|s| s.family)
    };
    assert_eq!(family_of("sel"), Some(EngineFamily::Sql));
    assert_eq!(family_of("fnd"), Some(EngineFamily::Document));
}

#[test]
fn the_library_file_keeps_families_and_reads_older_files_as_sql() {
    let source = store();
    source
        .create_saved_query(&query("find orders", EngineFamily::Document))
        .expect("document");
    source
        .create_saved_query(&query("keys", EngineFamily::KeyValue))
        .expect("key-value");
    let text = source.export_library().expect("export");

    let target = store();
    let report = target.import_library(&text).expect("import");
    assert_eq!(report.queries, 2);
    let mut families: Vec<EngineFamily> = target
        .saved_query_library()
        .expect("library")
        .queries
        .iter()
        .map(|q| q.family)
        .collect();
    families.sort_by_key(|f| format!("{f:?}"));
    assert_eq!(families, [EngineFamily::Document, EngineFamily::KeyValue]);

    // Importing it again adds nothing: same folder, name, text and family.
    assert_eq!(target.import_library(&text).expect("again").skipped, 2);

    // A file written before the family existed holds SQL.
    let old = r#"{"format":"yadbe-library","version":1,"folders":[],
        "queries":[{"name":"old","sql":"SELECT 1","folderId":null,"snippetTrigger":null}]}"#;
    let fresh = store();
    fresh.import_library(old).expect("old file");
    let queries = fresh.saved_query_library().expect("library").queries;
    assert_eq!(queries[0].family, EngineFamily::Sql);
}
