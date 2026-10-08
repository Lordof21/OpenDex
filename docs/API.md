# OpenDeX backend API

The backend is a local HTTP + WebSocket server (FastAPI) that drives the phone. The bundled desktop UI is one client of
it; this document is what you need to write another one — a script, a Stream Deck plugin, a test rig.

## What is this API for?

OpenDeX is two programs: a **backend** that talks to the phone, and a **UI** that you look at. They are separate on purpose — the UI never touches `adb`; it asks the backend over a
local network connection. That connection *is* this API, and it is useful beyond the bundled UI:

| Piece | What it is | What it is for |
|---|---|---|
| **REST API** (`/api/v1/…`) | ~120 operations: open a window, list apps, set the volume, read the battery, copy a file … | **Commands and reads.** A script, a macro pad, a test rig or another UI can do anything the bundled UI can. |
| **WebSockets** (`/ws/…`) | Long-lived connections | **Live data**: the video of a window, the sound of an app, touch input, and a stream of *events* ("a notification arrived", "the phone was unplugged"). REST would have to poll for these. |
| **OpenAPI document** ([`api/openapi.json`](api/openapi.json)) | A machine-readable *description* of the REST API (the standard OpenAPI 3.1 format): every path, parameter, body, answer, and the authentication rules | **Tooling.** Paste it into Swagger UI / Postman / Insomnia to explore the API, or run it through a code generator (`openapi-generator`, `openapi-typescript`, …) to get a typed client in your language. It is *generated from the code* and a test fails when the two disagree, so it is not documentation that can rot. |
| **API reference** ([`api/REFERENCE.md`](api/REFERENCE.md)) | The same description, rendered for reading | Looking up one operation. |
| **Daemon protocol** ([DAEMON_PROTOCOL.md](DAEMON_PROTOCOL.md)) | How the backend talks to the helper on the phone | Contributors only. **Not** a public API. |

Typical uses: automate a workflow (`curl`/Python), write a client in another language from the OpenAPI file, build a status widget from the event stream, or understand how the
UI and the backend fit together when you change either ([ARCHITECTURE.md](ARCHITECTURE.md)).

