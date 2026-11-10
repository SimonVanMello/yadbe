use super::*;
use crate::db::config::sample_definition;
use crate::db::dialect::Engine;
use crate::db::errors::ErrorCode;

fn store() -> Store {
    Store::open_in_memory().expect("store")
}

fn new_query(name: &str, sql: &str) -> NewSavedQuery {
    NewSavedQuery {
        name: name.into(),
        sql: sql.into(),
        ..NewSavedQuery::default()
    }
}

fn update_of(query: &SavedQuery) -> SavedQueryUpdate {
    SavedQueryUpdate {
        name: query.name.clone(),
        sql: None,
        description: query.description.clone(),
        tags: query.tags.clone(),
        folder_id: query.folder_id.clone(),
        connection_id: query.connection_id.clone(),
        database: query.database.clone(),
        snippet_trigger: query.snippet_trigger.clone(),
    }
}

fn codes<T: std::fmt::Debug>(result: Result<T, YadbeError>) -> Option<ErrorCode> {
    result.err().map(|e| e.code)
}

#[test]
fn the_migration_upgrades_a_v2_database_and_keeps_its_data() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(DB_FILE);
    {
        let mut conn = Connection::open(&path).expect("open");
        conn.execute_batch(migrations::first_migration())
            .expect("v1");
        conn.pragma_update(None, "user_version", 1)
            .expect("version");
        conn.execute(
            "INSERT INTO connections (id, name, engine, position, auth, tls_mode, created_at, updated_at)
             VALUES ('c', 'old', 'sqlite', 0, 'none', 'disable', 1, 1)",
            [],
        )
        .expect("insert");
        migrations::apply(&mut conn).expect("migrate");
    }
    let store = Store::open(&path).expect("reopen");
    assert_eq!(
        store.schema_version().expect("version"),
        Store::latest_schema_version()
    );
    assert!(store.connection("c").is_ok());
    let library = store.saved_query_library().expect("library");
    assert!(library.folders.is_empty() && library.queries.is_empty());
}

#[test]
fn a_query_round_trips_with_its_fields() {
    let store = store();
    let folder = store.create_query_folder("Reports", None).expect("folder");
    let connection = store
        .create_connection(&sample_definition(Engine::Postgres))
        .expect("connection");
    let created = store
        .create_saved_query(&NewSavedQuery {
            name: "  Orders per day ".into(),
            sql: "SELECT date_trunc('day', created_at), count(*) FROM orders GROUP BY 1;".into(),
            description: " Daily volume ".into(),
            tags: vec!["sales".into(), "Sales".into(), " daily ".into(), "".into()],
            folder_id: Some(folder.id.clone()),
            connection_id: Some(connection.id.clone()),
            database: Some("shop".into()),
            snippet_trigger: Some("opd".into()),
        })
        .expect("create");
    assert_eq!(created.name, "Orders per day");
    assert_eq!(created.description, "Daily volume");
    assert_eq!(created.tags, vec!["sales", "daily"]);
    assert_eq!(created.folder_id.as_ref(), Some(&folder.id));
    assert_eq!(created.connection_id.as_ref(), Some(&connection.id));
    assert_eq!(created.database.as_deref(), Some("shop"));
    assert_eq!(created.snippet_trigger.as_deref(), Some("opd"));
    assert!(!created.sql_truncated);
    assert_eq!(created.last_used_at, None);
    assert_eq!(
        store.saved_query(&created.id).expect("get"),
        Some(created.clone())
    );

    let mut update = update_of(&created);
    update.name = "Orders by day".into();
    update.sql = Some("SELECT 1;".into());
    update.connection_id = None;
    update.database = Some("ignored".into());
    update.snippet_trigger = None;
    let updated = store
        .update_saved_query(&created.id, &update)
        .expect("update");
    assert_eq!(updated.name, "Orders by day");
    assert_eq!(updated.sql, "SELECT 1;");
    assert_eq!(updated.connection_id, None);
    assert_eq!(updated.database, None, "a database needs a connection");
    assert_eq!(updated.snippet_trigger, None);
    assert_eq!(updated.created_at, created.created_at);

    // `sql: None` keeps the text.
    let mut keep = update_of(&updated);
    keep.description = "Changed".into();
    let kept = store.update_saved_query(&created.id, &keep).expect("keep");
    assert_eq!(kept.sql, "SELECT 1;");
    assert_eq!(kept.description, "Changed");

    store.touch_saved_query(&created.id).expect("touch");
    let touched = store.saved_query(&created.id).expect("get").expect("there");
    assert!(touched.last_used_at.is_some());

    store.delete_saved_query(&created.id).expect("delete");
    assert_eq!(store.saved_query(&created.id).expect("get"), None);
    assert_eq!(
        codes(store.delete_saved_query(&created.id)),
        Some(ErrorCode::SavedQueryNotFound)
    );
    assert_eq!(
        codes(store.touch_saved_query("nope")),
        Some(ErrorCode::SavedQueryNotFound)
    );
}

