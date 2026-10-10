# Building and releasing

How the installer is made from source, what each build artefact is, and what is — honestly — not verified yet.

> **Platform.** The release pipeline is **Windows-first** (PowerShell helpers, the Android SDK lookup in `backend/java/build.py`, MSVC
> for Nuitka and the `.msi`). The Tauri configuration also lists a macOS `.dmg` target; it has not been built or tested. The
> frontend and the backend test suites run anywhere.

## The artefacts

OpenDeX ships **four** things that are built, three of which are committed or bundled as binaries:

| Artefact | Built from | By | Lives in git? | Ends up |
|---|---|---|---|---|
| **UI bundle** | `frontend/src` | `npm run build` (Vite) | no (`frontend/dist/` is ignored) | inside the Tauri app |
| **Backend sidecar** `opendex-backend-<triple>[.exe]` | `backend/app` | `python backend/build_nuitka.py --package-sidecar` (Nuitka → native code) | **no** — a build output, `frontend/src-tauri/binaries/*` is ignored (the folder is kept with a `.gitkeep`) | the installer, started by the Tauri shell |
| **Phone helper** `opendex-tools.jar` | `backend/java/src` | `python backend/java/build.py` (javac + R8/d8) | **yes** — `backend/vendor/opendex-tools.jar` (the backend pushes it to the phone, and runs from a checkout need it) | `vendor/` next to the app |
| **scrcpy-server** | upstream `v4.1` and a patched build | `backend/scrcpy/build.py`; upstream fetched by `scripts/fetch-scrcpy-server.ps1` | **yes** — `backend/vendor/scrcpy-server-v4.1`, `…-opendex` (+ `.sha256`) | `vendor/` next to the app |

