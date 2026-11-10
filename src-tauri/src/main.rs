// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    work_around_webkit_wayland_crash();
    yadbe_lib::run();
}

/// WebKitGTK's DMA-BUF renderer aborts on some Wayland compositors and drivers
/// with "Error 71 (Protocol error) dispatching to Wayland display". Falling
/// back to the shared-memory renderer avoids it; a value already set by the
/// user wins.
#[cfg(target_os = "linux")]
fn work_around_webkit_wayland_crash() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    let on_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t == "wayland");
    if on_wayland && std::env::var_os(VAR).is_none() {
        // SAFETY: called first thing in `main`, before any other thread exists.
        unsafe { std::env::set_var(VAR, "1") };
    }
}
