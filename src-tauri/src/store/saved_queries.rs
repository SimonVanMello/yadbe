//! The query library (F-050): saved queries and snippets in nestable folders, global or bound
//! to a connection, with a full-text index on name, text, description and tags.

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::history::fts_query;
use super::{Store, new_id, now};
use crate::db::errors::YadbeError;

pub const MAX_QUERY_NAME_CHARS: usize = 120;
pub const MAX_FOLDER_NAME_CHARS: usize = 60;
pub const MAX_DESCRIPTION_CHARS: usize = 2000;
pub const MAX_SAVED_SQL_BYTES: usize = 1024 * 1024;
pub const MAX_TAGS: usize = 12;
pub const MAX_TAG_CHARS: usize = 32;
pub const MAX_TRIGGER_CHARS: usize = 32;
/// Folders nest at most this deep (the sidebar indents each level).
pub const MAX_FOLDER_DEPTH: usize = 8;
/// Characters of a statement sent in a list row; `get_saved_query` has the whole text.
pub const SAVED_PREVIEW_CHARS: usize = 400;
/// Matches returned by a full-text search.
pub const SEARCH_LIMIT: u32 = 200;

/// A saved query or snippet. In the library list `sql` is cut to [`SAVED_PREVIEW_CHARS`]
/// (`sqlTruncated`); `get_saved_query` returns it whole.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub sql: String,
    pub sql_truncated: bool,
    pub description: String,
    pub tags: Vec<String>,
    /// Scope: `null` is global, else the query belongs to this connection.
    pub connection_id: Option<String>,
    /// Database of the connection the query is bound to; only with `connection_id`.
    pub database: Option<String>,
    /// A snippet expands in the editor when its trigger word is completed.
    pub snippet_trigger: Option<String>,
    /// Unix time in seconds.
    pub created_at: u32,
    pub updated_at: u32,
    pub last_used_at: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QueryFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub created_at: u32,
}

/// The whole library: folders and queries, unordered (the sidebar sorts them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryLibrary {
    pub folders: Vec<QueryFolder>,
    pub queries: Vec<SavedQuery>,
}

/// What a new saved query holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewSavedQuery {
    pub name: String,
    pub sql: String,
    pub description: String,
    pub tags: Vec<String>,
    pub folder_id: Option<String>,
    pub connection_id: Option<String>,
    pub database: Option<String>,
    pub snippet_trigger: Option<String>,
}

/// Every field of a saved query, replaced at once; `sql` `null` keeps the text (the sidebar
/// only holds a preview of it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedQueryUpdate {
    pub name: String,
    pub sql: Option<String>,
    pub description: String,
    pub tags: Vec<String>,
    pub folder_id: Option<String>,
    pub connection_id: Option<String>,
    pub database: Option<String>,
    pub snippet_trigger: Option<String>,
}

/// A snippet with its whole template, for the editor's completion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDefinition {
    pub id: String,
    pub name: String,
    pub trigger: String,
    pub template: String,
    pub description: String,
    pub connection_id: Option<String>,
    pub database: Option<String>,
}

/// What deleting a folder removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderDeletion {
    pub folders: u32,
    pub queries: u32,
}

const QUERY_COLUMNS: &str = "id, folder_id, name, substr(sql, 1, ?1), description, tags, \
     connection_id, database_name, snippet_trigger, created_at, updated_at, last_used_at";

fn cut_chars(text: &str, max: usize) -> (&str, bool) {
    match text.char_indices().nth(max) {
        Some((at, _)) => (&text[..at], true),
        None => (text, false),
    }
}

fn row_to_query(row: &Row<'_>, sql_chars: usize) -> rusqlite::Result<SavedQuery> {
    let sql: String = row.get(3)?;
    let (sql, sql_truncated) = cut_chars(&sql, sql_chars);
    let tags: String = row.get(5)?;
    let connection_id: Option<String> = row.get(6)?;
    let database: Option<String> = row.get(7)?;
    Ok(SavedQuery {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        name: row.get(2)?,
        sql: sql.to_owned(),
        sql_truncated,
        description: row.get(4)?,
        // A damaged value reads as no tags: the rest of the query is still worth showing.
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        // Only meaningful with a connection (deleting it leaves the query global).
        database: connection_id.as_ref().and(database),
        connection_id,
        snippet_trigger: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_used_at: row.get(11)?,
    })
}

