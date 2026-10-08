"""Application settings — every tunable comes from the environment (Karar: MVP brief §6).

Nothing here is hardcoded at call sites; modules receive values through this object.
"""
from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

def resolve_backend_root(*, compiled: bool, frozen: bool, executable: str, meipass: str | None, file: str) -> Path:
    """Where ``vendor/`` (scrcpy servers, adb, opendex-tools.jar) lives, relative to however this process was run.

    ``Path(file).resolve().parent.parent`` normally IS the backend/ root — but inside a compiled Tauri-sidecar
    build, ``__file__`` resolves into the compiler's own internal layout, not the source tree, so it has to be
    found a different way depending on which compiler produced this binary:

    - Nuitka onefile (the release build — see backend/build_nuitka.py, scripts/build-backend-sidecar.ps1): the
      real, shipping pipeline. ``compiled`` (module global ``__compiled__``) is Nuitka's own documented marker for
      "this module was compiled, not interpreted". ``vendor/`` is NOT embedded in the onefile payload (that would
      need Nuitka's onefile temp-extraction internals, which aren't a stable public API to depend on); it ships as
      a Tauri bundle *resource* instead (frontend/src-tauri/tauri.conf.json → bundle.resources), landing next to
      the installed exe — and Nuitka documents ``sys.executable`` as the compiled binary's own real path in this
      mode, so its directory is exactly that.
    - PyInstaller onefile (kept only for local/dev builds — see opendex-backend.spec, never the release artifact):
      ``--add-data`` unpacks into a FRESH temp dir every run; ``sys.frozen``/``sys._MEIPASS`` are PyInstaller's own
      documented markers for it — see https://pyinstaller.org/en/stable/runtime-information.html.
    """
    if compiled:
        return Path(executable).resolve().parent
    if frozen:
        # `assert` would vanish under `python -O`/Nuitka's `-OO` flag (see build_nuitka.py) — an explicit raise
        # keeps this check live regardless of how the interpreter that evaluates it was invoked.
        if meipass is None:
            raise RuntimeError("sys.frozen without sys._MEIPASS — not a PyInstaller onefile build")
        return Path(meipass)
    return Path(file).resolve().parent.parent


