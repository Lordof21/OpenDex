# The on-phone daemon — protocol

> **Audience: contributors.** This is an *internal* protocol between the OpenDeX backend and a small Java process it starts
> on the phone. It is documented so the two halves can be changed together and reviewed; it is **not** a public API and
> carries no compatibility promise to third parties. If you want to script OpenDeX, use the [backend API](API.md).

## What the daemon is and why it exists

Everything OpenDeX does on the phone beyond scrcpy's video — media control, volumes, quick toggles, battery, notifications,
task and display events, per-app audio capture, a file manager, and a general-purpose shell — would otherwise be an `adb shell`
process per question: slow (tens to hundreds of ms of process start-up each), hard on the Wi-Fi link, and impossible to push.
The daemon is **one long-lived JVM on the phone** (`com.opendex.tools.OpenDexDaemon`, started with `app_process` as the
`shell` user — no APK, no root, nothing installed) that answers in-process (Binder calls, `/proc` reads) and *pushes* changes.

* Source: [`backend/java/src/com/opendex/tools/`](../backend/java/src/com/opendex/tools/) — build with `py backend/java/build.py`
  (output `backend/vendor/opendex-tools.jar`, pushed to `/data/local/tmp/opendex-tools.jar`).
* Backend client: [`backend/app/device/device_daemon_client.py`](../backend/app/device/device_daemon_client.py).
* Every capability has a fallback on the backend's `adb shell` path, so a phone whose daemon is missing, old or refused still
  works — slower. The daemon is an accelerator, never a hard dependency.

## Transport

| | Phone side | PC side |
|---|---|---|
| **control** (JSON lines) | abstract UNIX socket `opendex_daemon` | `adb forward tcp:28100 localabstract:opendex_daemon` → `127.0.0.1:28100` |
| **audio** (binary PCM) | abstract UNIX socket `opendex_audio` | `adb forward tcp:28101 localabstract:opendex_audio` → `127.0.0.1:28101` |

The ports are the backend's defaults (`DEFAULT_DAEMON_PORT`, `AUDIO_PORT`). If `adb forward` does not succeed (another program
holds the port) the backend **does not connect** — whatever answered would be that program, and would be sent commands.

Peer check on the phone: every accepted connection's UID is read with `SO_PEERCRED`; only `root` (0) and `shell` (2000) are
served. That alone is **not** enough on the PC side — `adb` (uid `shell`) makes the connection for *any* local program, a web
page's `fetch("http://127.0.0.1:28100")` included — hence the handshake below.

## Lifecycle

1. The backend binds a phone, pushes the jar if its checksum differs, and forwards the ports.
2. If no daemon runs (`pgrep -f OpenDexDaemon`), it starts one:
   ```text
   IFS= read -r T; [ -n "$T" ] || exit 1; OPENDEX_DAEMON_TOKEN="$T" \
     CLASSPATH=/data/local/tmp/opendex-tools.jar nohup app_process / com.opendex.tools.OpenDexDaemon opendex_daemon \
     > /data/local/tmp/opendex-daemon.log 2>&1 < /dev/null &
   ```
   The key travels on that command's **stdin** — in no argv, on the PC (where any program of the user can list `adb.exe`'s
   command line) or on the phone.
3. It connects, runs the handshake, and treats the socket as connected only once the greeting has arrived. A health check runs
   before anything polls the phone: 3 attempts, 3 s apart.
4. Reconnects use back-off (1 s × 1.5, capped at 5 s). A daemon still running **old bytecode** (the greeting's `build` is the
   MD5 of the jar it started from) is restarted once per start. A daemon that rejects our key is replaced up to 3 times (it
   was started with an older key file); after that something else is wrong and restarting would not fix it.
5. The daemon exits by itself 5 minutes after the last control client left. It also lights the panel again if *it* had blanked it
   (`display_power false`): 30 s after the last client left, on shutdown, and — via a marker file — on the next start after a crash.