fn row_to_folder(row: &Row<'_>) -> rusqlite::Result<QueryFolder> {
    Ok(QueryFolder {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn invalid(en: String, fr: String) -> YadbeError {
    YadbeError::invalid_argument(en, fr)
}

/// A name, trimmed and bounded.
fn checked_name(name: &str, max: usize, en: &str, fr: &str) -> Result<String, YadbeError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid(
            format!("{en} needs a name."),
            format!("{fr} doit avoir un nom."),
        ));
    }
    if name.chars().count() > max {
        return Err(invalid(
            format!("{en} name has at most {max} characters."),
            format!("Le nom de {fr} compte au plus {max} caractères."),
        ));
    }
    Ok(name.to_owned())
}

fn checked_sql(sql: &str) -> Result<(), YadbeError> {
    if sql.len() > MAX_SAVED_SQL_BYTES {
        return Err(invalid(
            "This statement is too large to be saved in the library.".into(),
            "Cette instruction est trop volumineuse pour la bibliothèque.".into(),
        ));
    }
    Ok(())
}

/// The tags, trimmed, without empty ones nor duplicates.
fn checked_tags(tags: &[String]) -> Result<Vec<String>, YadbeError> {
    let mut clean: Vec<String> = Vec::new();
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() || clean.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            continue;
        }
        if tag.chars().count() > MAX_TAG_CHARS {
            return Err(invalid(
                format!("A tag has at most {MAX_TAG_CHARS} characters."),
                format!("Une étiquette compte au plus {MAX_TAG_CHARS} caractères."),
            ));
        }
        clean.push(tag.to_owned());
    }
    if clean.len() > MAX_TAGS {
        return Err(invalid(
            format!("A query has at most {MAX_TAGS} tags."),
            format!("Une requête a au plus {MAX_TAGS} étiquettes."),
        ));
    }
    Ok(clean)
}

/// A trigger word: letters, digits and `_`, starting with a letter, so that the editor's word
/// completion can match it.
fn checked_trigger(trigger: Option<&str>) -> Result<Option<String>, YadbeError> {
    let Some(trigger) = trigger.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let valid = trigger.chars().count() <= MAX_TRIGGER_CHARS
        && trigger.starts_with(|c: char| c.is_ascii_alphabetic())
        && trigger
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid {
        return Err(invalid(
            format!(
                "A trigger word is made of letters, digits and _, starts with a letter and has at most {MAX_TRIGGER_CHARS} characters."
            ),
            format!(
                "Un mot déclencheur est fait de lettres, de chiffres et de _, commence par une lettre et compte au plus {MAX_TRIGGER_CHARS} caractères."
            ),
        ));
    }
    Ok(Some(trigger.to_owned()))
}

fn checked_description(description: &str) -> Result<String, YadbeError> {
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(invalid(
            format!("A description has at most {MAX_DESCRIPTION_CHARS} characters."),
            format!("Une description compte au plus {MAX_DESCRIPTION_CHARS} caractères."),
        ));
    }
    Ok(description.trim().to_owned())
}

fn tags_json(tags: &[String]) -> Result<String, YadbeError> {
    Ok(serde_json::to_string(tags)?)
}

/// `database` only means something next to a connection.
fn scoped_database(connection_id: Option<&String>, database: Option<&String>) -> Option<String> {
    connection_id
        .and(database)
        .map(|d| d.trim().to_owned())
        .filter(|d| !d.is_empty())
}

