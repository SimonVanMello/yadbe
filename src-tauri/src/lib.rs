pub mod commands;
pub mod db;
pub mod edit;
pub mod events;
pub mod export;
pub mod secrets;
pub mod session;
pub mod state;
pub mod store;
pub mod tunnel;

use std::sync::Arc;

use tauri::Manager;
use tauri_specta::{Builder, Event, collect_commands, collect_events};

/// Path of the generated TypeScript bindings, relative to the `src-tauri` crate root.
pub const BINDINGS_PATH: &str = "../src/ipc/bindings.ts";

/// Single source of truth for the IPC surface: every command exposed to the
/// frontend is registered here, so the generated bindings always match.
pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::app::app_info,
            commands::connections::list_engines,
            commands::connections::list_connections,
            commands::connections::create_connection,
            commands::connections::update_connection,
            commands::connections::duplicate_connection,
            commands::connections::delete_connection,
            commands::connections::move_connection,
            commands::connections::list_connection_groups,
            commands::connections::create_connection_group,
            commands::connections::rename_connection_group,
            commands::connections::set_connection_group_collapsed,
            commands::connections::move_connection_group,
            commands::connections::delete_connection_group,
            commands::sessions::test_connection,
            commands::sessions::cancel_test_connection,
            commands::sessions::connect,
            commands::sessions::connect_with_secrets,
            commands::sessions::disconnect,
            commands::sessions::list_sessions,
            commands::secrets::keychain_status,
            commands::secrets::set_connection_secret,
            commands::secrets::delete_connection_secret,
            commands::secrets::has_connection_secret,
            commands::secrets::parse_connection_string,
            commands::secrets::discard_pending_secret,
            commands::store::get_preferences,
            commands::store::set_preferences,
            commands::store::load_tabs,
            commands::store::save_tabs,
            commands::store::get_statement_log,
            commands::store::clear_statement_log,
            commands::meta::list_databases,
            commands::meta::list_schemas,
            commands::meta::list_object_counts,
            commands::meta::list_objects,
            commands::meta::get_table_details,
            commands::meta::get_completion_catalog,
            commands::meta::refresh_meta,
            commands::meta::cancel_meta_request,
            commands::meta::script_table,
            commands::query::split_statements,
            commands::query::statement_at,
            commands::query::execute_query,
            commands::query::cancel_query,
            commands::query::resume_result,
            commands::query::fetch_result_window,
            commands::query::fetch_result_cell,
            commands::query::get_query_tab,
            commands::query::set_transaction_mode,
            commands::query::commit_transaction,
            commands::query::rollback_transaction,
            commands::query::close_query_tab,
            commands::history::search_history,
            commands::history::get_history_entry,
            commands::history::delete_history_entry,
            commands::history::count_history,
            commands::history::clear_history,
            commands::saved_queries::list_saved_queries,
            commands::saved_queries::get_saved_query,
            commands::saved_queries::search_saved_queries,
            commands::saved_queries::list_snippets,
            commands::saved_queries::create_saved_query,
            commands::saved_queries::update_saved_query,
            commands::saved_queries::move_saved_query,
            commands::saved_queries::duplicate_saved_query,
            commands::saved_queries::delete_saved_query,
            commands::saved_queries::touch_saved_query,
            commands::saved_queries::create_query_folder,
            commands::saved_queries::rename_query_folder,
            commands::saved_queries::move_query_folder,
            commands::saved_queries::delete_query_folder,
            commands::saved_queries::export_saved_queries,
            commands::saved_queries::import_saved_queries,
            commands::files::read_text_file,
            commands::files::write_text_file,
            commands::value_file::write_value_file,
            commands::export::start_export,
            commands::export::cancel_export,
            commands::export::preview_export,
            commands::table_data::open_table_data,
            commands::table_data::fetch_table_page,
            commands::table_data::count_table_rows,
            commands::table_data::refresh_table_rows,
            commands::table_data::cancel_table_data,
            commands::table_data::close_table_data,
            commands::edit::preview_table_changes,
            commands::edit::apply_table_changes,
            commands::references::get_incoming_foreign_keys,
            commands::references::fetch_referenced_row,
            commands::references::count_referencing_rows,
            commands::references::search_referenced_rows,
            commands::references::cancel_reference_lookup,
            commands::ssh::list_known_hosts,
            commands::ssh::trust_host_key,
            commands::ssh::forget_host_key,
            commands::journal::search_change_journal,
            commands::journal::get_change_journal_entry,
            commands::journal::list_change_journal_tables,
            commands::journal::clear_change_journal,
            commands::journal::preview_change_set_revert,
            commands::journal::apply_change_set_revert,
            commands::objects::get_object_ddl,
            commands::objects::get_object_properties,
            commands::objects::plan_object_action,
            commands::objects::run_object_action,
            commands::objects::list_pinned_objects,
            commands::objects::pin_object,
            commands::objects::unpin_object,
        ])
        .events(collect_events![
            events::AppReady,
            events::ConnectionStateChanged,
            events::StatementLogged,
            events::MetaRefreshed,
            events::QueryProgress,
            events::QueryFinished,
            events::TransactionStateChanged,
            events::HistoryChanged,
            export::model::ExportProgress,
            export::model::ExportFinished,
            events::TableDataChanged,
            events::SavedQueriesChanged,
            events::ChangeJournalChanged,
        ])
}