6. Audio policies it set (per-app capture) outlive a control client by only 3 s: a brief reconnect keeps them, a real disconnect
   hands every app back to the phone's speaker.

## Authentication — mutual, HMAC-SHA256, the secret never travels

The per-install secret is 32 random bytes, **64 lower-case hex digits**, in `~/.opendex/daemon-token` (mode `0600`; override
`OPENDEX_DAEMON_TOKEN_FILE`). It is a different secret from the API token (that one is handed to the browser UI; this one
never leaves the backend and the phone). Each side proves it holds it, over fresh nonces; the key is never sent.

```text
daemon  → client   {"type":"auth_required","nonce":"<Ns>"}
client  → daemon   auth <hex HMAC-SHA256(key, "client|" + Ns)> <Nc>
daemon  → client   {"type":"greeting", …, "auth_proof":"<hex HMAC-SHA256(key, "server|" + Nc + "|" + Ns)>"}
                   — or {"type":"auth_failed"} and the connection is closed
```

* Nonces are lower-case hex (16–64 characters) — a fixed alphabet that can never contain the `|` or space the messages use.
* The role prefixes (`client|`, `server|`) stop either answer being replayed as the other; the client's fresh `Nc` makes a
  recorded greeting worthless on the next connection.
* The daemon waits **5 s** for the client's answer and reads nothing else until it has passed; the client waits **8 s** for the
  greeting and refuses (`UnverifiedDaemonError`) any daemon whose `auth_proof` is wrong — a program that got to the port first
  never receives a command (they may carry a Wi-Fi passphrase).
* Without a key (a hand-started daemon, an old backend) the socket is open as it always was, **and `shell`, `fs_*` and `auth`
  are not offered**. A daemon that merely *claims* capabilities without having completed the handshake is never trusted with a
  command that may carry a secret.
* Python: `backend/app/device/daemon_auth.py`; Java twin: `DaemonAuth.java`. Agreement across the two languages is tested
  (`backend/tests/test_java_pure_classes.py`).

## Framing

UTF-8, **one JSON object per line** in each direction after the handshake.

**Request** — a command word and space-separated arguments, optionally prefixed with a correlation id:

```text
#<req_id> <command> [arg …]\n
```

A line break inside a command would *be* a second command (the daemon also runs `shell`), so the client refuses to send one;
anything that can carry arbitrary text (a shell line, a path) is **base64** (see `shell` and the `fs_*` commands).

**Reply** — one JSON object carrying the same `"req_id"`. Replies may arrive **out of order**: slow read-only commands
(`notifications_list`, `notif_invoke`, `event_log`, `load_sample`, `proc_scan`, `dump`, `thermal_get`) run on a small pool so
they never hold up the connection's other commands; `shell` and `fs_*` answer from their own threads. Commands without an id
are answered without one.

**Pushed events** have no `req_id` (below). The client's line reader accepts up to 4 MiB per line.

Unknown commands answer `{"type":"error","message":"unknown_command"}`; a command that throws answers
`{"type":"error","message":<text>}`.

### Greeting

```json
{ "type": "greeting", "version": "1.2", "build": "<md5 of the jar>", "status": "ready",
  "capabilities": ["ping", "media_get", …],
  "notification_listener": true, "thermal_listener": true,
  "screen_blanked": false, "auth_proof": "<hex>" }
```

