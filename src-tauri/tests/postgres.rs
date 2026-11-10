//! PostgreSQL driver and sessions against a real server (`YADBE_TEST_PG_URL`, e.g.
//! `postgres://yadbe:pw@localhost:5432/yadbe_test`). Network failures that need no server
//! (DNS, refused port, timeout, TLS refused) always run.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{blank, harness, open, pg_ca, pg_definition, pg_url};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use yadbe_lib::db::config::{AuthMethod, TlsMode};
use yadbe_lib::db::dialect::Engine;
use yadbe_lib::db::errors::ErrorCode;
use yadbe_lib::db::value::{Value, ValueKind};
use yadbe_lib::secrets::{Secret, SecretKind};
use yadbe_lib::session::ConnectionState;

fn local(port: u16) -> yadbe_lib::db::config::ConnectionDefinition {
    let mut def = blank(Engine::Postgres, "local");
    def.host = "127.0.0.1".into();
    def.port = Some(port);
    def.username = "app".into();
    def.auth = AuthMethod::Password;
    def.connect_timeout_secs = Some(1);
    def
}

fn pw() -> Secret {
    Secret::new("pw")
}

#[tokio::test]
async fn unknown_host_is_a_dns_error() {
    let mut def = local(5432);
    def.host = "no-such-host.invalid".into();
    let error = open(&def, Some(&pw())).await.err().expect("fails");
    assert_eq!(error.code, ErrorCode::HostNotFound, "{error:?}");
}

#[tokio::test]
async fn closed_port_is_refused() {
    // Bind then drop: the port is free and nothing listens on it.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .expect("free port")
        .port();
    let error = open(&local(port), Some(&pw())).await.err().expect("fails");
    assert_eq!(error.code, ErrorCode::ConnectionRefused, "{error:?}");
}

#[tokio::test]
async fn a_silent_server_times_out() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let server = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.expect("accept");
        // Accept, then never answer.
        tokio::time::sleep(Duration::from_secs(10)).await;
    });
    let started = std::time::Instant::now();
    let error = open(&local(port), Some(&pw())).await.err().expect("fails");
    assert_eq!(error.code, ErrorCode::ConnectionTimeout, "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(3));
    server.abort();
}

#[tokio::test]
async fn require_fails_when_the_server_refuses_tls() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut request = [0_u8; 8];
        socket.read_exact(&mut request).await.expect("SSLRequest");
        // 'N': this server does not speak TLS.
        socket.write_all(b"N").await.expect("answer");
        tokio::time::sleep(Duration::from_secs(2)).await;
    });
    let mut def = local(port);
    def.tls_mode = TlsMode::Require;
    let error = open(&def, Some(&pw())).await.err().expect("fails");
    assert_eq!(error.code, ErrorCode::TlsNotSupported, "{error:?}");
    server.abort();
}