| You want to… | Read |
|---|---|
| call a REST endpoint | [reference](api/REFERENCE.md) (every operation) and [`api/openapi.json`](api/openapi.json) (OpenAPI 3.1, machine-readable) |
| know the rules every call follows | this page, [§ Conventions](#conventions) |
| receive live state, or stream video / audio, or inject touch | this page, [§ WebSocket channels](#websocket-channels) |
| talk to the on-phone daemon directly | [DAEMON_PROTOCOL.md](DAEMON_PROTOCOL.md) (not a public API — the backend is its only supported client) |
| change a setting (`OPENDEX_*`) | [CONFIGURATION.md](CONFIGURATION.md) |

> **Stability.** The API is pre-1.0 (`0.x`). `/api/v1` is the contract the bundled UI is tested against
> (`frontend/tests/apiContract.test.js`); breaking changes will move to `/api/v2`. Within `v1`, fields may be *added* to
> responses and events at any time — ignore what you do not know. WebSocket framing and the event names below are part of
> that contract; the human-readable `detail` text of errors is **not** (see [Errors](#errors)).

## Quick start

The backend listens on `http://127.0.0.1:8710`. Every call needs the API token — one secret per user, created with mode
`0600` on first start at `~/.opendex/api-token` (Windows: `%USERPROFILE%\.opendex\api-token`), or set explicitly with
`OPENDEX_API_TOKEN`.

```bash
TOKEN=$(cat ~/.opendex/api-token)

# liveness — the only call that needs no token
curl http://127.0.0.1:8710/api/v1/health
# {"ok":true,"version":"0.1.0","auth":"bearer"}

# the bound phone
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8710/api/v1/devices/state

# an endpoint with a body
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"action":"toggle"}' http://127.0.0.1:8710/api/v1/media/action
```

```python
# live events (pip install websockets)
import asyncio, json, pathlib, websockets

token = (pathlib.Path.home() / ".opendex" / "api-token").read_text().strip()

async def main():
    async with websockets.connect(f"ws://127.0.0.1:8710/ws/events?token={token}") as ws:
        async for frame in ws:
            event = json.loads(frame)
            print(event["type"], event["payload"])

asyncio.run(main())
```

## Conventions

### Base URL and versioning

| Prefix | Meaning |
|---|---|
| `/api/v1/…` | The versioned surface — **use this**. It is the one `api/openapi.json` documents. |
| `/api/…` | The same operations, unversioned. An alias that always tracks the latest version; the bundled UI uses it. |
| `/ws/…` | WebSocket channels. Not versioned (they are documented below, not in OpenAPI). |

Both HTTP prefixes are served by the same code; there is one implementation, not two.

### Authentication

Every `/api/*` request and every `/ws/*` handshake must present the token:

* `Authorization: Bearer <token>` — preferred;
* `?token=<token>` — accepted **only** on `GET` requests and on WebSocket handshakes, because a browser cannot set headers
  on `<img>` loads or `new WebSocket(…)`. A token in the query string of a state-changing request is ignored.

The comparison is constant-time. A missing or wrong token is answered before any route runs: **`401`** with
`WWW-Authenticate: Bearer` (HTTP) or WebSocket close code **`4401`**. Failures are logged at most once per 10 s.

Exempt: `GET /health`, and — only when `OPENDEX_TOKEN_BOOTSTRAP=true` (the Docker/nginx deployment; the desktop build never
enables it) — `GET /auth/bootstrap`, which hands the token to a browser page from one of the app's own origins.

The token never has to travel over HTTP on the desktop: the Tauri shell reads the file and gives it to the webview, the
Vite dev server reads the same file, and scripts read it themselves.

**Listening beyond loopback** is refused at start-up unless `OPENDEX_ALLOW_REMOTE=true` **and** `OPENDEX_API_TOKEN` is set
explicitly (a token the backend generated for itself was never given to anyone else). There is no TLS: put a reverse proxy
in front if you expose it. See [SECURITY_MODEL.md](SECURITY_MODEL.md).

### Browser protection (Origin and Host)

A second, independent lock keeps *other web pages* out — CORS alone does not (simple requests still run their side effect,
WebSockets are outside CORS, DNS rebinding bypasses it):

* a request with an `Origin` header that is not one of the app's own origins (`localhost`, `127.0.0.1`,
  `opendex.localhost`, `tauri.localhost`, plus `OPENDEX_CORS_ORIGINS`) → **`403`** (WebSocket: close code **`4403`**);
  `Origin: null` counts as foreign;
* a `Host` header that is not a loopback or `*.localhost` name (or listed in `OPENDEX_ALLOWED_HOSTS`) → **`403`** / `4403`;
* no `Origin` header (curl, scripts, the Tauri shell) → allowed here — such a client still needs the token.

### Limits

* Request bodies are capped at `OPENDEX_MAX_BODY_BYTES` (default 2 MB): **`413`** when the declared `Content-Length` is
  larger, **`411`** when a body arrives chunked without a `Content-Length`, **`400`** when the length is not a number.
  Applies to `POST`, `PUT`, `PATCH`. File contents never travel through this API as request bodies — the file manager moves
  bytes over adb, not HTTP.
* A single WebSocket message is capped at `OPENDEX_WS_MAX_MESSAGE_BYTES` (default 8 MB, enough for a large clipboard paste).

### Response headers

Every response — including the `401/403/411/413` the middleware answers itself — carries `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `Cache-Control: no-store` (some file-preview responses use
`private, no-store`). Send an `X-Op-Id` request header (letters, digits, `-`, `_`; 16 characters kept) to tag the backend log
lines of that request with your own id.

### Errors

Errors are JSON. The shape is FastAPI's:

```json
{ "detail": "Cihaz bağlı değil." }
```

| Status | Meaning |
|---|---|
| `400` | Malformed request (e.g. a non-numeric `Content-Length`). |
| `401` | Token missing or wrong. |
| `403` | Foreign `Origin` / `Host`; or a shell-only operation without the shell token (below). |
| `404` | Unknown window / icon / saved device / file, or a disabled feature (`Dosya yöneticisi kapalı.`). |
| `409` | The request is valid but the state does not allow it. Most often **no phone is bound** (`x-requires-device` operations — 22 of them, marked in the reference) or the window has no control socket. |
| `411` `413` | Body limits above. |
| `422` | Validation failed. For schema errors `detail` is FastAPI's list of `{loc, msg, type}`; for hand-checked inputs it is a sentence. |
| `500` `502` | The operation failed on the way to the phone (adb, daemon, Wi-Fi). `detail` carries the reason. |
| `501` | The phone cannot do this (e.g. reply to a notification). |
| `503` | A dependency is momentarily unavailable (`clock_unavailable`). |

Two things to know when you write a client:

1. **`detail` is for people, and it is Turkish.** The UI of OpenDeX is Turkish today (see the roadmap), and so are most
   error sentences. Do not parse them. Switch on the **status code**, and — where one exists — on a machine code:
   some endpoints return a snake_case code in `detail` (`not_supported`, `bad_request`, `clock_unavailable`), and the file
   manager returns a structured body:

   ```json
   { "detail": "Dosya bulunamadı.", "code": "not_found", "path": "/sdcard/x.txt", "reason": null }
   ```

   `code` is stable (`not_found`, `permission`, `exists`, `not_a_dir`, `is_a_dir`, `not_empty`, `no_space`, `read_only`,
   `cross_device`, `invalid_name`, `in_use`, …); the full table is `ERROR_TABLE` in
   [`backend/app/fs/errors.py`](../backend/app/fs/errors.py).
2. **Most "failures" of a phone are state, not errors.** A phone that is unplugged, locked or asleep makes many operations
   `409`. Listen to the [`devices_changed` / `device_connected` / `device_lost` events](#event-types) instead of polling.

### The bound device

The backend serves **one phone at a time** (the *bound* device; `GET /devices/state` says which). Operations that act on the
phone are marked `x-requires-device: true` in the OpenAPI document and answer `409` while none is bound. Binding happens
automatically when a phone appears on adb; `POST /device/bind`, `POST /devices/known/{android_id}/connect`, `POST /device/tcpip`
(USB → Wi-Fi), the `/pairing/…` endpoints and `POST /device/disconnect` change it.

### The shell token (`X-OpenDex-Shell`)

Two file-manager operations change what the app may touch on **your PC**: `POST /fs/folders` (add a folder to the file
manager's places) and `POST /fs/grants` (grant access to a path). A web page or a stray script must not be able to widen that
scope even with the API token, so both additionally require `X-OpenDex-Shell: <secret>`, where the secret is the file
`~/.opendex/shell-token` (mode `0600`) that **only the desktop shell** (Tauri) reads — it presents the folder picker the user
actually clicked. Without it: `403`. A third-party client has no use for these two operations.

### Enabling the interactive docs

`/docs` (Swagger UI) and `/openapi.json` (the live schema of the *running* backend, both `/api` and `/api/v1`) exist only with
`OPENDEX_API_DOCS=true` — a development aid, off in the product. They are served outside `/api/`, so they are not behind the
token (they describe; calling an operation from Swagger still needs it). The curated, `v1`-only document is
[`api/openapi.json`](api/openapi.json); it is committed and a test fails when the code and the file disagree.

### Responses without a declared schema

Only 19 of the ~123 operations declare a response model (devices, windows, apps, settings, layout, pairing — the ones with a stable, typed shape). **The other ~104 answer with a JSON
object (or list) that the OpenAPI document does not describe**, so a generated client types them as `object` / `any`. Parameters and request bodies *are* described; only the answer is
prose. The shapes below are what the bundled UI reads; remember the rule that fields may be added.

* **Commands answer `{"ok": true}`** (plus echoed fields such as `key`, `value`, `action`, `package`, `stream_id`). When the *phone* declined, many commands answer **`200` with `"ok": false`**
  (and often `error`) instead of an HTTP error — check `ok`, not only the status code. HTTP errors (`409` no phone bound, `422` bad input, `502` adb or the phone failed) are for what the *request* got wrong.
* **A value the phone could not read is `null` — except on the adb fallback of the two quick reads below.** The two legacy quick reads fall back to `adb` when the phone helper does not answer, and the
  fallback fills in defaults (`level: 100`; `torch` and `rotation_lock` are always `false` there). The honest reads are `GET /device/battery/health` (`null` = unknown) and the `devices_changed` / state events.

| Operation | Answer |
|---|---|
| `GET /startup` | `{device: "searching"\|"waiting"\|"binding"\|"bound", transport: "usb"\|"wireless"\|null, model, daemon: "idle"\|"checking"\|"healthy"\|"unavailable", daemon_attempt, daemon_attempts, daemon_rtt_ms, services: "idle"\|"starting"\|"ready"}` — the boot screen's source; in memory, never touches the phone. |
| `GET /devices/state` | `{devices: [{serial, state, model, transport, is_active, transport_id, …}], active_serial, session: null\|"binding"\|"ready"\|"lost", seq}` — the payload of every `devices_changed` event; `seq` only grows, so a read that arrives after a newer event can be ignored. |
| `GET /device/battery` | `{ok, level, is_charging, charging_type: "USB"\|"AC"\|"WIRELESS"\|"NONE", temperature_c, voltage_mv}` (the helper's reply may carry more). For health, charger, ETA and temperatures use `GET /device/battery/health`. |
| `GET /device/volumes` | `{ok, type: "volumes_update", streams: [{id, name, label, current, max, min, muted}]}`; `POST` takes `{stream_id, value}` and answers `{ok, stream_id, value}`. |
| `GET /device/states` | `{ok, type: "states_update", states: {wifi, bluetooth, mobile_data, mute, airplane_mode, rotation_lock, torch, screen_on, …}, …}` — booleans; `screen_on` is `null` when unknown. `POST` takes `{key, value}`. |
| `GET /device/display-power` | `{ok, on: true\|false\|null, …}` — the real panel state; `POST {on}` answers with the state it verified. |
| `GET /notifications` | A list of `{id, android_key, package, app_name, title, text, big_text, sub_text, lines[], post_time, timestamp, category, importance, active_window_id, is_ongoing, read, shortcut, actions: [{action_id, title, action_type: "reply"\|"button", reply_placeholder}]}`. Arrivals and removals are announced by the `notification_received` / `_updated` / `_cleared` [events](#event-types) (a smaller payload — fetch this list for the full items). Notification text is never written to the log. |
| `GET /media/status` | `{active, package, track_id, title, artist, album, art_ready, state, is_playing, position, duration, speed, sessions[]}` (times in milliseconds; `sessions` lists every player, the top-level fields describe the main one) — or `{active: false, error}`. `?fresh=true` asks the phone instead of the cache. |
| `GET /fs/list` and the rest of `/fs/*` | Entries and transfer jobs; the fields are the `Entry` / `Place` models in `backend/app/fs/models.py` and the transfer-job fields in `backend/app/fs/transfer.py`, and failures carry a stable `code` ([Errors](#errors)). |

If you need one of the remaining shapes, the fastest authority is the handler's docstring (it is the operation's description in the [reference](api/REFERENCE.md)) and the matching
`frontend/src` store that consumes it. Typing these responses is on the [roadmap](ROADMAP.md).

## WebSocket channels

All channels live on the same port as the REST API. The handshake needs the token (`?token=…`) and obeys the Origin/Host
rules; a refusal closes the socket with `4401` / `4403` *before* it opens. Other close codes:

| Code | Meaning |
|---|---|
| `4401` | Token missing or wrong. |
| `4403` | Foreign `Origin` / `Host`. |
| `4404` | Unknown window id (`/ws/video`, `/ws/input`) or no audio for that window (`/ws/audio/{id}`). |
| `1000` / `1001` | Normal close — e.g. the window was closed, or this consumer was replaced (audio). |

<!-- BEGIN GENERATED: ws-routes -->
| Channel | Direction | Purpose |
|---|---|---|
| `/ws/video/{window_id}` | server → client (binary); client → server `keyframe` | One window's H.264 video: scrcpy's 12-byte packet headers followed by NAL units, forwarded as the encoder wrote them (the frontend parses the same layout). The client may send the text `keyframe` when its decoder needs a key frame. |
| `/ws/audio` | server → client (binary) | The phone's session-wide audio: raw PCM (s16le, stereo, 48 kHz), each chunk behind a 12-byte header. Exactly ONE consumer at a time — a new connection replaces the older one, so a second tab or a hot-reloaded page never plays twice. |
| `/ws/audio/{window_id}` | server → client (binary) | One window's own audio (per-app capture, Android 13+): the same PCM framing as /ws/audio. One consumer per window — the newest connection wins, same rule as /ws/audio. |
| `/ws/input/{window_id}` | client → server (JSON) | Touch, scroll and clipboard injection for one window — one persistent connection per window, JSON messages. |
| `/ws/events` | server → client (JSON); client → server (JSON commands) | Backend → client state events (events.py), JSON text frames `{type, payload}`. Also a duplex command channel for the hot paths (media, volume, quick toggles, ping) so a UI needs no HTTP round trip for them. |
<!-- END GENERATED: ws-routes -->

Window ids come from `GET /windows` and from `window_*` events. A window is one phone app on one virtual display.

### `/ws/events` — state, as JSON

Server → client: one JSON object per text frame, always `{"type": <string>, "payload": <object>}`. Every event the
backend decides on is broadcast to every connected client. Each subscriber has a bounded queue (256); a client that cannot
keep up loses its **oldest** events rather than slowing the backend down — so treat events as *hints to re-read state*
where it matters (`devices_changed` → `GET /devices/state`), and do not rely on seeing every `device_load_sample`.

Client → server: JSON text frames, so a UI does not need an HTTP round trip for the hot paths. A frame is
`{"type": <command>, …fields}` (the fields may also be nested in `"payload"`; `"action"` is accepted in place of `"type"`).

| Command | Fields | Effect and answer |
|---|---|---|
| `ping` | `id`, `t` | Answered at once with `{"type":"pong","id":…,"t":…}` — the client's own timestamp, so the client measures the round trip with its own clock. |
| `media_action` | `action` (`play`, `pause`, `toggle`, `play_pause`, `next`, `prev`, `previous`), optional `package` | Controls the media session. Answered with `{"type":"media_action_ack","action","package","result":{"ok":bool,…}}`; a bad `action` / `package` → `result.error = "bad_request"`. |
| `media_seek` | `position` (ms), optional `package` | Seeks. Answered with `{"type":"media_seek_ack","position_ms","package","ok":bool,"error"?}`; `error: "session_gone"` when the named app has no media session. |
| `set_volume` | `stream_id` (default 3), `value` | Sets an Android volume stream. No answer; `device_volumes_update` follows. |
| `set_hardware_state` | `key` (`wifi`, `bluetooth`, `mobile_data`, `mute`, `torch`, …), `value` (bool) | Quick-settings toggle (REST twin: `POST /device/states`). No answer; `device_states_update` follows. |
| `set_display_power` | `on` (bool) | Screen on/off (the phone's panel; the mirror keeps running). |

Package names must match Android's package-name grammar — they travel on the daemon's line protocol, so anything else is
refused with `bad_request`. Unknown commands are ignored.

#### Event types

<!-- BEGIN GENERATED: events -->
| Event `type` | Payload |
|---|---|
| **Windows, device link, notifications, app hand-off** | |
| `fps_changed` | {window_id, fps} |
| `window_frozen` | {window_id, reason: "minimized"\|"occluded"\|"budget"} |
| `window_unfrozen` | {window_id} |
| `thermal_throttle` | {level} |
| `device_load_sample` | {sample, insights, adb, markers} — the "Phone Load" panel (telemetry/load_monitor.py) |
| `device_connected` | {android_id, transport} |
| `device_lost` | {reason} |
| `device_reconnected` | {android_id} |
| `link_quality` | {weak} — the phone stopped answering while its video is silent (a stalled link); cleared when it answers |
| `encoder_limit_hit` | {max_windows} |
| `notification_received` | {id, package, title, text, post_time, app_name} |
| `notification_updated` | {id, package, title, text, post_time, app_name} (silent in-place state update) |
| `notification_cleared` | {id} |
| `app_lock_pending` | {package, display_id, message} |
| `app_lock_resolved` | {package, display_id} |
| `app_lock_timeout` | {package, display_id, message} |
| `app_lock_cancelled` | {package, window_id, display_id, message} — the user cancelled the lock (gesture / home) |
| `app_handoff_to_phone` | {window_id, package, display_id, message} |
| `app_handoff_resolved` | {window_id, package} |
| `app_reclaim_result` | {window_id, package, outcome: "moved"\|"relaunched"} — the result of taking an app back from the phone |
| `vd_phase` | {window_id, package, phase: "stealth"\|"live", target_dpi?, physical_dpi?, deadline_ms?} |
| **Workspace** | |
| `workspace_task_added` | {window_id, package, bounds: [l,t,r,b]} |
| `workspace_task_removed` | {window_id} |
| `workspace_task_bounds_changed` | {window_id, bounds: [l,t,r,b]} |
| `workspace_task_density_changed` | {window_id, density, density_mode} |
| `task_popout_result` | {window_id, package, success, ws_url, display_w, display_h} |
| `task_dock_result` | {window_id, package, success, ws_url, bounds: [l,t,r,b]} |
| `workspace_task_returned` | {window_id, package, ws_url, bounds, render_scale, density, display_w, display_h} — a task came back from the phone |
| **OpenDeX daemon** | |
| `device_task_focused` | {display_id, package, activity, task_id} |
| `device_media_update` | {active, title, artist, album, duration_ms, position_ms, is_playing, ...} |
| `device_volumes_update` | {streams: [{id, name, label, current, max, min, muted}]} |
| `device_states_update` | {states: {wifi, bluetooth, torch, mute, ...}} |
| `device_battery_update` | {level, is_charging, charging_type, temperature_c, voltage_mv, health, ...} |
| `device_daemon_connected` | {version, capabilities, screen_blanked} — every (re)connect to the daemon |
| `device_tasks_update` | {ok, push, tasks: [{id, display, visible, package?}]} — task snapshot |
| `device_task_removed` | {taskId, package?} |
| `device_display_added` | {id, name?, w?, h?} |
| `device_display_removed` | {id} |
| `device_profile_changed` | {profile} — the phone's own screen changed (display size / smallest width) while bound |
| `devices_changed` | {devices: [DeviceInfo], active_serial} — adb's list / the bound phone changed |
| `device_bind_failed` | {serial, reason, attempt} — bringing a session up failed and was undone; retries follow |
| `window_app_closed` | {window_id, package, action: "close"\|"badge"} — app closed ON THE PHONE |
| `window_app_restored` | {window_id, package} — a badged window's app is running again |
| **Per-app audio** | |
| `app_audio_mode` | {supported, mode: "pending"\|"per_app"\|"legacy"\|"off"} |
| `app_audio_state` | {package, route, live_route, volume, muted, windows, stream_id, error, explicit} |
| **Transport handover** | |
| `migration_queued` | {window_id, old_serial, new_serial} |
| `migration_started` | {window_id, new_serial} |
| `migration_completed` | {window_id, new_serial} |
| `migration_failed` | {window_id, new_serial} |
| **File manager** | |
| `fs_transfer` | a transfer job's snapshot — TransferJob.snapshot(): state, progress, conflict, errors… |
| `fs_changed` | {provider, device, path} — a folder's content changed; open listings refresh |
<!-- END GENERATED: events -->

The payload column is a sketch taken from the comments next to each name in
[`backend/app/events.py`](../backend/app/events.py); the `EventType` literal there is the complete list, and a test fails if
this table and the code disagree.

### `/ws/video/{window_id}` — H.264, as the encoder wrote it

Server → client, **binary** frames. The bytes are the scrcpy server's video stream, forwarded without re-encoding (the
phone's hardware encoder produces H.264 — OpenDeX adds no transcoding step and no extra latency). The stream is a sequence of
**12-byte headers**, each followed by what it announces. Multi-byte integers are big-endian.

```text
byte 0   bit 7 = 1   SESSION packet — 12 bytes in total, no payload (consumed by the backend, never forwarded)
                     bytes 4..8 = video width (u32), bytes 8..12 = video height (u32); byte 3 bit 0 = "resized by us"
byte 0   bit 7 = 0   MEDIA packet:
         bytes 0..8   u64:  bit 62 = config packet (SPS/PPS), bit 61 = key frame, bits 0..60 = PTS in microseconds
         bytes 8..12  u32:  payload length N
         followed by N bytes of H.264 NAL units (Annex B)
```

(scrcpy ≥ 4.0 moved the config and key-frame flags down one bit to free bit 63 for the session packet; OpenDeX speaks
the 4.x layout.) A decoder needs the config packet first, then a key frame, then deltas. In the browser this maps directly
onto WebCodecs `VideoDecoder` (`frontend/src/media/videoDecoder.js`).

Late joiners (a window re-opened, a page reload) are given the config, the last key frame and the deltas since it, in one go.
When a client falls behind, the backend drops at **key-frame boundaries only** — it never drops a delta from the middle of a
group of pictures, because that would paint corrupt frames.

Client → server: the **text** frame `keyframe` asks the encoder for a key frame (use it when your decoder errors or after
you discarded a backlog). It is rate-limited; ask again if none arrives in ~2 s.

### `/ws/audio` and `/ws/audio/{window_id}` — PCM

Server → client, binary. Each frame is a **12-byte header** — `u64` PTS in microseconds, `u32` payload length (big-endian) —
followed by raw PCM: **signed 16-bit little-endian, 2 channels, 48 000 Hz**.

* `/ws/audio` — the phone's session-wide audio (every sound on the device).
* `/ws/audio/{window_id}` — **one app's** audio, captured per app on the phone (Android 13+; see
  [AUDIO.md](AUDIO.md)). Answers `4404` when that window has no audio.

Exactly **one consumer** per channel: a new connection evicts the older one (a second tab, a hot-reloaded page) so that one
sound never plays twice. The PTS is on the phone's clock — a player that wants audio and video in step schedules by PTS, not by
arrival (see [AUDIO.md](AUDIO.md#how-the-routes-stay-in-sync)).

### `/ws/input/{window_id}` — touch, scroll, clipboard

Client → server only; JSON text frames, one persistent socket per window. Coordinates are **pixels of the window's own video
frame** (`0 … width`, `0 … height` of the stream — the same space as the picture you decode); out-of-range values are dropped.

| `type` | Fields | Effect |
|---|---|---|
| `down` `move` `up` | `x`, `y` | One finger. `down` presses, `move` drags, `up` lifts. |
| `scroll` | `x`, `y`, `hscroll`, `vscroll` (floats; positive `vscroll` scrolls up) | Wheel / two-finger scroll at a point. |
| `clipboard` | `text`, `paste` (default `true`) | Sets the phone's clipboard and, if `paste`, pastes. |
| `release_all` | — | Lifts whatever this connection still holds down. Send it when your page loses focus or closes. |

Accepted types: <!-- BEGIN GENERATED: ws-input-types -->
`clipboard`, `down`, `move`, `release_all`, `scroll`, `up`
<!-- END GENERATED: ws-input-types -->.

**A finger never stays stuck.** Android keeps a pointer pressed until told otherwise. The backend records what each input socket
pressed and lifts it itself when the socket closes (tab closed, network dropped, backend restarting) or when `release_all`
arrives. A message for a window that was closed meanwhile is dropped silently, not an error. Key presses, typed text and
shortcuts use REST (`POST /input/key`); `POST /input/touch` is the REST fallback for clients that cannot hold a socket
(it also offers `tap`, `long_press` and `drag`, which the socket leaves to the client).

## Regenerating this documentation

Everything marked *generated* is derived from the code, and CI fails when it drifts:

```bash
python scripts/docgen.py          # rewrite docs/api/openapi.json, docs/api/REFERENCE.md, docs/CONFIGURATION.md, the generated blocks
python scripts/docgen.py --check  # exit 1 if something is out of date (what CI and the test suite run)
```

The OpenAPI document is built by `backend/app/api/openapi_export.py` from the live FastAPI app plus the rules enforced in
middleware (auth, Origin guard, limits) that the routes themselves do not show.
