use super::*;
use crate::db::config::sample_definition;
use crate::db::errors::ErrorCode;

const DAY: i64 = 86_400_000;
const T0: i64 = 1_700_000_000_000;

fn store() -> Store {
    Store::open_in_memory().expect("store")
}

fn entry(sql: &str, at: i64) -> NewHistoryEntry {
    NewHistoryEntry {
        connection_id: "c1".into(),
        connection_name: "shop".into(),
        engine: Engine::Postgres,
        database: Some("shop".into()),
        sql: sql.into(),
        started_at_ms: at,
        duration_ms: 5.0,
        rows: Some(1),
        outcome: HistoryOutcome::Ok,
        error_code: None,
        error_message: None,
    }
}

fn texts(page: &HistoryPage) -> Vec<&str> {
    page.rows.iter().map(|r| r.sql.as_str()).collect()
}

fn search(store: &Store, query: HistoryQuery) -> HistoryPage {
    store.search_history(&query).expect("search")
}

#[test]
fn the_migration_upgrades_a_v1_database_and_keeps_connections() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(DB_FILE);
    {
        // A database as v1 left it, with a connection in it.
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
    let old = store.connection("c").expect("connection");
    assert!(old.definition.history_enabled, "history is on by default");
    store
        .insert_history(&[entry("select 1", T0)])
        .expect("history table exists");
    assert_eq!(search(&store, HistoryQuery::default()).rows.len(), 1);
}

#[test]
fn the_flag_round_trips_and_older_payloads_default_to_enabled() {
    let store = store();
    let mut def = sample_definition(Engine::Sqlite);
    def.history_enabled = false;
    let saved = store.create_connection(&def).expect("create");
    assert!(!saved.definition.history_enabled);
    def.history_enabled = true;
    let updated = store.update_connection(&saved.id, &def).expect("update");
    assert!(updated.definition.history_enabled);

    let mut json = serde_json::to_value(&def).expect("json");
    json.as_object_mut()
        .expect("object")
        .remove("historyEnabled");
    let parsed: ConnectionDefinition = serde_json::from_value(json).expect("parse");
    assert!(parsed.history_enabled);
}

#[test]
fn searches_words_as_prefixes_in_any_order() {
    let store = store();
    store
        .insert_history(&[
            entry(
                "SELECT * FROM customers WHERE email LIKE '%@example.com'",
                T0,
            ),
            entry("UPDATE order_items SET qty = 2 WHERE id = 7", T0 + 1),
            entry("DELETE FROM sessions", T0 + 2),
        ])
        .expect("insert");
    let by = |text: &str| {
        let page = search(
            &store,
            HistoryQuery {
                text: Some(text.into()),
                ..HistoryQuery::default()
            },
        );
        page.rows.iter().map(|r| r.sql.clone()).collect::<Vec<_>>()
    };
    assert_eq!(by("cust").len(), 1, "prefix");
    assert_eq!(
        by("EMAIL customers").len(),
        1,
        "any order, case-insensitive"
    );
    assert_eq!(
        by("order_items").len(),
        1,
        "an identifier with an underscore"
    );
    assert_eq!(by("items").len(), 1, "the part after the underscore");
    assert_eq!(by("from").len(), 2);
    assert!(by("nothing").is_empty());
    assert_eq!(by("   ").len(), 3, "blank text filters nothing");
    // No word at all: plain substring.
    assert_eq!(by("%@").len(), 1);
    // FTS syntax typed by the user is only text.
    assert!(by("\"unbalanced").is_empty());
    assert_eq!(
        by("select OR delete").len(),
        0,
        "`OR` is a word, not an operator"
    );
}

