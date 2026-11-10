//! Services shared by every command, managed as Tauri state.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::events::EventSink;
use crate::export::ExportManager;
use crate::secrets::{KeychainBackend, SecretStore};
use crate::session::history_writer::StoreHistory;
use crate::session::library::Library;
use crate::session::meta_cache::{MetaService, ObservingSink};
use crate::session::statement_log::StatementLog;
use crate::session::table_data::TableDataService;
use crate::session::{ConnectionManager, QueryRunner};
use crate::store::{DB_FILE, Store};

/// Overrides the config folder (tests, isolated `xvfb-run` sessions).
pub const CONFIG_DIR_ENV: &str = "YADBE_CONFIG_DIR";

pub struct AppState {
    pub store: Arc<Store>,
    pub secrets: Arc<SecretStore>,
    pub log: Arc<StatementLog>,
    pub connections: Arc<ConnectionManager>,
    pub meta: Arc<MetaService>,
    pub queries: Arc<QueryRunner>,
    pub history: Arc<StoreHistory>,
    pub library: Arc<Library>,
    pub exports: Arc<ExportManager>,
    pub tables: Arc<TableDataService>,
}

impl AppState {
    pub fn new(store: Store, keychain: Arc<dyn KeychainBackend>, sink: Arc<dyn EventSink>) -> Self {
        let store = Arc::new(store);
        let secrets = Arc::new(SecretStore::new(keychain));
        let library = Arc::new(Library::new(Arc::clone(&store), Arc::clone(&sink)));
        let log = Arc::new(StatementLog::new(Arc::clone(&sink)));
        let meta = Arc::new(MetaService::new(Arc::clone(&sink)));
        // The metadata cache follows connection states (dropped, back, closed).
        let sink: Arc<dyn EventSink> = Arc::new(ObservingSink {
            inner: sink,
            meta: Arc::clone(&meta),
        });
        let connections = Arc::new(ConnectionManager::new(
            Arc::clone(&store),
            Arc::clone(&secrets),
            Arc::clone(&log),
            Arc::clone(&sink),
        ));
        let history = StoreHistory::new(Arc::clone(&store), Arc::clone(&sink));
        let queries = Arc::new(QueryRunner::new(
            Arc::clone(&connections),
            Arc::clone(&sink),
            history.clone(),
        ));
        // Table pages live in the query results' store: `fetch_result_window` reads both.
        let tables = Arc::new(TableDataService::new(
            Arc::clone(&connections),
            queries.shared_store(),
            Arc::clone(&sink),
        ));
        let exports = Arc::new(ExportManager::new(
            Arc::clone(&queries),
            Arc::clone(&tables),
            sink,
        ));
        Self {
            store,
            secrets,
            log,
            connections,
            meta,
            queries,
            history,
            library,
            exports,
            tables,
        }
    }
}

/// The OS config folder (`~/.config/dev.tropico.yadbe`…), unless `YADBE_CONFIG_DIR`
/// overrides it.
pub fn config_dir(app_config_dir: PathBuf) -> PathBuf {
    std::env::var_os(CONFIG_DIR_ENV).map_or(app_config_dir, PathBuf::from)
}

/// Opens the database; falls back to an in-memory one so the app still starts
/// (connections and preferences are then not persisted).
pub fn open_store(config_dir: &Path) -> Store {
    let path = config_dir.join(DB_FILE);
    match Store::open(&path) {
        Ok(store) => store,
        Err(err) => {
            tracing::error!(error = %err, path = %path.display(), "cannot open the database, using memory");
            match Store::open_in_memory() {
                Ok(store) => store,
                Err(err) => {
                    // In-memory SQLite only fails if the bundled library itself is broken.
                    tracing::error!(error = %err, "cannot create an in-memory database");
                    std::process::exit(1)
                }
            }
        }
    }
}
