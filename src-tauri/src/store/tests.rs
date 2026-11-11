use super::*;
use crate::db::config::sample_definition;
use crate::db::errors::ErrorCode;

fn store() -> Store {
    Store::open_in_memory().expect("store")
}

#[test]
fn migrations_reach_the_latest_version_and_are_idempotent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("nested").join(DB_FILE);
    let store = Store::open(&path).expect("open");
    assert_eq!(
        store.schema_version().expect("version"),
        Store::latest_schema_version()
    );
    drop(store);
    let again = Store::open(&path).expect("reopen");
    assert_eq!(
        again.schema_version().expect("version"),
        Store::latest_schema_version()
    );
}

#[test]
fn the_schema_has_no_secret_column() {
    let store = store();
    let conn = store.conn();
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_info('connections')")
        .expect("prepare");
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    assert!(columns.contains(&"remember_password".to_owned()));
    for column in &columns {
        assert!(
            !(column.contains("password") && column != "remember_password")
                && !column.contains("secret")
                && !column.contains("token"),
            "suspicious column {column}"
        );
    }
}

#[test]
fn connections_round_trip() {
    let store = store();
    let mut def = sample_definition(Engine::Postgres);
    def.options = vec![ConnectionOption {
        key: "application_name".into(),
        value: "yadbe".into(),
    }];
    def.environment = Environment {
        kind: EnvironmentKind::Custom,
        label: Some("QA".into()),
        color: Some("#123456".into()),
    };
    def.read_only = true;
    def.favorite = true;
    let saved = store.create_connection(&def).expect("create");
    assert_eq!(saved.definition, def);
    assert_eq!(saved.position, 0);
    assert_eq!(store.list_connections().expect("list"), vec![saved.clone()]);

    let mut changed = def.clone();
    changed.name = "Renamed".into();
    changed.tls_mode = TlsMode::VerifyFull;
    let updated = store
        .update_connection(&saved.id, &changed)
        .expect("update");
    assert_eq!(updated.definition.name, "Renamed");
    assert_eq!(updated.created_at, saved.created_at);

    store.touch_connection(&saved.id).expect("touch");
    assert!(
        store
            .connection(&saved.id)
            .expect("get")
            .last_connected_at
            .is_some()
    );

    store.delete_connection(&saved.id).expect("delete");
    assert_eq!(
        store.connection(&saved.id).map_err(|e| e.code).err(),
        Some(ErrorCode::ConnectionNotFound)
    );
}

#[test]
fn connections_move_between_groups_and_reorder() {
    let store = store();
    let group = store.create_group("Prod", None).expect("group");
    let a = store
        .create_connection(&sample_definition(Engine::Postgres))
        .expect("a");
    let b = store
        .create_connection(&sample_definition(Engine::Sqlite))
        .expect("b");
    let c = store
        .create_connection(&sample_definition(Engine::Postgres))
        .expect("c");
    assert_eq!((a.position, b.position, c.position), (0, 1, 2));

    store
        .move_connection(&c.id, None, 0)
        .expect("move to front");
    let order: Vec<String> = store
        .list_connections()
        .expect("list")
        .into_iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(order, vec![c.id.clone(), a.id.clone(), b.id.clone()]);

    store
        .move_connection(&a.id, Some(&group.id), 99)
        .expect("move into group");
    let moved = store.connection(&a.id).expect("a");
    assert_eq!(moved.definition.group_id.as_ref(), Some(&group.id));
    assert_eq!(moved.position, 0);

    let missing = "nope".to_owned();
    assert_eq!(
        store
            .move_connection(&a.id, Some(&missing), 0)
            .map_err(|e| e.code),
        Err(ErrorCode::GroupNotFound)
    );
}

