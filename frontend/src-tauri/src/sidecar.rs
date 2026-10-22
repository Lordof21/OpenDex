// Python backend as a Tauri sidecar.
//
// spawn_backend: starts the bundled FastAPI process, captures stdout/stderr
// into the app log; if the sidecar dies unexpectedly it is restarted once.
// shutdown_backend: asks the backend to end itself (POST /api/system/shutdown)
// so its lifespan cleanup runs (windows close, the phone's scrcpy servers and
// virtual displays stop) and kills it only when it does not end in time — a
// kill is TerminateProcess / SIGKILL and skips that cleanup. If this shell
// dies without asking, the backend notices its OPENDEX_PARENT_PID is gone and
// ends itself the same way (backend/app/lifecycle.py).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub struct BackendProcess(pub Mutex<Option<CommandChild>>);

// The app is quitting: a backend that ends now must not be restarted, and a second shutdown call is a no-op.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
// The sidecar we started has ended (its Terminated event arrived).
static EXITED: AtomicBool = AtomicBool::new(false);
// Long enough for the backend's own cleanup (closing windows, stopping the phone's servers); then it is killed.
const GRACEFUL_EXIT: Duration = Duration::from_secs(8);

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

    // The backend watches this PID and ends itself when the shell is gone without asking (crash, Task Manager).
    let sidecar = sidecar.env("OPENDEX_PARENT_PID", std::process::id().to_string());
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
    EXITED.store(false, Ordering::SeqCst);

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
                    EXITED.store(true, Ordering::SeqCst);
                    if SHUTTING_DOWN.load(Ordering::SeqCst) {
                        log::info!("{term_msg} (app quitting)");
                        break;
                    }
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
    if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
        return; // tray "quit" already did it; the window's Destroyed event comes after
    }
    let Some(state) = app.try_state::<BackendProcess>() else {
        return;
    };
    if state.0.lock().unwrap().is_none() {
        return; // not ours: dev mode, or a backend that was already running
    }
    if request_shutdown(app) {
        let deadline = Instant::now() + GRACEFUL_EXIT;
        while !EXITED.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    // The guard is a temporary of the `if let` scrutinee; taking the child first drops it before `state` does.
    let child = state.0.lock().unwrap().take();
    if let Some(child) = child {
        if !EXITED.load(Ordering::SeqCst) {
            log::warn!("[sidecar] Backend did not end in time — killing it");
            let _ = child.kill();
        }
    }
}

/// POST /api/system/shutdown with the API token over a plain loopback socket (no HTTP client dependency). True when
/// the backend accepted (202) — it is then ending itself.
fn request_shutdown(app: &AppHandle) -> bool {
    let Some(token) = api_token(app.clone()) else {
        return false;
    };
    let Ok(addr) = "127.0.0.1:8710".parse::<SocketAddr>() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "POST /api/system/shutdown HTTP/1.1\r\nHost: 127.0.0.1:8710\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut status = [0u8; 12]; // "HTTP/1.1 202"
    stream.read_exact(&mut status).is_ok() && &status[9..12] == b"202"
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