#[tokio::test]
async fn connects_and_decodes_every_common_type() {
    let Some(url) = pg_url("connects_and_decodes_every_common_type") else {
        return;
    };
    let (def, password) = pg_definition(&url);
    let conn = open(&def, password.as_ref()).await.expect("connect");
    assert!(
        conn.server_version().starts_with("PostgreSQL "),
        "{}",
        conn.server_version()
    );
    conn.ping().await.expect("ping");

    let sql = "SELECT
        NULL::int AS null_int,
        true AS bool,
        32767::int2 AS int2,
        9223372036854775807::int8 AS int8,
        (-2147483648)::int4 AS int4,
        12345678901234567890.123456789::numeric AS numeric,
        'NaN'::numeric AS numeric_nan,
        0.000012::numeric(10, 6) AS numeric_small,
        0.1::float8 AS float8,
        'Infinity'::float8 AS float_inf,
        1.5::float4 AS float4,
        'héllo'::text AS text,
        'abc'::varchar(5) AS varchar,
        'ab'::char(4) AS bpchar,
        '\\x00ff10'::bytea AS bytea,
        '2025-02-28'::date AS date,
        'infinity'::date AS date_inf,
        '0001-12-31 BC'::date AS date_bc,
        '12:34:56.5'::time AS time,
        '12:34:56+05:30'::timetz AS timetz,
        '2025-02-28 13:14:15.123456'::timestamp AS ts,
        '2025-02-28 13:14:15+02'::timestamptz AS tstz,
        '1 year 2 mons 3 days 04:05:06.7'::interval AS interval,
        'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS uuid,
        '{\"n\": 12345678901234567890}'::json AS json,
        '{\"b\": [1, 2]}'::jsonb AS jsonb,
        ARRAY[1, NULL, 3]::int[] AS int_array,
        ARRAY[['a', 'b'], ['c', 'd']] AS text_matrix,
        '192.168.0.1/24'::inet AS inet,
        '(1,2)'::point AS point,
        12.34::money AS money";
    let result = conn.query(sql, 10).await.expect("query");
    let row = &result.rows[0];
    let get = |name: &str| {
        let index = result
            .columns
            .iter()
            .position(|c| c.name == name)
            .unwrap_or_else(|| panic!("column {name}"));
        (row[index].clone(), result.columns[index].kind)
    };
    let s = |v: &str| v.to_owned();
    assert_eq!(get("null_int"), (Value::Null, ValueKind::Int));
    assert_eq!(get("bool"), (Value::Bool(true), ValueKind::Bool));
    assert_eq!(get("int2").0, Value::Int(s("32767")));
    assert_eq!(get("int8").0, Value::Int(s("9223372036854775807")));
    assert_eq!(get("int4").0, Value::Int(s("-2147483648")));
    assert_eq!(
        get("numeric"),
        (
            Value::Decimal(s("12345678901234567890.123456789")),
            ValueKind::Decimal
        )
    );
    assert_eq!(get("numeric_nan").0, Value::Decimal(s("NaN")));
    assert_eq!(get("numeric_small").0, Value::Decimal(s("0.000012")));
    assert_eq!(get("float8").0, Value::Float(s("0.1")));
    assert_eq!(get("float_inf").0, Value::Float(s("Infinity")));
    assert_eq!(get("float4").0, Value::Float(s("1.5")));
    assert_eq!(get("text").0, Value::Text(s("héllo")));
    assert_eq!(get("varchar").0, Value::Text(s("abc")));
    assert_eq!(get("bpchar").0, Value::Text(s("ab  ")));
    assert_eq!(get("bytea"), (Value::Bytes(s("00ff10")), ValueKind::Bytes));
    assert_eq!(get("date").0, Value::Date(s("2025-02-28")));
    assert_eq!(get("date_inf").0, Value::Date(s("infinity")));
    assert_eq!(get("date_bc").0, Value::Date(s("0001-12-31 BC")));
    assert_eq!(get("time").0, Value::Time(s("12:34:56.5")));
    assert_eq!(get("timetz").0, Value::Time(s("12:34:56+05:30")));
    assert_eq!(
        get("ts").0,
        Value::Timestamp(s("2025-02-28 13:14:15.123456"))
    );
    assert_eq!(
        get("tstz").0,
        Value::TimestampTz(s("2025-02-28 11:14:15+00"))
    );
    assert_eq!(
        get("interval").0,
        Value::Interval(s("1 year 2 mons 3 days 04:05:06.7"))
    );
    assert_eq!(
        get("uuid").0,
        Value::Uuid(s("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"))
    );
    assert_eq!(
        get("json").0,
        Value::Json(s("{\"n\": 12345678901234567890}"))
    );
    assert_eq!(get("jsonb").0, Value::Json(s("{\"b\": [1, 2]}")));
    assert_eq!(
        get("int_array"),
        (
            Value::Array(vec![Value::Int(s("1")), Value::Null, Value::Int(s("3"))]),
            ValueKind::Array
        )
    );
    assert_eq!(
        get("text_matrix").0,
        Value::Array(vec![
            Value::Array(vec![Value::Text(s("a")), Value::Text(s("b"))]),
            Value::Array(vec![Value::Text(s("c")), Value::Text(s("d"))]),
        ])
    );
    assert_eq!(get("inet").0, Value::Other(s("192.168.0.1/24")));
    assert!(matches!(get("point").0, Value::Other(_)));
    assert_eq!(get("money").0, Value::Decimal(s("12.34")));

    // Every timestamp and interval agrees with the server's own text output.
    let check = conn
        .query(
            "SELECT v, v::text FROM unnest(ARRAY[
                '2000-01-01 00:00:00', '1999-12-31 23:59:59.999999', '1970-01-01 00:00:01',
                '0044-03-15 12:00:00 BC', '2262-04-11 23:47:16.854775', 'infinity'
             ]::timestamp[]) v",
            100,
        )
        .await
        .expect("timestamps");
    for row in &check.rows {
        let (Value::Timestamp(ours), Value::Text(theirs)) = (&row[0], &row[1]) else {
            panic!("unexpected row {row:?}");
        };
        assert_eq!(ours, theirs);
    }
}

