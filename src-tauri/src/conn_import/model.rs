//! IPC model of the connection import and export (M3-10, F-012): where connections can be
//! read from, what a scan found, and what an import created. No secret ever appears here.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::config::ConnectionDefinition;
use crate::store::SavedConnection;

/// A program or file connections can be imported from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionSourceKind {
    AzureDataStudio,
    /// The `mssql` extension of Visual Studio Code.
    VscodeMssql,
    /// SQL Server Management Studio's registered servers (`RegSrvr.xml`).
    Ssms,
    Dbeaver,
    /// PostgreSQL's password file: the only source whose passwords can be imported.
    Pgpass,
    PgService,
    /// A file written by yadbe's own export.
    Yadbe,
}

impl ConnectionSourceKind {
    pub const ALL: [ConnectionSourceKind; 7] = [
        ConnectionSourceKind::AzureDataStudio,
        ConnectionSourceKind::VscodeMssql,
        ConnectionSourceKind::Ssms,
        ConnectionSourceKind::Dbeaver,
        ConnectionSourceKind::Pgpass,
        ConnectionSourceKind::PgService,
        ConnectionSourceKind::Yadbe,
    ];

    /// Only a `.pgpass` holds passwords in the clear.
    pub fn supports_passwords(self) -> bool {
        self == ConnectionSourceKind::Pgpass
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSourceInfo {
    pub kind: ConnectionSourceKind,
    /// The file at its usual place on this computer, when it exists.
    pub default_path: Option<String>,
    pub supports_passwords: bool,
}

/// Something to know about a found connection before importing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionNoteKind {
    /// The source uses Windows integrated authentication, which yadbe does not support
    /// yet: the connection needs a SQL login.
    IntegratedAuth,
    /// The source signs in with Microsoft Entra ID, which yadbe does not support yet.
    EntraAuth,
    /// The source holds a password that was not imported (only `.pgpass` passwords are).
    PasswordNotImported,
    /// The user name is not in the source (DBeaver keeps it encrypted).
    UserMissing,
    /// An SSH tunnel is defined but cannot be recreated (no user, or a jump host).
    SshIncomplete,
    /// A setting of the source has no equivalent and was left out (`detail` says which).
    SettingIgnored,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionNote {
    pub kind: ConnectionNoteKind,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    /// A saved connection has the same engine, host, port, database and user (or file).
    SameTarget,
    /// A saved connection has the same name.
    SameName,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConflict {
    pub existing_id: String,
    pub existing_name: String,
    pub kind: ConflictKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FoundConnection {
    /// Identifies the connection in its file, for `import_connections`.
    pub key: String,
    /// Never carries a group id: see `group_path`.
    pub definition: ConnectionDefinition,
    /// The folders of the source, outermost first.
    pub group_path: Vec<String>,
    /// A password is available and `import_connections` can store it in the keychain.
    pub has_password: bool,
    pub conflict: Option<ConnectionConflict>,
    pub notes: Vec<ConnectionNote>,
}

/// Why an entry of a file is not offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    /// An engine yadbe does not support (`detail`: its name).
    UnsupportedEngine,
    /// A pattern (`*` host or user) rather than one connection.
    Wildcard,
    /// Not enough to connect (no host, no file…).
    Incomplete,
    /// The definition is not valid (`detail`).
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub name: String,
    pub reason: SkipReason,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionScan {
    pub kind: ConnectionSourceKind,
    /// The file that was read.
    pub path: String,
    pub connections: Vec<FoundConnection>,
    pub skipped: Vec<SkippedEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportConnectionsRequest {
    pub kind: ConnectionSourceKind,
    /// `null`: the source's default file.
    pub path: Option<String>,
    /// The `key`s of the found connections to import.
    pub keys: Vec<String>,
    /// Store the passwords the source holds (`.pgpass`) in the OS keychain.
    pub import_passwords: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionImportFailure {
    pub key: String,
    pub name: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionImportResult {
    pub created: Vec<SavedConnection>,
    pub groups_created: u32,
    /// Passwords now in the OS keychain.
    pub passwords_stored: u32,
    /// Passwords kept for this session only (no keychain on this computer).
    pub passwords_session_only: u32,
    pub failed: Vec<ConnectionImportFailure>,
}
