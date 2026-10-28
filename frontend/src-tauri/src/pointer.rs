// Mouse button state for the PiP window. While the OS resizes a frameless window (`startResizeDragging`) Windows runs its own modal
// loop: the page gets resize events but NO pointer events, so it cannot see the moment the button is released. The PiP asks here
// instead, and re-requests the stream size only once the button is up (src/window/pip/pipBridge.js `isPrimaryButtonDown`).

/// True while the PRIMARY mouse button (the one that drags / resizes) is physically held. False elsewhere than Windows.
#[tauri::command]
pub fn primary_button_down() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};

        // GetAsyncKeyState reports the PHYSICAL buttons: with swapped buttons (left-handed setting) the primary one is the right.
        let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
        let key = if swapped { VK_RBUTTON } else { VK_LBUTTON };
        // the high bit = down right now
        return (unsafe { GetAsyncKeyState(key.0 as i32) } as u16) & 0x8000 != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}
