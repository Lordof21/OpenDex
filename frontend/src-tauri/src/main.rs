// OpenDeX native shell (Tauri, system webview, ~10MB binary).
//
// ONE native window only: every panel is a DOM element inside it.
// Tauri's own window management (native title bars, native resize) is
// intentionally unused for panels — the shell provides the outer frame, the
// OS taskbar presence and the system tray; the desktop metaphor is React's.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod gpu;
mod pointer;
mod restart;
mod sidecar;
mod tray;
mod webview_memory;
mod window_icon;

use tauri::Manager;

fn main() {
    // Before anything can create a webview: the user's graphics-card choice becomes a WebView2 switch (gpu.rs).
    gpu::apply_saved_preference();
    tauri::Builder::default()
        .plugin(window_icon::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Warn)
                .build(),
        )
        // The webview obtains the backend's API token over IPC (apiToken.js), never over HTTP.
        // File manager: the shell token + native pickers (files.rs) — the only way a PC path outside the roots is vouched for.
        .invoke_handler(tauri::generate_handler![
            webview_memory::webview_memory_level,
            gpu::gpu_preference,
            gpu::set_gpu_preference,
            restart::restart_app,
            pointer::primary_button_down,
            sidecar::api_token,
            files::fs_shell_token,
            files::fs_pick_folder,
            files::fs_pick_files
        ])
        .setup(|app| {
            tray::build_tray(app)?;
            sidecar::init(app.handle());
            sidecar::spawn_backend(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Only the MAIN window ends the app. The PiP windows (`os-window-*`, `ws-pip-*`) are opened and closed all the time; their
            // `Destroyed` used to shut the backend down too (in the packaged app a closing PiP killed the backend).
            if let tauri::WindowEvent::Destroyed = event {
                if ends_the_app(window.label()) {
                    sidecar::shutdown_backend(window.app_handle());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenDeX");
}

/// Whether the destruction of the window with this label ends the app (and so the backend). Only the main window does:
/// every other window is a PiP the user opens and closes while the app keeps running.
fn ends_the_app(label: &str) -> bool {
    label == "main"
}

#[cfg(test)]
mod tests {
    use super::ends_the_app;

    #[test]
    fn only_the_main_window_ends_the_app() {
        assert!(ends_the_app("main"));
        assert!(!ends_the_app("os-window-35f2cd806d7f"));
        assert!(!ends_the_app("ws-pip-task1"));
    }
}