#[test]
fn deleted_and_pruned_entries_leave_the_index() {
    let store = store();
    store
        .insert_history(&[
            entry("select zebra", T0),
            entry("select zebra again", T0 + 1),
        ])
        .expect("insert");
    let zebra = || {
        search(
            &store,
            HistoryQuery {
                text: Some("zebra".into()),
                ..HistoryQuery::default()
            },
        )
    };
    let page = zebra();
    assert_eq!(page.rows.len(), 2);
    assert!(store.delete_history_entry(page.rows[0].id).expect("delete"));
    assert!(!store.delete_history_entry(page.rows[0].id).expect("again"));
    assert_eq!(zebra().rows.len(), 1);
    assert_eq!(
        store
            .clear_history(&HistoryScope::default())
            .expect("clear"),
        1
    );
    assert!(zebra().rows.is_empty());
}

#[test]
fn filters_narrow_by_connection_outcome_date_and_duration() {
    let store = store();
    let mut a = entry("select 1", T0);
    a.duration_ms = 2.0;
    let mut b = entry("select 2", T0 + DAY);
    b.connection_id = "c2".into();
    b.connection_name = "blog".into();
    b.duration_ms = 900.0;
    let mut c = entry("select broken", T0 + 2 * DAY);
    c.outcome = HistoryOutcome::Error;
    c.error_code = Some(ErrorCode::QueryFailed);
    c.error_message = Some("syntax error at or near \"broken\"".into());
    c.duration_ms = 40.0;
    store.insert_history(&[a, b, c]).expect("insert");

    let q = |f: &dyn Fn(&mut HistoryQuery)| {
        let mut query = HistoryQuery::default();
        f(&mut query);
        search(&store, query)
    };
    assert_eq!(q(&|_| {}).rows.len(), 3);
    assert_eq!(
        texts(&q(&|x| x.connection_id = Some("c2".into()))),
        ["select 2"]
    );
    let errors = q(&|x| x.outcomes = vec![HistoryOutcome::Error]);
    assert_eq!(texts(&errors), ["select broken"]);
    assert_eq!(errors.rows[0].error_code, Some(ErrorCode::QueryFailed));
    assert_eq!(
        errors.rows[0].error_message.as_deref(),
        Some("syntax error at or near \"broken\"")
    );
    assert_eq!(
        texts(&q(&|x| {
            x.from = Some((T0 + DAY) as f64);
            x.to = Some((T0 + 2 * DAY) as f64);
        })),
        ["select 2"],
        "from is inclusive, to exclusive"
    );
    assert_eq!(
        texts(&q(&|x| x.min_duration_ms = Some(40.0))),
        ["select broken", "select 2"]
    );
    // Filters and text together.
    assert_eq!(
        texts(&q(&|x| {
            x.text = Some("select".into());
            x.connection_id = Some("c1".into());
            x.min_duration_ms = Some(30.0);
        })),
        ["select broken"]
    );
}

