//! Connection-string parser (F-006): URLs (`postgres://`, `mysql://`, `sqlserver://`,
//! `sqlite:`), ADO.NET (`Server=…;Database=…`) and JDBC (`jdbc:…`). The result fills the
//! connection form; the password is returned apart, as a `Secret`.

use serde::Serialize;
use specta::Type;

use crate::db::config::{ConnectionOption, TlsMode};
use crate::db::dialect::Engine;
use crate::db::errors::YadbeError;
use crate::secrets::Secret;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStringFormat {
    Url,
    AdoNet,
    Jdbc,
}

/// Form fields found in a connection string; `null`: absent from the string (keep the
/// form's value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParsedConnectionString {
    pub format: ConnectionStringFormat,
    pub engine: Option<Engine>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub file_path: Option<String>,
    pub tls_mode: Option<TlsMode>,
    pub ca_cert_path: Option<String>,
    /// Engine parameters to pass through (`application_name`…).
    pub options: Vec<ConnectionOption>,
    /// The string held a password: the backend keeps it under this id (see
    /// `SecretInput.pending`); it is never sent back.
    pub password_id: Option<String>,
    /// Keys yadbe did not understand and ignored.
    pub ignored_keys: Vec<String>,
}

/// Parser output: the fields, and the password kept apart.
#[derive(Debug)]
pub struct Parsed {
    pub fields: ParsedConnectionString,
    pub password: Option<Secret>,
}

/// Parses `input`; `hint` is the engine selected in the form, used when the string does
/// not say (ADO.NET).
pub fn parse(input: &str, hint: Option<Engine>) -> Result<Parsed, YadbeError> {
    let text = input.trim();
    if text.is_empty() {
        return Err(invalid());
    }
    if let Some(rest) = strip_prefix_ci(text, "jdbc:") {
        return parse_jdbc(rest);
    }
    if let Some(scheme) = scheme_of(text)
        && let Some(engine) = engine_of_scheme(&scheme)
    {
        return parse_url(text, &scheme, engine, ConnectionStringFormat::Url);
    }
    if text.contains('=') {
        return parse_ado_net(text, hint);
    }
    Err(invalid())
}

/// Whether `text` is a connection URL of a known engine (`postgres://…`, `jdbc:…`), as opposed
/// to a file path: what the command line uses to tell the two apart.
pub fn looks_like_url(text: &str) -> bool {
    let text = text.trim();
    strip_prefix_ci(text, "jdbc:").is_some()
        || scheme_of(text).is_some_and(|scheme| engine_of_scheme(&scheme).is_some())
}

fn invalid() -> YadbeError {
    YadbeError::invalid_connection_string(
        "This connection string is not a URL, an ADO.NET string or a JDBC URL.",
        "Cette chaîne de connexion n'est ni une URL, ni une chaîne ADO.NET, ni une URL JDBC.",
    )
}

