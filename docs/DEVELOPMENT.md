# Development guide

How to get the code running, where things live, and the conventions a change is expected to follow.
(Contribution *process* — issues, pull requests, review — is in [CONTRIBUTING.md](../CONTRIBUTING.md).)

## Repository map

```text
backend/        Python 3.11+ — FastAPI app, the part that talks to adb / scrcpy / the phone helper
  app/            api/ device/ windows/ streams/ input/ fs/ telemetry/ wireless/ apps/ storage/ schemas/
  java/           the on-phone helper ("daemon", opendex-tools.jar) — Java sources, build script, JVM tests
  scrcpy/         the four patches OpenDeX applies to scrcpy-server v4.1, and the script that builds it
  vendor/         what the backend pushes to the phone: scrcpy-server (upstream + patched), opendex-tools.jar
  tests/          pytest — the backend's contract and behaviour
frontend/       React 18 + Vite + Tailwind + Zustand — the desktop UI
  src/            desktop/ window/ taskbar/ files/ media/ settings/ notifications/ telemetry/ wireless/ state/ ui/ …
  src-tauri/      Tauri 2 shell (Rust): one native window, tray, the backend as a sidecar
  tests/          Vitest (jsdom)
docs/           this documentation — hand-written pages plus generated ones (see below)
scripts/        docgen.py, export_openapi.py, build_release.py, third-party-notices tooling, Windows helper scripts
tools/          screenshots/ (documentation images) and the visual-verification harnesses used while building features
```

