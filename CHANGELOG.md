# Changelog

All notable changes are recorded here, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The project is pre-1.0 (first public build: 0.9); the history before this file
is in `git log` (mostly in Turkish).

## [Unreleased]

## [0.9.2] - 2026-11-11

### Added
- **Pre-landing is now a choice: Automatic / On / Off**, for every window and for the whole system. Before a window goes to the phone, OpenDeX can bring its virtual display to the phone's own size and density, so the app is rebuilt behind the PC veil instead of on the phone. *Automatic* (the default, what the old switch did when it was on) skips it for an app that would be rebuilt both at the pre-landing and at the move, so its page is not reloaded twice; *On* does it on every eligible send; *Off* never does it (size and DPI change on the phone in one step, with the move). Where to set it: the window's Hub (a new "Pre-landing" row under the window tiles, cycling *Follow general → Automatic → On → Off*), DeX Settings › Window (this window only) and › System (general), and Settings › Windows. A window's own choice wins over the general one and travels with the hand-off request (`POST /api/windows/handoff` takes `prelanding`); the `handoff_prelanding` setting is now `"auto" | "on" | "off"` (an old `true` / `false` is read as `auto` / `off`). Why it exists: X keeps a separate feed position for the wide and the compact layout, so a hand-off that switches between them loses the place wherever the switch happens.

### Changed
- A browser window that only changes size keeps its process: after a resize at another density the settle no longer restarts Chrome (every page used to reload from its top); the tab watcher already gives every tab the window's scale.
- Resizing a browser window keeps the place of the page in front: the place is read before the display changes and put back afterwards (measured: 1440 → 448 → 1440 px kept page 30 of a chapter at 50 / 50.2 / 50.5 %).
- The desktop UI shows the app's real version (v0.9.2) on the start screen; the installer and the portable package carry it in their file names (`OpenDeX_0.9.2_…`), so a new installer upgrades an installed one.

### Fixed
- A reader's place on pages that scroll an inner box (a site's mobile layout scrolled a full-height box while the window had 56 px, so the page came back at its top) is found and restored by whatever scrolls the page.
- A manga reader that keeps the tallest height a page ever had left 78–103 px of nothing under every page after a narrower width: the tab watcher now notices pages left at the old width's heights and reloads them to the place of before.
- A watcher that cannot reach the browser no longer holds a hand-off for its whole timeout; its socket closes in 0.3 s instead of waiting 10 s for a close frame Chrome never sends.

### Performance
- Handing a browser to the phone no longer shows the desktop page for 2–5 s first. The site is decided before the move: when the pre-landing put the window's display at the phone's own size and density, the phone's tab watcher starts there and the move waits (at most 3.5 s) until the tab in front is the right site. Whether a site serves another page to the other identity is remembered per site and direction (24 h), re-checked behind the decision so a stale answer is corrected in the same hand-off; a page the watcher reloads is restored at DOMContentLoaded with the browser's own scroll restoration held off.

### Translations
- The new strings are translated into 18 languages.

## [0.9.1] and earlier

