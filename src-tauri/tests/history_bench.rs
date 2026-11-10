//! P-08: history search over 100 000 entries < 100 ms.
//! `cargo test --release --test history_bench p08 -- --ignored --nocapture`

use std::time::{Duration, Instant};

use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::store::{HistoryOutcome, HistoryQuery, HistoryScope, NewHistoryEntry, Store};

const N: i64 = 100_000;
const TABLES: [&str; 12] = [
    "customers",
    "orders",
    "order_items",
    "products",
    "invoices",
    "sessions",
    "audit_log",
    "payments",
    "shipments",
    "categories",
    "inventory",
    "employees",
];
const COLUMNS: [&str; 8] = [
    "id",
    "email",
    "total",
    "created_at",
    "status",
    "name",
    "price",
    "qty",
];

fn statement(i: i64) -> String {
    let table = TABLES[(i % 12) as usize];
    let column = COLUMNS[((i / 7) % 8) as usize];
    match i % 5 {
        0 => format!(
            "SELECT {column}, count(*) FROM {table} WHERE id > {i} GROUP BY {column} ORDER BY 2 DESC"
        ),
        1 => format!("UPDATE {table} SET {column} = {i} WHERE id = {}", i % 977),
        2 => format!(
            "SELECT * FROM {table} t JOIN {} u ON u.id = t.id WHERE t.{column} IS NOT NULL LIMIT 100",
            TABLES[((i / 3) % 12) as usize]
        ),
        3 => format!("INSERT INTO {table} ({column}) VALUES ({i})"),
        _ => format!("DELETE FROM {table} WHERE {column} = 'x{i}'"),
    }
}

#[test]
#[ignore = "benchmark"]
fn p08_search_over_100k_entries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(&dir.path().join("yadbe.db")).expect("store");
    let end = 1_760_000_000_000_i64;
    let mut batch = Vec::with_capacity(5000);
    for i in 0..N {
        let failed = i % 23 == 0;
        batch.push(NewHistoryEntry {
            connection_id: format!("c{}", i % 4),
            connection_name: format!("connection {}", i % 4),
            engine: Engine::Postgres,
            database: Some("shop".into()),
            sql: statement(i),
            started_at_ms: end - (N - i) * 60_000,
            duration_ms: (i % 400) as f64,
            rows: Some(i % 50),
            outcome: if failed {
                HistoryOutcome::Error
            } else {
                HistoryOutcome::Ok
            },
            error_code: failed.then_some(ErrorCode::QueryFailed),
            error_message: failed.then(|| "relation does not exist".into()),
        });
        if batch.len() == 5000 {
            store.insert_history(&batch).expect("insert");
            batch.clear();
        }
    }
    assert_eq!(
        store
            .count_history(&HistoryScope::default())
            .expect("count"),
        N as u32
    );

    let mut worst = Duration::ZERO;
    let mut time = |label: &str, query: HistoryQuery| {
        let mut slowest = Duration::ZERO;
        let mut rows = 0;
        for _ in 0..5 {
            let started = Instant::now();
            let page = store.search_history(&query).expect("search");
            slowest = slowest.max(started.elapsed());
            rows = page.rows.len();
        }
        println!("p08 {label:<42} rows={rows:<4} worst of 5 = {slowest:?}");
        worst = worst.max(slowest);
    };
    let text = |t: &str| HistoryQuery {
        text: Some(t.into()),
        ..HistoryQuery::default()
    };
    time("no text, first page", HistoryQuery::default());
    time("rare word (`x99999`)", text("x99999"));
    time("one table (`customers`)", text("customers"));
    time("common word (`select`)", text("select"));
    time("prefix of a common word (`sel`)", text("sel"));
    time("two words (`orders update`)", text("orders update"));
    time("one letter prefix (`s`)", text("s"));
    time(
        "common word + errors only + connection",
        HistoryQuery {
            text: Some("select".into()),
            outcomes: vec![HistoryOutcome::Error],
            connection_id: Some("c1".into()),
            ..HistoryQuery::default()
        },
    );
    time(
        "common word + min duration 390 ms",
        HistoryQuery {
            text: Some("select".into()),
            min_duration_ms: Some(390.0),
            ..HistoryQuery::default()
        },
    );
    time(
        "no text, deep page (after 50 000 rows)",
        HistoryQuery {
            after: Some(((end - 50_000 * 60_000) * 1024) as f64),
            ..HistoryQuery::default()
        },
    );
    time(
        "no text, one day",
        HistoryQuery {
            from: Some((end - 3 * 86_400_000) as f64),
            to: Some((end - 2 * 86_400_000) as f64),
            ..HistoryQuery::default()
        },
    );
    println!("p08 worst case overall = {worst:?} (target < 100 ms)");
    assert!(worst < Duration::from_millis(100), "{worst:?}");
}
