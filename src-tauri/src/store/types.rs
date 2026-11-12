use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::config::ConnectionDefinition;
use crate::db::engine::EngineFamily;

/// A connection as saved in the app database. Never contains a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    /// UUID; also the keychain account prefix.
    pub id: String,
    pub definition: ConnectionDefinition,
    /// The family of the definition's engine, so the front picks the query tab, explorer and
    /// toolbar of the connection without waiting for the engine list. Derived, not stored.
    pub family: EngineFamily,
    /// Order inside its group, from 0.
    pub position: u32,
    /// Unix time in seconds.
    pub created_at: u32,
    pub updated_at: u32,
    pub last_connected_at: Option<u32>,
}

/// A folder of connections; groups can nest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    /// Order among its siblings, from 0.
    pub position: u32,
    /// Folded in the sidebar.
    pub collapsed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Locale {
    En,
    Fr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Density {
    Comfortable,
    Compact,
}

/// Bounds of the preferences the backend itself applies (F-125).
pub const HISTORY_ENTRIES_RANGE: (u32, u32) = (100, 1_000_000);
pub const HISTORY_AGE_DAYS_RANGE: (u32, u32) = (1, 3650);
pub const CONNECT_TIMEOUT_RANGE: (u32, u32) = (1, 600);
pub const JOURNAL_ENTRIES_RANGE: (u32, u32) = (10, 100_000);
pub const JOURNAL_AGE_DAYS_RANGE: (u32, u32) = (1, 3650);

/// App preferences (F-125). The settings only the frontend reads live in `ui_state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: ThemePreference,
    /// `null`: follow the OS language.
    pub locale: Option<Locale>,
    pub density: Density,
    /// Opaque JSON owned by the frontend (panel sizes, collapsed sections…), at most 64 KiB.
    pub ui_state: Option<String>,
    /// Record the statements that are run in the history; a connection can still opt out.
    pub history_enabled: bool,
    /// History bound: most entries kept.
    pub history_max_entries: u32,
    /// History bound: oldest entry kept, in days.
    pub history_max_age_days: u32,
    /// Connect timeout of the connections that do not set their own, in seconds.
    pub connect_timeout_secs: u32,
    /// Change journal bound (F-090): most change sets kept.
    pub journal_max_entries: u32,
    /// Change journal bound: oldest change set kept, in days.
    pub journal_max_age_days: u32,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            locale: None,
            density: Density::Comfortable,
            ui_state: None,
            history_enabled: true,
            history_max_entries: 50_000,
            history_max_age_days: 365,
            connect_timeout_secs: 15,
            journal_max_entries: 1_000,
            journal_max_age_days: 90,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TabKind {
    /// SQL editor.
    Query,
    /// Data of one table.
    Table,
}

/// Editor selection, as character offsets into the content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CursorPosition {
    pub anchor: u32,
    pub head: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TableRef {
    pub schema: Option<String>,
    pub name: String,
}

/// An open tab, saved so it survives a restart (F-044).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    pub id: String,
    pub kind: TabKind,
    pub title: String,
    /// `null` when the connection was deleted, or for a tab not bound yet.
    pub connection_id: Option<String>,
    pub database: Option<String>,
    /// Editor text (empty for table tabs).
    pub content: String,
    pub cursor: Option<CursorPosition>,
    pub pinned: bool,
    /// The `.sql` file the editor is bound to (F-045).
    pub file_path: Option<String>,
    /// The table of a table tab.
    pub table: Option<TableRef>,
    /// Opaque JSON owned by the frontend (scroll, panel sizes…).
    pub ui_state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TabsState {
    /// In display order.
    pub tabs: Vec<SavedTab>,
    pub active_tab_id: Option<String>,
}
