pub mod commands;
pub mod db;
pub mod edit;
pub mod events;
pub mod export;
pub mod secrets;
pub mod session;
pub mod store;

use tauri_specta::{Builder, Event, collect_commands, collect_events};

/// Path of the generated TypeScript bindings, relative to the `src-tauri` crate root.
pub const BINDINGS_PATH: &str = "../src/ipc/bindings.ts";

/// Single source of truth for the IPC surface: every command exposed to the
/// frontend is registered here, so the generated bindings always match.
pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![commands::app::app_info])
        .events(collect_events![events::AppReady])
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