BACKEND_ROOT = resolve_backend_root(
    compiled="__compiled__" in globals(),
    frozen=getattr(sys, "frozen", False),
    executable=sys.executable,
    meipass=getattr(sys, "_MEIPASS", None),
    file=__file__,
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="OPENDEX_", env_file=".env", extra="ignore")

    # --- ADB / scrcpy ---
    # The adb executable: a name found on PATH, or a full path.
    ADB_PATH: str = "adb"
    # The default device serial for adb commands that name none (a USB serial or `host:port`); unset: adb's own default.
    ADB_SERIAL: str | None = None
    # The scrcpy protocol version the backend speaks; it selects vendor/scrcpy-server-v<version>[-opendex].
    SCRCPY_CLIENT_VERSION: str = "4.1"
    # Which scrcpy-server binary is pushed. "opendex": the patched build of
    # the same version (backend/scrcpy — leading-edge resize debouncer, OPENDEX_RESIZE, bitrate on reset), "upstream":
    # Genymobile's release, "auto": the patched build when vendor/ has it, else upstream. Resolved to "upstream" or
    # "opendex" at load. What a running server can do is learned from its own announcement, never from this setting,
    # so the wrong binary under either name only means today's behaviour. Rollback: "upstream".
    SCRCPY_SERVER_FLAVOR: Literal["auto", "upstream", "opendex"] = "auto"
    # None: derived from the flavor (vendor/scrcpy-server-v<version>[-opendex]). An explicit path is used as given.
    SCRCPY_SERVER_PATH: Path | None = None
    # Patched server only: least time between two flex display resizes (its leading-edge debouncer).
    SCRCPY_RESIZE_MIN_INTERVAL_MS: int = Field(300, ge=0, le=5000)
    # Where the server jar is pushed on the phone.
    SCRCPY_DEVICE_SERVER_PATH: str = "/data/local/tmp/opendex-scrcpy-server.jar"

    # --- HTTP ---
    # The address the API listens on. Anything but loopback is refused unless ALLOW_REMOTE is true and API_TOKEN is set.
    HTTP_HOST: str = "127.0.0.1"
    # The port of the API (the bundled UI and the dev proxy expect 8710).
    HTTP_PORT: int = 8710
    # Log level of the backend: DEBUG, INFO, WARNING or ERROR (also changeable at run time: POST /diagnostics/log-level). The log file gets INFO and above unless this is DEBUG or a trace is on.
    LOG_LEVEL: str = "INFO"
    # http://localhost:5173 = Vite dev server (`npm run dev` / `npm run tauri
    # dev`'s beforeDevCommand). The packaged Tauri app (`opendex.exe`, the
    # backend sidecar build) is a DIFFERENT origin at runtime — WebView2 on
    # Windows serves Tauri's bundled frontend from https://tauri.localhost,
    # never localhost:5173 — so without it here every fetch() from the
    # packaged exe to this API (QR generation included — usually the FIRST
    # request the UI makes, hence the earliest visible symptom) was silently
    # blocked by this exact allowlist. tauri://localhost included too as a
    # defensive alias for other platforms' custom-protocol origin naming.
    CORS_ORIGINS: list[str] = Field(
        default_factory=lambda: [
            "http://localhost",
            "http://127.0.0.1",
            "http://localhost:80",
            "http://127.0.0.1:80",
            "http://opendex.localhost",
            "https://opendex.localhost",
            "opendex://localhost",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
        ]
    )

    # --- Authentication (app/api/auth.py) ---
    # The bearer token every /api and /ws call must present. Empty: the per-user file below is used (created 0600
    # on first start). Set it explicitly when the API must be reachable from another machine.
    API_TOKEN: str | None = None
    # The per-user token file, used when API_TOKEN is empty.
    API_TOKEN_FILE: Path = Path.home() / ".opendex" / "api-token"
    # The secret the on-device daemon is started with and the backend answers its challenge with (device/daemon_auth.py).
    # A different file from the API token on purpose: that one reaches the browser UI, this one never leaves the backend.
    DAEMON_TOKEN_FILE: Path = Path.home() / ".opendex" / "daemon-token"
    # Device shell commands go to the daemon first (device/adb.py). False is the way back: every command runs on adb,
    # as before — for comparing the two paths on a device, or if a phone's daemon misbehaves. The daemon itself
    # (media, volume, tasks, …) is unaffected.
    DAEMON_SHELL: bool = True
    # Listening beyond loopback is refused unless this is true AND API_TOKEN is set explicitly.
    ALLOW_REMOTE: bool = False
    # GET /api/auth/bootstrap hands the token to a browser page from one of the app's own origins. Only for the
    # nginx/Docker deployment, where nothing else can give the page the token; the desktop build leaves it off.
    TOKEN_BOOTSTRAP: bool = False
    # Largest request body a route may receive (settings, layouts and client-log batches are a few KB).
    MAX_BODY_BYTES: int = 2_000_000
    # Largest single WebSocket message uvicorn accepts (/ws/input, /ws/events — /ws/video and /ws/audio* only ever
    # send). The one legitimately large payload is a clipboard paste (arbitrary, uncapped text); this stays a small
    # fraction of uvicorn's 16 MB default, which existed only to let a client make the backend allocate.
    WS_MAX_MESSAGE_BYTES: int = 8_000_000
    # Interactive API docs (/docs, /openapi.json) — a development aid, off in the product.
    API_DOCS: bool = False

    # Host names the API answers to (app/api/origin_guard.py): anything else is a DNS-rebinding attempt. Loopback and
    # every *.localhost name are always accepted; add a LAN name here only together with real authentication.
    ALLOWED_HOSTS: list[str] = Field(default_factory=lambda: ["127.0.0.1", "::1", "localhost"])

    # --- File system ---
    # False turns the file manager off: its routes answer 404.
    FS_ENABLED: bool = True
    # How much of THIS PC the file manager may touch: "folders" (Desktop/Documents/Downloads/Pictures/Music/Videos and
    # folders the user adds), "home" (the whole user profile) or "all" (every drive). OpenDeX's own data folder and the
    # usual credential stores stay closed in every mode (fs/roots.py).
    FS_PC_ACCESS: Literal["folders", "home", "all"] = "folders"
    # Extra PC folders the file manager may browse, in addition to its defaults.
    FS_EXTRA_ROOTS: list[Path] = Field(default_factory=list)
    # Where adb's server listens: the file transfers open their own streams on it (fs/adb_sync.py).
    FS_ADB_HOST: str = "127.0.0.1"
    FS_ADB_PORT: int = Field(5037, ge=1, le=65535)        # the adb server's port
    FS_TRANSFER_WORKERS: int = Field(3, ge=1, le=8)       # files in flight per job
    FS_MAX_JOBS: int = Field(2, ge=1, le=4)               # jobs running at once; the rest wait, queued
    FS_CACHE_DIR: Path = Path.home() / ".opendex" / "cache" / "fs"   # the OLD on-disk preview cache: only ever cleaned up
    FS_CACHE_MB: int = Field(256, ge=32, le=4096)         # RAM kept for previewed phone files (never written to the disk)
    FS_THUMB_CACHE_MB: int = Field(48, ge=8, le=1024)     # RAM kept for thumbnails
    FS_PREVIEW_MAX_MB: int = Field(96, ge=1, le=4096)     # a bigger phone file is copied, not previewed (also capped by FS_CACHE_MB)
    FS_TRASH_DAYS: int = Field(30, ge=0, le=365)          # the phone's Recycle Bin keeps items this long (0: for ever)
    # Only the Tauri shell can read this file: it proves a drag-and-drop / file-picker grant came from native UI.
    FS_SHELL_TOKEN_FILE: Path = Path.home() / ".opendex" / "shell-token"

    # --- Video defaults (user-overridable via project settings) ---
    # Frame-rate cap of a new window's stream.
    DEFAULT_MAX_FPS: int = 60
    # Video bit rate in bit/s. Raised (never lowered) for large windows — see MIN_BITS_PER_PIXEL_PER_FRAME.
    DEFAULT_VIDEO_BIT_RATE: int = 8_000_000
    # The longest side, in pixels, of a window's video.
    DEFAULT_MAX_SIZE: int = 1280
    # "auto", "h264", "h265" or "av1" — the project setting `video_codec` overrides it.
    DEFAULT_VIDEO_CODEC: str = "auto"

    # video_bit_rate was a single, resolution-agnostic project setting: opening
    # a small windowed panel and later growing it (dynamic bucket growth, or
    # dynamic_fit continuously enlarging) never re-examined it, so the SAME
    # bitrate budget that looked fine at a small size kept being reused at a
    # much larger one — visible blocking/softness ("kalite düşüyor"), worst on
    # screen content (sharp text/UI edges compress far worse than camera video).
    # This is a FLOOR, not a fixed value: max(configured, w*h*fps*this) —
    # window_manager._resolution_aware_bitrate() — so it only ever RAISES an
    # under-provisioned bitrate for a large target, never lowers what the user
    # explicitly chose for a small one. 0.04 is deliberately modest: at the
    # existing DEFAULT_MAX_SIZE-class 1280x720@60, it computes to ~2.2Mbps
    # (well under the 8Mbps default, so nothing changes there), while at
    # dynamic_fit's ~3200x1800@60 ceiling it comes to ~13.8Mbps — close to the
    # Settings panel's own "16 Mbps: 2K netlik için önerilen" guidance, and
    # still under its 20Mbps maximum preset.
    MIN_BITS_PER_PIXEL_PER_FRAME: float = 0.04

    # Fixed density for every virtual display.
    # scrcpy's `new_display=WxH` (no /dpi) leaves density to an unspecified
    # default — observed in practice to track the PHYSICAL device's own density
    # (~440-460 for many phones). That silently caps dp-width (dpWidth =
    # px / (dpi/160)) below Android's sw600dp tablet threshold no matter how
    # many pixels are requested, since higher-density phones need MORE pixels
    # just to stay phone-sized in dp. Pinning DPI ourselves makes the relation
    # deterministic: more requested pixels -> proportionally more dp -> a big
    # enough request genuinely crosses into tablet layout territory, matching
    # how larger real devices differ from phones (more dp, not just more px).
    VIRTUAL_DISPLAY_DPI: int = 420

    # Grace period between stopping a window's OLD scrcpy server and spawning
    # its replacement during freeze/unfreeze (minimize-restore, resize).
    # Real-device testing (Xiaomi/HyperOS) showed the new app_process could
    # get killed outright ("Aborted", not a Java exception) when spawned
    # immediately after the previous one's teardown — releasing the prior
    # virtual display/encoder is apparently not instantaneous even after our
    # own stop() (sockets closed, local process reaped) returns.
    UNFREEZE_GRACE_DELAY_S: float = 0.2

    # --- Audio (raw PCM default, no decoder dependency) ---
    AUDIO_CODEC: str = "raw"  # "raw" | "opus"

    # --- Resilience (Karar: connection_supervisor) ---
    # Waits between reconnect attempts after a lost link, in ms; when the list runs out the supervisor gives up.
    RECONNECT_BACKOFF_MS: list[int] = Field(default_factory=lambda: [1000, 2000, 5000])
    # Fallback interval of the device check (adb's own device-change stream wakes it earlier).
    DEVICE_POLL_INTERVAL_S: float = 2.0
    # A link that comes back within this many seconds is a blip, not a lost device: the windows stay open.
    DEVICE_DISCONNECT_GRACE_S: float = 3.0

    # --- Thermal ---
    # Fallback poll of `dumpsys thermalservice` for phones whose daemon does not push thermal events.
    THERMAL_POLL_INTERVAL_S: float = 10.0

    # --- Device-load telemetry (app/telemetry, the Telefon Yükü panel) ---
    # One `adb shell` of file reads per tick (no dumpsys); discovery (thermal zones, pids) every TELEMETRY_DISCOVERY_S
    # or when the open apps change. History kept in memory for the panel; samples also appended to
    # logs/telemetry-YYYYMMDD.jsonl when TELEMETRY_RECORD.
    TELEMETRY_ENABLED: bool = True
    TELEMETRY_INTERVAL_S: float = 5.0      # seconds between two load samples
    TELEMETRY_DISCOVERY_S: float = 30.0    # seconds between re-discoveries (thermal zones, process ids)
    TELEMETRY_HISTORY_S: float = 7200.0    # how much history the panel keeps in memory
    TELEMETRY_RECORD: bool = True          # also append every sample to logs/telemetry-YYYYMMDD.jsonl

    # --- Resource budget ("Açık Teknik Risk": tiers stay off until measured) ---
    ENABLE_FPS_TIERS: bool = False  # intermediate fps steps under load — off until MediaCodec's fps-change cost is measured
    ENABLE_OCCLUSION_FREEZE: bool = False  # default False: each window runs independently without cross-window freeze interference
    FALLBACK_ENCODER_LIMIT: int = 16  # used only when the probe cannot determine a real value (modern SoCs support 16+)

    # --- Storage (single-file SQLite) ---
    # The SQLite file that holds the project settings and window layouts.
    DB_PATH: Path = Path.home() / ".opendex" / "settings.db"

    # --- Helper APK (reserved) ---
    # Reserved: the package name of the optional on-device helper APK (nothing reads it yet).
    HELPER_APK_PACKAGE: str = "com.opendex.helper"

    # --- Flex display (scrcpy v4.x RESIZE_DISPLAY) ---
    # Resize a window's virtual display live (scrcpy v4 RESIZE_DISPLAY) instead of restarting its server, when phone and server support it.
    ENABLE_FLEX_DISPLAY: bool = True
    # VirtualDisplay.resize() itself only needs API 28+; the binding
    # constraint is already MIN_API_FOR_VIRTUAL_DISPLAY_LAUNCH=29 (no window
    # exists below that). Kept as an INDEPENDENT constant (not reused
    # directly) because real-device testing may need to raise it above 29 for
    # a specific OEM without touching the unrelated virtual-display-launch gate.
    MIN_API_FOR_FLEX_DISPLAY: int = 29
    # Bound on waiting for the confirming session packet after RESIZE_DISPLAY
    # (video socket). Not scrcpy's own server-side resize debounce — this is
    # OUR ceiling on "how long do we wait before giving up and falling back to
    # freeze/unfreeze for this one call".
    # --- Timeouts ---
    FLEX_RESIZE_TIMEOUT_S: float = 3.0
    # Per-window resize safety belt (windows/resize_gate.py): at least this long between the END of one real resize
    # and the start of the next; requests overtaken meanwhile are dropped (newest wins). Caps the phone at ~3
    # reconfigurations a second; a calm single resize waits 0. 0 = no wait, newest-wins still applies.
    RESIZE_MIN_INTERVAL_S: float = 0.3
    # Keyframe on demand: least time between two requests for one window. The encoder's own keyframe interval is 60 s on
    # the patched server (10 s upstream), so a decoder that lost its reference chain would otherwise show a frozen
    # picture for up to that long. The interval keeps a stalled network from turning requests into a storm.
    KEYFRAME_REQUEST_MIN_INTERVAL_S: float = 1.5
    # A server announcing "keyframe_request" is asked without an encoder restart; when no keyframe has arrived this long
    # after (a codec that ignores the request), RESET_VIDEO — the restart — is sent after all.
    KEYFRAME_REQUEST_FALLBACK_S: float = 1.0
    # Phone notification safety net: logcat events already trigger a (debounced) `dumpsys notification` refresh; this
    # periodic full dump only catches events logcat dropped. A full dump is large and every one is a new adb process
    # sharing the video stream's single transport — it used to run every 2.5 s.
    NOTIFICATION_POLL_INTERVAL_S: float = Field(10.0, ge=1.0, le=300.0)

    # --- Density reconciliation (windows/density_reconciler.py) ---
    # An app process that lived through a display-density change is restarted (state preserving) once the change has
    # settled. VERIFY_TIMEOUT: how long we wait for the process identity to change after asking Android to restart it.
    # QUIET: a burst of density changes (dragging a DP slider) collapses into one restart after this much silence.
    # MIN_GAP: never restart the same app twice within this window (restart-loop guard).
    DENSITY_REFRESH_VERIFY_TIMEOUT_S: float = 6.0
    # How long we wait for the system event log to show the in-place activity relaunch (`am update-appinfo`) before
    # escalating to a process restart.
    DENSITY_REFRESH_RELAUNCH_PROOF_S: float = 2.5
    DENSITY_REFRESH_POLL_S: float = 0.25     # poll interval while waiting for the app's process identity to change
    DENSITY_REFRESH_QUIET_S: float = 1.2     # a burst of density changes becomes ONE restart after this much silence
    DENSITY_REFRESH_MIN_GAP_S: float = 5.0   # never restart the same app twice within this many seconds
    # How long after the last density change the event log is watched for the app rebuilding ITSELF (Chrome recreates
    # its activity on every density change; a move that changes the screen size makes Android relaunch many apps).
    # Such an app is left alone — refreshing it again was the needless second refresh.
    DENSITY_ADAPT_WAIT_S: float = 1.5
    # OPT-IN. An app that "adapted" only by recreating its OWN activity (proof "app:") is still restarted (state preserving, i.e.
    # an onDestroy + cold start) when it crossed between the phone's and the window's density (handoff / reclaim / open).
    # Measured: Chrome switches its page scale to x1.2 in the PC window's config and never switches back in-process
    # (devicePixelRatio 3.8475 instead of 3.206 on the phone); only a process restart resets it.
    DENSITY_SELF_RECREATE_ESCALATE: bool = False

    # After the handoff pre-landing the task is moved only after this much quiet, so the rebuilt app (Chrome: a NEW renderer
    # process) draws its first frame at the new density first — moved mid-rebuild, the phone showed a black surface.
    HANDOFF_PRELANDING_STABILIZE_S: float = 0.8

    # --- Encoder capacity stress test (capability_probe.py tier-2 follow-up) ---
    # Empirically opens throwaway, app-less virtual displays until one fails,
    # to measure the REAL concurrent-encoder ceiling instead of trusting the
    # OEM's media_codecs.xml value (an upper-bound estimate, not a guarantee).
    STRESS_TEST_MAX_ATTEMPTS: int = 16  # comfortably above AOSP's documented sample max of 13
    STRESS_TEST_ATTEMPT_TIMEOUT_S: float = 6.0  # a full open+push+forward+spawn+handshake, not just a resize ack
    STRESS_TEST_PROBE_DISPLAY_W: int = 1280   # width of the throwaway probe displays
    STRESS_TEST_PROBE_DISPLAY_H: int = 720    # height of the probe displays
    # Real-world operational defaults: tests true hardware VPU / bandwidth / pixel
    # throughput ceiling under actual multi-window usage conditions (60 FPS, 8 Mbps, 720p+).
    STRESS_TEST_PROBE_MAX_FPS: int = 60
    STRESS_TEST_PROBE_VIDEO_BIT_RATE: int = 8_000_000   # bit/s of the probe streams

    # --- Eco Workspace (Karar: Hibrit Pencereleme Faz 1/3) ---
    ECO_WORKSPACE_DISPLAY_W: int = 1920   # width (px) of the shared virtual display that hosts Workspace (freeform) tasks
    ECO_WORKSPACE_DISPLAY_H: int = 1080   # its height (px)
    ECO_WORKSPACE_DPI: int = 210          # its density

    @model_validator(mode="after")
    def _resolve_scrcpy_server(self) -> "Settings":
        """``auto`` → the patched build when it is there (and no explicit path names another binary), else upstream;
        no explicit path → the flavor's binary under vendor/."""
        vendor = BACKEND_ROOT / "vendor"
        patched = vendor / f"scrcpy-server-v{self.SCRCPY_CLIENT_VERSION}-opendex"
        if self.SCRCPY_SERVER_FLAVOR == "auto":
            self.SCRCPY_SERVER_FLAVOR = (
                "opendex" if self.SCRCPY_SERVER_PATH is None and patched.is_file() else "upstream"
            )
        if self.SCRCPY_SERVER_PATH is None:
            self.SCRCPY_SERVER_PATH = (
                patched if self.SCRCPY_SERVER_FLAVOR == "opendex"
                else vendor / f"scrcpy-server-v{self.SCRCPY_CLIENT_VERSION}"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
