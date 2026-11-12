//! The engines yadbe knows and what each one is and can do, as data: its family, its label,
//! its capabilities and, for the SQL family, its dialect. Services and the frontend branch on
//! the family and the capabilities; they never `match` on the engine.
//!
//! Adding an engine: a variant here, its [`EngineProfile`] (one arm of [`Engine::profile`]),
//! its driver in `drivers::builtin()`, and its scheme in `connstring`. An engine outside the
//! SQL family has no dialect (`dialect: None`): the SQL services refuse it with `sqlOnly`.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::dialect::{Dialect, MssqlDialect, MysqlDialect, PostgresDialect, SqliteDialect};
use crate::db::meta::Qualifier;
use crate::db::params::ParameterStyles;

/// Database engines yadbe knows; drivers arrive one by one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    Postgres,
    Mssql,
    Mysql,
    Sqlite,
    Mongodb,
    /// Redis and Valkey (same protocol, same code).
    Redis,
}

/// What kind of database an engine is: it decides the connection's backend (the `Backend`
/// variant its driver returns), its query language, its explorer and its tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EngineFamily {
    /// Relational engines spoken to in SQL, through a [`Dialect`].
    Sql,
    /// Document stores (MongoDB).
    Document,
    /// Search engines (Elasticsearch, OpenSearch).
    Search,
    /// Key-value stores (Redis, Valkey).
    KeyValue,
}

/// What an engine supports, as data the services and the UI can branch on. Identifier
/// quoting, parameter styles, plans and the flags from `formatter` on describe SQL features:
/// the other families leave them off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// The engine's family: its query tab, explorer and connection fields.
    pub family: EngineFamily,
    /// The database is a local file (no host, port or user).
    pub uses_file: bool,
    /// Default TCP port, for server engines.
    pub default_port: Option<u16>,
    /// The engine supports TLS and the connection form shows the TLS settings.
    pub supports_tls: bool,
    /// The connection can present a TLS client certificate (F-009).
    pub client_certificate: bool,
    /// A server hosts several databases that can be listed and switched.
    pub multiple_databases: bool,
    /// Schemas exist between the database and its tables.
    pub schemas: bool,
    /// A running statement can be cancelled with a native mechanism.
    pub native_cancel: bool,
    /// The session can be put in read-only mode by the engine itself.
    pub read_only_session: bool,
    /// The character that opens a quoted identifier (`"`, `[` or a backtick).
    pub identifier_quote_open: char,
    /// The character that closes a quoted identifier; inside one it is written twice.
    pub identifier_quote_close: char,
    /// The engine reads an unquoted identifier in lower case (PostgreSQL), so a name with
    /// capitals needs its quotes to be found again.
    pub folds_unquoted_to_lower: bool,
    /// Placeholders read as query parameters (F-048).
    pub parameter_styles: ParameterStyles,
    /// The engine shows its plan for a statement without running it (F-053).
    pub explain: bool,
    /// The engine runs a statement and shows its plan with actual rows and times.
    pub explain_analyze: bool,
    /// The engine has sessions to watch: the activity monitor is offered (F-140).
    pub activity_monitor: bool,
    /// A running statement can be stopped while its session stays (`pg_cancel_backend`,
    /// `KILL QUERY`); otherwise only the whole session can be ended.
    pub activity_cancel_query: bool,
    /// What names a table besides its own name, in generated SQL and in the UI's labels:
    /// its schema, its database (MySQL), or nothing (SQLite).
    pub table_qualifier: Qualifier,
    /// The query editor formats its text (F-049).
    pub formatter: bool,
    /// Objects show their DDL and their properties (F-024, F-025).
    pub ddl: bool,
    /// Objects can be scripted as `SELECT` / `INSERT` / `CREATE`… (F-023).
    pub script_as: bool,
    /// Files can be imported into a table (F-091).
    pub data_import: bool,
    /// The EF Core migrations of a database can be listed (F-143).
    pub ef_migrations: bool,
    /// The connection can be copied as an ADO.NET / EF Core connection string (F-143).
    pub dotnet_connection_string: bool,
}

/// No placeholder at all; the start of an engine's own set.
const NO_PARAMETERS: ParameterStyles = ParameterStyles {
    colon: false,
    at: false,
    at_declared_are_variables: false,
    dollar_name: false,
    dollar_number: false,
    question: false,
    question_number: false,
};

/// Everything yadbe knows about an engine without connecting to it.
pub struct EngineProfile {
    /// Stable identifier, as stored in the app database.
    pub id: &'static str,
    /// Human-readable engine name (not translated: product names).
    pub label: &'static str,
    /// User name the connection form suggests.
    pub default_username: Option<&'static str>,
    pub capabilities: Capabilities,
    /// How yadbe writes SQL for it; `Some` exactly for the SQL family.
    pub dialect: Option<&'static dyn Dialect>,
}