/// Writes the TypeScript bindings to `path`.
pub fn export_bindings(path: &std::path::Path) -> Result<(), specta_typescript::Error> {
    specta_builder().export(
        specta_typescript::Typescript::default().header("// Regenerate with `pnpm bindings`."),
        path,
    )
}

fn init_logging() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // A second initialization (tests, embedding) is harmless: keep the first subscriber.
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

/// Set to measure the startup (P-01, `scripts/measure-startup.mjs`): prints when the window
/// becomes visible, then quits.
pub const PERF_PROBE_ENV: &str = "YADBE_PERF_PROBE";

/// The frontend shows the (initially hidden) window once the restored tabs are rendered:
/// visible means usable.
fn perf_probe(app: tauri::AppHandle, started: std::time::Instant) {
    std::thread::spawn(move || {
        let deadline = started + std::time::Duration::from_secs(20);
        while std::time::Instant::now() < deadline {
            let visible = app
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if visible {
                println!(
                    "yadbe-perf window-visible since_run_ms={}",
                    started.elapsed().as_millis()
                );
                // Let pending IPC (tab and preference saves) finish before quitting.
                std::thread::sleep(std::time::Duration::from_millis(400));
                app.exit(0);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        println!("yadbe-perf timeout");
        app.exit(2);
    });
}

pub fn run() {
    let started = std::time::Instant::now();
    init_logging();
    let builder = specta_builder();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let config_dir = state::config_dir(app.path().app_config_dir()?);
            tracing::info!(path = %config_dir.display(), "config folder");
            let sink = Arc::new(events::TauriSink(app.handle().clone()));
            let app_state = state::AppState::new(
                state::open_store(&config_dir),
                Arc::new(secrets::OsKeychain),
                sink,
            );
            // Probing the keychain can take a moment (D-Bus): do it before the UI asks.
            let secrets = Arc::clone(&app_state.secrets);
            tauri::async_runtime::spawn_blocking(move || secrets.status());
            app.manage(app_state);
            let ready = events::AppReady {
                app_version: env!("CARGO_PKG_VERSION").to_owned(),
            };
            if let Err(err) = ready.emit(app.handle()) {
                tracing::warn!(error = %err, "failed to emit app-ready");
            }
            if std::env::var_os(PERF_PROBE_ENV).is_some() {
                perf_probe(app.handle().clone(), started);
            }
            Ok(())
        })
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|_, _| {}),
        Err(err) => {
            tracing::error!(error = %err, "failed to run the Tauri application");
            std::process::exit(1);
        }
    }
}
