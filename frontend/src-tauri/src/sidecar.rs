// Python backend as a Tauri sidecar.
//
// spawn_backend: starts the bundled FastAPI process, captures stdout/stderr
// into the app log. watch_and_restart: if the sidecar dies unexpectedly it is
// restarted once and the user is notified via a tray tooltip. shutdown_backend:
// graceful termination so the backend's lifespan-finally (close_all → audio
// stop → monitors stop) always runs.

use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub struct BackendProcess(pub Mutex<Option<CommandChild>>);

pub fn init(app: &AppHandle) {
    app.manage(BackendProcess(Mutex::new(None)));
}

fn is_backend_alive() -> bool {
    if let Ok(addr) = "127.0.0.1:8710".parse::<SocketAddr>() {
        TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
    } else {
        false
    }
}

pub fn spawn_backend(app: AppHandle) {
    if cfg!(debug_assertions) {
        let dev_msg = "[sidecar] DEV modu aktif: Backend sidecar (.exe) calistirilmiyor. Terminaldeki 'python -m app.main' kullaniliyor (127.0.0.1:8710).".to_string();
        log::info!("{dev_msg}");
        let _ = app.emit("backend-log", &dev_msg);
        return;
    }

    if is_backend_alive() {
        let active_msg = "[sidecar] Port 8710 zaten aktif (harici backend bulundu). Sidecar .exe calistirilmiyor.".to_string();
        log::info!("{active_msg}");
        let _ = app.emit("backend-log", &active_msg);
        return;
    }

    spawn_backend_attempt(app, false);
}

fn spawn_backend_attempt(app: AppHandle, is_retry: bool) {
    if is_backend_alive() {
        log::info!("[sidecar] Port 8710 zaten aktif. Sidecar calistirilmiyor.");
        return;
    }

    let start_msg = format!("[sidecar] Attempting to spawn backend sidecar (retry={is_retry})");
    log::info!("{start_msg}");
    let _ = app.emit("backend-log", &start_msg);

    let sidecar = match app.shell().sidecar("opendex-backend") {
        Ok(s) => s,
        Err(err) => {
            let warn_msg = format!("[sidecar ERROR] Sidecar binary lookup failed: {err}");
            log::warn!("{warn_msg}");
            let _ = app.emit("backend-error", &warn_msg);
            return;
        }
    };

    let (mut rx, child) = match sidecar.spawn() {
        Ok(pair) => pair,
        Err(err) => {
            let warn_msg = format!("[sidecar ERROR] Sidecar spawn failed: {err}");
            log::warn!("{warn_msg}");
            let _ = app.emit("backend-error", &warn_msg);
            return;
        }
    };
    let _ = app.emit(
        "backend-log",
        "[sidecar] Backend process spawned successfully",
    );

    if let Some(state) = app.try_state::<BackendProcess>() {
        *state.0.lock().unwrap() = Some(child);
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line).trim_end().to_string();
                    log::info!("[backend] {}", text);
                    let _ = handle.emit("backend-log", format!("[backend] {}", text));
                }
                CommandEvent::Terminated(status) => {
                    let term_msg = format!(
                        "[sidecar] Backend process exited with code {:?}",
                        status.code
                    );
                    log::warn!("{term_msg}");
                    let _ = handle.emit("backend-error", &term_msg);

                    if is_retry || is_backend_alive() {
                        log::info!("[sidecar] Giving up restart (already retried or backend active on port 8710)");
                    } else {
                        spawn_backend_attempt(handle.clone(), true);
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

pub fn shutdown_backend(app: &AppHandle) {
    if let Some(state) = app.try_state::<BackendProcess>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            // Triggers the backend lifespan-finally: window_manager.close_all()
            let _ = child.kill();
        }
    }
}

/// The backend's per-user API token (backend/app/api/auth.py): `~/.opendex/api-token`, written with mode 0600 by
/// the backend on its first start. Read at call time — the file may not exist yet while the sidecar is booting, and
/// the boot splash asks again once `/api/health` answers. In the desktop build the token never travels over HTTP.
#[tauri::command]
pub fn api_token(app: AppHandle) -> Option<String> {
    let path = app
        .path()
        .home_dir()
        .ok()?
        .join(".opendex")
        .join("api-token");
    let text = std::fs::read_to_string(path).ok()?;
    let token = text.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}
