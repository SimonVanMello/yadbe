//! macOS application menu whose Quit asks the window first.
//!
//! Tauri's default menu quits through `NSApplication terminate:`, which tao turns straight into
//! an exit: no `CloseRequested`, no `ExitRequested`, so the close guard of the frontend (open
//! transaction, pending changes) is never asked and Cmd+Q drops them. The default menu is kept
//! whole except for that item, replaced by one that closes the window like its close button:
//! the guard runs, and the app exits with its last window.
//!
//! Still out of reach: Quit from the Dock and a logout / shutdown send `terminate:` too, and
//! tao has no `applicationShouldTerminate:` to stop them.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind};
use tauri::{AppHandle, Manager, Runtime};

/// Menu id of yadbe's own Quit item.
const QUIT_ID: &str = "yadbe-quit";
/// Label of the window the Quit item closes (`tauri.conf.json`).
const MAIN_WINDOW: &str = "main";

/// Sets Tauri's default menu with its Quit item replaced by [`QUIT_ID`].
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    // On macOS the first submenu is the application menu, and Quit is its last item.
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let count = app_menu.items()?.len();
        if count > 0 {
            app_menu.remove_at(count - 1)?;
        }
        let name = app.package_info().name.clone();
        let quit = MenuItem::with_id(
            app,
            QUIT_ID,
            format!("Quit {name}"),
            true,
            Some("CmdOrCtrl+Q"),
        )?;
        app_menu.append(&quit)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

/// Handles yadbe's Quit: a close request on the main window, which the frontend may stop.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() != QUIT_ID {
        return;
    }
    match app.get_webview_window(MAIN_WINDOW) {
        // `close` emits `CloseRequested` first, like the window's own close button.
        Some(window) => {
            if let Err(err) = window.close() {
                tracing::warn!(error = %err, "failed to close the window on Quit");
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}