`version` is the protocol version (**additive**: 1.2 only added to 1.1; a field is never renamed or retyped — the backend's test
suite asserts the names and types). `notification_listener` / `thermal_listener` say whether those push sources are live in
this process — a refused listener means the backend polls through `adb` instead. `screen_blanked` is the daemon's own truth about
a panel it switched off (Android's `PowerManager` cannot see a raw blank). Right after the greeting the daemon pushes a baseline:
media, focus, tasks, volumes, quick states, battery, thermal and the notification list.

### Capabilities

The backend gates each feature on the list in the greeting, so a skewed jar (new backend, old phone — or the reverse) shows up as a
fallback, not a hang. Base list:

<!-- BEGIN GENERATED: capabilities -->
`ping`, `proc_probe`, `media_get`, `media_action`, `media_seek`, `get_focus`, `set_density`, `set_task_density`, `set_task_windowing`, `get_task_geometry`, `move_task`, `volumes_get`, `volume_set`, `states_get`, `state_set`, `battery_get`, `battery_health`, `display_power`, `status`, `audio_route`, `audio_stop`, `audio_list`, `audio_playout`, `audio_probe`, `task_events`, `tasks_list`, `display_events`, `bluetooth`, `bt_list`, `bt_connect`, `bt_disconnect`, `bt_forget`, `wifi_connect_saved`, `wifi_disconnect`, `quit`, `exit`, `notification_events`, `notifications_list`, `notif_invoke`, `thermal_events`, `thermal_get`, `event_log`, `load_sample`, `proc_scan`, `find_task`, `task_info`, `top_activities`, `power_get`, `dump`, `display_get`, `set_task_windowing_bounds`
<!-- END GENERATED: capabilities -->

Added only when the daemon was started **with a key**: <!-- BEGIN GENERATED: capabilities-token -->
`auth`, `shell`, `fs`
<!-- END GENERATED: capabilities-token -->. (`auth` — the handshake itself, `shell` — the `shell` command, `fs` — the `fs_*` commands.)

Most names are commands of the same name. A few are *flags*: `task_events`, `display_events`, `notification_events`,
`thermal_events` (push sources — events, no command), `bluetooth` (the `bt_*` commands), `audio_playout` (`audio_route … both <ms>`
is understood) and `set_task_windowing_bounds` (`set_task_windowing` takes `l,t,r,b`).

## Commands

All commands of the main dispatch (`handleCommand` in `OpenDexDaemon.java`) — this list is generated from the source, and a test
fails if one of them is missing from the tables below:

<!-- BEGIN GENERATED: commands -->
`ping`, `proc_probe`, `media_get`, `media_action`, `media_seek`, `get_focus`, `set_density`, `set_task_density`, `set_task_windowing`, `get_task_geometry`, `move_task`, `volumes_get`, `volume_set`, `states_get`, `state_set`, `battery_get`, `battery_health`, `notifications_list`, `notif_invoke`, `thermal_get`, `event_log`, `load_sample`, `proc_scan`, `find_task`, `task_info`, `power_get`, `top_activities`, `dump`, `display_power`, `audio_route`, `audio_target`, `audio_probe`, `audio_stop`, `audio_list`, `tasks_list`, `display_get`, `bt_list`, `bt_connect`, `bt_disconnect`, `bt_forget`, `wifi_connect_saved`, `wifi_disconnect`, `task_density_info`, `restart_task_activity`, `status`
<!-- END GENERATED: commands -->

Besides these: `quit` / `exit` (terminate the process), `shell` (below) and the `fs_*` family (below). Replies below are `type`
values; every reply also carries `req_id` when the request had one, and `ok` is the command's verdict.

### Media

| Command | Arguments | Reply |
|---|---|---|
| `media_get` | `[package]` | `media_update` — the active session (title, artist, album, duration, position, state, art …). |
| `media_action` | `play`\|`pause`\|`toggle`\|`play_pause`\|`next`\|`prev`\|`previous` `[package]` | `media_action_result {ok, action}`; a fresh `media_update` follows ~150 ms later. |
| `media_seek` | `<ms> [package]` | `media_seek_result {ok, position}`. |
| `get_focus` | — | `focus_update` — the focused display/package/activity/task. |

### Display, tasks and windows

| Command | Arguments | Reply |
|---|---|---|
| `display_get` | `[display_id]` (default 0) | `display_update {id, …}` — the panel's size and density, read over Binder (`ok:false, error:"window_manager_unavailable"` when the service cannot be reached). |
| `display_power` | `[true\|false]` (default on) | `display_power_result {ok, on}` — raw panel on/off; the fail-safe above restores a panel we blanked. |
| `set_density` | `<display_id> <dpi>` | `set_density_result`. |
| `set_task_density` | `<task_id> <dpi>` | `set_task_density_result` — per-task density override. |
| `task_density_info` | `<task_id>` | `task_density_info` — what is applied to the task. |
| `set_task_windowing` | `<task_id> <mode> [true\|false\|l,t,r,b]` | `set_task_windowing_result` — windowing mode; `true` clears the override bounds, `l,t,r,b` places the task in the same transaction. |
| `get_task_geometry` | `<task_id>` | `task_geometry_result` — bounds and windowing mode. |
| `move_task` | `<task_id> <display_id>` | `move_task_result`. |
| `restart_task_activity` | `<task_id>` | `restart_task_activity_result` — recreates the top activity so it re-reads its density. |
| `tasks_list` | — | `tasks_update` — every task `{id, display, visible, package?}`. |
| `find_task` | `<package> [display_id]` | `find_task {ok, …}`. |
| `task_info` | `<task_id>` | `task_info`. |
| `top_activities` | — | `top_activities`. |
| `power_get` | — | `power_state` — interactive / awake / wakefulness. |

### Quick settings, volumes, battery, thermal

| Command | Arguments | Reply |
|---|---|---|
| `volumes_get` | — | `volumes_update` — every stream `{id, name, label, current, max, min, muted}`. |
| `volume_set` | `<stream_id> <value>` | `volume_set_result`; a `volumes_update` follows. |
| `states_get` | — | `states_update` — `{wifi, bluetooth, mobile_data, airplane_mode, rotation_lock, mute, torch, …}`. |
| `state_set` | `<key> <true\|false\|1\|0>` | `state_set_result {ok, key, value}`; `error: "unknown_state_key"` for anything else (a typo never reports `ok`). |
| `battery_get` | — | `battery_update` — level, charging, temperature, voltage, … |
| `battery_health` | — | `battery_health` — health and charge diagnostics (what the Battery page shows). |
| `thermal_get` | — | `thermal_update` — throttling level. |
| `status` | — | `status_result` — uptime, active clients, version, listener flags, last error. |
| `ping` | — | `pong {clock_us}` — the phone's monotonic clock; the backend derives its offset from a few probes (min round trip) for audio sync. |

### Notifications

| Command | Arguments | Reply |
|---|---|---|
| `notifications_list` | — | `notifications_update` — the current list. |
| `notif_invoke` | action arguments | `notif_invoke_result` — runs a notification's action / dismiss (`NotificationInvoker`). |

### Wi-Fi and Bluetooth

| Command | Arguments | Reply |
|---|---|---|
| `wifi_connect_saved` | `<network_id>` | `wifi_result` — joins a saved network without its passphrase. |
| `wifi_disconnect` | `[network_id]` | `wifi_result` — with an id the network is *disabled* (stays off until joined again); without, the link drops and auto-join may rejoin. |
| `bt_list` | — | `bt_list` — bonded devices and their state. |
| `bt_connect` / `bt_disconnect` / `bt_forget` | `<AA:BB:CC:DD:EE:FF>` | `bt_result {ok, error?, status?}`. |

### Per-app audio

| Command | Arguments | Reply |
|---|---|---|
| `audio_route` | `<package> <pc\|both\|phone> [target_ms]` | `audio_result {ok, stream_id?, uid?, error?}`. `pc` captures the app and mutes it on the phone, `phone` releases it, `both` keeps both — with `target_ms` the daemon plays the phone copy itself, each chunk presented that long after capture. |
| `audio_target` | `<package> <ms>` | `audio_result` — retunes a syncing capture's phone copy in place. |
| `audio_probe` | `<target_ms> [count=6] [spacing_ms=500] [lead_ms=700]` | `audio_result {ok, pts_us[], …}` — plays calibration tones on the phone (see [AUDIO.md](AUDIO.md)). |
| `audio_stop` | `<package>` | `audio_result`. |
| `audio_list` | — | `audio_list` — active captures. |

The PCM itself travels on the separate [audio link](#audio-link).

### Telemetry reads

| Command | Arguments | Reply |
|---|---|---|
| `proc_probe` | `<base64(comma-separated packages)>` | `proc_probe_result {ok, out}` — CPU counters and `/proc` stat lines for those packages, read in-process. |
| `proc_scan` | `[marker]` | `proc_scan` — a `/proc` walk. |
| `load_sample` | `[marker]` | `load_sample` — one sample of device load for the Phone Load panel. |
| `event_log` | `<since epoch.sec> <tag,tag,…>` | `event_log` — selected `logd` events since a time (replaces a `logcat` fork). |
| `dump` | `<service> [args]` — `battery`, `SurfaceFlinger` or `window` | `dump_result` — a Binder `dump` of a whitelisted service. |

### `shell` — run a command on the phone

```text
shell <timeout_ms> <t|b> <base64(UTF-8 command)>
```

Offered **only** with a key. `t` returns text, `b` binary-safe bytes. Limits (Java `ShellWire`, mirrored by the client): timeout
clamped to 100 ms – 120 s, command ≤ 64 KiB, output ≤ 8 MiB, reply ≤ 3 MiB (output of 2 KiB or more is gzipped when that makes it smaller).

```json
{ "type": "shell_result", "ok": true, "exit": 0, "timed_out": false, "ms": 41, "enc": "plain", "out": "…", "err": "…" }
{ "type": "shell_result", "ok": false, "error": "bad_request" | "exec_failed" | "too_large" | "busy", "detail": "…" }
```

`enc` is `plain` (UTF-8), `b64` (bytes) or `gz` (gzip, base64). `ok:false` means *nothing ran or the answer cannot be carried* —
the backend then runs the same command through `adb`; `ok:true` is a verdict about the command itself (`exit`, `timed_out`) and
is never retried. After a lost reply (a daemon that is alive but silent) the backend sends shell commands straight to `adb` for 5 s,
doubling per consecutive loss up to 60 s, instead of waiting out each timeout. The command goes through the `OPENDEX_DAEMON_SHELL`
switch; `false` is the way back to pure `adb`.

> **Why a shell at all, and why this one.** Routing the backend's own `adb shell` calls through the daemon removes most of the
> phone-load of polling and the per-command process start. Earlier builds had an unauthenticated `exec` command, which was removed:
> a shell on a socket that any local program could reach is exactly what the handshake exists to prevent. `shell` exists only
> behind the handshake, takes its command as base64 (it can never be mistaken for protocol), and has hard limits.

### `fs_*` — file manager on the phone

Offered only with a key. Paths and names are **base64** (UTF-8, no NUL, ≤ 4096 bytes each); the argument count is checked
before anything is decoded (`bad_request`), unknown subcommands answer `unknown_command`.

<!-- BEGIN GENERATED: fs-commands -->
`fs_roots`, `fs_stat`, `fs_stat_many`, `fs_delete`, `fs_scan`, `fs_thumb`, `fs_mkdir`, `fs_rename`, `fs_list`
<!-- END GENERATED: fs-commands -->

| Command | Arguments |
|---|---|
| `fs_roots` | — |
| `fs_list` | `<b64 path> <b64 after-name \| -> <limit>` — paged (default 500, max 2000) |
| `fs_stat` | `<b64 path>` |
| `fs_stat_many` | `<b64 paths joined by \n>` — ≤ 500 paths |
| `fs_mkdir` | `<b64 path> <p \| ->` — `p` also creates missing parents |
| `fs_rename` | `<b64 from> <b64 to> <o \| ->` — `o` replaces an existing target |
| `fs_delete` | `<b64 path>` — recursive, never follows a link |
| `fs_thumb` | `<b64 path> <max edge px>` — 32 … 1024 |
| `fs_scan` | `<b64 paths joined by \n>` — asks the media scanner to index them |

Bulk transfer does **not** use this protocol: file bytes move with the `adb sync` protocol (`backend/app/fs/adb_sync.py`).
`fs_*` is for browsing and small mutations. Which paths may be touched is decided by the daemon's own policy (`FsPolicy.java`),
independently of anything the backend sends.

## Pushed events

Sent without `req_id` whenever something changes (media, volumes, states and battery are also diffed on a ~1.2 s tick, so an
unchanged value costs no bytes):

| `type` | Meaning | Becomes (backend `EventBus`) |
|---|---|---|
| `media_update` | Active media session changed (position excluded from the diff). | `device_media_update` |
| `focus_update` | Focused task/display/package changed. | `device_task_focused` |
| `volumes_update` | A volume stream changed. | `device_volumes_update` |
| `states_update` | A quick toggle changed. | `device_states_update` |
| `battery_update` | Battery changed. | `device_battery_update` |
| `tasks_update` | Task snapshot (from `TaskStackListener`; the daemon polls only when the listener is refused). | `device_tasks_update` |
| `task_removed`, `display_added`, `display_removed` | One-shot display/task listener events. | `device_task_removed`, `device_display_added`, `device_display_removed` |
| `display_update` | The phone panel's own size/density changed (user changed "Display size"). | `device_profile_changed` |
| `notification_posted`, `notification_removed`, `notifications_update` | Notification listener. | *in-process only* — never forwarded raw: they carry notification text; the notification supervisor turns them into `notification_*` events |
| `thermal_update` | Thermal status listener. | *in-process only* — the thermal monitor turns it into `thermal_throttle` |

## Audio link

A second socket, `opendex_audio`, carries PCM only; **what is captured and where it goes** travels on the control socket
(`audio_route` …). One consumer at a time — a new connection replaces the old one. Big-endian frames:

```text
u16 stream_id | u16 flags | u64 pts_us | u32 size | size bytes of PCM (s16le, stereo, 48 kHz)
```

`flags` bit 0 (`0x1`) = end of that stream; bit 1 (`0x2`) = keepalive (`stream_id` 0, `size` 0), sent every second while the channel is
idle. `pts_us` is on the **phone's** monotonic clock (the clock `ping` returns). The phone side queues at most 64 frames (~1.3 s of
one stream) and a stalled consumer loses the *oldest audio* — freshness over completeness — so a slow PC link can neither block an
`AudioRecord` read nor the command thread. A stream's *end* is never dropped: one that finds no consumer (the link is down), or
dies unwritten with its connection, is kept and delivered first to the next. The backend (`app_audio_link.py`) validates `size`
(≤ 1 MiB; more means the stream desynced), reconnects with back-off (0.25 s … 2 s), treats 4 s of silence as a dead link once it has
seen a keepalive on the connection (a half-open socket gives no error; a helper without keepalives is never timed out), and re-emits
each payload with the 12-byte `u64 pts | u32 size` header the browser player already parses for `/ws/audio` (see
[API.md](API.md#wsaudio-and-wsaudiowindow_id--pcm)).

## Changing the protocol

* **Only add.** New commands, new fields, new capabilities. Never rename or retype a field — the backend's tests assert them.
* A new command needs: a `case` in `handleCommand` (or `FsWire.parse`), an entry in `CAPABILITIES`, a row in the table above
  (`backend/tests/test_docs_generated.py` fails without it), a backend method that checks the capability and **falls back to the
  `adb` path**, and a JVM test if it parses input (`backend/java/test`).
* Anything that carries free text is base64. Anything that reaches a shell is validated on **both** sides.
* After changing Java: `py backend/java/build.py`, then restart the daemon (the greeting's `build` makes the backend do it).