How the pieces fit together: [ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

| | |
|---|---|
| Python | 3.11 or newer |
| Node.js | 18 or newer (20 is what CI and the Docker image use) |
| adb | Android platform-tools on `PATH`, or `OPENDEX_ADB_PATH` |
| Phone | A phone with USB debugging for anything beyond the automated tests ([INSTALL.md](INSTALL.md#prepare-the-phone)) |
| Rust + Tauri CLI | **Only** for the native window (`npm run tauri dev`) — [Tauri prerequisites](https://tauri.app/start/prerequisites/) |
| JDK 17+ | **Only** to run the daemon's JVM tests (they are skipped without one) |
| Android SDK + a JDK | **Only** to rebuild `opendex-tools.jar` or the patched scrcpy-server |

## Run it

Two processes, started in this order (the backend first — it creates the API token the UI needs):

```bash
# 1. backend  → http://127.0.0.1:8710
cd backend
python -m venv .venv && . .venv/bin/activate        # Windows: .venv\Scripts\activate
python -m pip install -e ".[dev]"
python -m app.main

# 2. frontend → http://localhost:5173  (proxies /api and /ws to the backend)
cd frontend
npm ci
npm run dev
```

Open <http://localhost:5173>. Run both from **their own directory**: `python -m app.main` finds the `app` package relative to
the current directory, and `npm` finds `package.json` there.

The Vite dev server reads `~/.opendex/api-token` when it starts and hands the token to the page — so if you start the backend for
the first time *after* Vite, restart Vite.

### Native window (Tauri)

```bash
cd frontend
npm run tauri dev        # starts Vite itself (beforeDevCommand) and opens the native window
```

`tauri dev` does **not** compile the Python backend. If `frontend/src-tauri/binaries/opendex-backend-<target-triple>[.exe]` exists
(a build output — [BUILD_AND_RELEASE.md](BUILD_AND_RELEASE.md#the-backend-sidecar)) the shell starts it as a sidecar; if not, it logs a
warning and you keep running `python -m app.main` yourself. Either way the app works.

### Without a phone

The whole test suite and the screenshot tool run with no phone ([TESTING.md](TESTING.md)). To see the UI against sample data:
`tools/screenshots/run.sh` (images) or serve the frontend and point it at
[`tools/screenshots/mock/backend.cjs`](../tools/screenshots/mock/backend.cjs)'s world.

### Docker (UI + API only)

`docker compose up --build` starts the API and the UI behind nginx on loopback (`127.0.0.1:8710`, `127.0.0.1:80`). **It cannot drive a
phone**: the image has no `adb` and no `vendor/` binaries. It exists to exercise the API / UI packaging. Put an
`OPENDEX_API_TOKEN` (≥ 32 characters) in a `.env` next to `docker-compose.yml`; the nginx-served UI gets it from
`/api/auth/bootstrap`, which answers the app's own origins only ([SECURITY_MODEL.md](SECURITY_MODEL.md)).

## Daily commands

```bash
# backend
cd backend
python -m pytest -q                      # ≈ 2000 tests, no phone, ≈ 1–2 min
python -m ruff check app                 # what CI enforces (pyflakes rules)

# frontend
cd frontend
npm test                                 # vitest, ≈ 1700 tests
npm run build                            # production bundle (see BUILD_AND_RELEASE.md: it is obfuscated by default)

# documentation (from the repository root)
python scripts/docgen.py                 # regenerate API reference, configuration reference, protocol blocks
python scripts/docgen.py --check         # what CI / the test suite runs
tools/screenshots/run.sh                 # regenerate docs/images
```

## Generated files — do not edit by hand

| File | Source | Command |
|---|---|---|
| `docs/api/openapi.json`, `docs/api/REFERENCE.md` | the FastAPI routes + `backend/app/api/openapi_export.py` | `python scripts/docgen.py` |
| `docs/CONFIGURATION.md` | `backend/app/config.py` (the comment above each setting is its description) | same |
| generated blocks in `docs/API.md`, `docs/DAEMON_PROTOCOL.md` | `websockets.py`, `events.py`, `OpenDexDaemon.java`, `FsWire.java` | same |
| `docs/images/*.webp` | the real UI against sample data | `tools/screenshots/run.sh` |
| `backend/vendor/opendex-tools.jar` | `backend/java/src` | `python backend/java/build.py` (Windows + Android SDK, below) |

`backend/tests/test_docs_generated.py` and `test_openapi_snapshot.py` fail with the command to run when a generated file is stale — so
a change to a route, a setting, an event or a daemon command is never merged without its documentation.

## Changing the API

1. Add the route in `backend/app/api/v1/endpoints/*.py` with a `response_model` where the answer is stable and a docstring (it becomes the
   operation's description in the reference).
2. If the UI calls it, add it to the frontend's API client; `frontend/tests/apiContract.test.js` pins every path the UI uses against
   the routes the backend actually has.
3. `python scripts/docgen.py`, commit the regenerated files with the change.
4. Anything that must hold for **every** route (token, Origin guard, limits) is middleware, not a per-route check
   ([API.md](API.md#conventions)). A route that acts on the phone depends on `get_active_serial` and is marked `x-requires-device`.

## Changing the phone helper (Java)

`backend/java/src/com/opendex/tools/*.java` runs on the phone under `app_process` as the `shell` user. The protocol is
**additive**: [DAEMON_PROTOCOL.md](DAEMON_PROTOCOL.md#changing-the-protocol). The pure classes (no Android types — shell, auth, `/proc`,
file-system wire) are tested on a plain JVM by `backend/tests/test_java_pure_classes.py`.

The compiled `backend/vendor/opendex-tools.jar` **is committed** (the backend pushes it to the phone), so a change to the Java sources is
not finished until the jar is rebuilt and committed with it:

```bash
python backend/java/build.py            # javac + R8/d8 → backend/vendor/opendex-tools.jar
```

> **Today `build.py` looks for the Android SDK in the Windows locations** (`%LOCALAPPDATA%\Android\Sdk`, `d8.bat`, Android Studio's
> JBR). Making it find an SDK elsewhere is on the [roadmap](ROADMAP.md); until then, rebuild on Windows or ask a maintainer to.
> The backend notices a daemon that runs older bytecode than the jar (it compares MD5s) and restarts it.

## Conventions

* **Comments and docs in English.** Much of the existing code carries Turkish comments and log messages (the project grew up in
  Turkish); new code and every document in `docs/` is English, and a file you touch may be translated as you go.
* **The UI is Turkish today.** User-visible strings are literals in the components; there is no i18n layer yet
  ([ROADMAP.md](ROADMAP.md)). New UI text: keep it short and keep Turkish for now, centralise it if you can.
* **Root cause, not symptom.** The history is full of "fix the one place it showed"; the reconcilers
  (`windows/density_reconciler.py`, `windows/resize_gate.py`, the app-audio reconcile loop) exist because those fixes did not hold.
  If you find yourself adding a third special case, look for the missing owner of that decision.
* **No hidden state.** Backend state that the UI shows is derived and pushed as an event, not polled
  (`devices_changed`, `device_*_update`). Add the event to `backend/app/events.py` with a payload comment — the docs pick it up.
* **Every device command has a fallback.** If a daemon capability is missing, the backend falls back to `adb shell` — see
  `device/android_shell.py`. Do not add a feature that works only with the newest helper.
* **Tests are the specification.** A bug fix comes with a test that fails without it. Prefer testing the pure decision
  (`density_reconciler`, `battery_health.build_report`, `telemetry/insights.py`) over mocking the world.
* **Security-relevant inputs are validated at the API boundary** (`schemas/identifiers.py`): anything that ends up in a shell line or on the
  daemon's line protocol. Never build a shell command from a request field without it.

## Debugging tips

* Backend log: `backend/logs/opendex-YYYYMMDD.log` (INFO and above; set `OPENDEX_LOG_LEVEL=DEBUG` to add DEBUG). Each HTTP request carries an `op_id`
  (`X-Op-Id` header or generated) printed as `[op:xxxxxx]` — a UI action can be followed through every line it caused.
* `OPENDEX_LOG_LEVEL=DEBUG`, or `POST /api/v1/diagnostics/log-level` at run time.
* `OPENDEX_API_DOCS=true` serves Swagger UI at `/docs` for the **running** backend.
* The phone side logs to `/data/local/tmp/opendex-daemon.log` (`adb shell cat …`).
* In the UI, **F8** toggles each window's stream HUD (RTT, FPS, decode queue); the **Phone Load** panel shows what OpenDeX asks of the phone.
* Phone-side checks that cannot be automated are in [DEVICE_CHECKLIST.md](DEVICE_CHECKLIST.md) (Turkish).
