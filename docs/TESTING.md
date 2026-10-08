# Testing

What is tested, how to run it, what each layer can and cannot prove — and the part that **only a real phone** can check.

| Layer | Where | Count | Runs on |
|---|---|---|---|
| Backend | `backend/tests/` (pytest + pytest-asyncio) | ≈ 2 140 | CI (Linux), any machine |
| Frontend | `frontend/tests/` (Vitest + Testing Library, jsdom) | ≈ 1 750 | CI (Linux), any machine |
| Phone helper, pure Java | `backend/java/test/` via `test_java_pure_classes.py` | 1 module | any machine with a JDK; skipped without |
| Contracts & generated docs | `test_openapi_snapshot.py`, `test_docs_generated.py`, `test_screenshot_fixtures.py`, `apiContract.test.js`, input/event fixtures | ~25 | with the suites above |
| Visual verification | `tools/*` Playwright harnesses, `tools/screenshots` | by hand | a Chromium |
| **On a real phone** | [DEVICE_CHECKLIST.md](DEVICE_CHECKLIST.md) | by hand | a phone |

## Run

```bash
cd backend  && python -m pytest -q              # backend (≈ 1–2 min)
cd backend  && python -m ruff check app         # lint — what CI enforces
cd frontend && npm test                         # frontend (≈ 1 min)
cd frontend && npm run build                    # the bundle still builds
python scripts/docgen.py --check                # generated docs are current
```

No test needs a phone, a network or an Android SDK. Anything that does is not in these suites (and is on the checklist).

## What the backend tests are

* **Behaviour of the decisions**, preferably pure: the density reconciler, the resize gate, the battery report, the load insights, the audio route reconciler,
  the transfer engine, path/name rules. They take facts in and return what should happen.
* **The wire**: the scrcpy frame headers, the daemon's line protocol and framing, the file-system wire, the audio link — and **in both languages**:
  `test_java_pure_classes.py` compiles the daemon's pure Java classes and runs them on a plain JVM against the Python side (the HMAC the client
  answers is the one the daemon verifies; a request line the client builds is what the daemon parses; a reply the daemon encodes is what the client decodes, byte for byte).
* **The security rules**: bearer token on every route and socket, Origin/Host guard, body limits, security headers on refusals too, the shell token, the
  phone and PC path allow-lists (`test_api_auth.py`, `test_origin_guard.py`, `test_daemon_auth.py`, `test_fs_*`).
* **The fakes are honest**: a fake adb server speaking the real *sync* protocol, a fake daemon, fake scrcpy sockets — so the code under test runs
  its real parsing, timing and error paths. `conftest.py` gives the suite a fixed API token and hermetic settings (a developer's local `.env` never changes what a
  test means).

## What the frontend tests are

Stores and pure helpers (the window model, the media model, the audio mixer, the sync calibration DSP), and components with real stores and real children —
only the network boundary (`lib/api.js`) and layout measurements (jsdom measures nothing) are faked. `apiContract.test.js` reads the frontend's API client and
checks that **every path the UI calls exists in the backend**; `tests/fixtures/` pin the shapes of events and input messages on both sides.

## Contracts that fail loudly

| Test | Fails when |
|---|---|
| `test_openapi_snapshot.py` | the public OpenAPI document, the middleware rules it states, or the device-guard markers drift from the code |
| `test_docs_generated.py` | a generated doc is stale, or an event / command / message type / daemon command is undocumented |
| `test_screenshot_fixtures.py` | the screenshot sample data is stale, no longer matches the API schemas, or the mock answers a route that no longer exists |
| `apiContract.test.js` | the UI calls a path the backend does not have |
| `test_route_manifest.py` | the route table the frontend depends on changes unannounced |

## Visual verification

`tools/` keeps the Playwright harnesses used while building UI features: they open the **real component** (or the whole app) in Chromium against a fake
backend, assert on layout, focus, keyboard and console errors, and write screenshots. They are not part of CI. `tools/screenshots` is the general one — it also
produces the documentation images ([its README](../tools/screenshots/README.md)). A mutation harness for the file-manager tests lives in
`tools/dosya-sistemi-dogrulama/mutasyon` (it breaks the source on purpose and checks that a test notices).

## The real-phone checklist

Some behaviour exists only on hardware: hand-off of an app between displays, density after a size change, the first frame after a window opens, a
dropped Wi-Fi link, audio you can *hear* in step, a battery page that reflects *your* phone. Those checks, with what to look for in the log when
one fails, are in [DEVICE_CHECKLIST.md](DEVICE_CHECKLIST.md) (Turkish for now). **A change that touches them is not done until someone has run its section on a
phone** — and the pull-request template asks which sections were run.

## CI

`.github/workflows/` has two workflows, run on every pull request that touches what they cover:

* **Backend CI** — `ruff check app` and the whole backend `pytest` run. That run already contains the documentation drift tests, the OpenAPI snapshot and, because the runner has a JDK,
  the phone helper's JVM tests.
* **Frontend CI** — `npm test` and a production `npm run build` (with the obfuscation step off: it only slows CI down).

A change to the frontend or the docs does not need a phone to be reviewed, but a change to the daemon, the window manager or the audio path does need the checklist.