static POSTGRES: EngineProfile = EngineProfile {
    id: "postgres",
    label: "PostgreSQL",
    default_username: Some("postgres"),
    capabilities: Capabilities {
        family: EngineFamily::Sql,
        uses_file: false,
        default_port: Some(5432),
        supports_tls: true,
        client_certificate: true,
        multiple_databases: true,
        schemas: true,
        native_cancel: true,
        read_only_session: true,
        identifier_quote_open: '"',
        identifier_quote_close: '"',
        folds_unquoted_to_lower: true,
        parameter_styles: ParameterStyles {
            colon: true,
            dollar_number: true,
            ..NO_PARAMETERS
        },
        explain: true,
        explain_analyze: true,
        activity_monitor: true,
        activity_cancel_query: true,
        table_qualifier: Qualifier::Schema,
        formatter: true,
        ddl: true,
        script_as: true,
        data_import: true,
        ef_migrations: true,
        dotnet_connection_string: true,
    },
    dialect: Some(&PostgresDialect),
};

static MSSQL: EngineProfile = EngineProfile {
    id: "mssql",
    label: "SQL Server",
    default_username: Some("sa"),
    capabilities: Capabilities {
        family: EngineFamily::Sql,
        uses_file: false,
        default_port: Some(1433),
        supports_tls: true,
        client_certificate: false,
        multiple_databases: true,
        schemas: true,
        native_cancel: true,
        read_only_session: false,
        identifier_quote_open: '[',
        identifier_quote_close: ']',
        folds_unquoted_to_lower: false,
        parameter_styles: ParameterStyles {
            at: true,
            at_declared_are_variables: true,
            ..NO_PARAMETERS
        },
        explain: true,
        explain_analyze: true,
        activity_monitor: true,
        activity_cancel_query: false,
        table_qualifier: Qualifier::Schema,
        formatter: true,
        ddl: true,
        script_as: true,
        data_import: true,
        ef_migrations: true,
        dotnet_connection_string: true,
    },
    dialect: Some(&MssqlDialect),
};

static MYSQL: EngineProfile = EngineProfile {
    id: "mysql",
    label: "MySQL / MariaDB",
    default_username: Some("root"),
    capabilities: Capabilities {
        family: EngineFamily::Sql,
        uses_file: false,
        default_port: Some(3306),
        supports_tls: true,
        client_certificate: true,
        multiple_databases: true,
        schemas: false,
        native_cancel: true,
        read_only_session: true,
        identifier_quote_open: '`',
        identifier_quote_close: '`',
        folds_unquoted_to_lower: false,
        parameter_styles: ParameterStyles {
            colon: true,
            question: true,
            ..NO_PARAMETERS
        },
        explain: true,
        explain_analyze: true,
        activity_monitor: true,
        activity_cancel_query: true,
        table_qualifier: Qualifier::Database,
        formatter: true,
        ddl: true,
        script_as: true,
        data_import: true,
        ef_migrations: true,
        dotnet_connection_string: true,
    },
    dialect: Some(&MysqlDialect),
};

static SQLITE: EngineProfile = EngineProfile {
    id: "sqlite",
    label: "SQLite",
    default_username: None,
    capabilities: Capabilities {
        family: EngineFamily::Sql,
        uses_file: true,
        default_port: None,
        supports_tls: false,
        client_certificate: false,
        multiple_databases: false,
        schemas: false,
        native_cancel: true,
        read_only_session: true,
        identifier_quote_open: '"',
        identifier_quote_close: '"',
        folds_unquoted_to_lower: false,
        parameter_styles: ParameterStyles {
            colon: true,
            at: true,
            dollar_name: true,
            question: true,
            question_number: true,
            ..NO_PARAMETERS
        },
        explain: true,
        explain_analyze: false,
        activity_monitor: false,
        activity_cancel_query: false,
        table_qualifier: Qualifier::None,
        formatter: true,
        ddl: true,
        script_as: true,
        data_import: true,
        ef_migrations: true,
        dotnet_connection_string: true,
    },
    dialect: Some(&SqliteDialect),
};

static MONGODB: EngineProfile = EngineProfile {
    id: "mongodb",
    label: "MongoDB",
    default_username: None,
    capabilities: Capabilities {
        family: EngineFamily::Document,
        uses_file: false,
        default_port: Some(27017),
        supports_tls: true,
        client_certificate: true,
        multiple_databases: true,
        schemas: false,
        // `killOp` on the operation.
        native_cancel: true,
        // Read-only is yadbe's command gate: the server has no read-only session.
        read_only_session: false,
        identifier_quote_open: '"',
        identifier_quote_close: '"',
        folds_unquoted_to_lower: false,
        parameter_styles: NO_PARAMETERS,
        explain: false,
        explain_analyze: false,
        activity_monitor: false,
        activity_cancel_query: false,
        table_qualifier: Qualifier::Database,
        formatter: false,
        ddl: false,
        script_as: false,
        data_import: false,
        ef_migrations: false,
        dotnet_connection_string: false,
    },
    dialect: None,
};