Why binaries are committed for the last two: the backend must find them in a source checkout, and a rebuild needs an Android SDK most
contributors do not have. The patched server's provenance is auditable: [`backend/scrcpy/patches/`](../backend/scrcpy/patches) are the
four patches (≈ 185 lines of Java) applied to the tagged upstream commit, and `build.py` rebuilds the binary from them and writes the
checksum. See [`backend/scrcpy/README.md`](../backend/scrcpy/README.md) and [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## One command

```bash
python scripts/build_release.py                 # all four steps
python scripts/build_release.py --skip-backend  # reuse the sidecar already in frontend/src-tauri/binaries/
python scripts/build_release.py --skip-installer
python scripts/build_release.py --no-obfuscate  # plain Java dex and JS bundle (see "Hardening", below)
```

Every step either finishes or stops the whole run; nothing is skipped silently:

1. **Java helper** — `backend/java/build.py`: compiles with `javac`, shrinks and dexes with R8/d8, writes `backend/vendor/opendex-tools.jar`.
   Needs the Android SDK (`platforms/android-*/android.jar`, `build-tools/*/d8`) and a JDK. If the R8 tools are missing the build **fails**
   rather than emit an unprotected jar, unless you pass `--no-obfuscate` on purpose.
2. **UI** — `npm run build` in `frontend/`.
3. **Backend sidecar** — `backend/build_nuitka.py --package-sidecar`: compiles the whole backend (interpreter included) to one native
   binary, verifies that no distinctive source text survived inside it, and copies it to
   `frontend/src-tauri/binaries/opendex-backend-<rustc host triple>.exe` — the name Tauri's `externalBin` expects.
4. **Installer** — `npm run tauri build` (in `frontend/`): bundles the UI, the sidecar and `backend/vendor/` (as a Tauri *resource*, landing
   next to the installed exe, where `resolve_backend_root()` in `config.py` looks for it) into an `.msi`.

### The backend sidecar

`tauri dev` and `tauri build` start the sidecar if `frontend/src-tauri/binaries/opendex-backend-<triple>` exists. The sidecar is a **build output that
you must rebuild yourself** whenever `backend/` changes and the change should show up in the native app:

```powershell
powershell -File scripts\build-backend-sidecar.ps1      # calls build_nuitka.py --package-sidecar
```

Without a sidecar the shell logs a warning and carries on; you then start the backend by hand (`python -m app.main`). A fresh clone has
no sidecar, which is why `npm run tauri dev` works from the first command as described in [DEVELOPMENT.md](DEVELOPMENT.md).

> The PyInstaller path (`backend/opendex-backend.spec`, `pyinstaller_entry.py`) is the quick route and needs no C compiler:
> `python scripts/build_release.py --pyinstaller` builds the whole chain with it (a minute instead of tens of minutes for the backend
> step) and writes the same `binaries/opendex-backend-<triple>.exe`. It packs bytecode, not native code, and embeds `vendor/` in the exe.
> The source is public, so that is a size/start-time trade-off, not a secrecy one; the Nuitka build stays the default.

## Hardening of release builds (obfuscation) — and why you may not want it

The release pipeline makes reverse engineering of the shipped binaries harder:

| Layer | What is done |
|---|---|
| Phone helper (Java) | R8: shrinking, package flattening, debug-info stripping; only entry points are kept (`backend/java/proguard.pro`) |
| UI bundle (JS) | `javascript-obfuscator`: control-flow flattening, string-array encryption, no source maps (`frontend/vite.config.js`). The options that fight an inspector (`debugProtection`, `selfDefending`, `disableConsoleOutput`) are off |
| Backend (Python) | Nuitka native compilation, docstrings stripped, a leak check on the result |
| Shell (Tauri) | `panic = "abort"`; the `devtools` Cargo feature is **on**, so right-click → *Inspect* and F12 work in release builds |

This is *friction, not secrecy*: the project is open source and a determined reader has the source. For the same reason the inspector is
left open and the debugger-hostile obfuscator options are off — a contributor or someone auditing the build should be able to look
inside it. So:

* `npm run build` **obfuscates by default** (that is what the installer gets). **`OPENDEX_NO_OBFUSCATE=1 npm run build`** produces a plain,
  debuggable bundle (≈ 10 s instead of minutes). `python scripts/build_release.py --no-obfuscate` does that for the JS and the Java dex.
* Whether the *official* release should keep the hardening is a maintainer decision recorded in [ROADMAP.md](ROADMAP.md); the
  default has been left as it was.

## Docker

The `docker-compose.yml` stack (API + nginx UI) is for exercising the API and UI packaging, **not** a way to run OpenDeX: the image has no
`adb` and no `vendor/`, so it cannot see a phone. See [DEVELOPMENT.md](DEVELOPMENT.md#docker-ui--api-only).

## Cutting a release

There is no automated release workflow yet. The manual checklist, in order:

1. `main` is green: backend `pytest` + `ruff`, frontend `vitest` + `vite build`, `python scripts/docgen.py --check`.
2. Update [CHANGELOG.md](../CHANGELOG.md); bump the version in `backend/pyproject.toml`, `frontend/package.json`, `frontend/src-tauri/Cargo.toml`
   and `tauri.conf.json`, plus the `version=` of the `FastAPI(...)` call in `create_app()` (`backend/app/main.py`) — they are kept equal by hand today.
3. On a Windows machine with the Android SDK, Rust, Nuitka and a C compiler: `python scripts/build_release.py`.
4. **Run the result on a phone.** Open the app, check that the backend started (the boot screen says so), that the helper's health check passes,
   and walk the relevant parts of [DEVICE_CHECKLIST.md](DEVICE_CHECKLIST.md). Right-click → *Inspect* (or F12) should open the WebView inspector.
5. **Licences.** Re-check [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) against the lock files (a new dependency, or a changed licence, is added by hand). The Rust crates for Windows/macOS were
   not inspected when the file was written — run `cargo deny check licenses` (or `cargo about`) on `Cargo.lock`. MIT/BSD/ISC require their notice to accompany a *binary*: ship the notices file and
   `LICENSES/` with the installer (e.g. as a resource shown in *About*), and attach the dependencies' full licence texts to the release.
6. Tag `vX.Y.Z`, attach the `.msi` and its SHA-256 to the GitHub release. Sign the installer if you have a certificate (the pipeline does not).

### What is not on record yet

No end-to-end run of the whole chain (Nuitka → sidecar → `tauri build` → the installed `.msi` started on a clean machine) is documented, no macOS
bundle has been built, no installer has been code-signed, and reproducible builds are not a goal yet. This page describes the steps as the
scripts implement them. If you build a release, please tell us what broke ([issue form](../.github/ISSUE_TEMPLATE)).
