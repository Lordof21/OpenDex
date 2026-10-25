// WebView2 memory target. Chromium keeps the GPU/renderer memory a stream window used long after the window closed (measured
// 2026-10-23: ~790 MB stayed for minutes); `MemoryUsageTargetLevel = Low` makes the engine drop its caches and page the rest out
// (~46 MB measured). The page keeps running — scripts, timers and sockets are untouched — and `Normal` restores full speed.
// The frontend decides WHEN (src/lib/webviewMemory.js: no live window and no input for a while → low, any activity → normal).

/// `level`: "low" or "normal" (anything else is treated as normal). A failure is logged, never raised: this is an optimisation.
#[tauri::command]
pub fn webview_memory_level(window: tauri::WebviewWindow, level: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows::core::Interface;

        let low = level == "low";
        return window
            .with_webview(move |webview| unsafe {
                let target = if low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                };
                let applied = webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.cast::<ICoreWebView2_19>())
                    .and_then(|core| core.SetMemoryUsageTargetLevel(target));
                if let Err(err) = applied {
                    // an older WebView2 runtime without ICoreWebView2_19 lands here
                    log::warn!("[webview] memory level not applied: {err}");
                }
            })
            .map_err(|e| e.to_string());
    }
    #[cfg(not(windows))]
    {
        let _ = (window, level);
        Ok(())
    }
}
