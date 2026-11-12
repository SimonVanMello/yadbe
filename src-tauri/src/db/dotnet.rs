//! A connection as a .NET connection string (F-143): the ADO.NET string of the engine's data
//! provider, or the EF Core call that uses it. The password is left out unless the caller
//! passes it; whatever yadbe cannot say in a connection string is listed as a note instead of
//! being dropped silently.
//!
//! Providers: Npgsql (PostgreSQL), Microsoft.Data.SqlClient (SQL Server), MySqlConnector
//! (MySQL / MariaDB; Pomelo.EntityFrameworkCore.MySql reads the same string), and
//! Microsoft.Data.Sqlite.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::config::{ConnectionDefinition, TlsMode};
use crate::db::dialect::{Dialect, MssqlDialect, MysqlDialect, PostgresDialect, SqliteDialect};
use crate::secrets::{RevealedText, Secret};

/// What the user asks to copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStringFlavor {
    /// The connection string alone, as the data provider reads it.
    AdoNet,
    /// The C# that gives it to an EF Core `DbContext` (`options.UseNpgsql(…)`).
    EfCore,
}

/// A part of the connection that the string does not carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStringNote {
    /// The connection goes through an SSH tunnel: the string holds the database's own host
    /// and port, to be used from a machine that reaches it.
    SshTunnel,
    /// The connection is read-only in yadbe; the provider has no setting for it.
    ReadOnlyNotExpressed,
    /// Engine parameters of the connection the provider has no keyword for.
    OptionsNotExpressed,
    /// A custom CA file: the provider has no keyword for it.
    CertificateNotExpressed,
    /// The password is not in the string (the default): add it where the app reads secrets.
    PasswordLeftOut,
}

/// The data provider behind a string, for the label of the copy and the notes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DotnetProvider {
    /// The ADO.NET provider (`Npgsql`).
    pub ado_net: &'static str,
    /// The EF Core provider package (`Npgsql.EntityFrameworkCore.PostgreSQL`).
    pub ef_core: &'static str,
}

/// The copy handed to the user. The text carries the password only when it was asked for
/// (`includes_password`): it crosses the IPC once, is never stored, and its type neither
/// logs nor prints it.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStringCopy {
    pub text: RevealedText,
    pub provider: DotnetProvider,
    pub includes_password: bool,
    pub notes: Vec<ConnectionStringNote>,
}

/// The engine half of the builders, on the dialect like the other engine differences.
pub trait DotnetDialect {
    fn dotnet_provider(&self) -> DotnetProvider;

    /// The `UseXxx(…)` call of the EF Core provider with `cs` as the name of a C# variable
    /// that holds the connection string.
    fn ef_use_call(&self, cs: &str) -> String;