impl Store {
    fn check_folder(conn: &Connection, folder_id: Option<&String>) -> Result<(), YadbeError> {
        if let Some(folder_id) = folder_id {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM saved_query_folders WHERE id = ?1)",
                [folder_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(YadbeError::query_folder_not_found(folder_id));
            }
        }
        Ok(())
    }

    fn check_connection(
        conn: &Connection,
        connection_id: Option<&String>,
    ) -> Result<(), YadbeError> {
        if let Some(connection_id) = connection_id {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM connections WHERE id = ?1)",
                [connection_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(YadbeError::connection_not_found(connection_id));
            }
        }
        Ok(())
    }

    /// Number of folders above `folder_id`, itself included.
    fn folder_depth(conn: &Connection, folder_id: &str) -> Result<usize, YadbeError> {
        let mut depth = 0;
        let mut cursor = Some(folder_id.to_owned());
        while let Some(id) = cursor {
            depth += 1;
            if depth > MAX_FOLDER_DEPTH * 4 {
                break;
            }
            cursor = conn
                .query_row(
                    "SELECT parent_id FROM saved_query_folders WHERE id = ?1",
                    [&id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
        }
        Ok(depth)
    }

    /// Height of the folder tree under `folder_id`, itself included.
    fn folder_height(conn: &Connection, folder_id: &str) -> Result<usize, YadbeError> {
        let mut stmt =
            conn.prepare_cached("SELECT id FROM saved_query_folders WHERE parent_id = ?1")?;
        let children = stmt
            .query_map([folder_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let mut tallest = 0;
        for child in children {
            tallest = tallest.max(Self::folder_height(conn, &child)?);
        }
        Ok(tallest + 1)
    }

    fn check_folder_depth(
        conn: &Connection,
        parent_id: Option<&String>,
        height: usize,
    ) -> Result<(), YadbeError> {
        let above = match parent_id {
            Some(parent) => Self::folder_depth(conn, parent)?,
            None => 0,
        };
        if above + height > MAX_FOLDER_DEPTH {
            return Err(invalid(
                format!("Folders nest at most {MAX_FOLDER_DEPTH} levels deep."),
                format!("Les dossiers s'imbriquent sur {MAX_FOLDER_DEPTH} niveaux au plus."),
            ));
        }
        Ok(())
    }

    // ---- Reading -------------------------------------------------------------------------

    /// Every folder and query, texts cut to a preview.
    pub fn saved_query_library(&self) -> Result<SavedQueryLibrary, YadbeError> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT id, name, parent_id, created_at FROM saved_query_folders")?;
        let folders = stmt
            .query_map([], row_to_folder)?
            .collect::<Result<Vec<_>, _>>()?;
        let mut stmt = conn.prepare(&format!("SELECT {QUERY_COLUMNS} FROM saved_queries"))?;
        let queries = stmt
            .query_map([(SAVED_PREVIEW_CHARS + 1) as i64], |row| {
                row_to_query(row, SAVED_PREVIEW_CHARS)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(SavedQueryLibrary { folders, queries })
    }

    /// A query with its whole text.
    pub fn saved_query(&self, id: &str) -> Result<Option<SavedQuery>, YadbeError> {
        let conn = self.conn();
        Self::query_by_id(&conn, id)
    }

    fn query_by_id(conn: &Connection, id: &str) -> Result<Option<SavedQuery>, YadbeError> {
        Ok(conn
            .query_row(
                &format!("SELECT {QUERY_COLUMNS} FROM saved_queries WHERE id = ?2"),
                params![i64::MAX / 4, id],
                |row| row_to_query(row, usize::MAX),
            )
            .optional()?)
    }

    fn existing_query(conn: &Connection, id: &str) -> Result<SavedQuery, YadbeError> {
        Self::query_by_id(conn, id)?.ok_or_else(|| YadbeError::saved_query_not_found(id))
    }

    /// Ids of the queries matching `text` (name, statement, description, tags; every word is
    /// the start of a word), best match first. `connection_id`: only the global queries and
    /// the ones of that connection.
    pub fn search_saved_queries(
        &self,
        text: &str,
        connection_id: Option<&str>,
    ) -> Result<Vec<String>, YadbeError> {
        let Some(fts) = fts_query(text.trim()) else {
            return Ok(Vec::new());
        };
        let mut sql = String::from(
            "SELECT q.id FROM saved_queries_fts f JOIN saved_queries q ON q.seq = f.rowid
             WHERE saved_queries_fts MATCH ?1",
        );
        let mut args = vec![SqlValue::Text(fts)];
        if let Some(connection_id) = connection_id {
            sql.push_str(" AND (q.connection_id IS NULL OR q.connection_id = ?2)");
            args.push(SqlValue::Text(connection_id.to_owned()));
        }
        sql.push_str(&format!(
            " ORDER BY bm25(saved_queries_fts, 8.0, 1.0, 3.0, 4.0) LIMIT {SEARCH_LIMIT}"
        ));
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let ids = stmt
            .query_map(params_from_iter(args), |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// The snippets (queries with a trigger word) with their whole template.
    pub fn snippets(&self) -> Result<Vec<SnippetDefinition>, YadbeError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, snippet_trigger, sql, description, connection_id, database_name
             FROM saved_queries WHERE snippet_trigger IS NOT NULL ORDER BY snippet_trigger, name",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let connection_id: Option<String> = row.get(5)?;
                let database: Option<String> = row.get(6)?;
                Ok(SnippetDefinition {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    trigger: row.get(2)?,
                    template: row.get(3)?,
                    description: row.get(4)?,
                    database: connection_id.as_ref().and(database),
                    connection_id,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---- Queries -------------------------------------------------------------------------

    pub fn create_saved_query(&self, new: &NewSavedQuery) -> Result<SavedQuery, YadbeError> {
        Self::insert_query(&self.conn(), new)
    }

    /// Validates and inserts a query on an open connection (or transaction).
    pub(super) fn insert_query(
        conn: &Connection,
        new: &NewSavedQuery,
    ) -> Result<SavedQuery, YadbeError> {
        let name = checked_name(&new.name, MAX_QUERY_NAME_CHARS, "A query", "la requête")?;
        checked_sql(&new.sql)?;
        let description = checked_description(&new.description)?;
        let tags = checked_tags(&new.tags)?;
        let trigger = checked_trigger(new.snippet_trigger.as_deref())?;
        let id = new_id();
        Self::check_folder(conn, new.folder_id.as_ref())?;
        Self::check_connection(conn, new.connection_id.as_ref())?;
        conn.execute(
            "INSERT INTO saved_queries (id, folder_id, name, sql, description, tags,
                connection_id, database_name, snippet_trigger, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                id,
                new.folder_id,
                name,
                new.sql,
                description,
                tags_json(&tags)?,
                new.connection_id,
                scoped_database(new.connection_id.as_ref(), new.database.as_ref()),
                trigger,
                now(),
            ],
        )?;
        Self::existing_query(conn, &id)
    }

    pub fn update_saved_query(
        &self,
        id: &str,
        update: &SavedQueryUpdate,
    ) -> Result<SavedQuery, YadbeError> {
        let name = checked_name(&update.name, MAX_QUERY_NAME_CHARS, "A query", "la requête")?;
        if let Some(sql) = &update.sql {
            checked_sql(sql)?;
        }
        let description = checked_description(&update.description)?;
        let tags = checked_tags(&update.tags)?;
        let trigger = checked_trigger(update.snippet_trigger.as_deref())?;
        let conn = self.conn();
        let current = Self::existing_query(&conn, id)?;
        Self::check_folder(&conn, update.folder_id.as_ref())?;
        if update.connection_id != current.connection_id {
            Self::check_connection(&conn, update.connection_id.as_ref())?;
        }
        conn.execute(
            "UPDATE saved_queries SET name = ?2, sql = COALESCE(?3, sql), description = ?4,
                tags = ?5, folder_id = ?6, connection_id = ?7, database_name = ?8,
                snippet_trigger = ?9, updated_at = ?10
             WHERE id = ?1",
            params![
                id,
                name,
                update.sql,
                description,
                tags_json(&tags)?,
                update.folder_id,
                update.connection_id,
                scoped_database(update.connection_id.as_ref(), update.database.as_ref()),
                trigger,
                now(),
            ],
        )?;
        Self::existing_query(&conn, id)
    }

    /// Moves a query into a folder (`None`: the root).
    pub fn move_saved_query(
        &self,
        id: &str,
        folder_id: Option<&String>,
    ) -> Result<SavedQuery, YadbeError> {
        let conn = self.conn();
        Self::existing_query(&conn, id)?;
        Self::check_folder(&conn, folder_id)?;
        conn.execute(
            "UPDATE saved_queries SET folder_id = ?2 WHERE id = ?1",
            params![id, folder_id],
        )?;
        Self::existing_query(&conn, id)
    }

    /// A copy next to the original: same text and scope, no trigger word (two snippets with
    /// one trigger would compete).
    pub fn duplicate_saved_query(
        &self,
        id: &str,
        copy_suffix: &str,
    ) -> Result<SavedQuery, YadbeError> {
        let source = self
            .saved_query(id)?
            .ok_or_else(|| YadbeError::saved_query_not_found(id))?;
        let mut name = format!("{} {copy_suffix}", source.name);
        if name.chars().count() > MAX_QUERY_NAME_CHARS {
            let keep = MAX_QUERY_NAME_CHARS.saturating_sub(copy_suffix.chars().count() + 1);
            name = format!(
                "{} {copy_suffix}",
                source.name.chars().take(keep).collect::<String>()
            );
        }
        self.create_saved_query(&NewSavedQuery {
            name,
            sql: source.sql,
            description: source.description,
            tags: source.tags,
            folder_id: source.folder_id,
            connection_id: source.connection_id,
            database: source.database,
            snippet_trigger: None,
        })
    }

    pub fn delete_saved_query(&self, id: &str) -> Result<(), YadbeError> {
        let changed = self
            .conn()
            .execute("DELETE FROM saved_queries WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(YadbeError::saved_query_not_found(id));
        }
        Ok(())
    }

    /// Notes that a query was just used (opened, inserted, run).
    pub fn touch_saved_query(&self, id: &str) -> Result<(), YadbeError> {
        // Not an `updated_at` change: the text is the same.
        let changed = self.conn().execute(
            "UPDATE saved_queries SET last_used_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
        if changed == 0 {
            return Err(YadbeError::saved_query_not_found(id));
        }
        Ok(())
    }

    // ---- Folders -------------------------------------------------------------------------

    pub fn create_query_folder(
        &self,
        name: &str,
        parent_id: Option<&String>,
    ) -> Result<QueryFolder, YadbeError> {
        Self::insert_folder(&self.conn(), name, parent_id)
    }

    pub(super) fn insert_folder(
        conn: &Connection,
        name: &str,
        parent_id: Option<&String>,
    ) -> Result<QueryFolder, YadbeError> {
        let name = checked_name(name, MAX_FOLDER_NAME_CHARS, "A folder", "le dossier")?;
        Self::check_folder(conn, parent_id)?;
        Self::check_folder_depth(conn, parent_id, 1)?;
        let id = new_id();
        conn.execute(
            "INSERT INTO saved_query_folders (id, name, parent_id, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, name, parent_id, now()],
        )?;
        Self::folder_by_id(conn, &id)
    }

    fn folder_by_id(conn: &Connection, id: &str) -> Result<QueryFolder, YadbeError> {
        conn.query_row(
            "SELECT id, name, parent_id, created_at FROM saved_query_folders WHERE id = ?1",
            [id],
            row_to_folder,
        )
        .optional()?
        .ok_or_else(|| YadbeError::query_folder_not_found(id))
    }

    pub fn rename_query_folder(&self, id: &str, name: &str) -> Result<QueryFolder, YadbeError> {
        let name = checked_name(name, MAX_FOLDER_NAME_CHARS, "A folder", "le dossier")?;
        let conn = self.conn();
        Self::folder_by_id(&conn, id)?;
        conn.execute(
            "UPDATE saved_query_folders SET name = ?2 WHERE id = ?1",
            params![id, name],
        )?;
        Self::folder_by_id(&conn, id)
    }

    /// Moves a folder under `parent_id` (`None`: the root). A folder cannot go into itself or
    /// into what it holds.
    pub fn move_query_folder(
        &self,
        id: &str,
        parent_id: Option<&String>,
    ) -> Result<QueryFolder, YadbeError> {
        let conn = self.conn();
        Self::folder_by_id(&conn, id)?;
        Self::check_folder(&conn, parent_id)?;
        let mut cursor = parent_id.cloned();
        while let Some(ancestor) = cursor {
            if ancestor == id {
                return Err(invalid(
                    "A folder cannot be moved into itself or into one of its subfolders.".into(),
                    "Un dossier ne peut pas être déplacé dans lui-même ni dans l'un de ses sous-dossiers."
                        .into(),
                ));
            }
            cursor = conn
                .query_row(
                    "SELECT parent_id FROM saved_query_folders WHERE id = ?1",
                    [&ancestor],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
        }
        let height = Self::folder_height(&conn, id)?;
        Self::check_folder_depth(&conn, parent_id, height)?;
        conn.execute(
            "UPDATE saved_query_folders SET parent_id = ?2 WHERE id = ?1",
            params![id, parent_id],
        )?;
        Self::folder_by_id(&conn, id)
    }

    /// Deletes a folder with its subfolders and every query in them.
    pub fn delete_query_folder(&self, id: &str) -> Result<FolderDeletion, YadbeError> {
        let mut conn = self.conn();
        Self::folder_by_id(&conn, id)?;
        let tx = conn.transaction()?;
        // The folder and everything under it.
        let tree = "WITH RECURSIVE tree(id) AS (
                SELECT ?1 UNION ALL
                SELECT f.id FROM saved_query_folders f JOIN tree t ON f.parent_id = t.id)";
        let folders: i64 =
            tx.query_row(&format!("{tree} SELECT COUNT(*) FROM tree"), [id], |row| {
                row.get(0)
            })?;
        // Deleted explicitly rather than through the foreign key cascade, so that the index
        // triggers surely run.
        let queries = tx.execute(
            &format!("{tree} DELETE FROM saved_queries WHERE folder_id IN (SELECT id FROM tree)"),
            [id],
        )?;
        tx.execute("DELETE FROM saved_query_folders WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(FolderDeletion {
            folders: u32::try_from(folders).unwrap_or(u32::MAX),
            queries: u32::try_from(queries).unwrap_or(u32::MAX),
        })
    }
}
