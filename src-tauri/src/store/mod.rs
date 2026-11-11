//! Local SQLite store in the OS config folder: connections (without secrets), groups, tabs,
//! preferences (SPEC §8). History, saved queries and the change journal arrive with M1/M3.

mod history;
mod known_hosts;
mod library_io;
mod migrations;
mod pins;
mod saved_queries;
mod types;

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::db::config::{
    AuthMethod, ConnectionDefinition, ConnectionOption, Environment, EnvironmentKind, TlsMode,
};
use crate::db::dialect::Engine;
use crate::db::errors::YadbeError;
pub use history::*;
pub use library_io::ImportReport;
pub use saved_queries::*;
pub use types::*;

/// File name of the database inside the app config folder.
pub const DB_FILE: &str = "yadbe.db";
pub const MAX_GROUP_NAME_CHARS: usize = 60;
pub const MAX_UI_STATE_BYTES: usize = 64 * 1024;
pub const MAX_TAB_CONTENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TABS: usize = 200;

const PREF_THEME: &str = "theme";
const PREF_LOCALE: &str = "locale";
const PREF_DENSITY: &str = "density";
const PREF_UI_STATE: &str = "ui_state";
const PREF_HISTORY_ENABLED: &str = "history_enabled";
const PREF_HISTORY_MAX_ENTRIES: &str = "history_max_entries";
const PREF_HISTORY_MAX_AGE_DAYS: &str = "history_max_age_days";
const PREF_CONNECT_TIMEOUT_SECS: &str = "connect_timeout_secs";
const META_ACTIVE_TAB: &str = "active_tab";

const CONNECTION_COLUMNS: &str = "id, name, engine, group_id, position, host, port, database_name, \
     username, file_path, auth, tls_mode, ca_cert_path, connect_timeout_secs, options, \
     environment, environment_label, environment_color, favorite, read_only, remember_password, \
     created_at, updated_at, last_connected_at, history_enabled, ssh_tunnel";

/// Thread-safe handle on the app database. Queries are small: one connection behind a
/// mutex is enough.
pub struct Store {
    conn: Mutex<Connection>,
}

fn now() -> u32 {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    u32::try_from(secs).unwrap_or(u32::MAX)
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn corrupt(what: &str, value: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        format!("unexpected {what} `{value}` in the store").into(),
    )
}

fn row_to_connection(row: &Row<'_>) -> rusqlite::Result<SavedConnection> {
    let engine: String = row.get("engine")?;
    let auth: String = row.get("auth")?;
    let tls: String = row.get("tls_mode")?;
    let environment: String = row.get("environment")?;
    let options: String = row.get("options")?;
    let options: Vec<(String, String)> =
        serde_json::from_str(&options).map_err(|_| corrupt("options", &options))?;
    let ssh: Option<String> = row.get("ssh_tunnel")?;
    let ssh = ssh
        .map(|json| serde_json::from_str(&json).map_err(|_| corrupt("SSH tunnel", &json)))
        .transpose()?;
    Ok(SavedConnection {
        id: row.get("id")?,
        definition: ConnectionDefinition {
            name: row.get("name")?,
            engine: Engine::from_id(&engine).ok_or_else(|| corrupt("engine", &engine))?,
            host: row.get("host")?,
            port: row.get("port")?,
            database: row.get("database_name")?,
            username: row.get("username")?,
            file_path: row.get("file_path")?,
            auth: AuthMethod::from_id(&auth).ok_or_else(|| corrupt("auth", &auth))?,
            tls_mode: TlsMode::from_id(&tls).ok_or_else(|| corrupt("TLS mode", &tls))?,
            ca_cert_path: row.get("ca_cert_path")?,
            connect_timeout_secs: row.get("connect_timeout_secs")?,
            options: options
                .into_iter()
                .map(|(key, value)| ConnectionOption { key, value })
                .collect(),
            group_id: row.get("group_id")?,
            environment: Environment {
                kind: EnvironmentKind::from_id(&environment)
                    .ok_or_else(|| corrupt("environment", &environment))?,
                label: row.get("environment_label")?,
                color: row.get("environment_color")?,
            },
            favorite: row.get("favorite")?,
            read_only: row.get("read_only")?,
            remember_password: row.get("remember_password")?,
            history_enabled: row.get("history_enabled")?,
            ssh,
        },
        position: row.get("position")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        last_connected_at: row.get("last_connected_at")?,
    })
}

