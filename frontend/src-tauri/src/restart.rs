// "Restart now" for the settings that only apply at the next start (the graphics card, gpu.rs).
//
// The backend this shell started is shut down the way the tray's "Çıkış" does it (it closes the windows and the phone's servers
// itself; killed only when it does not end in time), then Tauri relaunches the executable.
//
// NOT in a `tauri dev` session (a debug build): there the dev server (Vite) lives and dies with the app process, so a relaunch would
// come back pointing at a dead localhost:5173 ("connection refused"). The command answers "dev_session" instead, touching nothing; the
// settings page then says to restart `npm run tauri dev` by hand (the choice is already saved).
//
// `async`: a plain command would run on the main thread, which the graceful shutdown (up to a few seconds) must not block.

#[tauri::command]
pub async fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("dev_session".to_string());
    }
    crate::sidecar::shutdown_backend(&app);
    app.restart();
}
