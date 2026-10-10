# Changelog

All notable changes are recorded here, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The project is pre-1.0 and has no published release yet; the history before this file
is in `git log` (mostly in Turkish).

## [Unreleased]

### Added
- First public documentation set: README (EN/TR), install, architecture, API (with a generated OpenAPI 3.1 document and reference), configuration reference, phone-helper protocol, audio, security model, testing, troubleshooting, FAQ, roadmap.
- `tools/screenshots`: documentation images generated from the real UI against sample data.
- `OPENDEX_NO_OBFUSCATE=1` / `build_release.py --no-obfuscate` for plain, debuggable builds.
- Drift tests that fail when generated documentation, the OpenAPI document, the sample-data fixtures or the daemon-protocol tables fall out of step with the code.

### Changed
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