#[tokio::test]
async fn reports_auth_failure_and_unknown_database() {
    let Some(url) = pg_url("reports_auth_failure_and_unknown_database") else {
        return;
    };
    let (def, password) = pg_definition(&url);
    let wrong = Secret::new("definitely-not-the-password");
    let error = open(&def, Some(&wrong)).await.err().expect("fails");
    assert_eq!(error.code, ErrorCode::AuthFailed, "{error:?}");
    assert!(
        !format!("{error:?}").contains("definitely-not"),
        "the password leaked"
    );

    let mut missing = def.clone();
    missing.database = "yadbe_no_such_database".into();
    let error = open(&missing, password.as_ref())
        .await
        .err()
        .expect("fails");
    assert_eq!(error.code, ErrorCode::UnknownDatabase, "{error:?}");
    assert!(error.message.en.contains("yadbe_no_such_database"));

    let error = open(&def, None).await.err().expect("no password");
    assert_eq!(error.code, ErrorCode::PasswordRequired, "{error:?}");
}

#[tokio::test]
async fn statement_errors_and_cancellation() {
    let Some(url) = pg_url("statement_errors_and_cancellation") else {
        return;
    };
    let (def, password) = pg_definition(&url);
    let conn = open(&def, password.as_ref()).await.expect("connect");
    let error = conn.query("SELEC 1", 1).await.expect_err("syntax");
    assert_eq!(error.code, ErrorCode::QueryFailed);
    assert!(error.detail.unwrap_or_default().contains("42601"));

    let cancel = conn.cancel_handle();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        cancel.cancel().await
    });
    let error = conn
        .query("SELECT pg_sleep(10)", 1)
        .await
        .expect_err("cancelled");
    assert!(error.detail.unwrap_or_default().contains("57014"));
    canceller.await.expect("join").expect("cancel request");
    // The connection is still usable after a cancelled statement.
    conn.ping().await.expect("ping after cancel");
}

#[tokio::test]
async fn tls_modes() {
    let Some(url) = pg_url("tls_modes") else {
        return;
    };
    let (base, password) = pg_definition(&url);
    let password = password.as_ref();
    let server_tls = {
        let conn = open(&base, password).await.expect("connect");
        conn.query("SHOW ssl", 1).await.expect("SHOW ssl").rows[0][0] == Value::Text("on".into())
    };
    // `prefer` uses TLS exactly when the server offers it; `require` fails without it.
    for (mode, encrypted) in [
        (TlsMode::Disable, false),
        (TlsMode::Prefer, server_tls),
        (TlsMode::Require, true),
    ] {
        let mut def = base.clone();
        def.tls_mode = mode;
        if mode == TlsMode::Require && !server_tls {
            let error = open(&def, password)
                .await
                .err()
                .expect("no TLS on the server");
            assert_eq!(error.code, ErrorCode::TlsNotSupported, "{error:?}");
            continue;
        }
        let conn = open(&def, password)
            .await
            .unwrap_or_else(|e| panic!("{mode:?}: {e:?}"));
        let ssl = conn
            .query(
                "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
                1,
            )
            .await
            .expect("pg_stat_ssl");
        assert_eq!(ssl.rows[0][0], Value::Bool(encrypted), "{mode:?}");
    }
    if !server_tls {
        common::skip(
            "tls_modes (CA part)",
            "the test server has no TLS certificate",
        );
        return;
    }
    let Some(ca) = pg_ca("tls_modes (CA part)") else {
        return;
    };
    // The test certificate is for DNS:localhost only (dev/tls-certs.sh).
    let mut def = base.clone();
    def.host = "localhost".into();
    def.tls_mode = TlsMode::VerifyFull;
    let error = open(&def, password).await.err().expect("unknown issuer");
    assert_eq!(error.code, ErrorCode::TlsFailed, "{error:?}");

    def.ca_cert_path = Some(ca.clone());
    open(&def, password).await.expect("verify-full with the CA");

    let mut by_ip = def.clone();
    by_ip.host = "127.0.0.1".into();
    let error = open(&by_ip, password).await.err().expect("name mismatch");
    assert_eq!(error.code, ErrorCode::TlsFailed, "{error:?}");

    by_ip.tls_mode = TlsMode::Require;
    open(&by_ip, password)
        .await
        .expect("require + CA verifies the chain, not the name");

    let mut bad_ca = def.clone();
    bad_ca.ca_cert_path = Some("/nonexistent/ca.pem".into());
    let error = open(&bad_ca, password).await.err().expect("unreadable CA");
    assert_eq!(error.code, ErrorCode::TlsFailed, "{error:?}");
}

