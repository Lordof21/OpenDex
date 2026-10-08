# Documentation screenshots

Regenerates every image in [`docs/images/`](../../docs/images/) from the **real frontend** — no phone, no backend, no network.

```bash
cd frontend && npm ci && cd ..        # once
tools/screenshots/run.sh              # all 15 images, ≈ 4 minutes
tools/screenshots/run.sh hero files   # only these
```

Needs Node 18+, Playwright with a Chromium (set `PLAYWRIGHT_PATH` to its node module if `require('playwright')` does not resolve),
and Python 3 with Pillow (the captures are published as WebP: 150–200 KB instead of 700 KB). `run.sh` starts the Vite dev server on
`:5173`, takes the shots, stops it.

## What is real and what is sample

| | |
|---|---|
| **Real** | The whole UI: the React app is served unmodified by its own dev server, and every pixel of every panel, taskbar, dialog and window frame is what a user sees. The REST/WebSocket *client* code, the stores, the video pipeline (`videoDecoder.js`, frame pacer, canvas) and the error handling all run. |
| **Sample** | What is on the other end of the wire. [`mock/backend.cjs`](mock/backend.cjs) answers the app's calls to `127.0.0.1:8710` at the browser boundary (Playwright `route` / `routeWebSocket`), from [`mock/sample-data.json`](mock/sample-data.json) and [`mock/fixtures.cjs`](mock/fixtures.cjs). |
| **Illustrations** | The *contents of the mirror windows*. Real streams are H.264 from a phone; automation browsers have no H.264 decoder and a screenshot must not carry someone's real apps, so [`mock/media.js`](mock/media.js) swaps WebCodecs' `VideoDecoder` for one that paints a drawing from [`mock/scenes.js`](mock/scenes.js) ("Clips", "Notes", "Chat" — fictional apps, plain shapes). The packets that reach it are real scrcpy-framed packets. |

The imaginary phone is "Example Phone" with fictional apps (`com.example.*`) — no real device, account, network, track or person
appears. App icons are generated letters; thumbnails are gradients; addresses are RFC 5737 documentation addresses.

The UI is Turkish today, so the screenshots are too; the sample notifications and apps are English so the pictures read either way.

## Why it is trustworthy

* **The sample data comes from the backend's own code** wherever that code is pure: [`gen_fixtures.py`](gen_fixtures.py) builds the
  settings (`ProjectSettings`), the windows (`WindowState`), the Battery page's report (`battery_health.build_report`), the boot
  snapshot (`StartupSnapshot`), the per-app audio state (`AppAudioState.public`), the notifications (`RichNotificationItem`), the
  file manager's places and entries (`fs.models`), the QR payload (`QrPayload`) and the Phone Load findings
  (`telemetry.insights.compute` — the Turkish sentences are the product's own).
* `backend/tests/test_screenshot_fixtures.py` fails when that file is stale, when a typed part no longer validates against
  [`docs/api/openapi.json`](../../docs/api/openapi.json), or when the mock answers a route the API no longer has.
* The run **fails (exit 1)** if the app logs a console error or asks for something the sample backend does not know
  (`mock: not implemented`) — a new screen that needs more sample data is noticed, not silently painted empty.
* Every shot is "taken" at the same instant (`2026-10-06 11:24 Europe/Istanbul`, Playwright's fixed clock), so clocks and relative
  times do not change from run to run.

This tool has already paid for itself twice: it showed that grid thumbnails in the file manager were requested for the *folder* instead
of the file (fixed in `FileIcon.jsx`), and that `NotificationCard` gave React a ref warning inside `AnimatePresence`.

## Adding a screenshot

1. Add a function to `SCENARIOS` in [`shoot.cjs`](shoot.cjs): open the app (`desktop(browser)` for the three-window desktop, or
   `openApp(browser, { mutate })` to change the sample world first), drive the **real UI** (click the real button — prefer its
   `aria-label`), wait for animations to settle, `page.screenshot({ path: path.join(RAW, 'name.png') })`, `finish(session)`.
2. If the screen asks for data the mock lacks, add the route to `routes` in `mock/backend.cjs` (the test checks it exists in the API)
   and, if the backend derives it, build it in `gen_fixtures.py` rather than typing it.
3. `tools/screenshots/run.sh yourscene`, **look at the image**, then reference it from the docs.

Window contents are drawn per *scene*; to show another sample app, add a function to `scenes.js` and map its package in
`SCENE_OF` (`mock/fixtures.cjs`).

## Known limits

* The stream HUD (RTT / FPS) is hidden with its own `F8` shortcut: its numbers would describe the sample stream, not a phone.
* Nothing here proves behaviour on a real phone — it proves the UI renders what the documented API says. Real-device checks are
  listed in [`docs/DEVICE_CHECKLIST.md`](../../docs/DEVICE_CHECKLIST.md).
