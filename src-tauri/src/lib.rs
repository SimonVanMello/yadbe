pub mod commands;
pub mod db;
pub mod edit;
pub mod events;
pub mod export;
pub mod secrets;
pub mod session;
pub mod state;
pub mod store;

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
        ])
        .events(collect_events![
            events::AppReady,
            events::ConnectionStateChanged,
            events::StatementLogged,
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

pub fn run() {
    init_logging();
    let builder = specta_builder();

    let app = tauri::Builder::default()
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