static REDIS: EngineProfile = EngineProfile {
    id: "redis",
    label: "Redis / Valkey",
    // The `default` user when none is given (ACL user otherwise).
    default_username: None,
    capabilities: Capabilities {
        family: EngineFamily::KeyValue,
        uses_file: false,
        default_port: Some(6379),
        supports_tls: true,
        client_certificate: true,
        // Numbered databases (`db0`…), listed from `INFO keyspace`.
        multiple_databases: true,
        schemas: false,
        // A running command cannot be stopped; key scans stop between batches.
        native_cancel: false,
        read_only_session: false,
        identifier_quote_open: '"',
        identifier_quote_close: '"',
        folds_unquoted_to_lower: false,
        parameter_styles: NO_PARAMETERS,
        explain: false,
        explain_analyze: false,
        activity_monitor: false,
        activity_cancel_query: false,
        table_qualifier: Qualifier::Database,
        formatter: false,
        ddl: false,
        script_as: false,
        data_import: false,
        ef_migrations: false,
        dotnet_connection_string: false,
    },
    dialect: None,
};

impl Engine {
    pub const ALL: [Engine; 6] = [
        Engine::Postgres,
        Engine::Mssql,
        Engine::Mysql,
        Engine::Sqlite,
        Engine::Mongodb,
        Engine::Redis,
    ];

    /// The one place that maps an engine to what it is.
    pub fn profile(self) -> &'static EngineProfile {
        match self {
            Engine::Postgres => &POSTGRES,
            Engine::Mssql => &MSSQL,
            Engine::Mysql => &MYSQL,
            Engine::Sqlite => &SQLITE,
            Engine::Mongodb => &MONGODB,
            Engine::Redis => &REDIS,
        }
    }

    /// Stable identifier, as stored in the app database.
    pub fn id(self) -> &'static str {
        self.profile().id
    }

    pub fn from_id(id: &str) -> Option<Engine> {
        Engine::ALL.into_iter().find(|engine| engine.id() == id)
    }

    pub fn family(self) -> EngineFamily {
        self.profile().capabilities.family
    }

    /// Human-readable engine name (not translated: product names).
    pub fn label(self) -> &'static str {
        self.profile().label
    }

    pub fn capabilities(self) -> Capabilities {
        self.profile().capabilities
    }

    /// The SQL dialect of an engine of the SQL family; `None` for the other families.
    pub fn sql_dialect(self) -> Option<&'static dyn Dialect> {
        self.profile().dialect
    }

    /// The engines of the SQL family with their dialects.
    pub fn sql_dialects() -> impl Iterator<Item = (Engine, &'static dyn Dialect)> {
        Engine::ALL
            .into_iter()
            .filter_map(|engine| engine.sql_dialect().map(|dialect| (engine, dialect)))
    }
}

#[cfg(test)]
impl Engine {
    /// The dialect of an engine the test knows to be SQL.
    pub fn dialect(self) -> &'static dyn Dialect {
        self.sql_dialect().expect("an engine of the SQL family")
    }
}

/// An engine as the connection form sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub engine: Engine,
    pub label: String,
    pub capabilities: Capabilities,
    pub default_username: Option<String>,
    /// A driver for this engine ships in this build; otherwise connecting fails with
    /// `engineNotSupported`.
    pub available: bool,
    /// Drop, truncate and rename per kind of object (F-026): the menus hide the rest.
    pub object_actions: Vec<crate::db::object_model::ObjectActionSupport>,
}

impl EngineInfo {
    pub fn of(engine: Engine, available: bool) -> Self {
        let profile = engine.profile();
        Self {
            engine,
            label: profile.label.to_owned(),
            capabilities: profile.capabilities,
            default_username: profile.default_username.map(str::to_owned),
            available,
            object_actions: profile
                .dialect
                .map(crate::db::object_ops::support_of)
                .unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip() {
        for engine in Engine::ALL {
            assert_eq!(Engine::from_id(engine.id()), Some(engine));
            let json = serde_json::to_value(engine).expect("serializes");
            assert_eq!(json, engine.id());
        }
    }

    #[test]
    fn the_sql_family_is_the_engines_with_a_dialect() {
        for engine in Engine::ALL {
            assert_eq!(
                engine.family() == EngineFamily::Sql,
                engine.sql_dialect().is_some(),
                "{engine:?}"
            );
            if let Some(dialect) = engine.sql_dialect() {
                assert_eq!(dialect.engine(), engine);
            }
        }
        let json = serde_json::to_value(EngineFamily::KeyValue).expect("serializes");
        assert_eq!(json, "keyValue");
    }

    #[test]
    fn the_table_qualifier_follows_the_namespaces() {
        for engine in Engine::ALL {
            let caps = engine.capabilities();
            let expected = if caps.schemas {
                Qualifier::Schema
            } else if caps.multiple_databases {
                Qualifier::Database
            } else {
                Qualifier::None
            };
            assert_eq!(caps.table_qualifier, expected, "{engine:?}");
        }
    }

    #[test]
    fn capabilities_describe_the_quoting_the_dialect_does() {
        for (engine, dialect) in Engine::sql_dialects() {
            let caps = engine.capabilities();
            assert_eq!(
                dialect.quote_identifier("x"),
                format!(
                    "{}x{}",
                    caps.identifier_quote_open, caps.identifier_quote_close
                ),
                "{engine:?}"
            );
        }
    }
}