#[test]
fn groups_nest_without_cycles_and_deleting_reparents() {
    let store = store();
    let root = store.create_group("Clients", None).expect("root");
    let child = store.create_group("ACME", Some(&root.id)).expect("child");
    let grandchild = store
        .create_group("Prod", Some(&child.id))
        .expect("grandchild");
    assert_eq!(
        store
            .move_group(&root.id, Some(&grandchild.id), 0)
            .map_err(|e| e.code),
        Err(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        store
            .move_group(&root.id, Some(&root.id), 0)
            .map_err(|e| e.code),
        Err(ErrorCode::InvalidArgument)
    );

    let mut def = sample_definition(Engine::Postgres);
    def.group_id = Some(child.id.clone());
    let conn = store.create_connection(&def).expect("connection");

    store.delete_group(&child.id).expect("delete");
    let grandchild = store.group(&grandchild.id).expect("still there");
    assert_eq!(grandchild.parent_id.as_ref(), Some(&root.id));
    let conn = store.connection(&conn.id).expect("still there");
    assert_eq!(conn.definition.group_id.as_ref(), Some(&root.id));

    let renamed = store
        .rename_group(&root.id, "  Customers ")
        .expect("rename");
    assert_eq!(renamed.name, "Customers");
    assert!(store.rename_group(&root.id, " ").is_err());
    store.set_group_collapsed(&root.id, true).expect("collapse");
    assert!(store.group(&root.id).expect("group").collapsed);
}

#[test]
fn preferences_default_and_round_trip() {
    let store = store();
    assert_eq!(store.preferences().expect("prefs"), Preferences::default());
    let prefs = Preferences {
        theme: ThemePreference::Dark,
        locale: Some(Locale::Fr),
        density: Density::Compact,
        ui_state: Some("{\"sidebar\":280}".into()),
        history_enabled: false,
        history_max_entries: 1000,
        history_max_age_days: 30,
        connect_timeout_secs: 45,
        journal_max_entries: 500,
        journal_max_age_days: 7,
    };
    assert_eq!(store.set_preferences(&prefs).expect("set"), prefs);
    let cleared = Preferences {
        locale: None,
        ui_state: None,
        ..prefs
    };
    assert_eq!(store.set_preferences(&cleared).expect("set"), cleared);
    let too_big = Preferences {
        ui_state: Some("x".repeat(MAX_UI_STATE_BYTES + 1)),
        ..Preferences::default()
    };
    assert!(store.set_preferences(&too_big).is_err());
    for bad in [
        Preferences {
            history_max_entries: 5,
            ..Preferences::default()
        },
        Preferences {
            history_max_age_days: 0,
            ..Preferences::default()
        },
        Preferences {
            connect_timeout_secs: 601,
            ..Preferences::default()
        },
    ] {
        assert!(store.set_preferences(&bad).is_err());
    }
}

#[test]
fn preferences_saved_before_the_backend_fields_existed_get_their_defaults() {
    let store = store();
    // A database from M1: only theme, density and the UI state were ever written.
    {
        let conn = store.conn();
        conn.execute(
            "INSERT INTO preferences (key, value) VALUES ('theme', 'dark')",
            [],
        )
        .expect("insert");
        conn.execute(
            "INSERT INTO preferences (key, value) VALUES ('history_max_entries', 'garbage')",
            [],
        )
        .expect("insert");
    }
    let prefs = store.preferences().expect("prefs");
    assert_eq!(prefs.theme, ThemePreference::Dark);
    assert!(prefs.history_enabled);
    assert_eq!(prefs.history_max_entries, 50_000);
    assert_eq!(prefs.history_max_age_days, 365);
    assert_eq!(prefs.connect_timeout_secs, 15);
}

#[test]
fn tabs_round_trip_and_survive_a_deleted_connection() {
    let store = store();
    let conn = store
        .create_connection(&sample_definition(Engine::Postgres))
        .expect("connection");
    let state = TabsState {
        tabs: vec![
            SavedTab {
                id: "t1".into(),
                kind: TabKind::Query,
                title: "Query 1".into(),
                connection_id: Some(conn.id.clone()),
                database: Some("shop".into()),
                content: "select 1;".into(),
                cursor: Some(CursorPosition { anchor: 3, head: 7 }),
                pinned: true,
                file_path: None,
                table: None,
                ui_state: None,
            },
            SavedTab {
                id: "t2".into(),
                kind: TabKind::Table,
                title: "orders".into(),
                connection_id: Some("deleted-meanwhile".into()),
                database: None,
                content: String::new(),
                cursor: None,
                pinned: false,
                file_path: None,
                table: Some(TableRef {
                    schema: Some("public".into()),
                    name: "orders".into(),
                }),
                ui_state: Some("{}".into()),
            },
        ],
        active_tab_id: Some("t2".into()),
    };
    store.save_tabs(&state).expect("save");
    let loaded = store.tabs().expect("load");
    assert_eq!(loaded.tabs[0], state.tabs[0]);
    assert_eq!(
        loaded.tabs[1].connection_id, None,
        "unknown connection unbound"
    );
    assert_eq!(loaded.tabs[1].table, state.tabs[1].table);
    assert_eq!(loaded.active_tab_id.as_deref(), Some("t2"));

    store.delete_connection(&conn.id).expect("delete");
    assert_eq!(store.tabs().expect("load").tabs[0].connection_id, None);

    store.save_tabs(&TabsState::default()).expect("clear");
    assert_eq!(store.tabs().expect("load"), TabsState::default());
}
