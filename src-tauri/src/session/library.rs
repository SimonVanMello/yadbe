//! The query library service (F-050): the store's saved queries and folders, plus the
//! `saved-queries-changed` event after every change so that the sidebar, the palette and the
//! editor's snippet completion read the library again.

use std::sync::Arc;

use crate::db::errors::{ErrorCode, YadbeError};
use crate::events::{BackendEvent, EventSink, SavedQueriesChanged};
use crate::store::{
    FolderDeletion, ImportReport, NewSavedQuery, QueryFolder, SavedQuery, SavedQueryLibrary,
    SavedQueryUpdate, SnippetDefinition, Store,
};

/// Largest library file read by an import.
const MAX_IMPORT_BYTES: u64 = 32 * 1024 * 1024;

pub struct Library {
    store: Arc<Store>,
    sink: Arc<dyn EventSink>,
}

impl Library {
    pub fn new(store: Arc<Store>, sink: Arc<dyn EventSink>) -> Self {
        Self { store, sink }
    }

    fn changed<T>(&self, result: Result<T, YadbeError>) -> Result<T, YadbeError> {
        if result.is_ok() {
            self.sink
                .emit(BackendEvent::SavedQueriesChanged(SavedQueriesChanged {}));
        }
        result
    }

    pub fn library(&self) -> Result<SavedQueryLibrary, YadbeError> {
        self.store.saved_query_library()
    }

    pub fn get(&self, id: &str) -> Result<Option<SavedQuery>, YadbeError> {
        self.store.saved_query(id)
    }

    pub fn search(
        &self,
        text: &str,
        connection_id: Option<&str>,
    ) -> Result<Vec<String>, YadbeError> {
        self.store.search_saved_queries(text, connection_id)
    }

    pub fn snippets(&self) -> Result<Vec<SnippetDefinition>, YadbeError> {
        self.store.snippets()
    }

    pub fn create(&self, new: &NewSavedQuery) -> Result<SavedQuery, YadbeError> {
        self.changed(self.store.create_saved_query(new))
    }

    pub fn update(&self, id: &str, update: &SavedQueryUpdate) -> Result<SavedQuery, YadbeError> {
        self.changed(self.store.update_saved_query(id, update))
    }

    pub fn move_query(
        &self,
        id: &str,
        folder_id: Option<&String>,
    ) -> Result<SavedQuery, YadbeError> {
        self.changed(self.store.move_saved_query(id, folder_id))
    }

    pub fn duplicate(&self, id: &str, copy_suffix: &str) -> Result<SavedQuery, YadbeError> {
        self.changed(self.store.duplicate_saved_query(id, copy_suffix))
    }

    pub fn delete(&self, id: &str) -> Result<(), YadbeError> {
        self.changed(self.store.delete_saved_query(id))
    }

    /// No event: using a query changes nothing the views show.
    pub fn touch(&self, id: &str) -> Result<(), YadbeError> {
        self.store.touch_saved_query(id)
    }

    pub fn create_folder(
        &self,
        name: &str,
        parent_id: Option<&String>,
    ) -> Result<QueryFolder, YadbeError> {
        self.changed(self.store.create_query_folder(name, parent_id))
    }

    pub fn rename_folder(&self, id: &str, name: &str) -> Result<QueryFolder, YadbeError> {
        self.changed(self.store.rename_query_folder(id, name))
    }

    pub fn move_folder(
        &self,
        id: &str,
        parent_id: Option<&String>,
    ) -> Result<QueryFolder, YadbeError> {
        self.changed(self.store.move_query_folder(id, parent_id))
    }

    pub fn delete_folder(&self, id: &str) -> Result<FolderDeletion, YadbeError> {
        self.changed(self.store.delete_query_folder(id))
    }