fn ssh_json(definition: &ConnectionDefinition) -> Result<Option<String>, YadbeError> {
    Ok(definition
        .ssh
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?)
}

fn row_to_group(row: &Row<'_>) -> rusqlite::Result<ConnectionGroup> {
    Ok(ConnectionGroup {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        position: row.get(3)?,
        collapsed: row.get(4)?,
    })
}

fn options_json(options: &[ConnectionOption]) -> Result<String, YadbeError> {
    let pairs: Vec<(&str, &str)> = options
        .iter()
        .map(|o| (o.key.as_str(), o.value.as_str()))
        .collect();
    Ok(serde_json::to_string(&pairs)?)
}

fn validate_group_name(name: &str) -> Result<String, YadbeError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(YadbeError::invalid_argument(
            "A group needs a name.",
            "Un groupe doit avoir un nom.",
        ));
    }
    if name.chars().count() > MAX_GROUP_NAME_CHARS {
        return Err(YadbeError::invalid_argument(
            format!("A group name has at most {MAX_GROUP_NAME_CHARS} characters."),
            format!("Un nom de groupe compte au plus {MAX_GROUP_NAME_CHARS} caractères."),
        ));
    }
    Ok(name.to_owned())
}

fn check_ui_state(ui_state: Option<&String>) -> Result<(), YadbeError> {
    if ui_state.is_some_and(|s| s.len() > MAX_UI_STATE_BYTES) {
        return Err(YadbeError::invalid_argument(
            "The UI state is too large.",
            "L'état de l'interface est trop volumineux.",
        ));
    }
    Ok(())
}

fn check_range(value: u32, (min, max): (u32, u32), en: &str, fr: &str) -> Result<(), YadbeError> {
    if (min..=max).contains(&value) {
        return Ok(());
    }
    Err(YadbeError::invalid_argument(
        format!("{en} must be between {min} and {max}."),
        format!("{fr} : valeur attendue entre {min} et {max}."),
    ))
}

/// Inserts `id` at `position` among `siblings` (ordered, `id` excluded) and returns the new
/// order.
fn reordered(mut siblings: Vec<String>, id: &str, position: u32) -> Vec<String> {
    let index = usize::try_from(position)
        .unwrap_or(usize::MAX)
        .min(siblings.len());
    siblings.insert(index, id.to_owned());
    siblings
}

