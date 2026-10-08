//! Native half of the file manager (frontend/src/files/tauriBridge.js).
//!
//! What only the native shell can prove to the backend: "the user picked / dropped THIS path". The backend's file manager
//! denies every PC folder outside its allow-list; a path the user chose through a native dialog (or dropped from Explorer)
//! is vouched for with the *shell token* — a 256-bit secret in `~/.opendex/shell-token` (mode 0600, created by the
//! backend). Page scripts cannot read that file, so a script — however it got there — cannot widen what is browsable.
//!
//! * `fs_shell_token` — the token, read at call time (the backend creates it on its first start).
//! * `fs_pick_folder` / `fs_pick_files` — native pickers; they return plain paths, which the frontend turns into
//!   `/api/fs/grants` (files) or `/api/fs/folders` (a permanent extra root) calls carrying the token.

use std::path::Path;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// A secret file under `<home>/.opendex/`: trimmed contents, `None` when missing, unreadable or empty.
pub(crate) fn read_secret(home: &Path, name: &str) -> Option<String> {
    let text = std::fs::read_to_string(home.join(".opendex").join(name)).ok()?;
    let secret = text.trim();
    if secret.is_empty() {
        None
    } else {
        Some(secret.to_string())
    }
}

#[tauri::command]
pub fn fs_shell_token(app: AppHandle) -> Option<String> {
    read_secret(&app.path().home_dir().ok()?, "shell-token")
}

fn lossy(path: tauri_plugin_dialog::FilePath) -> Option<String> {
    path.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

/// Native folder picker. `None` = cancelled. Blocks its (async-pool) thread, never the UI thread.
#[tauri::command]
pub async fn fs_pick_folder(app: AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().and_then(lossy)
}

/// Native multi-file picker. Empty = cancelled.
#[tauri::command]
pub async fn fs_pick_files(app: AppHandle) -> Vec<String> {
    app.dialog()
        .file()
        .blocking_pick_files()
        .map(|files| files.into_iter().filter_map(lossy).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::read_secret;
    use std::fs;
    use std::path::PathBuf;

    fn home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("opendex-files-rs-{}-{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".opendex")).unwrap();
        dir
    }

    #[test]
    fn reads_and_trims_the_secret() {
        let dir = home("trim");
        fs::write(dir.join(".opendex").join("shell-token"), "abc123\n").unwrap();
        assert_eq!(read_secret(&dir, "shell-token").as_deref(), Some("abc123"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_or_blank_is_none() {
        let dir = home("blank");
        assert_eq!(read_secret(&dir, "shell-token"), None);
        fs::write(dir.join(".opendex").join("shell-token"), "  \n").unwrap();
        assert_eq!(read_secret(&dir, "shell-token"), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