fn invalid_port(value: &str) -> YadbeError {
    YadbeError::invalid_connection_string(
        format!("The port \"{value}\" is not a number between 1 and 65535."),
        format!("Le port « {value} » n'est pas un nombre compris entre 1 et 65535."),
    )
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

/// The URL scheme, lowercased, when `text` starts with one (`scheme:`).
fn scheme_of(text: &str) -> Option<String> {
    let colon = text.find(':')?;
    let scheme = &text[..colon];
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    valid.then(|| scheme.to_ascii_lowercase())
}

fn engine_of_scheme(scheme: &str) -> Option<Engine> {
    match scheme {
        "postgres" | "postgresql" => Some(Engine::Postgres),
        "mysql" | "mariadb" => Some(Engine::Mysql),
        "sqlserver" | "mssql" => Some(Engine::Mssql),
        "sqlite" | "sqlite3" => Some(Engine::Sqlite),
        _ => None,
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(byte) = text
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_port(value: &str) -> Result<u16, YadbeError> {
    match value.trim().parse::<u16>() {
        Ok(port) if port > 0 => Ok(port),
        _ => Err(invalid_port(value.trim())),
    }
}

fn empty(format: ConnectionStringFormat, engine: Engine) -> ParsedConnectionString {
    ParsedConnectionString {
        format,
        engine: Some(engine),
        host: None,
        port: None,
        database: None,
        username: None,
        file_path: None,
        tls_mode: None,
        ca_cert_path: None,
        options: Vec::new(),
        password_id: None,
        ignored_keys: Vec::new(),
    }
}

fn non_empty(value: impl Into<String>) -> Option<String> {
    let value = value.into();
    (!value.is_empty()).then_some(value)
}

/// TLS mode of a libpq `sslmode` or a MySQL `ssl-mode` value. `verify-ca` maps to `require`
/// with the CA kept: yadbe then verifies the chain, not the host name.
fn tls_from_ssl_mode(value: &str) -> Option<TlsMode> {
    match value.to_ascii_lowercase().replace(['-', '_'], "").as_str() {
        "disable" | "disabled" | "none" => Some(TlsMode::Disable),
        "allow" | "prefer" | "preferred" => Some(TlsMode::Prefer),
        "require" | "required" | "verifyca" => Some(TlsMode::Require),
        "verifyfull" | "verifyidentity" => Some(TlsMode::VerifyFull),
        _ => None,
    }
}

fn is_true(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "yes" | "1" | "on"
    )
}

/// SQL Server's `Encrypt` / `TrustServerCertificate` pair.
fn tls_from_mssql(
    encrypt: Option<&str>,
    trust_server_certificate: Option<&str>,
) -> Option<TlsMode> {
    let trust = trust_server_certificate.is_some_and(is_true);
    match encrypt.map(|e| e.trim().to_ascii_lowercase()) {
        Some(e) if matches!(e.as_str(), "false" | "no" | "0" | "optional") => Some(TlsMode::Prefer),
        Some(e) if e == "strict" => Some(TlsMode::VerifyFull),
        Some(e) if matches!(e.as_str(), "true" | "yes" | "1" | "mandatory") => Some(if trust {
            TlsMode::Require
        } else {
            TlsMode::VerifyFull
        }),
        Some(_) => None,
        None => trust.then_some(TlsMode::Require),
    }
}

/// Key normalized for comparison: lowercase, without spaces, `_` or `-`.
fn norm_key(key: &str) -> String {
    key.chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

/// SQL Server's TLS keys, resolved together once every pair is read.
#[derive(Default)]
struct Tls {
    encrypt: Option<String>,
    trust: Option<String>,
}

/// Applies one `key=value` pair, whatever the format; the password goes to `password`.
/// Unknown keys land in `ignored_keys`.
fn apply_pair(
    fields: &mut ParsedConnectionString,
    tls: &mut Tls,
    password: &mut Option<Secret>,
    key: &str,
    value: String,
) -> Result<(), YadbeError> {
    let engine = fields.engine;
    match norm_key(key).as_str() {
        "host" | "server" | "datasource" | "address" | "addr" | "networkaddress" | "servername" => {
            if engine == Some(Engine::Sqlite) {
                fields.file_path = non_empty(value);
            } else {
                let (host, port) = split_server(&value, engine)?;
                fields.host = non_empty(host);
                if port.is_some() {
                    fields.port = port;
                }
            }
        }
        "port" | "portnumber" => fields.port = Some(parse_port(&value)?),
        "database" | "initialcatalog" | "dbname" | "databasename" => {
            fields.database = non_empty(value);
        }
        "userid" | "uid" | "user" | "username" => fields.username = non_empty(value),
        "password" | "pwd" => *password = Some(Secret::new(value)),
        "sslmode" => fields.tls_mode = tls_from_ssl_mode(&value).or(fields.tls_mode),
        "ssl" | "usessl" => {
            if is_true(&value) && fields.tls_mode.is_none() {
                fields.tls_mode = Some(TlsMode::Require);
            }
        }
        "encrypt" => tls.encrypt = Some(value),
        "trustservercertificate" => tls.trust = Some(value),
        "sslrootcert" | "sslca" | "rootcertificate" | "ca" | "servercacertificate" => {
            fields.ca_cert_path = non_empty(value);
        }
        "applicationname" => fields.options.push(ConnectionOption {
            key: if engine == Some(Engine::Postgres) {
                "application_name".to_owned()
            } else {
                key.to_owned()
            },
            value,
        }),
        "options" if engine == Some(Engine::Postgres) => fields.options.push(ConnectionOption {
            key: "options".to_owned(),
            value,
        }),
        _ => fields.ignored_keys.push(key.to_owned()),
    }
    Ok(())
}

/// `host`, `host,port` (SQL Server), `host:port`, `tcp:host`, `[::1]:5432`.
fn split_server(value: &str, engine: Option<Engine>) -> Result<(String, Option<u16>), YadbeError> {
    let value = strip_prefix_ci(value.trim(), "tcp:").unwrap_or(value.trim());
    if let Some((host, port)) = value.rsplit_once(',') {
        return Ok((host.trim().to_owned(), Some(parse_port(port)?)));
    }
    if let Some(rest) = value.strip_prefix('[')
        && let Some((host, after)) = rest.split_once(']')
    {
        let port = after.strip_prefix(':').map(parse_port).transpose()?;
        return Ok((host.to_owned(), port));
    }
    // `host:port`, but not an IPv6 address (several colons) nor a SQL Server instance.
    if engine != Some(Engine::Mssql)
        && value.matches(':').count() == 1
        && let Some((host, port)) = value.split_once(':')
    {
        return Ok((host.to_owned(), Some(parse_port(port)?)));
    }
    Ok((value.to_owned(), None))
}

fn finish(mut fields: ParsedConnectionString, tls: &Tls, password: Option<Secret>) -> Parsed {
    if let Some(mode) = tls_from_mssql(tls.encrypt.as_deref(), tls.trust.as_deref()) {
        fields.tls_mode = Some(mode);
    }
    Parsed {
        fields,
        password: password.filter(|p| !p.is_empty()),
    }
}

fn parse_sqlite_path(rest: &str, format: ConnectionStringFormat) -> Parsed {
    let mut fields = empty(format, Engine::Sqlite);
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let path = path.strip_prefix("//").unwrap_or(path);
    let mut path = percent_decode(path);
    // `sqlite:///C:/data/app.db` on Windows.
    if path.len() > 3 && path.starts_with('/') && path.as_bytes()[2] == b':' {
        path.remove(0);
    }
    fields.file_path = non_empty(path);
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let key = pair.split_once('=').map_or(pair, |(k, _)| k);
        fields.ignored_keys.push(key.to_owned());
    }
    Parsed {
        fields,
        password: None,
    }
}

fn parse_url(
    text: &str,
    scheme: &str,
    engine: Engine,
    format: ConnectionStringFormat,
) -> Result<Parsed, YadbeError> {
    let rest = &text[scheme.len() + 1..];
    if engine == Engine::Sqlite {
        return Ok(parse_sqlite_path(rest, format));
    }
    if engine == Engine::Mssql && (rest.contains(';') || !rest.contains('@')) {
        return parse_sqlserver_props(rest, format);
    }
    // Several hosts (`h1,h2:5433`): yadbe connects to the first one.
    let authority_end = rest
        .strip_prefix("//")
        .and_then(|r| r.find(['/', '?']))
        .map_or(rest.len(), |i| i + 2);
    let authority = &rest[..authority_end];
    let mut multi_host = false;
    let first_host_url;
    let to_parse = if let Some(comma) = authority.find(',') {
        multi_host = true;
        let at = authority.rfind('@').map_or(2, |i| i + 1);
        let host_end = authority[comma..]
            .find(['/', '?'])
            .map_or(authority.len(), |i| comma + i);
        first_host_url = format!(
            "{scheme}:{}{}{}",
            &authority[..comma.max(at)],
            &authority[host_end..],
            &rest[authority_end..]
        );
        first_host_url.as_str()
    } else {
        text
    };
    let url = url::Url::parse(to_parse).map_err(|err| invalid().with_detail(err.to_string()))?;
    let mut fields = empty(format, engine);
    let mut tls = Tls::default();
    let mut password = url.password().map(|p| Secret::new(percent_decode(p)));
    if let Some(host) = url.host_str() {
        let host = host.trim_start_matches('[').trim_end_matches(']');
        fields.host = non_empty(percent_decode(host));
    }
    fields.port = url.port();
    fields.username = non_empty(percent_decode(url.username()));
    fields.database = non_empty(percent_decode(url.path().trim_start_matches('/')));
    if multi_host {
        fields.ignored_keys.push("host".to_owned());
    }
    for (key, value) in url.query_pairs() {
        apply_pair(
            &mut fields,
            &mut tls,
            &mut password,
            &key,
            value.into_owned(),
        )?;
    }
    Ok(finish(fields, &tls, password))
}

/// `sqlserver://host[:port][\instance];key=value;…` (JDBC, Prisma).
fn parse_sqlserver_props(rest: &str, format: ConnectionStringFormat) -> Result<Parsed, YadbeError> {
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let mut parts = split_pairs(rest).into_iter();
    let head = parts.next().unwrap_or_default();
    let mut fields = empty(format, Engine::Mssql);
    let mut tls = Tls::default();
    let mut password = None;
    if !head.trim().is_empty() && !head.contains('=') {
        let (host, port) = match head.rsplit_once(':') {
            Some((host, port)) => (host.to_owned(), Some(parse_port(port)?)),
            None => (head.clone(), None),
        };
        fields.host = non_empty(host);
        fields.port = port;
    } else if head.contains('=') {
        let (key, value) = head.split_once('=').unwrap_or((&head, ""));
        apply_pair(&mut fields, &mut tls, &mut password, key, value.to_owned())?;
    }
    for part in parts {
        let (key, value) = part.split_once('=').unwrap_or((&part, ""));
        if norm_key(key) == "instancename" {
            if let Some(host) = &mut fields.host {
                host.push('\\');
                host.push_str(value);
            }
            continue;
        }
        apply_pair(
            &mut fields,
            &mut tls,
            &mut password,
            key.trim(),
            unquote(value),
        )?;
    }
    Ok(finish(fields, &tls, password))
}

fn parse_jdbc(rest: &str) -> Result<Parsed, YadbeError> {
    let scheme = scheme_of(rest).ok_or_else(invalid)?;
    let engine = engine_of_scheme(&scheme).ok_or_else(invalid)?;
    parse_url(rest, &scheme, engine, ConnectionStringFormat::Jdbc)
}

/// Splits on `;` outside quotes (`'…'` or `"…"` doubled to escape, JDBC's `{…}` with `}}`).
fn split_pairs(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some('{') if c == '}' => {
                current.push(c);
                if chars.peek() == Some(&'}') {
                    current.push('}');
                    chars.next();
                } else {
                    quote = None;
                }
            }
            Some(q) if c == q => {
                if chars.peek() == Some(&q) {
                    current.push(c);
                    current.push(c);
                    chars.next();
                } else {
                    current.push(c);
                    quote = None;
                }
            }
            Some(_) => current.push(c),
            None if c == ';' => parts.push(std::mem::take(&mut current)),
            None => {
                if (c == '\'' || c == '"' || c == '{') && current.trim_end().ends_with('=') {
                    quote = Some(c);
                }
                current.push(c);
            }
        }
    }
    parts.push(current);
    parts.into_iter().filter(|p| !p.trim().is_empty()).collect()
}