    /// The keyword / value pairs of the ADO.NET string, in the order they read best. The
    /// password is `Some` only when it is to be included.
    fn ado_net_pairs(
        &self,
        definition: &ConnectionDefinition,
        password: Option<&Secret>,
        notes: &mut Vec<ConnectionStringNote>,
    ) -> Vec<(&'static str, String)>;
}

/// Builds the copy. `password`: `Some` to include it.
pub fn build(
    dialect: &dyn Dialect,
    definition: &ConnectionDefinition,
    flavor: ConnectionStringFlavor,
    password: Option<&Secret>,
) -> ConnectionStringCopy {
    let mut notes = Vec::new();
    if definition.ssh.is_some() {
        notes.push(ConnectionStringNote::SshTunnel);
    }
    let pairs = dialect.ado_net_pairs(definition, password, &mut notes);
    let uses_password = pairs.iter().any(|(key, _)| is_password_key(key));
    if !uses_password && !dialect.capabilities().uses_file {
        notes.push(ConnectionStringNote::PasswordLeftOut);
    }
    let ado = pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", ado_value(value)))
        .collect::<Vec<_>>()
        .join(";");
    let text = match flavor {
        ConnectionStringFlavor::AdoNet => ado,
        ConnectionStringFlavor::EfCore => format!(
            "var connectionString = {};\noptions.{};",
            csharp_string(&ado),
            dialect.ef_use_call("connectionString")
        ),
    };
    ConnectionStringCopy {
        text: RevealedText::new(text),
        provider: dialect.dotnet_provider(),
        includes_password: uses_password,
        notes,
    }
}

fn is_password_key(key: &str) -> bool {
    key == "Password"
}

/// A value as the provider's connection string builder writes it: bare, or quoted when it
/// holds a separator, a quote or edge spaces.
pub fn ado_value(value: &str) -> String {
    let plain =
        !value.is_empty() && value.trim() == value && !value.contains([';', '=', '"', '\'']);
    if plain {
        return value.to_owned();
    }
    let quote = if !value.contains('"') {
        '"'
    } else if !value.contains('\'') {
        '\''
    } else {
        '"'
    };
    let doubled = format!("{quote}{quote}");
    format!("{quote}{}{quote}", value.replace(quote, &doubled))
}

/// A regular C# string literal.
pub fn csharp_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn push_nonempty(pairs: &mut Vec<(&'static str, String)>, key: &'static str, value: &str) {
    if !value.trim().is_empty() {
        pairs.push((key, value.to_owned()));
    }
}

fn push_password(pairs: &mut Vec<(&'static str, String)>, password: Option<&Secret>) {
    if let Some(password) = password.filter(|p| !p.is_empty()) {
        pairs.push(("Password", password.expose().to_owned()));
    }
}

fn host_port(definition: &ConnectionDefinition) -> (String, Option<u16>) {
    (definition.host.clone(), definition.port)
}

/// Options the provider has no keyword for, noted once.
fn note_options(definition: &ConnectionDefinition, notes: &mut Vec<ConnectionStringNote>) {
    if !definition.options.is_empty() {
        notes.push(ConnectionStringNote::OptionsNotExpressed);
    }
}

impl DotnetDialect for PostgresDialect {
    fn dotnet_provider(&self) -> DotnetProvider {
        DotnetProvider {
            ado_net: "Npgsql",
            ef_core: "Npgsql.EntityFrameworkCore.PostgreSQL",
        }
    }

    fn ef_use_call(&self, cs: &str) -> String {
        format!("UseNpgsql({cs})")
    }

    fn ado_net_pairs(
        &self,
        definition: &ConnectionDefinition,
        password: Option<&Secret>,
        notes: &mut Vec<ConnectionStringNote>,
    ) -> Vec<(&'static str, String)> {
        let mut pairs = Vec::new();
        let (host, port) = host_port(definition);
        push_nonempty(&mut pairs, "Host", &host);
        if let Some(port) = port {
            pairs.push(("Port", port.to_string()));
        }
        push_nonempty(&mut pairs, "Database", &definition.database);
        push_nonempty(&mut pairs, "Username", &definition.username);
        push_password(&mut pairs, password);
        let custom_ca = definition.ca_cert_path.as_deref();
        match (definition.tls_mode, custom_ca) {
            (TlsMode::Disable, _) => pairs.push(("SSL Mode", "Disable".into())),
            (TlsMode::Prefer, _) => {
                pairs.push(("SSL Mode", "Prefer".into()));
                pairs.push(("Trust Server Certificate", "true".into()));
            }
            (TlsMode::Require, None) => {
                pairs.push(("SSL Mode", "Require".into()));
                pairs.push(("Trust Server Certificate", "true".into()));
            }
            (TlsMode::Require, Some(ca)) => {
                pairs.push(("SSL Mode", "VerifyCA".into()));
                pairs.push(("Root Certificate", ca.to_owned()));
            }
            (TlsMode::VerifyFull, ca) => {
                pairs.push(("SSL Mode", "VerifyFull".into()));
                if let Some(ca) = ca {
                    pairs.push(("Root Certificate", ca.to_owned()));
                }
            }
        }
        if let Some(seconds) = definition.connect_timeout_secs {
            pairs.push(("Timeout", seconds.to_string()));
        }
        let mut dropped = false;
        for option in &definition.options {
            match option.key.as_str() {
                "application_name" => pairs.push(("Application Name", option.value.clone())),
                _ => dropped = true,
            }
        }
        if dropped {
            notes.push(ConnectionStringNote::OptionsNotExpressed);
        }
        if definition.read_only {
            pairs.push(("Options", "-c default_transaction_read_only=on".into()));
        }
        pairs
    }
}

impl DotnetDialect for MssqlDialect {
    fn dotnet_provider(&self) -> DotnetProvider {
        DotnetProvider {
            ado_net: "Microsoft.Data.SqlClient",
            ef_core: "Microsoft.EntityFrameworkCore.SqlServer",
        }
    }

    fn ef_use_call(&self, cs: &str) -> String {
        format!("UseSqlServer({cs})")
    }

    fn ado_net_pairs(
        &self,
        definition: &ConnectionDefinition,
        password: Option<&Secret>,
        notes: &mut Vec<ConnectionStringNote>,
    ) -> Vec<(&'static str, String)> {
        let mut pairs = Vec::new();
        let (host, port) = host_port(definition);
        let server = match port {
            Some(port) => format!("{host},{port}"),
            None => host,
        };
        push_nonempty(&mut pairs, "Server", &server);
        push_nonempty(&mut pairs, "Database", &definition.database);
        push_nonempty(&mut pairs, "User Id", &definition.username);
        push_password(&mut pairs, password);
        match definition.tls_mode {
            TlsMode::Disable => pairs.push(("Encrypt", "False".into())),
            TlsMode::Prefer => {
                pairs.push(("Encrypt", "Optional".into()));
                pairs.push(("TrustServerCertificate", "True".into()));
            }
            TlsMode::Require => {
                pairs.push(("Encrypt", "True".into()));
                pairs.push(("TrustServerCertificate", "True".into()));
            }
            TlsMode::VerifyFull => {
                pairs.push(("Encrypt", "True".into()));
                pairs.push(("TrustServerCertificate", "False".into()));
            }
        }
        if definition.ca_cert_path.is_some() {
            notes.push(ConnectionStringNote::CertificateNotExpressed);
        }
        if let Some(seconds) = definition.connect_timeout_secs {
            pairs.push(("Connect Timeout", seconds.to_string()));
        }
        for option in &definition.options {
            if option.key.eq_ignore_ascii_case("applicationname")
                || option.key.eq_ignore_ascii_case("application name")
            {
                pairs.push(("Application Name", option.value.clone()));
            } else {
                notes.push(ConnectionStringNote::OptionsNotExpressed);
                break;
            }
        }
        if definition.read_only {
            notes.push(ConnectionStringNote::ReadOnlyNotExpressed);
        }
        pairs
    }
}

impl DotnetDialect for MysqlDialect {
    fn dotnet_provider(&self) -> DotnetProvider {
        DotnetProvider {
            ado_net: "MySqlConnector",
            ef_core: "Pomelo.EntityFrameworkCore.MySql",
        }
    }

    fn ef_use_call(&self, cs: &str) -> String {
        format!("UseMySql({cs}, ServerVersion.AutoDetect({cs}))")
    }

    fn ado_net_pairs(
        &self,
        definition: &ConnectionDefinition,
        password: Option<&Secret>,
        notes: &mut Vec<ConnectionStringNote>,
    ) -> Vec<(&'static str, String)> {
        let mut pairs = Vec::new();
        let (host, port) = host_port(definition);
        push_nonempty(&mut pairs, "Server", &host);
        if let Some(port) = port {
            pairs.push(("Port", port.to_string()));
        }
        push_nonempty(&mut pairs, "Database", &definition.database);
        push_nonempty(&mut pairs, "User ID", &definition.username);
        push_password(&mut pairs, password);
        let custom_ca = definition.ca_cert_path.as_deref();
        match (definition.tls_mode, custom_ca) {
            (TlsMode::Disable, _) => pairs.push(("SSL Mode", "None".into())),
            (TlsMode::Prefer, _) => pairs.push(("SSL Mode", "Preferred".into())),
            (TlsMode::Require, None) => pairs.push(("SSL Mode", "Required".into())),
            (TlsMode::Require, Some(ca)) => {
                pairs.push(("SSL Mode", "VerifyCA".into()));
                pairs.push(("SSL CA", ca.to_owned()));
            }
            (TlsMode::VerifyFull, ca) => {
                pairs.push(("SSL Mode", "VerifyFull".into()));
                if let Some(ca) = ca {
                    pairs.push(("SSL CA", ca.to_owned()));
                }
            }
        }
        if let Some(seconds) = definition.connect_timeout_secs {
            pairs.push(("Connection Timeout", seconds.to_string()));
        }
        note_options(definition, notes);
        if definition.read_only {
            notes.push(ConnectionStringNote::ReadOnlyNotExpressed);
        }
        pairs
    }
}

impl DotnetDialect for SqliteDialect {
    fn dotnet_provider(&self) -> DotnetProvider {
        DotnetProvider {
            ado_net: "Microsoft.Data.Sqlite",
            ef_core: "Microsoft.EntityFrameworkCore.Sqlite",
        }
    }

    fn ef_use_call(&self, cs: &str) -> String {
        format!("UseSqlite({cs})")
    }

    fn ado_net_pairs(
        &self,
        definition: &ConnectionDefinition,
        _password: Option<&Secret>,
        notes: &mut Vec<ConnectionStringNote>,
    ) -> Vec<(&'static str, String)> {
        let mut pairs = Vec::new();
        push_nonempty(&mut pairs, "Data Source", &definition.file_path);
        if definition.read_only {
            pairs.push(("Mode", "ReadOnly".into()));
        }
        note_options(definition, notes);
        pairs
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::config::{AuthMethod, ConnectionOption, Environment};
    use crate::db::connstring;
    use crate::db::engine::Engine;
    use crate::tunnel::{SshAuthMethod, SshHop, SshTunnel};

    fn definition(engine: Engine) -> ConnectionDefinition {
        ConnectionDefinition {
            name: "shop".into(),
            engine,
            host: "db.example.com".into(),
            port: Some(6543),
            database: "shop".into(),
            username: "app".into(),
            file_path: String::new(),
            auth: AuthMethod::Password,
            tls_mode: TlsMode::VerifyFull,
            ca_cert_path: None,
            tls_client_cert_path: None,
            tls_client_key_path: None,
            connect_timeout_secs: None,
            statement_timeout_secs: None,
            keep_alive_secs: None,
            options: Vec::new(),
            group_id: None,
            environment: Environment::default(),
            favorite: false,
            read_only: false,
            remember_password: true,
            history_enabled: true,
            ssh: None,
        }
    }

    fn text(definition: &ConnectionDefinition, flavor: ConnectionStringFlavor) -> String {
        let copy = build(definition.engine.dialect(), definition, flavor, None);
        copy.text.expose().to_owned()
    }

    #[test]
    fn writes_each_provider_s_keywords_without_the_password() {
        let pg = text(
            &definition(Engine::Postgres),
            ConnectionStringFlavor::AdoNet,
        );
        assert_eq!(
            pg,
            "Host=db.example.com;Port=6543;Database=shop;Username=app;SSL Mode=VerifyFull"
        );
        let ms = text(&definition(Engine::Mssql), ConnectionStringFlavor::AdoNet);
        assert_eq!(
            ms,
            "Server=db.example.com,6543;Database=shop;User Id=app;Encrypt=True;TrustServerCertificate=False"
        );
        let my = text(&definition(Engine::Mysql), ConnectionStringFlavor::AdoNet);
        assert_eq!(
            my,
            "Server=db.example.com;Port=6543;Database=shop;User ID=app;SSL Mode=VerifyFull"
        );
        let mut lite = definition(Engine::Sqlite);
        lite.file_path = "/data/my app.db".into();
        lite.read_only = true;
        assert_eq!(
            text(&lite, ConnectionStringFlavor::AdoNet),
            "Data Source=/data/my app.db;Mode=ReadOnly"
        );
        for (engine, _) in Engine::sql_dialects() {
            assert!(
                !text(&definition(engine), ConnectionStringFlavor::AdoNet).contains("Password")
            );
        }
    }

    #[test]
    fn includes_the_password_only_when_given_and_quotes_it() {
        let def = definition(Engine::Postgres);
        let secret = Secret::new("p;w=\"x'");
        let copy = build(
            def.engine.dialect(),
            &def,
            ConnectionStringFlavor::AdoNet,
            Some(&secret),
        );
        assert!(copy.includes_password);
        assert!(!copy.notes.contains(&ConnectionStringNote::PasswordLeftOut));
        assert!(
            copy.text
                .expose()
                .contains("Password=\"p;w=\"\"x'\";SSL Mode")
        );
        let without = build(
            def.engine.dialect(),
            &def,
            ConnectionStringFlavor::AdoNet,
            None,
        );
        assert!(!without.includes_password);
        assert!(
            without
                .notes
                .contains(&ConnectionStringNote::PasswordLeftOut)
        );
        // The Debug form of the copy never shows the text.
        assert!(!format!("{copy:?}").contains("p;w"));
    }

    #[test]
    fn what_it_writes_the_parser_reads_back() {
        for engine in [Engine::Postgres, Engine::Mssql, Engine::Mysql] {
            let mut def = definition(engine);
            def.tls_mode = TlsMode::Require;
            def.username = "o'neil;x".into();
            let secret = Secret::new("a=b;\"c\"");
            let copy = build(
                engine.dialect(),
                &def,
                ConnectionStringFlavor::AdoNet,
                Some(&secret),
            );
            let parsed = connstring::parse(copy.text.expose(), Some(engine)).expect("parses");
            assert_eq!(
                parsed.fields.host.as_deref(),
                Some("db.example.com"),
                "{engine:?}"
            );
            assert_eq!(parsed.fields.port, Some(6543), "{engine:?}");
            assert_eq!(
                parsed.fields.database.as_deref(),
                Some("shop"),
                "{engine:?}"
            );
            assert_eq!(
                parsed.fields.username.as_deref(),
                Some("o'neil;x"),
                "{engine:?}"
            );
            assert_eq!(parsed.fields.tls_mode, Some(TlsMode::Require), "{engine:?}");
            assert_eq!(
                parsed.password.as_ref().map(Secret::expose),
                Some("a=b;\"c\""),
                "{engine:?}"
            );
        }
    }

    #[test]
    fn maps_tls_modes_and_ca_files() {
        let mut pg = definition(Engine::Postgres);
        pg.tls_mode = TlsMode::Require;
        assert!(
            text(&pg, ConnectionStringFlavor::AdoNet)
                .ends_with("SSL Mode=Require;Trust Server Certificate=true")
        );
        pg.ca_cert_path = Some("/etc/ca.pem".into());
        assert!(
            text(&pg, ConnectionStringFlavor::AdoNet)
                .ends_with("SSL Mode=VerifyCA;Root Certificate=/etc/ca.pem")
        );
        pg.tls_mode = TlsMode::Disable;
        assert!(text(&pg, ConnectionStringFlavor::AdoNet).ends_with("SSL Mode=Disable"));

        let mut my = definition(Engine::Mysql);
        my.tls_mode = TlsMode::Prefer;
        assert!(text(&my, ConnectionStringFlavor::AdoNet).ends_with("SSL Mode=Preferred"));
        my.tls_mode = TlsMode::Require;
        my.ca_cert_path = Some("/etc/ca.pem".into());
        assert!(
            text(&my, ConnectionStringFlavor::AdoNet)
                .ends_with("SSL Mode=VerifyCA;SSL CA=/etc/ca.pem")
        );

        let mut ms = definition(Engine::Mssql);
        ms.tls_mode = TlsMode::Disable;
        ms.ca_cert_path = Some("/etc/ca.pem".into());
        let copy = build(
            ms.engine.dialect(),
            &ms,
            ConnectionStringFlavor::AdoNet,
            None,
        );
        assert!(copy.text.expose().ends_with("Encrypt=False"));
        assert!(
            copy.notes
                .contains(&ConnectionStringNote::CertificateNotExpressed)
        );
    }

    #[test]
    fn notes_what_a_string_cannot_say() {
        let mut def = definition(Engine::Mysql);
        def.read_only = true;
        def.options = vec![ConnectionOption {
            key: "init_command".into(),
            value: "SET x=1".into(),
        }];
        def.ssh = Some(SshTunnel {
            server: SshHop {
                host: "bastion".into(),
                port: None,
                username: "me".into(),
                auth: SshAuthMethod::Agent,
                key_path: None,
                remember_secret: false,
            },
            jump: None,
            keepalive_secs: None,
        });
        let copy = build(
            def.engine.dialect(),
            &def,
            ConnectionStringFlavor::AdoNet,
            None,
        );
        assert_eq!(
            copy.notes,
            vec![
                ConnectionStringNote::SshTunnel,
                ConnectionStringNote::OptionsNotExpressed,
                ConnectionStringNote::ReadOnlyNotExpressed,
                ConnectionStringNote::PasswordLeftOut,
            ]
        );
        // PostgreSQL and SQLite can say it.
        let mut pg = definition(Engine::Postgres);
        pg.read_only = true;
        let copy = build(
            pg.engine.dialect(),
            &pg,
            ConnectionStringFlavor::AdoNet,
            None,
        );
        assert!(
            copy.text
                .expose()
                .contains("Options=\"-c default_transaction_read_only=on\"")
        );
        assert!(
            !copy
                .notes
                .contains(&ConnectionStringNote::ReadOnlyNotExpressed)
        );
    }

    #[test]
    fn efcore_wraps_the_string_in_the_provider_call() {
        let mut def = definition(Engine::Postgres);
        def.database = "sh\"op".into();
        let pg = text(&def, ConnectionStringFlavor::EfCore);
        assert_eq!(
            pg,
            "var connectionString = \"Host=db.example.com;Port=6543;Database='sh\\\"op';Username=app;SSL Mode=VerifyFull\";\noptions.UseNpgsql(connectionString);"
        );
        let ms = text(&definition(Engine::Mssql), ConnectionStringFlavor::EfCore);
        assert!(ms.ends_with("options.UseSqlServer(connectionString);"));
        let my = text(&definition(Engine::Mysql), ConnectionStringFlavor::EfCore);
        assert!(my.ends_with(
            "options.UseMySql(connectionString, ServerVersion.AutoDetect(connectionString));"
        ));
        let mut lite = definition(Engine::Sqlite);
        lite.file_path = "C:\\data\\app.db".into();
        let sqlite = text(&lite, ConnectionStringFlavor::EfCore);
        assert!(sqlite.starts_with("var connectionString = \"Data Source=C:\\\\data\\\\app.db\";"));
        assert!(sqlite.ends_with("options.UseSqlite(connectionString);"));
    }

    #[test]
    fn quotes_values_the_way_the_providers_do() {
        assert_eq!(ado_value("plain"), "plain");
        assert_eq!(ado_value(" lead"), "\" lead\"");
        assert_eq!(ado_value("a;b"), "\"a;b\"");
        assert_eq!(ado_value("say \"hi\""), "'say \"hi\"'");
        assert_eq!(ado_value("both ' and \""), "\"both ' and \"\"\"");
        assert_eq!(
            csharp_string("tab\there \\ \"q\""),
            "\"tab\\there \\\\ \\\"q\\\"\""
        );
    }
}