#[tokio::test]
async fn reconnects_after_the_server_kills_the_backend_without_replaying() {
    let Some(url) = pg_url("reconnects_after_the_server_kills_the_backend_without_replaying")
    else {
        return;
    };
    let (mut def, password) = pg_definition(&url);
    def.remember_password = false;
    let h = harness();
    let saved = h.store.create_connection(&def).expect("save");
    let id = saved.id.clone();
    let password = password.map(|p| p.expose().to_owned());
    if let Some(password) = &password {
        h.secrets
            .set(
                &id,
                SecretKind::Password,
                Secret::new(password.clone()),
                false,
            )
            .expect("secret");
    }
    h.manager.connect(&id, None).await.expect("connect");
    let session = h.manager.session(&id).expect("session");
    session
        .query("CREATE TABLE IF NOT EXISTS yadbe_replay_probe (x int)", 0)
        .await
        .expect("create");
    session
        .query("TRUNCATE yadbe_replay_probe", 0)
        .await
        .expect("truncate");
    let pid = match &session
        .query("SELECT pg_backend_pid()", 1)
        .await
        .expect("pid")
        .rows[0][0]
    {
        Value::Int(pid) => pid.clone(),
        other => panic!("pid {other:?}"),
    };

    // A slow insert is running when the server kills the backend.
    let running = {
        let session = Arc::clone(&session);
        tokio::spawn(async move {
            session
                .query(
                    "INSERT INTO yadbe_replay_probe SELECT 1 FROM pg_sleep(2)",
                    0,
                )
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let killer = open(
        &def,
        password.as_ref().map(|p| Secret::new(p.clone())).as_ref(),
    )
    .await
    .expect("second connection");
    killer
        .query(&format!("SELECT pg_terminate_backend({pid})"), 1)
        .await
        .expect("terminate");

    let error = running.await.expect("join").expect_err("the insert failed");
    assert_eq!(error.code, ErrorCode::ConnectionLost, "{error:?}");
    h.wait_for_states(
        &id,
        &[
            ConnectionState::Connecting,
            ConnectionState::Connected,
            ConnectionState::Lost,
            ConnectionState::Reconnecting,
            ConnectionState::Connected,
        ],
    )
    .await;

    // Back, on a new backend, and the insert was not replayed.
    let count = session
        .query("SELECT count(*) FROM yadbe_replay_probe", 1)
        .await
        .expect("count");
    assert_eq!(count.rows[0][0], Value::Int("0".into()));
    let new_pid = session
        .query("SELECT pg_backend_pid()", 1)
        .await
        .expect("pid");
    assert_ne!(new_pid.rows[0][0], Value::Int(pid));
    session
        .query("DROP TABLE yadbe_replay_probe", 0)
        .await
        .expect("drop");
    h.manager.disconnect(&id).await;
    assert_eq!(h.states(&id).last(), Some(&ConnectionState::Closed));
}
