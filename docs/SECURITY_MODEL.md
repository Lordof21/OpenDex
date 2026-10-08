# Security model

What OpenDeX trusts, what it defends against, how, and — equally important — what it does **not** protect. (To report a vulnerability, see
[SECURITY.md](../SECURITY.md).)

## The one-paragraph version

OpenDeX is a **local** application. A backend on `127.0.0.1` drives your phone over `adb` and serves a UI to a native window on the same
computer. It makes no outbound network connections of its own. The interesting question is therefore not "who on the internet" but
**"what else on this computer can reach that port"** — another web page open in your browser, or another program. Two independent locks
answer those two: an **Origin/Host guard** for web pages and a **bearer token** for programs. Everything that executes on the phone is
gated by a third, **mutual** authentication between the backend and the phone helper.

## Assets and trust boundaries

| Asset | Why it matters |
|---|---|
| **Control of the phone** (touch, keys, shell, files, notifications) | Anyone who can drive it can read messages, move money in a banking app, delete photos. |
| **Notification contents and file contents** | Often one-time codes and private documents. |
| **The secrets**: API token, daemon key, shell token | They are what stops the above from being reachable by "any program". |
| **The computer's files** (file manager) | The backend can read and write what the file manager is allowed to touch. |

**Trust boundary: the operating-system user.** A program running as *you* can read `~/.opendex/*` and talk to `adb` directly; OpenDeX does not
(and cannot) defend against it — it already has everything OpenDeX has. What OpenDeX defends is the **gap between a web page / a different user and
that boundary.**

## Defences

### 1. Web pages: the Origin / Host guard (`api/origin_guard.py`)

CORS alone is not enough for a local server: a "simple" cross-origin request still runs its side effect, WebSockets are not covered by CORS at all (any page
could open `/ws/events` and read every notification), and DNS rebinding makes an attacker's host name resolve to `127.0.0.1`. So every HTTP request and every
WebSocket handshake is checked **before** a route runs:

* an `Origin` header that is not one of the app's own origins (`localhost`, `127.0.0.1`, `opendex.localhost`, `tauri.localhost`, plus
  `OPENDEX_CORS_ORIGINS`) → `403` / WebSocket close `4403`; `Origin: null` is foreign too;
* a `Host` that is not a loopback or `*.localhost` name → refused (DNS rebinding).

Browsers always send `Origin` on cross-origin requests and WebSocket handshakes and cannot forge it. Clients without one (curl, scripts, the Tauri shell) pass
this lock and meet the next.

### 2. Programs: the bearer token (`api/auth.py`)

* One secret per user: 256 random bits in `~/.opendex/api-token` (created `0600`), or `OPENDEX_API_TOKEN` (≥ 32 characters).
* Every `/api/*` request and `/ws/*` handshake presents it (`Authorization: Bearer …`; a `token` query parameter **only** on `GET` and WebSocket, where browsers cannot
  set headers). Constant-time comparison; a miss is `401` / close `4401` before any route runs; failures are logged at most once per 10 s.