/// Removes ADO.NET quoting from a value: `'it''s'` → `it's`, `{a;b}}c}` → `a;b}c`.
fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('{') && value.ends_with('}') {
        return value[1..value.len() - 1].replace("}}", "}");
    }
    for q in ['\'', '"'] {
        if value.len() >= 2 && value.starts_with(q) && value.ends_with(q) {
            let doubled = format!("{q}{q}");
            return value[1..value.len() - 1].replace(&doubled, &q.to_string());
        }
    }
    value.to_owned()
}

fn detect_ado_engine(keys: &[String], values: &[(String, String)], hint: Option<Engine>) -> Engine {
    let has = |k: &str| keys.iter().any(|key| key == k);
    let sqlite_file = values.iter().any(|(k, v)| {
        k == "datasource" && {
            let v = v.to_ascii_lowercase();
            v.ends_with(".db")
                || v.ends_with(".sqlite")
                || v.ends_with(".sqlite3")
                || v == ":memory:"
        }
    });
    if sqlite_file || (has("mode") && has("datasource")) {
        Engine::Sqlite
    } else if has("host") || has("username") || has("searchpath") {
        Engine::Postgres
    } else if has("initialcatalog")
        || has("integratedsecurity")
        || has("trustservercertificate")
        || has("encrypt")
        || has("trustedconnection")
        || has("multipleactiveresultsets")
    {
        Engine::Mssql
    } else if let Some(hint) = hint {
        hint
    } else if has("uid") || has("pwd") || has("sslmode") {
        Engine::Mysql
    } else {
        Engine::Mssql
    }
}

