// OpenDeX native shell (Tauri, system webview, ~10MB binary).
//
// ONE native window only: every panel is a DOM element inside it.
// Tauri's own window management (native title bars, native resize) is
// intentionally unused for panels — the shell provides the outer frame, the
// OS taskbar presence and the system tray; the desktop metaphor is React's.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod sidecar;
mod tray;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
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
            if let tauri::WindowEvent::Destroyed = event {
                sidecar::shutdown_backend(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenDeX");
}
