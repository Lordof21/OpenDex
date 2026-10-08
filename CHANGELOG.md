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
- The security headers (`nosniff`, `no-store`, …) are now also sent on the `401`/`403`/`411`/`413` answers of the middleware.
- `docker-compose` publishes the UI on loopback only.
- Release builds keep the WebView inspector (right-click → Inspect, F12) available; the obfuscator options that fight an inspector are off.
- The installer is built in Turkish (`OpenDeX_0.1.0_x64_tr-TR.msi`), the only language the interface has.
- The backend log file gets INFO and above by default; log and telemetry files older than 7 days are deleted at start and the folder is kept under 150 MB.
- The stream HUD (F8) is hidden by default.
- "İkisi" audio: the DeX copy starts with a 60 ms jitter margin (was 30), raises it faster after late chunks and gives it back after three calm minutes (was 48 s), so a resize burst on Wi-Fi is less likely to cut the sound.

### Fixed
- File manager: grid thumbnails were requested for the folder instead of the file, so they never showed.
- Notification cards forward their ref (React warning inside `AnimatePresence`).
- A phone that adb lists but cannot talk to ("device offline") no longer causes an endless bind/reload loop: failed binds now back off (2 s … 30 s) for API callers too, and the QR pairing panel is not torn down by the momentary "connected" state of a failing attempt.
- The phone helper (`opendex-tools.jar`) compiles again against the public SDK (compile-only `IContentProvider` stub), and the release exe no longer embeds the builder's home directory.

### Removed
- Obsolete planning and analysis reports from the repository root; the compiled backend sidecar and developer-specific files from version control.