#[test]
fn pages_are_keyset_paginated_even_with_equal_timestamps() {
    let store = store();
    let entries: Vec<_> = (0..25)
        .map(|i| entry(&format!("select {i}"), T0 + i64::from(i / 5)))
        .collect();
    store.insert_history(&entries).expect("insert");
    let mut seen = Vec::new();
    let mut after = None;
    let mut pages = 0;
    loop {
        let page = search(
            &store,
            HistoryQuery {
                limit: Some(7),
                after,
                ..HistoryQuery::default()
            },
        );
        pages += 1;
        seen.extend(page.rows.iter().map(|r| r.id));
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    assert_eq!(pages, 4);
    assert_eq!(seen.len(), 25, "no row twice, none missing");
    let mut sorted = seen.clone();
    sorted.sort_by(f64::total_cmp);
    sorted.dedup();
    assert_eq!(sorted.len(), 25);

    let exact = search(
        &store,
        HistoryQuery {
            limit: Some(25),
            ..HistoryQuery::default()
        },
    );
    assert!(exact.next.is_none(), "a full last page has no next");
    let capped = search(
        &store,
        HistoryQuery {
            limit: Some(100_000),
            ..HistoryQuery::default()
        },
    );
    assert_eq!(capped.rows.len(), 25);
}

#[test]
fn list_rows_cut_long_statements_and_get_returns_them_whole() {
    let store = store();
    let long = format!("SELECT '{}'", "é".repeat(HISTORY_PREVIEW_CHARS * 2));
    let mut failed = entry(&long, T0);
    failed.outcome = HistoryOutcome::Error;
    failed.error_code = Some(ErrorCode::QueryFailed);
    failed.error_message = Some("x".repeat(1000));
    store
        .insert_history(&[failed, entry("select 1", T0 - 1)])
        .expect("insert");
    let page = search(&store, HistoryQuery::default());
    let row = &page.rows[0];
    assert!(row.sql_truncated);
    assert_eq!(row.sql.chars().count(), HISTORY_PREVIEW_CHARS);
    assert!(long.starts_with(&row.sql));
    assert!(row.error_message.as_deref().is_some_and(|m| m.len() < 1000));
    assert!(!page.rows[1].sql_truncated);

    let whole = store.history_entry(row.id).expect("get").expect("exists");
    assert_eq!(whole.sql, long);
    assert!(!whole.sql_truncated);
    assert_eq!(whole.error_message.as_deref().map(str::len), Some(1000));
    assert!(store.history_entry(999_999.0).expect("get").is_none());
}

#[test]
fn a_huge_statement_is_stored_cut_at_a_character_boundary() {
    let store = store();
    let huge = "é".repeat(MAX_STORED_SQL_BYTES);
    store.insert_history(&[entry(&huge, T0)]).expect("insert");
    let id = search(&store, HistoryQuery::default()).rows[0].id;
    let stored = store.history_entry(id).expect("get").expect("exists").sql;
    assert!(stored.len() <= MAX_STORED_SQL_BYTES + 100);
    assert!(stored.ends_with("cut by the yadbe history"));
}

#[test]
fn retention_drops_old_entries_then_the_excess() {
    let store = store();
    let now = T0 + 400 * DAY;
    let mut entries = vec![entry("ancient", T0), entry("a year ago", now - 366 * DAY)];
    entries.extend((0..10).map(|i| entry(&format!("recent {i}"), now - i64::from(i) * 1000)));
    store.insert_history(&entries).expect("insert");

    let removed = store
        .prune_history(
            HistoryRetention {
                max_entries: 8,
                max_age_days: 365,
            },
            now,
        )
        .expect("prune");
    assert_eq!(removed, 2 + 2, "two too old, then two over the bound");
    let page = search(&store, HistoryQuery::default());
    assert_eq!(page.rows.len(), 8);
    assert_eq!(page.rows[0].sql, "recent 0", "the newest stay");
    assert_eq!(page.rows[7].sql, "recent 7");
    let none = search(
        &store,
        HistoryQuery {
            text: Some("ancient".into()),
            ..HistoryQuery::default()
        },
    );
    assert!(none.rows.is_empty(), "pruned entries leave the index");
}

#[test]
fn clears_all_one_connection_or_a_date_range() {
    let store = store();
    let mut other = entry("other", T0 + DAY);
    other.connection_id = "c2".into();
    store
        .insert_history(&[
            entry("a", T0),
            entry("b", T0 + DAY),
            entry("c", T0 + 2 * DAY),
            other,
        ])
        .expect("insert");

    let range = HistoryScope {
        from: Some((T0 + DAY) as f64),
        to: Some((T0 + 2 * DAY) as f64),
        connection_id: None,
    };
    assert_eq!(store.count_history(&range).expect("count"), 2);
    assert_eq!(store.clear_history(&range).expect("clear"), 2);

    let one = HistoryScope {
        connection_id: Some("c1".into()),
        ..HistoryScope::default()
    };
    assert_eq!(store.count_history(&one).expect("count"), 2);
    assert_eq!(store.clear_history(&one).expect("clear"), 2);
    assert_eq!(
        texts(&search(&store, HistoryQuery::default())),
        Vec::<&str>::new()
    );
}