impl Store {
    /// Opens (or creates) the database at `path` and applies pending migrations.
    pub fn open(path: &Path) -> Result<Self, YadbeError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                YadbeError::storage(format!("cannot create {}: {e}", parent.display()))
            })?;
        }
        Self::init(Connection::open(path)?)
    }

    /// In-memory database, for tests and as a fallback when the file cannot be opened.
    pub fn open_in_memory() -> Result<Self, YadbeError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self, YadbeError> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(2))?;
        migrations::apply(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // SQLite keeps the database consistent even if a thread panicked mid-call.
        self.conn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn schema_version(&self) -> Result<i64, YadbeError> {
        Ok(self
            .conn()
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    pub fn latest_schema_version() -> i64 {
        migrations::latest_version()
    }

    // ---- Connections -------------------------------------------------------------------

    /// Every connection, by group then position.
    pub fn list_connections(&self) -> Result<Vec<SavedConnection>, YadbeError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {CONNECTION_COLUMNS} FROM connections
             ORDER BY group_id IS NOT NULL, group_id, position, name"
        ))?;
        let rows = stmt
            .query_map([], row_to_connection)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn connection(&self, id: &str) -> Result<SavedConnection, YadbeError> {
        let conn = self.conn();
        conn.query_row(
            &format!("SELECT {CONNECTION_COLUMNS} FROM connections WHERE id = ?1"),
            [id],
            row_to_connection,
        )
        .optional()?
        .ok_or_else(|| YadbeError::connection_not_found(id))
    }

    fn check_group(conn: &Connection, group_id: Option<&String>) -> Result<(), YadbeError> {
        if let Some(group_id) = group_id {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM connection_groups WHERE id = ?1)",
                [group_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(YadbeError::group_not_found(group_id));
            }
        }
        Ok(())
    }

    fn next_connection_position(
        conn: &Connection,
        group_id: Option<&String>,
    ) -> Result<u32, YadbeError> {
        Ok(conn.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM connections WHERE group_id IS ?1",
            [group_id],
            |row| row.get(0),
        )?)
    }

    /// Saves a new connection at the end of its group. The definition must be normalized.
    pub fn create_connection(
        &self,
        definition: &ConnectionDefinition,
    ) -> Result<SavedConnection, YadbeError> {
        let id = new_id();
        {
            let conn = self.conn();
            Self::check_group(&conn, definition.group_id.as_ref())?;
            let position = Self::next_connection_position(&conn, definition.group_id.as_ref())?;
            let at = now();
            conn.execute(
                &format!(
                    "INSERT INTO connections ({CONNECTION_COLUMNS}) VALUES
                     (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                      ?17, ?18, ?19, ?20, ?21, ?22, ?22, NULL, ?23, ?24)"
                ),
                params![
                    id,
                    definition.name,
                    definition.engine.id(),
                    definition.group_id,
                    position,
                    definition.host,
                    definition.port,
                    definition.database,
                    definition.username,
                    definition.file_path,
                    definition.auth.id(),
                    definition.tls_mode.id(),
                    definition.ca_cert_path,
                    definition.connect_timeout_secs,
                    options_json(&definition.options)?,
                    definition.environment.kind.id(),
                    definition.environment.label,
                    definition.environment.color,
                    definition.favorite,
                    definition.read_only,
                    definition.remember_password,
                    at,
                    definition.history_enabled,
                    ssh_json(definition)?,
                ],
            )?;
        }
        self.connection(&id)
    }

    /// Replaces a connection's definition; moving it to another group puts it last there.
    pub fn update_connection(
        &self,
        id: &str,
        definition: &ConnectionDefinition,
    ) -> Result<SavedConnection, YadbeError> {
        let current = self.connection(id)?;
        {
            let conn = self.conn();
            Self::check_group(&conn, definition.group_id.as_ref())?;
            let position = if current.definition.group_id == definition.group_id {
                current.position
            } else {
                Self::next_connection_position(&conn, definition.group_id.as_ref())?
            };
            conn.execute(
                "UPDATE connections SET name = ?2, engine = ?3, group_id = ?4, position = ?5,
                    host = ?6, port = ?7, database_name = ?8, username = ?9, file_path = ?10,
                    auth = ?11, tls_mode = ?12, ca_cert_path = ?13, connect_timeout_secs = ?14,
                    options = ?15, environment = ?16, environment_label = ?17,
                    environment_color = ?18, favorite = ?19, read_only = ?20,
                    remember_password = ?21, updated_at = ?22, history_enabled = ?23,
                    ssh_tunnel = ?24
                 WHERE id = ?1",
                params![
                    id,
                    definition.name,
                    definition.engine.id(),
                    definition.group_id,
                    position,
                    definition.host,
                    definition.port,
                    definition.database,
                    definition.username,
                    definition.file_path,
                    definition.auth.id(),
                    definition.tls_mode.id(),
                    definition.ca_cert_path,
                    definition.connect_timeout_secs,
                    options_json(&definition.options)?,
                    definition.environment.kind.id(),
                    definition.environment.label,
                    definition.environment.color,
                    definition.favorite,
                    definition.read_only,
                    definition.remember_password,
                    now(),
                    definition.history_enabled,
                    ssh_json(definition)?,
                ],
            )?;
        }
        self.connection(id)
    }

    pub fn delete_connection(&self, id: &str) -> Result<(), YadbeError> {
        let changed = self
            .conn()
            .execute("DELETE FROM connections WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(YadbeError::connection_not_found(id));
        }
        Ok(())
    }

    /// Moves a connection into `group_id` (`None`: top level) at `position` (clamped).
    pub fn move_connection(
        &self,
        id: &str,
        group_id: Option<&String>,
        position: u32,
    ) -> Result<(), YadbeError> {
        self.connection(id)?;
        let mut conn = self.conn();
        Self::check_group(&conn, group_id)?;
        let tx = conn.transaction()?;
        let siblings: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM connections WHERE group_id IS ?1 AND id <> ?2
                 ORDER BY position, name",
            )?;
            stmt.query_map(params![group_id, id], |row| row.get(0))?
                .collect::<Result<_, _>>()?
        };
        tx.execute(
            "UPDATE connections SET group_id = ?2 WHERE id = ?1",
            params![id, group_id],
        )?;
        for (index, sibling) in (0_i64..).zip(reordered(siblings, id, position)) {
            tx.execute(
                "UPDATE connections SET position = ?2 WHERE id = ?1",
                params![sibling, index],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn touch_connection(&self, id: &str) -> Result<(), YadbeError> {
        self.conn().execute(
            "UPDATE connections SET last_connected_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    // ---- Groups ------------------------------------------------------------------------

    pub fn list_groups(&self) -> Result<Vec<ConnectionGroup>, YadbeError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, parent_id, position, collapsed FROM connection_groups
             ORDER BY parent_id IS NOT NULL, parent_id, position, name",
        )?;
        let rows = stmt
            .query_map([], row_to_group)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn group(&self, id: &str) -> Result<ConnectionGroup, YadbeError> {
        self.conn()
            .query_row(
                "SELECT id, name, parent_id, position, collapsed FROM connection_groups
                 WHERE id = ?1",
                [id],
                row_to_group,
            )
            .optional()?
            .ok_or_else(|| YadbeError::group_not_found(id))
    }

    pub fn create_group(
        &self,
        name: &str,
        parent_id: Option<&String>,
    ) -> Result<ConnectionGroup, YadbeError> {
        let name = validate_group_name(name)?;
        let id = new_id();
        {
            let conn = self.conn();
            Self::check_group(&conn, parent_id)?;
            let position: u32 = conn.query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM connection_groups
                 WHERE parent_id IS ?1",
                [parent_id],
                |row| row.get(0),
            )?;
            conn.execute(
                "INSERT INTO connection_groups (id, name, parent_id, position)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, name, parent_id, position],
            )?;
        }
        self.group(&id)
    }

    pub fn rename_group(&self, id: &str, name: &str) -> Result<ConnectionGroup, YadbeError> {
        let name = validate_group_name(name)?;
        let changed = self.conn().execute(
            "UPDATE connection_groups SET name = ?2 WHERE id = ?1",
            params![id, name],
        )?;
        if changed == 0 {
            return Err(YadbeError::group_not_found(id));
        }
        self.group(id)
    }

    pub fn set_group_collapsed(&self, id: &str, collapsed: bool) -> Result<(), YadbeError> {
        let changed = self.conn().execute(
            "UPDATE connection_groups SET collapsed = ?2 WHERE id = ?1",
            params![id, collapsed],
        )?;
        if changed == 0 {
            return Err(YadbeError::group_not_found(id));
        }
        Ok(())
    }

    /// Moves a group under `parent_id` (`None`: top level) at `position`; a group cannot
    /// move into itself or one of its descendants.
    pub fn move_group(
        &self,
        id: &str,
        parent_id: Option<&String>,
        position: u32,
    ) -> Result<(), YadbeError> {
        self.group(id)?;
        let mut conn = self.conn();
        Self::check_group(&conn, parent_id)?;
        if let Some(parent) = parent_id {
            let cycle: bool = conn.query_row(
                "WITH RECURSIVE up(id, parent_id) AS (
                    SELECT id, parent_id FROM connection_groups WHERE id = ?1
                    UNION ALL
                    SELECT g.id, g.parent_id FROM connection_groups g JOIN up ON g.id = up.parent_id
                 ) SELECT EXISTS(SELECT 1 FROM up WHERE id = ?2)",
                params![parent, id],
                |row| row.get(0),
            )?;
            if cycle {
                return Err(YadbeError::invalid_argument(
                    "A group cannot move into itself.",
                    "Un groupe ne peut pas être déplacé dans lui-même.",
                ));
            }
        }
        let tx = conn.transaction()?;
        let siblings: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM connection_groups WHERE parent_id IS ?1 AND id <> ?2
                 ORDER BY position, name",
            )?;
            stmt.query_map(params![parent_id, id], |row| row.get(0))?
                .collect::<Result<_, _>>()?
        };
        tx.execute(
            "UPDATE connection_groups SET parent_id = ?2 WHERE id = ?1",
            params![id, parent_id],
        )?;
        for (index, sibling) in (0_i64..).zip(reordered(siblings, id, position)) {
            tx.execute(
                "UPDATE connection_groups SET position = ?2 WHERE id = ?1",
                params![sibling, index],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Deletes a group; its subgroups and connections move to its parent, after the
    /// parent's own children.
    pub fn delete_group(&self, id: &str) -> Result<(), YadbeError> {
        let group = self.group(id)?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let parent = group.parent_id.as_ref();
        let group_base: u32 = tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM connection_groups WHERE parent_id IS ?1",
            [parent],
            |row| row.get(0),
        )?;
        tx.execute(
            "UPDATE connection_groups SET parent_id = ?2, position = position + ?3
             WHERE parent_id = ?1",
            params![id, parent, group_base],
        )?;
        let connection_base: u32 = tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM connections WHERE group_id IS ?1",
            [parent],
            |row| row.get(0),
        )?;
        tx.execute(
            "UPDATE connections SET group_id = ?2, position = position + ?3 WHERE group_id = ?1",
            params![id, parent, connection_base],
        )?;
        tx.execute("DELETE FROM connection_groups WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    // ---- Preferences -------------------------------------------------------------------

    fn pref(conn: &Connection, key: &str) -> Result<Option<String>, YadbeError> {
        Ok(conn
            .query_row(
                "SELECT value FROM preferences WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// A numeric preference; missing, unreadable or out-of-range values fall back to `default`.
    fn pref_number(
        conn: &Connection,
        key: &str,
        (min, max): (u32, u32),
        default: u32,
    ) -> Result<u32, YadbeError> {
        Ok(Self::pref(conn, key)?
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|v| (min..=max).contains(v))
            .unwrap_or(default))
    }

    /// Preferences; unknown or missing values fall back to the defaults.
    pub fn preferences(&self) -> Result<Preferences, YadbeError> {
        let conn = self.conn();
        let defaults = Preferences::default();
        let parse = |key: &str| -> Result<Option<String>, YadbeError> {
            Ok(Self::pref(&conn, key)?.map(|v| format!("\"{v}\"")))
        };
        Ok(Preferences {
            theme: parse(PREF_THEME)?
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or(defaults.theme),
            locale: parse(PREF_LOCALE)?.and_then(|v| serde_json::from_str(&v).ok()),
            density: parse(PREF_DENSITY)?
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or(defaults.density),
            ui_state: Self::pref(&conn, PREF_UI_STATE)?,
            history_enabled: Self::pref(&conn, PREF_HISTORY_ENABLED)?
                .and_then(|v| v.parse().ok())
                .unwrap_or(defaults.history_enabled),
            history_max_entries: Self::pref_number(
                &conn,
                PREF_HISTORY_MAX_ENTRIES,
                HISTORY_ENTRIES_RANGE,
                defaults.history_max_entries,
            )?,
            history_max_age_days: Self::pref_number(
                &conn,
                PREF_HISTORY_MAX_AGE_DAYS,
                HISTORY_AGE_DAYS_RANGE,
                defaults.history_max_age_days,
            )?,
            connect_timeout_secs: Self::pref_number(
                &conn,
                PREF_CONNECT_TIMEOUT_SECS,
                CONNECT_TIMEOUT_RANGE,
                defaults.connect_timeout_secs,
            )?,
        })
    }

    pub fn set_preferences(&self, preferences: &Preferences) -> Result<Preferences, YadbeError> {
        check_ui_state(preferences.ui_state.as_ref())?;
        check_range(
            preferences.history_max_entries,
            HISTORY_ENTRIES_RANGE,
            "The history size",
            "La taille de l'historique",
        )?;
        check_range(
            preferences.history_max_age_days,
            HISTORY_AGE_DAYS_RANGE,
            "The history age",
            "L'âge de l'historique",
        )?;
        check_range(
            preferences.connect_timeout_secs,
            CONNECT_TIMEOUT_RANGE,
            "The connect timeout",
            "Le délai de connexion",
        )?;
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let set = |key: &str, value: Option<String>| -> Result<(), YadbeError> {
                match value {
                    Some(value) => tx.execute(
                        "INSERT INTO preferences (key, value) VALUES (?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![key, value],
                    )?,
                    None => tx.execute("DELETE FROM preferences WHERE key = ?1", [key])?,
                };
                Ok(())
            };
            set(PREF_THEME, Some(enum_text(&preferences.theme)?))?;
            set(
                PREF_LOCALE,
                preferences.locale.as_ref().map(enum_text).transpose()?,
            )?;
            set(PREF_DENSITY, Some(enum_text(&preferences.density)?))?;
            set(PREF_UI_STATE, preferences.ui_state.clone())?;
            set(
                PREF_HISTORY_ENABLED,
                Some(preferences.history_enabled.to_string()),
            )?;
            set(
                PREF_HISTORY_MAX_ENTRIES,
                Some(preferences.history_max_entries.to_string()),
            )?;
            set(
                PREF_HISTORY_MAX_AGE_DAYS,
                Some(preferences.history_max_age_days.to_string()),
            )?;
            set(
                PREF_CONNECT_TIMEOUT_SECS,
                Some(preferences.connect_timeout_secs.to_string()),
            )?;
            tx.commit()?;
        }
        self.preferences()
    }

    // ---- Tabs --------------------------------------------------------------------------

    pub fn tabs(&self) -> Result<TabsState, YadbeError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, kind, title, connection_id, database_name, content, cursor_anchor,
                    cursor_head, pinned, file_path, table_schema, table_name, ui_state
             FROM tabs ORDER BY position",
        )?;
        let tabs = stmt
            .query_map([], |row| {
                let kind: String = row.get(1)?;
                let anchor: Option<u32> = row.get(6)?;
                let head: Option<u32> = row.get(7)?;
                let table_schema: Option<String> = row.get(10)?;
                let table_name: Option<String> = row.get(11)?;
                Ok(SavedTab {
                    id: row.get(0)?,
                    kind: match kind.as_str() {
                        "query" => TabKind::Query,
                        "table" => TabKind::Table,
                        other => return Err(corrupt("tab kind", other)),
                    },
                    title: row.get(2)?,
                    connection_id: row.get(3)?,
                    database: row.get(4)?,
                    content: row.get(5)?,
                    cursor: anchor
                        .zip(head)
                        .map(|(anchor, head)| CursorPosition { anchor, head }),
                    pinned: row.get(8)?,
                    file_path: row.get(9)?,
                    table: table_name.map(|name| TableRef {
                        schema: table_schema,
                        name,
                    }),
                    ui_state: row.get(12)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let active_tab_id = conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [META_ACTIVE_TAB],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .filter(|id| tabs.iter().any(|t| &t.id == id));
        Ok(TabsState {
            tabs,
            active_tab_id,
        })
    }

    /// Replaces the saved tabs. A tab bound to a deleted connection is kept, unbound.
    pub fn save_tabs(&self, state: &TabsState) -> Result<(), YadbeError> {
        if state.tabs.len() > MAX_TABS {
            return Err(YadbeError::invalid_argument(
                format!("At most {MAX_TABS} tabs can be saved."),
                format!("Au plus {MAX_TABS} onglets peuvent être enregistrés."),
            ));
        }
        for tab in &state.tabs {
            if tab.content.len() > MAX_TAB_CONTENT_BYTES {
                return Err(YadbeError::invalid_argument(
                    "A tab is too large to be saved (8 MB at most).",
                    "Un onglet est trop volumineux pour être enregistré (8 Mo au plus).",
                ));
            }
            check_ui_state(tab.ui_state.as_ref())?;
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM tabs", [])?;
        for (position, tab) in (0_i64..).zip(&state.tabs) {
            tx.execute(
                "INSERT INTO tabs (position, id, kind, title, connection_id, database_name,
                    content, cursor_anchor, cursor_head, pinned, file_path, table_schema,
                    table_name, ui_state)
                 VALUES (?1, ?2, ?3, ?4, (SELECT id FROM connections WHERE id = ?5), ?6, ?7,
                    ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    position,
                    tab.id,
                    match tab.kind {
                        TabKind::Query => "query",
                        TabKind::Table => "table",
                    },
                    tab.title,
                    tab.connection_id,
                    tab.database,
                    tab.content,
                    tab.cursor.map(|c| c.anchor),
                    tab.cursor.map(|c| c.head),
                    tab.pinned,
                    tab.file_path,
                    tab.table.as_ref().and_then(|t| t.schema.clone()),
                    tab.table.as_ref().map(|t| t.name.clone()),
                    tab.ui_state,
                ],
            )?;
        }
        match &state.active_tab_id {
            Some(id) => tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![META_ACTIVE_TAB, id],
            )?,
            None => tx.execute("DELETE FROM meta WHERE key = ?1", [META_ACTIVE_TAB])?,
        };
        tx.commit()?;
        Ok(())
    }
}

/// The serialized name of a unit enum variant (`"dark"` → `dark`).
fn enum_text<T: serde::Serialize>(value: &T) -> Result<String, YadbeError> {
    Ok(serde_json::to_string(value)?.trim_matches('"').to_owned())
}

#[cfg(test)]
mod history_tests;
#[cfg(test)]
mod saved_queries_tests;
#[cfg(test)]
mod tests;
