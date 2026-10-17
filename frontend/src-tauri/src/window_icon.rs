// Crisp window / taskbar icon on Windows.
//
// Tauri hands every window ONE bitmap — the first entry of icons/icon.ico, decoded to RGBA — and Windows then scales that single
// bitmap to whatever the taskbar, title bar and Alt-Tab ask for (24/30/36 px for the taskbar at 100/125/150 %). Scaling is what
// makes the icon look blurry. The .ico embedded in the exe (resource 32512, written by tauri-build) already holds a hand-tuned
// frame for every size, so this plugin asks Windows for the exact-size frame and installs it with WM_SETICON:
//   ICON_BIG   -> taskbar size   (24 px at 100 % scale)
//   ICON_SMALL -> title-bar size (16 px at 100 % scale)
// It runs for every window (main, PiP, Workspace PiP) and again when a window moves to a monitor with another scale.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    const APP_ICON_RESOURCE: usize = 32512; // IDI_APPLICATION: where tauri-build embeds icons/icon.ico
    const IMAGE_ICON: u32 = 1;
    const WM_SETICON: u32 = 0x0080;
    const ICON_SMALL: usize = 0;
    const ICON_BIG: usize = 1;

    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn LoadImageW(
            instance: *mut c_void,
            name: *const u16,
            kind: u32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> *mut c_void;
        fn SendMessageW(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> isize;
    }

    /// Installs the exact-size frames for `scale` (1.0 = 100 %). A frame that is missing leaves the previous icon untouched.
    pub fn apply(hwnd: *mut c_void, scale: f64) {
        let big = (24.0 * scale).round() as i32;
        let small = (16.0 * scale).round() as i32;
        unsafe {
            let module = GetModuleHandleW(std::ptr::null());
            for (kind, size) in [(ICON_BIG, big), (ICON_SMALL, small)] {
                let icon = LoadImageW(module, APP_ICON_RESOURCE as *const u16, IMAGE_ICON, size, size, 0);
                if !icon.is_null() {
                    SendMessageW(hwnd, WM_SETICON, kind, icon as isize);
                }
            }
        }
    }
}


pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("window-icon")
        .on_window_ready(|_window| {
            #[cfg(windows)]
            if let (Ok(hwnd), Ok(scale)) = (_window.hwnd(), _window.scale_factor()) {
                win::apply(hwnd.0 as *mut std::ffi::c_void, scale);
            }
        })
        .on_event(|_app, _event| {
            #[cfg(windows)]
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::ScaleFactorChanged { scale_factor, .. },
                ..
            } = _event
            {
                use tauri::Manager;
                if let Some(Ok(hwnd)) = _app.get_webview_window(label).map(|w| w.hwnd()) {
                    win::apply(hwnd.0 as *mut std::ffi::c_void, *scale_factor);
                }
            }
        })
        .build()
}
