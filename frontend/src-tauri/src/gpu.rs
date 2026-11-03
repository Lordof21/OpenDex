// Which graphics processor draws the desktop interface (the WebView2 renderer).
//
// On a laptop with an integrated GPU and a dedicated card, Windows gives a browser engine the integrated one by default:
// the interface then lives in shared system RAM (measured: ~1 GB with one 1080p stream, docs/research/WEBVIEW2_MEMORY.md),
// and a graphics-driver regression shows up in this app and nowhere else. The user can pick the card in Settings.
//
// The choice has to be known BEFORE the webview exists (a WebView2 environment takes its command line once), and the backend
// is not up yet then — so it is a small file of its own in the app's config folder, read first thing in `main`:
//
//     %APPDATA%\com.opendex.desktop\gpu_preference     one word: auto | high_performance | software
//
// `auto` adds nothing (Windows decides: its Graphics settings for the app apply). The other two become a Chromium switch,
// appended to WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (WebView2 adds that variable to the arguments Tauri itself passes).
// The setting is therefore applied at the next start; `gpu_preference` reports both what is saved and what this run uses,
// so the Settings page can say "restart to apply".

use serde::Serialize;
use std::{fs, path::PathBuf, sync::OnceLock};

const AUTO: &str = "auto";
const HIGH_PERFORMANCE: &str = "high_performance";
const SOFTWARE: &str = "software";

#[cfg(windows)]
const IDENTIFIER: &str = "com.opendex.desktop";
const ENV_ARGS: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// What this run started with (set once by `apply_saved_preference`).
static ACTIVE: OnceLock<&'static str> = OnceLock::new();

/// A known mode, or `auto` for anything else (an edited or older file never breaks the start).
fn normalize(raw: &str) -> &'static str {
    match raw.trim() {
        HIGH_PERFORMANCE => HIGH_PERFORMANCE,
        SOFTWARE => SOFTWARE,
        _ => AUTO,
    }
}

/// The Chromium switch of a mode. `--force_high_performance_gpu` is honoured by WebView2 runtime 145+ (measured on 155: the
/// ANGLE renderer changes from the integrated Radeon to the RTX); `--disable-gpu` is the long-standing software fallback.
fn switch_of(mode: &str) -> Option<&'static str> {
    match mode {
        HIGH_PERFORMANCE => Some("--force_high_performance_gpu"),
        SOFTWARE => Some("--disable-gpu"),
        _ => None,
    }
}

/// Our switch added to whatever the environment already carries (a developer may have set the variable for a test).
fn merged_args(existing: Option<&str>, switch: &str) -> String {
    match existing.map(str::trim) {
        Some(args) if !args.is_empty() => format!("{args} {switch}"),
        _ => switch.to_string(),
    }
}

fn preference_file() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join(IDENTIFIER).join("gpu_preference"))
    }
    #[cfg(not(windows))]
    {
        None // WebKit on the other platforms has no such switch
    }
}

fn saved_mode() -> &'static str {
    preference_file()
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|text| normalize(&text))
        .unwrap_or(AUTO)
}

/// First thing in `main`, before the Tauri builder: nothing else may have created a webview yet.
pub fn apply_saved_preference() {
    let mode = saved_mode();
    let _ = ACTIVE.set(mode);
    if let Some(switch) = switch_of(mode) {
        let merged = merged_args(std::env::var(ENV_ARGS).ok().as_deref(), switch);
        std::env::set_var(ENV_ARGS, merged);
    }
}

#[derive(Serialize)]
pub struct GpuPreference {
    /// False where the choice does not exist (not Windows): the Settings page hides it.
    supported: bool,
    /// What the file says now (applies at the next start).
    saved: &'static str,
    /// What this run was started with.
    active: &'static str,
}

#[tauri::command]
pub fn gpu_preference() -> GpuPreference {
    GpuPreference { supported: cfg!(windows), saved: saved_mode(), active: ACTIVE.get().copied().unwrap_or(AUTO) }
}

#[tauri::command]
pub fn set_gpu_preference(mode: String) -> Result<(), String> {
    let mode = match mode.as_str() {
        AUTO | HIGH_PERFORMANCE | SOFTWARE => mode.as_str(),
        other => return Err(format!("unknown GPU mode: {other}")),
    };
    let path = preference_file().ok_or_else(|| "the GPU choice is not available on this platform".to_string())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, mode).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_or_damaged_content_means_auto() {
        assert_eq!(normalize("high_performance\n"), HIGH_PERFORMANCE);
        assert_eq!(normalize(" software "), SOFTWARE);
        assert_eq!(normalize("auto"), AUTO);
        assert_eq!(normalize("turbo"), AUTO);
        assert_eq!(normalize(""), AUTO);
    }

    #[test]
    fn only_the_two_explicit_modes_carry_a_switch() {
        assert_eq!(switch_of(AUTO), None);
        assert_eq!(switch_of(HIGH_PERFORMANCE), Some("--force_high_performance_gpu"));
        assert_eq!(switch_of(SOFTWARE), Some("--disable-gpu"));
    }

    #[test]
    fn our_switch_is_added_to_what_the_environment_already_has() {
        assert_eq!(merged_args(None, "--disable-gpu"), "--disable-gpu");
        assert_eq!(merged_args(Some("  "), "--disable-gpu"), "--disable-gpu");
        assert_eq!(merged_args(Some("--remote-debugging-port=9333"), "--disable-gpu"), "--remote-debugging-port=9333 --disable-gpu");
    }

    #[test]
    fn a_mode_nobody_knows_is_refused() {
        assert!(set_gpu_preference("turbo".into()).is_err());
    }
}