    /// Writes the library to `path` (a JSON file chosen in a save dialog).
    pub fn export_to(&self, path: &str) -> Result<(), YadbeError> {
        let file = checked_library_path(path)?;
        let text = self.store.export_library()?;
        std::fs::write(file, text).map_err(|error| YadbeError::file_write_failed(path, &error))
    }

    /// Adds the content of the library file at `path`.
    pub fn import_from(&self, path: &str) -> Result<ImportReport, YadbeError> {
        let file = checked_library_path(path)?;
        let size = std::fs::metadata(file)
            .map_err(|error| read_failure(path, &error))?
            .len();
        if size > MAX_IMPORT_BYTES {
            return Err(YadbeError::invalid_argument(
                "This file is larger than 32 MiB: it is not a yadbe library.",
                "Ce fichier dépasse 32 Mio : ce n'est pas une bibliothèque yadbe.",
            ));
        }
        let bytes = std::fs::read(file).map_err(|error| read_failure(path, &error))?;
        let text = String::from_utf8(bytes).map_err(|_| {
            YadbeError::invalid_argument(
                "This file is not UTF-8 text.",
                "Ce fichier n'est pas du texte UTF-8.",
            )
        })?;
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        self.changed(self.store.import_library(text))
    }
}

/// The paths come from native dialogs, but the webview is not trusted with arbitrary file
/// access: only an absolute `.json` path is served.
fn checked_library_path(path: &str) -> Result<&std::path::Path, YadbeError> {
    let candidate = std::path::Path::new(path);
    let json = candidate
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
    if !candidate.is_absolute() || !json {
        return Err(YadbeError::invalid_argument(
            "A library file is an absolute path ending in .json.",
            "Un fichier de bibliothèque est un chemin absolu qui se termine par .json.",
        ));
    }
    Ok(candidate)
}

