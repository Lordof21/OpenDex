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

### Fixed
- File manager: grid thumbnails were requested for the folder instead of the file, so they never showed.
- Notification cards forward their ref (React warning inside `AnimatePresence`).

### Removed
- Obsolete planning and analysis reports from the repository root; the compiled backend sidecar and developer-specific files from version control.