* It reaches the UI without crossing HTTP: the Tauri shell reads the file (an IPC command) and the Vite dev server reads it at start. Only the Docker/nginx setup
  uses `GET /auth/bootstrap` (off by default, answers the app's own origins only).
* **Bind policy:** listening on anything but loopback is refused unless `OPENDEX_ALLOW_REMOTE=true` **and** the token is set explicitly (a token the backend invented was
  never given to anyone else). There is no TLS; do not expose the port without a reverse proxy.

### 3. Transport hygiene (`api/hardening.py`)

Request bodies are capped (`OPENDEX_MAX_BODY_BYTES`, default 2 MB; chunked bodies refused, `411`), WebSocket messages are capped
(`OPENDEX_WS_MAX_MESSAGE_BYTES`), and every response — refusals included — carries `nosniff`, `no-referrer`, `X-Frame-Options: DENY` and `Cache-Control: no-store`.
The desktop shell and the nginx image add a strict Content-Security-Policy (`default-src 'self'`; scripts from the bundle only; `connect-src` the backend on
loopback; `frame-ancestors 'none'`). Swagger UI (`/docs`) is off unless `OPENDEX_API_DOCS=true`.

### 4. The phone helper: mutual authentication (`device/daemon_auth.py`, `DaemonAuth.java`)

`adb` (uid `shell`) makes the connection to the helper's socket for *any* local program — a web page's `fetch("http://127.0.0.1:28100")` included — so the helper's
own peer-UID check passes for everyone. Since the helper can run shell commands for the backend, it requires proof of a **per-install key** before it reads one byte,
and the backend refuses a "helper" that cannot prove the same key (an impostor that got to the port first must not be sent a Wi-Fi passphrase). The proof is an
HMAC-SHA256 over fresh nonces and a role prefix; the key is never sent and reaches the phone on the *stdin* of the start command, in no argv. Details:
[DAEMON_PROTOCOL.md](DAEMON_PROTOCOL.md#authentication--mutual-hmac-sha256-the-secret-never-travels). Without a key the helper offers **no** shell and **no** file access.

The shell the helper offers takes its command as base64 (it can never be mistaken for protocol), with hard limits (64 KiB command, 8 MiB output, 120 s). An
earlier unauthenticated `exec` command no longer exists.

### 5. The file manager (`fs/`)

* The **PC side** can only touch folders it was granted: by default the user's known folders (`FS_PC_ACCESS=folders`), more only through a native folder picker.
  Widening that scope (`POST /fs/folders`, `/fs/grants`) additionally requires the **shell token** (`X-OpenDex-Shell`, `~/.opendex/shell-token`, readable only by the
  Tauri shell), so a web page or a stray script cannot widen it even with the API token. Narrowing needs nothing extra.
* The **phone side** is limited to `/storage` and `/data/local/tmp` (never `/data/data`, `/proc`, …) by a lexical allow-list **and** again, after resolving links, on the
  phone (`FsPolicy.java`). `..` is resolved before the check; deletion never follows a link.
* Previews are served with a `sandbox` Content-Security-Policy and `nosniff`; previewed bytes live in memory with a byte budget, never on disk.

### 6. Input validation at the boundary (`schemas/identifiers.py`)

Anything that ends up in a shell command line or on the helper's line protocol — package names, host names, media actions, Bluetooth addresses — is validated by a strict
grammar when it enters the API (`schemas/identifiers.py`, and the same patterns again in the daemon client and the Java parsers); a line break in a daemon command is refused at the last gate, because it would *be* a second command.

## What OpenDeX changes on the phone

Honesty matters more than reassurance here. While it runs, OpenDeX does the following to the phone:

| Change | Persistent? | Restored? |
|---|---|---|
| Virtual displays (one per window) and the apps launched on them | no — they disappear with the session | n/a |
| Screen density / size of a **virtual display** and per-task density overrides | tied to the display / task | yes, with the display; `wm density reset` on request |
| `stay_on_while_plugged_in = 7` (so the phone does not sleep while windows are open and charging) | while windows are open | **yes** — your own value is restored when the last window closes, the phone is unplugged or the backend exits; the original is kept on the phone (`opendex_stay_on_original`) so a crash is repaired at the next start |
| Panel switched off (option *screen off while mirroring*) | while it runs | **yes** — restored 30 s after the last client leaves, at shutdown, and (via a marker file) at the next start after a crash |
| **Developer multi-window settings**: `global enable_freeform_support=1`, `global force_resizable_activities=1`, `secure force_resizable_activities=1`, `global enable_non_resizable_multi_window=1`, `global force_desktop_mode_on_external_displays=0`, `global overlay_display_devices=none`, `wm set-multi-window-config --supportsNonResizable 1` | **yes — they stay** | **no — not reverted today** |
| Quick toggles you press (Wi-Fi, Bluetooth, mobile data, torch, mute, airplane mode, rotation lock) and Wi-Fi "disconnect" / "forget" | as you asked | n/a |
| Files in `/data/local/tmp` (helper jar, scrcpy-server jar, its log) | until removed | no |

The **developer multi-window settings** are what make freeform windows and non-resizable apps work on a virtual display. They are ordinary Android
developer options, persist across reboots, and can change how multi-window behaves on the phone itself afterwards. To undo them:

```bash
adb shell settings delete global enable_freeform_support
adb shell settings delete global force_resizable_activities
adb shell settings delete secure force_resizable_activities
adb shell settings delete global enable_non_resizable_multi_window
adb shell settings delete global force_desktop_mode_on_external_displays
```

Restoring them automatically (or offering a "reset phone settings" action) is on the [roadmap](ROADMAP.md).
OpenDeX does **not** touch the phone's gesture/navigation settings and does not install an app, an accessibility service or an input method.

## What OpenDeX stores on the computer

| | |
|---|---|
| `~/.opendex/api-token`, `daemon-token`, `shell-token` | secrets, mode `0600` from the first byte (POSIX); on Windows modes mean little and the per-user profile directory is the protection |
| `~/.opendex/settings.db` | settings, window layouts, remembered devices (model, last IP:port), file-manager favourites and transfer history |
| `logs/` | rotating logs (10 MB × 5; files older than 7 days are deleted at start, the folder is kept under 150 MB): package names, window ids, adb command *categories*, errors. Notification **text is not logged** (only its length). Review before sharing a log publicly. |
| memory only | notification contents, previewed file bytes, thumbnails |

No account, no cloud, no analytics, no crash reporter, no update check.

## Known limits and non-goals

* **Same-user malware is out of scope** (see the trust boundary above).
* **The phone's `adb` access is total.** Anyone who can authorise USB/wireless debugging on your phone (or pair a QR code you show) controls it; the Wireless-debugging
  pairing codes OpenDeX shows are the same ones Android would show — keep the QR off screenshots.
* **The release binaries are obfuscated** ([BUILD_AND_RELEASE.md](BUILD_AND_RELEASE.md#hardening-of-release-builds-obfuscation--and-why-you-may-not-want-it)).
  That is friction for casual copying, not a security control; none of the defences above depends on it.
* **No TLS, no multi-user separation** on the loopback API.
* The security headers/CSP are tested; the Tauri capability set and the Windows ACL on the token files are **not** independently audited.

## Reviewing the code

Start here: `api/auth.py`, `api/origin_guard.py`, `api/hardening.py`, `device/daemon_auth.py`, `java/…/DaemonAuth.java`, `java/…/ShellWire.java`, `fs/roots.py`,
`fs/providers/phone.py`, `java/…/FsPolicy.java`, `schemas/identifiers.py`. Their tests: `test_api_auth.py`, `test_origin_guard.py`, `test_daemon_auth.py`,
`test_java_pure_classes.py`, `test_fs_*.py`.
