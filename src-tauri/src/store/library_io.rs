//! Export and import of the library as a JSON file (F-050). Scope is not exported: connection
//! ids mean nothing on another machine, so imported queries are global.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{NewSavedQuery, Store};
use crate::db::errors::YadbeError;

const FORMAT: &str = "yadbe-library";
const VERSION: u32 = 1;
const MAX_IMPORT_FOLDERS: usize = 2_000;
const MAX_IMPORT_QUERIES: usize = 20_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryFile {
    format: String,
    version: u32,
    folders: Vec<FileFolder>,
    queries: Vec<FileQuery>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileFolder {
    id: String,
    name: String,
    parent_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileQuery {
    name: String,
    sql: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    tags: Vec<String>,
    folder_id: Option<String>,
    snippet_trigger: Option<String>,
}

/// What an import added.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub folders: u32,
    pub queries: u32,
    /// Queries already in the library (same folder, name and text).
    pub skipped: u32,
}

fn unreadable(detail: impl std::fmt::Display) -> YadbeError {
    YadbeError::invalid_argument(
        format!("This file is not a yadbe library: {detail}."),
        format!("Ce fichier n'est pas une bibliothèque yadbe : {detail}."),
    )
}

impl Store {
    /// The whole library as the text of a JSON file.
    pub fn export_library(&self) -> Result<String, YadbeError> {
        let library = self.saved_query_library()?;
        let mut queries = Vec::with_capacity(library.queries.len());
        for summary in &library.queries {
            let Some(whole) = self.saved_query(&summary.id)? else {
                continue;
            };
            queries.push(FileQuery {
                name: whole.name,
                sql: whole.sql,
                description: whole.description,
                tags: whole.tags,
                folder_id: whole.folder_id,
                snippet_trigger: whole.snippet_trigger,
            });
        }
        let file = LibraryFile {
            format: FORMAT.into(),
            version: VERSION,
            folders: library
                .folders
                .into_iter()
                .map(|f| FileFolder {
                    id: f.id,
                    name: f.name,
                    parent_id: f.parent_id,
                })
                .collect(),
            queries,
        };
        Ok(serde_json::to_string_pretty(&file)?)
    }

    /// Adds the content of an exported file, in one transaction: either everything or nothing.
    pub fn import_library(&self, text: &str) -> Result<ImportReport, YadbeError> {
        let file: LibraryFile = serde_json::from_str(text).map_err(unreadable)?;
        if file.format != FORMAT {
            return Err(unreadable("unknown format"));
        }
        if file.version != VERSION {
            return Err(YadbeError::invalid_argument(
                format!(
                    "This library file has version {}, which this yadbe cannot read.",
                    file.version
                ),
                format!(
                    "Cette bibliothèque est en version {}, que cette version de yadbe ne sait pas lire.",
                    file.version
                ),
            ));
        }
        if file.folders.len() > MAX_IMPORT_FOLDERS || file.queries.len() > MAX_IMPORT_QUERIES {
            return Err(unreadable("too many entries"));
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut report = ImportReport {
            folders: 0,
            queries: 0,
            skipped: 0,
        };

        // Parents before children, whatever the order of the file; a folder whose parent is
        // missing (or in a cycle) lands at the root.
        let mut mapped: HashMap<&str, String> = HashMap::new();
        let known: Vec<&str> = file.folders.iter().map(|f| f.id.as_str()).collect();
        let mut pending: Vec<&FileFolder> = file.folders.iter().collect();
        while !pending.is_empty() {
            let before = pending.len();
            let mut later = Vec::new();
            for folder in pending {
                let parent = match folder.parent_id.as_deref() {
                    None => Some(None),
                    Some(p) if mapped.contains_key(p) => Some(mapped.get(p).cloned()),
                    Some(p) if !known.contains(&p) => Some(None),
                    Some(_) => None,
                };
                let Some(parent) = parent else {
                    later.push(folder);
                    continue;
                };
                let id = Self::import_folder(&tx, &folder.name, parent.as_ref(), &mut report)?;
                mapped.insert(folder.id.as_str(), id);
            }
            pending = later;
            if pending.len() == before {
                // A cycle: the rest goes to the root.
                for folder in std::mem::take(&mut pending) {
                    let id = Self::import_folder(&tx, &folder.name, None, &mut report)?;
                    mapped.insert(folder.id.as_str(), id);
                }
            }
        }

        for query in &file.queries {
            let folder_id = query
                .folder_id
                .as_deref()
                .and_then(|f| mapped.get(f).cloned());
            let present: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM saved_queries
                 WHERE folder_id IS ?1 AND name = ?2 AND sql = ?3)",
                params![folder_id, query.name.trim(), query.sql],
                |row| row.get(0),
            )?;
            if present {
                report.skipped += 1;
                continue;
            }
            Self::insert_query(
                &tx,
                &NewSavedQuery {
                    name: query.name.clone(),
                    sql: query.sql.clone(),
                    description: query.description.clone(),
                    tags: query.tags.clone(),
                    folder_id,
                    connection_id: None,
                    database: None,
                    snippet_trigger: query.snippet_trigger.clone(),
                },
            )?;
            report.queries += 1;
        }
        tx.commit()?;
        Ok(report)
    }

    /// The folder `name` under `parent`, created when it does not exist yet.
    fn import_folder(
        conn: &Connection,
        name: &str,
        parent: Option<&String>,
        report: &mut ImportReport,
    ) -> Result<String, YadbeError> {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM saved_query_folders WHERE parent_id IS ?1 AND name = ?2",
                params![parent, name.trim()],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return Ok(id);
        }
        let folder = Self::insert_folder(conn, name, parent)?;
        report.folders += 1;
        Ok(folder.id)
    }
}