fn read_failure(path: &str, error: &std::io::Error) -> YadbeError {
    if error.kind() == std::io::ErrorKind::NotFound {
        return YadbeError::file_not_found(path);
    }
    YadbeError::new(
        ErrorCode::Internal,
        format!("The file \"{path}\" could not be read."),
        format!("Le fichier « {path} » n'a pas pu être lu."),
    )
    .with_detail(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::RecordingSink;

    fn library() -> (Library, Arc<RecordingSink>) {
        let sink = Arc::new(RecordingSink::default());
        let store = Arc::new(Store::open_in_memory().expect("store"));
        (Library::new(store, sink.clone()), sink)
    }

    fn changes(sink: &RecordingSink) -> usize {
        sink.events()
            .iter()
            .filter(|e| matches!(e, BackendEvent::SavedQueriesChanged(_)))
            .count()
    }

    fn new_query(name: &str, sql: &str) -> NewSavedQuery {
        NewSavedQuery {
            name: name.into(),
            sql: sql.into(),
            ..NewSavedQuery::default()
        }
    }

    #[test]
    fn every_change_is_announced_and_a_failure_or_a_read_is_not() {
        let (library, sink) = library();
        let folder = library.create_folder("F", None).expect("folder");
        assert_eq!(changes(&sink), 1);
        let query = library.create(&new_query("q", "SELECT 1")).expect("create");
        assert_eq!(changes(&sink), 2);
        library
            .move_query(&query.id, Some(&folder.id))
            .expect("move");
        library.duplicate(&query.id, "(copy)").expect("duplicate");
        library.rename_folder(&folder.id, "G").expect("rename");
        library.move_folder(&folder.id, None).expect("move folder");
        assert_eq!(changes(&sink), 6);
        library.delete(&query.id).expect("delete");
        library.delete_folder(&folder.id).expect("delete folder");
        assert_eq!(changes(&sink), 8);

        library.library().expect("list");
        library.search("x", None).expect("search");
        library.snippets().expect("snippets");
        let other = library.create(&new_query("o", "SELECT 2")).expect("o");
        assert_eq!(changes(&sink), 9);
        library.touch(&other.id).expect("touch");
        assert_eq!(changes(&sink), 9, "using a query is not a change");

        assert!(library.delete("nope").is_err());
        assert!(library.create(&new_query(" ", "SELECT 1")).is_err());
        assert_eq!(changes(&sink), 9, "a refused change is not announced");
    }

    #[test]
    fn a_library_exports_and_imports_into_another_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("library.json");
        let path = path.to_str().expect("utf-8");
        let (source, _) = library();
        let outer = source.create_folder("Reports", None).expect("outer");
        let inner = source
            .create_folder("Monthly", Some(&outer.id))
            .expect("inner");
        let mut nested = new_query("Revenue", "SELECT sum(total) FROM orders");
        nested.folder_id = Some(inner.id.clone());
        nested.description = "Money".into();
        nested.tags = vec!["sales".into()];
        nested.snippet_trigger = Some("rev".into());
        source.create(&nested).expect("nested");
        source.create(&new_query("Root", "SELECT 1")).expect("root");
        source.export_to(path).expect("export");

        let (target, sink) = library();
        let existing = target.create_folder("Reports", None).expect("existing");
        let report = target.import_from(path).expect("import");
        assert_eq!(
            report,
            ImportReport {
                folders: 1,
                queries: 2,
                skipped: 0
            }
        );
        assert_eq!(changes(&sink), 2);
        let imported = target.library().expect("library");
        assert_eq!(imported.folders.len(), 2, "the Reports folder is merged");
        let monthly = imported
            .folders
            .iter()
            .find(|f| f.name == "Monthly")
            .expect("monthly");
        assert_eq!(monthly.parent_id.as_ref(), Some(&existing.id));
        let revenue = imported
            .queries
            .iter()
            .find(|q| q.name == "Revenue")
            .expect("revenue");
        assert_eq!(revenue.folder_id.as_ref(), Some(&monthly.id));
        assert_eq!(revenue.snippet_trigger.as_deref(), Some("rev"));
        assert_eq!(revenue.tags, vec!["sales"]);
        assert_eq!(revenue.connection_id, None);

        // Importing again adds nothing.
        let again = target.import_from(path).expect("again");
        assert_eq!(
            again,
            ImportReport {
                folders: 0,
                queries: 0,
                skipped: 2
            }
        );
    }

    #[test]
    fn an_import_is_all_or_nothing_and_refuses_what_is_not_a_library() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (library, sink) = library();
        let write = |name: &str, text: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, text).expect("write");
            path.to_str().expect("utf-8").to_owned()
        };
        let not_json = write("a.json", "hello");
        let other = write(
            "b.json",
            r#"{"format":"other","version":1,"folders":[],"queries":[]}"#,
        );
        let newer = write(
            "c.json",
            r#"{"format":"yadbe-library","version":9,"folders":[],"queries":[]}"#,
        );
        // The second query has no name: nothing of the file may stay.
        let half = write(
            "d.json",
            r#"{"format":"yadbe-library","version":1,"folders":[{"id":"f","name":"F","parentId":null}],
               "queries":[{"name":"ok","sql":"SELECT 1","folderId":"f","snippetTrigger":null},
                          {"name":" ","sql":"SELECT 2","folderId":null,"snippetTrigger":null}]}"#,
        );
        for path in [&not_json, &other, &newer, &half] {
            assert!(library.import_from(path).is_err(), "{path}");
        }
        let content = library.library().expect("library");
        assert!(content.folders.is_empty() && content.queries.is_empty());
        assert_eq!(changes(&sink), 0);

        let txt = dir.path().join("x.txt");
        assert!(library.import_from(txt.to_str().expect("utf-8")).is_err());
        assert!(library.import_from("relative.json").is_err());
        let missing = dir.path().join("missing.json");
        assert_eq!(
            library
                .import_from(missing.to_str().expect("utf-8"))
                .map_err(|e| e.code),
            Err(ErrorCode::FileNotFound)
        );
    }
}