### Added
- Multi-app sound (the phone's "several apps play at once" flag): Settings › Sound card with the live state, the time of the last reading and a **Check again** button; one-click, read-back-verified **Turn on** (policy *Ask* by default, *Always*, *Never*); restored when the last window closes; a once-per-run offer when one app pauses another; a mixer pill and a DeX panel shortcut. New daemon command `audio_multi_focus` (rebuild the helper jar), `GET/POST/PUT /api/audio/multi-focus`, event `multi_audio_focus_update`, setting `multi_audio_focus_policy` ([design/MULTI_APP_SOUND.md](docs/design/MULTI_APP_SOUND.md)).
- First public documentation set: README (EN/TR), install, architecture, API (with a generated OpenAPI 3.1 document and reference), configuration reference, phone-helper protocol, audio, security model, testing, troubleshooting, FAQ, roadmap.
- `tools/screenshots`: documentation images generated from the real UI against sample data.
- `OPENDEX_NO_OBFUSCATE=1` / `build_release.py --no-obfuscate` for plain, debuggable builds.
- Drift tests that fail when generated documentation, the OpenAPI document, the sample-data fixtures or the daemon-protocol tables fall out of step with the code.

### Fixed
- The OpenDeX Settings window now shows in the taskbar like any other task (icon, open / active / minimized state; click minimizes or restores it) — the entry was missing, so it never appeared.
- "Maximize" on the Settings window no longer slides under the taskbar: its stage ends above the taskbar strip (and follows a screen resize).
- `Ctrl` + mouse wheel (and `Ctrl` `+` / `-` / `0`, touchpad pinch) zooms the desktop UI in the native window like in Chrome (`zoomHotkeysEnabled`; WebView2's zoom control was off). Over a phone window `Ctrl` + wheel is still the pinch gesture sent to the phone.

### Changed
- Device manager (docs/design/DEVICE_MANAGER.md): a phone's USB and Wi-Fi links are one device (the backend reads each link's ANDROID_ID once: `DeviceInfo.android_id`), saved devices are matched to it by identity instead of a guessed `ip:port`, and adb's own state (unauthorized, offline) reaches the UI with what to do about it. The Device Center has a USB | Wi-Fi link switcher with an in-progress state, inline confirmations (closing windows, forgetting), a right-click / ⋯ / Shift+F10 menu (connect, switch link, disconnect, rename, copy serial or IP, forget) and in-place renaming (`PATCH /api/devices/known/{android_id}`, `KnownDevice.alias`). One "Cihaz bağla" dialog replaces the QR panel: my devices (plugged in, on the network, saved, USB instructions) next to the pairing methods.
- Quitting the desktop app ends the backend gracefully: the shell asks first (`POST /api/system/shutdown`, so windows close and the phone's scrcpy servers and virtual displays stop) and kills the sidecar only if it has not ended within 8 s — a kill skips that cleanup. If the shell dies without asking (crash, Task Manager), the backend notices its `OPENDEX_PARENT_PID` is gone and ends itself the same way instead of staying orphaned on port 8710.
- Tapping a notification sends its own PendingIntent onto the window's display (daemon `notif_invoke launch`, sender mode `ALLOW_ALWAYS` — the plain mode is blocked for a shell sender on Android 16) instead of rebuilding an `am start` from the intent's text, which dropped the extras and fell back to the app's home feed; focusing a window no longer starts the app's launcher page on top of it (`hold_launch`). It is the only path: the per-app routes and the Tier 1/2/3 ladder (`deep_navigator`: 632 → 213 lines) are gone, so a failure is logged with its reason and `POST /api/notifications/open` answers `ok: false` instead of hiding it.
- Quick settings: the master volume slider is gone (it moved the DeX output and the phone's media volume at once); per-app audio and the phone's own Android streams remain. The six toggles keep a fixed size at the top of a panel whose height no longer depends on the page.
- The OpenDeX apps (Files, Settings, Phone mirror, Workspace) have their own icon artwork (`frontend/src/assets/icons`).
- `scripts/build_release.py --pyinstaller` builds the backend sidecar with PyInstaller (about a minute, ~31 MB) instead of Nuitka; the spec excludes the unrelated packages of a crowded dev environment.
- The security headers (`nosniff`, `no-store`, …) are now also sent on the `401`/`403`/`411`/`413` answers of the middleware.
- `docker-compose` publishes the UI on loopback only.
- Release builds keep the WebView inspector (right-click → Inspect, F12) available; the obfuscator options that fight an inspector are off.
- The installer is built in Turkish (`OpenDeX_0.1.0_x64_tr-TR.msi`), the only language the interface has.
- The backend log file gets INFO and above by default; log and telemetry files older than 7 days are deleted at start and the folder is kept under 150 MB.
- The stream HUD (F8) is hidden by default.
- "İkisi" audio: the DeX copy starts with a 60 ms jitter margin (was 30), raises it faster after late chunks and gives it back after three calm minutes (was 48 s), so a resize burst on Wi-Fi is less likely to cut the sound.

### Fixed
- "Bağlantıyı kes" did not keep the phone disconnected: the bootstrap (and every API call through `ensure_device`) bound the still-plugged cable or the open Wi-Fi link again within seconds. A user disconnect now pauses automatic connecting until the user picks a device (`auto_connect_paused` in the device state), and the connect dialog opens with their devices. On USB it also ran a bare `adb disconnect`, which dropped every other wireless link adb held; only the session's own Wi-Fi link is released now.
- "Back to USB" could pick another phone's USB link; it now only offers the same phone's. Picking another phone no longer tries to migrate this phone's windows onto it: the session changes cleanly (`device_lost` reason `device_switch`) after the UI asked whether the open windows may close. `POST /api/device/bind` answers `502` with the reason instead of a `500`.
- Battery page: a placeholder design capacity (Xiaomi's power profile says 1000 mAh) no longer hides the real capacity; when the battery takes more than the port's reported limit (a vendor fast charger on a stale 500 mA / SDP default) the measured value wins and the "slow port" verdict is not drawn; long values wrap instead of being cut with "…". The "reaches N °C in 10 min" extrapolation is gone, only the measured trend is shown.
- Saved Wi-Fi networks listed once per security type (WPA2 + WPA3 under one id) produced duplicate React keys; they are folded into one row.
- File manager, phone layout: "Up" and previewing with ←/→ no longer leave a file selected (which switched the toolbar into selection mode).
- The taskbar panels are `forwardRef` components, so `AnimatePresence` can measure them (React "ref is not a prop" / "Function components cannot be given refs" warnings).
- "İkisi" audio was silent on the phone on Android 12+: the phone-side track waited for its whole (large) buffer to fill before starting, so the aligned writer dropped every chunk. The track now starts after 10 ms of data.
- The backend terminal no longer prints every flow when `OPENDEX_LOG_LEVEL=DEBUG` is set (media covers, notifications, temperatures and every RPC flooded it). That level now only adds DEBUG lines to the log file; the terminal shows the flows named in `OPENDEX_TRACE`.
- Audio on a weak or unstable link: the Android ≤ 12 session stream reopens itself when its adb socket ends (it stayed silent until a window opened); the phone → PC channel never loses a stream's end, sends a keepalive when idle and is reconnected when it goes silent; the browser's playback cushion adapts to the link instead of a fixed 50 ms. The phone-side part needs a rebuilt `opendex-tools.jar`.
- File manager: grid thumbnails were requested for the folder instead of the file, so they never showed.
- Notification cards forward their ref (React warning inside `AnimatePresence`).
- A phone that adb lists but cannot talk to ("device offline") no longer causes an endless bind/reload loop: failed binds now back off (2 s … 30 s) for API callers too, and the QR pairing panel is not torn down by the momentary "connected" state of a failing attempt.
- A phone that adb reports as offline / unauthorized is no longer asked again by every background loop at once (eleven `adb.exe` processes in two seconds for one app-list request): after adb's verdict the same phone is not asked for 2 s, until the device list changes. Uncaught adb errors answer `503` with a readable sentence instead of a `500` and a page-long traceback.
- Opening or resizing an app no longer costs a dozen `pidof` round trips to the phone: the density reconciler now waits for "the process died / was reborn" on the phone in one shell call instead of asking every 0.15–0.25 s (it falls back to asking when the phone cannot run the loop).
- The phone helper (`opendex-tools.jar`) compiles again against the public SDK (compile-only `IContentProvider` stub), and the release exe no longer embeds the builder's home directory.

### Removed
- Obsolete planning and analysis reports from the repository root; the compiled backend sidecar and developer-specific files from version control.