#[test]
fn input_is_validated() {
    let store = store();
    assert_eq!(
        codes(store.create_saved_query(&new_query("  ", "SELECT 1"))),
        Some(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        codes(store.create_saved_query(&new_query(&"x".repeat(121), "SELECT 1"))),
        Some(ErrorCode::InvalidArgument)
    );
    let mut bad_trigger = new_query("n", "SELECT 1");
    for trigger in ["1abc", "a b", "é", &"a".repeat(33)] {
        bad_trigger.snippet_trigger = Some(trigger.into());
        assert_eq!(
            codes(store.create_saved_query(&bad_trigger)),
            Some(ErrorCode::InvalidArgument),
            "{trigger}"
        );
    }
    let mut blank_trigger = new_query("n", "SELECT 1");
    blank_trigger.snippet_trigger = Some("  ".into());
    assert_eq!(
        store
            .create_saved_query(&blank_trigger)
            .expect("blank is none")
            .snippet_trigger,
        None
    );
    let mut many_tags = new_query("n", "SELECT 1");
    many_tags.tags = (0..13).map(|i| format!("t{i}")).collect();
    assert_eq!(
        codes(store.create_saved_query(&many_tags)),
        Some(ErrorCode::InvalidArgument)
    );
    let mut missing_folder = new_query("n", "SELECT 1");
    missing_folder.folder_id = Some("nope".into());
    assert_eq!(
        codes(store.create_saved_query(&missing_folder)),
        Some(ErrorCode::QueryFolderNotFound)
    );
    let mut missing_connection = new_query("n", "SELECT 1");
    missing_connection.connection_id = Some("nope".into());
    assert_eq!(
        codes(store.create_saved_query(&missing_connection)),
        Some(ErrorCode::ConnectionNotFound)
    );
    let huge = "x".repeat(MAX_SAVED_SQL_BYTES + 1);
    assert_eq!(
        codes(store.create_saved_query(&new_query("big", &huge))),
        Some(ErrorCode::InvalidArgument)
    );
}

#[test]
fn the_list_cuts_long_statements_and_get_returns_them_whole() {
    let store = store();
    let long = format!("SELECT '{}';", "é".repeat(1000));
    let query = store
        .create_saved_query(&new_query("long", &long))
        .expect("create");
    assert!(!query.sql_truncated);
    assert_eq!(query.sql, long);
    let listed = store.saved_query_library().expect("list").queries;
    assert_eq!(listed.len(), 1);
    assert!(listed[0].sql_truncated);
    assert_eq!(listed[0].sql.chars().count(), SAVED_PREVIEW_CHARS);
}

#[test]
fn folders_nest_move_without_cycles_and_stop_at_the_depth_limit() {
    let store = store();
    let a = store.create_query_folder("A", None).expect("a");
    let b = store.create_query_folder("B", Some(&a.id)).expect("b");
    let c = store.create_query_folder("C", Some(&b.id)).expect("c");
    assert_eq!(
        codes(store.move_query_folder(&a.id, Some(&c.id))),
        Some(ErrorCode::InvalidArgument),
        "into a descendant"
    );
    assert_eq!(
        codes(store.move_query_folder(&a.id, Some(&a.id))),
        Some(ErrorCode::InvalidArgument),
        "into itself"
    );
    assert_eq!(
        codes(store.move_query_folder(&a.id, Some(&"nope".to_owned()))),
        Some(ErrorCode::QueryFolderNotFound)
    );
    // Moving a subfolder out works, and back to the root too.
    let moved = store.move_query_folder(&c.id, None).expect("to root");
    assert_eq!(moved.parent_id, None);
    let moved = store
        .move_query_folder(&c.id, Some(&a.id))
        .expect("under a");
    assert_eq!(moved.parent_id.as_ref(), Some(&a.id));

    let mut parent = None;
    for depth in 1..=MAX_FOLDER_DEPTH {
        let folder = store
            .create_query_folder(&format!("level {depth}"), parent.as_ref())
            .expect("within the limit");
        parent = Some(folder.id);
    }
    assert_eq!(
        codes(store.create_query_folder("too deep", parent.as_ref())),
        Some(ErrorCode::InvalidArgument)
    );
    // A subtree whose move would exceed the limit is refused whole.
    assert_eq!(
        codes(store.move_query_folder(&a.id, parent.as_ref())),
        Some(ErrorCode::InvalidArgument)
    );

    assert_eq!(
        store
            .rename_query_folder(&a.id, " Renamed ")
            .expect("rename")
            .name,
        "Renamed"
    );
    assert_eq!(
        codes(store.rename_query_folder(&a.id, "")),
        Some(ErrorCode::InvalidArgument)
    );
}

#[test]
fn queries_move_between_folders_and_the_root() {
    let store = store();
    let folder = store.create_query_folder("F", None).expect("folder");
    let query = store
        .create_saved_query(&new_query("q", "SELECT 1"))
        .expect("create");
    let moved = store
        .move_saved_query(&query.id, Some(&folder.id))
        .expect("into");
    assert_eq!(moved.folder_id.as_ref(), Some(&folder.id));
    assert_eq!(
        store
            .move_saved_query(&query.id, None)
            .expect("out")
            .folder_id,
        None
    );
    assert_eq!(
        codes(store.move_saved_query(&query.id, Some(&"nope".to_owned()))),
        Some(ErrorCode::QueryFolderNotFound)
    );
    assert_eq!(
        codes(store.move_saved_query("nope", None)),
        Some(ErrorCode::SavedQueryNotFound)
    );
}

#[test]
fn deleting_a_folder_deletes_what_it_holds_and_its_index_entries() {
    let store = store();
    let outer = store.create_query_folder("outer", None).expect("outer");
    let inner = store
        .create_query_folder("inner", Some(&outer.id))
        .expect("inner");
    let keep = store
        .create_saved_query(&new_query("keeper", "SELECT zebra FROM safe"))
        .expect("keep");
    for (name, folder) in [("one", &outer.id), ("two", &inner.id), ("three", &inner.id)] {
        let mut q = new_query(name, "SELECT zebra FROM doomed");
        q.folder_id = Some(folder.clone());
        store.create_saved_query(&q).expect("create");
    }
    assert_eq!(
        store
            .search_saved_queries("zebra", None)
            .expect("search")
            .len(),
        4
    );
    let removed = store.delete_query_folder(&outer.id).expect("delete");
    assert_eq!(
        removed,
        FolderDeletion {
            folders: 2,
            queries: 3
        }
    );
    let library = store.saved_query_library().expect("library");
    assert!(library.folders.is_empty());
    assert_eq!(library.queries.len(), 1);
    assert_eq!(
        store.search_saved_queries("zebra", None).expect("search"),
        vec![keep.id]
    );
    assert_eq!(
        codes(store.delete_query_folder(&outer.id)),
        Some(ErrorCode::QueryFolderNotFound)
    );
}

#[test]
fn search_reads_name_text_description_and_tags_and_follows_edits() {
    let store = store();
    let mut by_name = new_query("Quarterly revenue", "SELECT 1");
    by_name.description = String::new();
    let by_name = store.create_saved_query(&by_name).expect("a");
    let by_text = store
        .create_saved_query(&new_query(
            "Misc",
            "SELECT sum(total) AS revenue FROM orders",
        ))
        .expect("b");
    let mut by_description = new_query("Misc 2", "SELECT 2");
    by_description.description = "Monthly revenue by country".into();
    let by_description = store.create_saved_query(&by_description).expect("c");
    let mut by_tag = new_query("Misc 3", "SELECT 3");
    by_tag.tags = vec!["revenue".into()];
    let by_tag = store.create_saved_query(&by_tag).expect("d");
    store
        .create_saved_query(&new_query("Unrelated", "SELECT now()"))
        .expect("e");

    let found = store.search_saved_queries("reven", None).expect("search");
    assert_eq!(found.len(), 4);
    assert_eq!(found[0], by_name.id, "a name match ranks first: {found:?}");
    for id in [&by_text.id, &by_description.id, &by_tag.id] {
        assert!(found.contains(id));
    }
    // Every word must match, each as a prefix.
    assert_eq!(
        store
            .search_saved_queries("reven country", None)
            .expect("and"),
        vec![by_description.id.clone()]
    );
    assert!(
        store
            .search_saved_queries("   ", None)
            .expect("blank")
            .is_empty()
    );
    assert!(
        store
            .search_saved_queries("%%", None)
            .expect("punct")
            .is_empty()
    );

    // The index follows edits and deletions.
    let mut update = update_of(&by_text);
    update.sql = Some("SELECT 42".into());
    store
        .update_saved_query(&by_text.id, &update)
        .expect("edit");
    let after = store.search_saved_queries("reven", None).expect("search");
    assert!(!after.contains(&by_text.id));
    store.delete_saved_query(&by_name.id).expect("delete");
    assert!(
        !store
            .search_saved_queries("reven", None)
            .expect("search")
            .contains(&by_name.id)
    );
    // Using a query does not change what the index holds.
    store.touch_saved_query(&by_tag.id).expect("touch");
    assert!(
        store
            .search_saved_queries("reven", None)
            .expect("search")
            .contains(&by_tag.id)
    );
}

#[test]
fn search_can_be_limited_to_the_global_queries_and_one_connection() {
    let store = store();
    let pg = store
        .create_connection(&sample_definition(Engine::Postgres))
        .expect("pg");
    let lite = store
        .create_connection(&sample_definition(Engine::Sqlite))
        .expect("lite");
    let global = store
        .create_saved_query(&new_query("global", "SELECT needle"))
        .expect("global");
    let mut mine = new_query("mine", "SELECT needle");
    mine.connection_id = Some(pg.id.clone());
    let mine = store.create_saved_query(&mine).expect("mine");
    let mut other = new_query("other", "SELECT needle");
    other.connection_id = Some(lite.id.clone());
    let other = store.create_saved_query(&other).expect("other");

    let mut here = store
        .search_saved_queries("needle", Some(&pg.id))
        .expect("scoped");
    here.sort();
    let mut expected = vec![global.id.clone(), mine.id.clone()];
    expected.sort();
    assert_eq!(here, expected);
    assert_eq!(
        store
            .search_saved_queries("needle", None)
            .expect("all")
            .len(),
        3
    );
    assert!(
        !store
            .search_saved_queries("needle", Some(&pg.id))
            .expect("scoped")
            .contains(&other.id)
    );
}

#[test]
fn deleting_a_connection_keeps_its_queries_as_global_ones() {
    let store = store();
    let connection = store
        .create_connection(&sample_definition(Engine::Postgres))
        .expect("connection");
    let mut bound = new_query("bound", "SELECT 1");
    bound.connection_id = Some(connection.id.clone());
    bound.database = Some("shop".into());
    let bound = store.create_saved_query(&bound).expect("create");
    store.delete_connection(&connection.id).expect("delete");
    let after = store.saved_query(&bound.id).expect("get").expect("kept");
    assert_eq!(after.connection_id, None);
    assert_eq!(after.database, None);
}

#[test]
fn a_duplicate_keeps_the_scope_and_drops_the_trigger() {
    let store = store();
    let folder = store.create_query_folder("F", None).expect("folder");
    let mut source = new_query("Top customers", "SELECT 1");
    source.folder_id = Some(folder.id.clone());
    source.snippet_trigger = Some("topc".into());
    source.tags = vec!["a".into()];
    let source = store.create_saved_query(&source).expect("create");
    let copy = store
        .duplicate_saved_query(&source.id, "(copy)")
        .expect("duplicate");
    assert_ne!(copy.id, source.id);
    assert_eq!(copy.name, "Top customers (copy)");
    assert_eq!(copy.sql, source.sql);
    assert_eq!(copy.folder_id, source.folder_id);
    assert_eq!(copy.tags, source.tags);
    assert_eq!(copy.snippet_trigger, None);
    let long = store
        .create_saved_query(&new_query(&"n".repeat(MAX_QUERY_NAME_CHARS), "SELECT 1"))
        .expect("long");
    let copy = store
        .duplicate_saved_query(&long.id, "(copy)")
        .expect("dup");
    assert_eq!(copy.name.chars().count(), MAX_QUERY_NAME_CHARS);
    assert!(copy.name.ends_with("(copy)"));
}

#[test]
fn snippets_list_whole_templates() {
    let store = store();
    let long = format!("SELECT '{}'", "x".repeat(2000));
    let mut snippet = new_query("Long one", &long);
    snippet.snippet_trigger = Some("longone".into());
    store.create_saved_query(&snippet).expect("snippet");
    store
        .create_saved_query(&new_query("Plain", "SELECT 1"))
        .expect("plain");
    let snippets = store.snippets().expect("snippets");
    assert_eq!(snippets.len(), 1);
    assert_eq!(snippets[0].trigger, "longone");
    assert_eq!(snippets[0].template, long);
}