fn parse_ado_net(text: &str, hint: Option<Engine>) -> Result<Parsed, YadbeError> {
    let pairs: Vec<(String, String)> = split_pairs(text)
        .into_iter()
        .map(|part| match part.split_once('=') {
            Some((key, value)) => (key.trim().to_owned(), unquote(value)),
            None => (part.trim().to_owned(), String::new()),
        })
        .collect();
    let keys: Vec<String> = pairs.iter().map(|(k, _)| norm_key(k)).collect();
    let normalized: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (norm_key(k), v.clone()))
        .collect();
    let engine = detect_ado_engine(&keys, &normalized, hint);
    let mut fields = empty(ConnectionStringFormat::AdoNet, engine);
    let mut tls = Tls::default();
    let mut password = None;
    for (key, value) in pairs {
        apply_pair(&mut fields, &mut tls, &mut password, &key, value)?;
    }
    Ok(finish(fields, &tls, password))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::errors::ErrorCode;

    fn parse_ok(input: &str) -> Parsed {
        parse(input, None).unwrap_or_else(|e| panic!("{input}: {e}"))
    }

    fn password(parsed: &Parsed) -> Option<&str> {
        parsed.password.as_ref().map(Secret::expose)
    }

    #[test]
    fn postgres_urls() {
        let p = parse_ok(
            "postgres://app:s%40cr%3At@db.example.com:6543/shop?sslmode=verify-full&application_name=etl&connect_timeout=5",
        );
        assert_eq!(p.fields.format, ConnectionStringFormat::Url);
        assert_eq!(p.fields.engine, Some(Engine::Postgres));
        assert_eq!(p.fields.host.as_deref(), Some("db.example.com"));
        assert_eq!(p.fields.port, Some(6543));
        assert_eq!(p.fields.database.as_deref(), Some("shop"));
        assert_eq!(p.fields.username.as_deref(), Some("app"));
        assert_eq!(password(&p), Some("s@cr:t"));
        assert_eq!(p.fields.tls_mode, Some(TlsMode::VerifyFull));
        assert_eq!(
            p.fields.options,
            vec![ConnectionOption {
                key: "application_name".into(),
                value: "etl".into()
            }]
        );
        assert_eq!(p.fields.ignored_keys, vec!["connect_timeout".to_owned()]);
        // The fields sent to the frontend never contain the password.
        let json = serde_json::to_string(&p.fields).expect("serializes");
        assert!(!json.contains("cr:t") && !json.contains("%40"));

        let p = parse_ok("postgresql://localhost");
        assert_eq!(p.fields.host.as_deref(), Some("localhost"));
        assert_eq!(p.fields.database, None);
        assert!(p.password.is_none());

        let p = parse_ok(
            "postgresql://[::1]:5433/db?user=u&password=p&sslmode=verify-ca&sslrootcert=/etc/ca.pem",
        );
        assert_eq!(p.fields.host.as_deref(), Some("::1"));
        assert_eq!(p.fields.port, Some(5433));
        assert_eq!(p.fields.username.as_deref(), Some("u"));
        assert_eq!(password(&p), Some("p"));
        assert_eq!(p.fields.tls_mode, Some(TlsMode::Require));
        assert_eq!(p.fields.ca_cert_path.as_deref(), Some("/etc/ca.pem"));

        let p = parse_ok("postgres:///shop?host=/var/run/postgresql");
        assert_eq!(p.fields.host.as_deref(), Some("/var/run/postgresql"));
        assert_eq!(p.fields.database.as_deref(), Some("shop"));

        let p = parse_ok("postgres://u@h1:5432,h2:5433/db");
        assert_eq!(p.fields.host.as_deref(), Some("h1"));
        assert_eq!(p.fields.port, Some(5432));
        assert_eq!(p.fields.database.as_deref(), Some("db"));
        assert_eq!(p.fields.ignored_keys, vec!["host".to_owned()]);
    }

    #[test]
    fn mysql_and_mssql_urls() {
        let p = parse_ok("mysql://root:pw@127.0.0.1:3307/wp?ssl-mode=REQUIRED");
        assert_eq!(p.fields.engine, Some(Engine::Mysql));
        assert_eq!(p.fields.port, Some(3307));
        assert_eq!(p.fields.tls_mode, Some(TlsMode::Require));
        assert_eq!(password(&p), Some("pw"));

        let p = parse_ok(
            "sqlserver://sql.example.com:1433;database=Reporting;user=sa;password={x;y};encrypt=true;trustServerCertificate=true",
        );
        assert_eq!(p.fields.engine, Some(Engine::Mssql));
        assert_eq!(p.fields.host.as_deref(), Some("sql.example.com"));
        assert_eq!(p.fields.port, Some(1433));
        assert_eq!(p.fields.database.as_deref(), Some("Reporting"));
        assert_eq!(p.fields.username.as_deref(), Some("sa"));
        assert_eq!(password(&p), Some("x;y"));
        assert_eq!(p.fields.tls_mode, Some(TlsMode::Require));

        let p = parse_ok("mssql://sa:pw@sql/Reporting");
        assert_eq!(p.fields.host.as_deref(), Some("sql"));
        assert_eq!(password(&p), Some("pw"));
    }

    #[test]
    fn sqlite_urls() {
        assert_eq!(
            parse_ok("sqlite:///home/ana/app.db")
                .fields
                .file_path
                .as_deref(),
            Some("/home/ana/app.db")
        );
        assert_eq!(
            parse_ok("sqlite://data/app.db?mode=ro")
                .fields
                .file_path
                .as_deref(),
            Some("data/app.db")
        );
        assert_eq!(
            parse_ok("sqlite:app.db").fields.file_path.as_deref(),
            Some("app.db")
        );
        assert_eq!(
            parse_ok("sqlite:///C:/data/app%20x.db")
                .fields
                .file_path
                .as_deref(),
            Some("C:/data/app x.db")
        );
    }

    #[test]
    fn ado_net_strings() {
        let p = parse_ok(
            "Server=tcp:sql.example.com,1433;Initial Catalog=Reporting;User Id=sa;Password='p;w''d';Encrypt=True;TrustServerCertificate=False;Connection Timeout=30",
        );
        assert_eq!(p.fields.format, ConnectionStringFormat::AdoNet);
        assert_eq!(p.fields.engine, Some(Engine::Mssql));
        assert_eq!(p.fields.host.as_deref(), Some("sql.example.com"));
        assert_eq!(p.fields.port, Some(1433));
        assert_eq!(p.fields.database.as_deref(), Some("Reporting"));
        assert_eq!(password(&p), Some("p;w'd"));
        assert_eq!(p.fields.tls_mode, Some(TlsMode::VerifyFull));
        assert_eq!(p.fields.ignored_keys, vec!["Connection Timeout".to_owned()]);

        let p = parse_ok(
            "Host=localhost;Port=5433;Database=shop;Username=app;Password=pw;SSL Mode=Require",
        );
        assert_eq!(p.fields.engine, Some(Engine::Postgres));
        assert_eq!(p.fields.port, Some(5433));
        assert_eq!(p.fields.tls_mode, Some(TlsMode::Require));

        let p = parse("Server=localhost;Database=wp;Uid=root;Pwd=pw", None).expect("mysql");
        assert_eq!(p.fields.engine, Some(Engine::Mysql));
        assert_eq!(password(&p), Some("pw"));

        // An ambiguous string follows the engine selected in the form.
        let p = parse("Server=db;Database=wp;User Id=u", Some(Engine::Mysql)).expect("hint");
        assert_eq!(p.fields.engine, Some(Engine::Mysql));
        let p = parse("Server=db;Database=wp;User Id=u", None).expect("default");
        assert_eq!(p.fields.engine, Some(Engine::Mssql));

        let p = parse_ok("Data Source=C:\\data\\app.db;Mode=ReadOnly");
        assert_eq!(p.fields.engine, Some(Engine::Sqlite));
        assert_eq!(p.fields.file_path.as_deref(), Some("C:\\data\\app.db"));

        let p = parse_ok("Server=sql\\SQLEXPRESS;Database=x;Trusted_Connection=True");
        assert_eq!(p.fields.host.as_deref(), Some("sql\\SQLEXPRESS"));
    }

    #[test]
    fn jdbc_urls() {
        let p = parse_ok("jdbc:postgresql://db:5432/shop?user=app&password=pw&ssl=true");
        assert_eq!(p.fields.format, ConnectionStringFormat::Jdbc);
        assert_eq!(p.fields.engine, Some(Engine::Postgres));
        assert_eq!(p.fields.tls_mode, Some(TlsMode::Require));
        assert_eq!(password(&p), Some("pw"));

        let p = parse_ok(
            "jdbc:sqlserver://sql.example.com:1433;databaseName=Reporting;user=sa;password=pw;encrypt=true;trustServerCertificate=true;instanceName=PROD",
        );
        assert_eq!(p.fields.engine, Some(Engine::Mssql));
        assert_eq!(p.fields.host.as_deref(), Some("sql.example.com\\PROD"));
        assert_eq!(p.fields.database.as_deref(), Some("Reporting"));
        assert_eq!(p.fields.tls_mode, Some(TlsMode::Require));

        let p = parse_ok("jdbc:sqlserver://;serverName=sql;databaseName=x");
        assert_eq!(p.fields.host.as_deref(), Some("sql"));

        let p = parse_ok("jdbc:mysql://db/wp?useSSL=true&sslMode=VERIFY_IDENTITY");
        assert_eq!(p.fields.tls_mode, Some(TlsMode::VerifyFull));

        let p = parse_ok("jdbc:sqlite:/var/data/app.db");
        assert_eq!(p.fields.file_path.as_deref(), Some("/var/data/app.db"));
    }

    #[test]
    fn rejects_garbage() {
        for input in [
            "",
            "   ",
            "hello world",
            "ftp://x",
            "jdbc:oracle:thin:@x",
            "postgres://h:99999/db",
        ] {
            let code = parse(input, None).map(|_| ()).map_err(|e| e.code);
            assert_eq!(code, Err(ErrorCode::InvalidConnectionString), "{input}");
        }
    }

    #[test]
    fn parsed_debug_never_shows_the_password() {
        let p = parse_ok("postgres://u:hunter2@h/db");
        assert!(!format!("{p:?}").contains("hunter2"));
    }
}
