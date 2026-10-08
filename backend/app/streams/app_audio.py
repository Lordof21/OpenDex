"""Per-window isolated audio.

Each app shown in an OpenDeX window gets its own capture on the phone (daemon AudioRouter: AudioPolicy +
RULE_MATCH_UID), its PCM arrives on the AppAudioLink and is fanned out to that window's broadcaster
("audio:<window_id>" → WS /ws/audio/{window_id}). Everything else (notifications, calls, apps without a window) keeps
playing on the phone.

ONE reconcile loop owns the phone side. The desired state is derived, never tracked incrementally:
  * which windows exist, and whether each app is currently on the phone (handoff / parked Workspace member)
    — read live from the window sessions (``windows_getter``),
  * which apps the user TRANSFERRED from the Media Center although they have no window (``_standalone``): such an app
    gets a virtual window id ``app:<package>`` — the PC-side channel, broadcaster and WS route are the ones every
    window uses, so nothing downstream knows the difference. A transfer ends when the user sends the app back to the
    phone, when the phone's media session list no longer holds the app (TRANSFER_GRACE_S), or when the device goes,
  * the route per package — the user's saved preference, else the default from ProjectSettings ("Ses çıkışı").
Every trigger — a window opened/closed (SessionTable), a handoff, a preference change, a daemon reconnect, a capture
that died — only calls ``request_sync()``. Missing one trigger therefore costs latency, never correctness.

"İkisi" (route "both") is heard on the DeX AND the phone — and the two must come out at the same instant. Left to
themselves they cannot: the phone plays the app at once, the DeX copy arrives after capture buffering, the adb link, the relay
and the page's own buffers (100–300 ms, and not constant: the link jitters). So both outputs follow ONE timeline: every
capture chunk carries the device clock's time of its first frame (PTS) and each output presents it at ``PTS + target``.
  * the PHONE: the daemon silences the app and plays the capture itself through an AudioTrack, placed by the track's own
    timestamps (``audio_route <pkg> both <phone_target>``; PhoneRender),
  * the DeX page: reads the same PTS, converts it to its own clock with the device-clock offset it measures (``POST
    /api/audio/clock``) and schedules each chunk at ``PTS + target`` (media/appAudioMixer.js; ``target_ms`` in the state),
  * the TARGET is the least latency every chunk can meet: the page's output device + one chunk + the link + the relay + a jitter
    margin that grows when the page reports chunks that arrived too late (``PUT /api/audio/sync``) and relaxes when it does
    not; the user's fine tune (ProjectSettings.audio_sync_offset_ms, by ear) moves the PHONE alone.
A jar without ``audio_playout``, or a phone that cannot build the playback track: the app plays natively on the phone as before
(state.synced is False and the UI says so).

Mode (one per bound device):
  pending  → API 33+ device, waiting for the daemon's greeting; the legacy session stream is SUPPRESSED meanwhile
             (no double audio, no scrcpy spawn torn down seconds later). A fallback timer ends in "legacy".
  per_app  → the daemon supports audio_route; legacy stays suppressed.
  legacy   → Android ≤12 or an old jar: the single session stream (SessionAudio) as before.
  off      → no device.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from ..events import EventBus
from ..schemas import AUDIO_ROUTES, AppAudioPref, AudioRoute
from ..storage import settings_db
from ..windows.mirror_packages import is_internal_package
from .app_audio_link import AppAudioLink
from .broadcaster import BroadcasterRegistry

log = logging.getLogger(__name__)

Mode = Literal["off", "pending", "per_app", "legacy"]

MIN_API = 33                 # AudioPolicy playback capture from the shell (same floor as scrcpy)
AUDIO_QUEUE_CHUNKS = 32      # per-client WS backlog: 32 × 20 ms; freshness wins beyond it (lossy broadcaster)


def audio_key(window_id: str) -> str:
    return f"audio:{window_id}"


def standalone_id(package: str) -> str:
    """The channel id of a transferred app that has no window (window ids never contain a colon)."""
    return f"app:{package}"


class TransferRefused(ValueError):
    """A Media Center transfer that cannot start; ``code`` is the machine-readable reason."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class AudioWindow:
    """What the router needs to know about one open window."""

    package: str
    on_phone: bool = False


@dataclass
class AppAudioState:
    package: str
    route: AudioRoute = "pc"      # where the user wants it (saved preference, or the default)
    volume: float = 1.0           # PC-side gain 0..1 (applied in the browser)
    muted: bool = False           # PC-side mute
    explicit: bool = False        # route/volume/mute come from a saved preference, not the default
    windows: set[str] = field(default_factory=set)
    on_phone: bool = False        # the app is showing on the phone right now (handoff / parked member)
    stream_id: int | None = None
    live_route: AudioRoute = "phone"   # what the phone is ACTUALLY doing
    error: str | None = None
    restarts: int = 0             # captures lost on their own, recently (auto-restart budget)
    lost_at: float = 0.0
    standalone: bool = False      # transferred from the Media Center (may or may not have a window of its own)
    sync_requested: bool = False  # the capture was asked to render the phone copy itself (route "both", a jar that can)
    synced: bool = False          # … and the phone really does (False: the app plays natively there, an echo)
    target_ms: int | None = None  # while synced: the common latency (capture → speaker) the DeX page presents at
    phone_ms: int | None = None   # … and the phone's own (the same plus the user's fine tune)

    def target_route(self) -> AudioRoute:
        return "phone" if (not self.windows or self.on_phone) else self.route

    def public(self) -> dict[str, Any]:
        return {
            "package": self.package, "route": self.route, "live_route": self.live_route,
            "volume": self.volume, "muted": self.muted, "explicit": self.explicit,
            "windows": sorted(self.windows), "on_phone": self.on_phone,
            "stream_id": self.stream_id, "error": self.error, "standalone": self.standalone,
            "synced": self.synced, "target_ms": self.target_ms, "phone_ms": self.phone_ms,
        }


class AppAudioRouter:
    PENDING_FALLBACK_S = 10.0     # no audio-capable daemon greeting by then → legacy stream
    # "İkisi" alignment (see the module docstring). All in ms.
    CHUNK_MS = 20                 # a chunk is complete (and sent) this long after its first frame
    RELAY_MS = 6                  # backend relay + the page's socket
    JITTER_MARGIN_MS = 30         # headroom over the link's jitter; LATE reports add to it
    DEFAULT_PC_OUTPUT_MS = 30     # the page's output device latency until it reports its own
    MIN_TARGET_MS = 60
    MAX_TARGET_MS = 800
    MAX_PHONE_TARGET_MS = 1500    # = PhoneRender.MAX_TARGET_MS on the phone
    LATE_BUMP_AFTER = 3           # late chunks in one report that raise the margin …
    LATE_BUMP_MS = 20             # … by this much (up to LATE_BUMP_MAX_MS)
    LATE_BUMP_MAX_MS = 240
    CALM_REPORTS_TO_RELAX = 12    # reports without a late chunk before the margin gives a step back
    RELAX_STEP_MS = 10
    RETUNE_MIN_MS = 4             # a smaller change is not worth a daemon round trip (and an audible skip)
    REPORT_MIN_MS = 15            # the page's output latency jitters: only a real change retunes
    LINK_FALLBACK_MS = 25.0       # one-way link estimate until a ping answered
    MAX_AUTO_RESTARTS = 3         # per package, within RESTART_WINDOW_S
    RESTART_WINDOW_S = 60.0
    RESTART_DELAY_S = 1.0
    RETRY_AFTER_TIMEOUT_S = 2.0
    TRANSFER_GRACE_S = 20.0       # a transferred app missing from the phone's media sessions this long ends its transfer

    def __init__(
        self,
        broadcasters: BroadcasterRegistry,
        events: EventBus,
        *,
        daemon_getter: Callable[[], Any],
        link: AppAudioLink,
        windows_getter: Callable[[], dict[str, AudioWindow]],
        default_route_getter: Callable[[], Awaitable[AudioRoute]],
        suppress_legacy: Callable[[], Awaitable[None]],
        resume_legacy: Callable[[], Awaitable[None]],
        sync_offset_getter: Callable[[], Awaitable[int]] | None = None,
    ) -> None:
        self._broadcasters = broadcasters
        self._events = events
        self._daemon = daemon_getter
        self._link = link
        self._windows = windows_getter
        self._default_route = default_route_getter
        self._suppress_legacy = suppress_legacy
        self._resume_legacy = resume_legacy
        self._sync_offset_getter = sync_offset_getter      # → the user's fine tune (ms; + delays the phone)
        self._pc_output_ms: int = self.DEFAULT_PC_OUTPUT_MS
        self._link_ms: float | None = None                 # one-way link latency, from the daemon ping
        self._late_extra_ms = 0                            # jitter margin earned from late chunks the page reported
        self._calm_reports = 0

        self._mode: Mode = "off"
        self._serial: str | None = None
        self._apps: dict[str, AppAudioState] = {}
        self._by_stream: dict[int, str] = {}      # live stream_id → package
        self._retiring: set[int] = set()          # streams WE asked the daemon to end (their FLAG_END is expected)
        self._lock = asyncio.Lock()
        self._sync_task: asyncio.Task | None = None
        self._sync_again = False
        self._fallback_task: asyncio.Task | None = None
        self._timers: set[asyncio.Task] = set()
        self._standalone: set[str] = set()                 # Media Center transfers (apps that may have no window)
        self._gone_since: dict[str, float] = {}            # transferred package → first media update without its session

        events.on("device_daemon_connected", self._on_daemon_connected)
        events.on("device_media_update", self._on_media_update)
        events.on("app_handoff_to_phone", self._on_handoff_event)
        events.on("app_handoff_resolved", self._on_handoff_event)

    # ------------------------------------------------------------------ read side

    @property
    def mode(self) -> Mode:
        return self._mode

    @property
    def supported(self) -> bool:
        return self._mode == "per_app"

    def list_apps(self) -> list[dict[str, Any]]:
        if not self.supported:
            return []
        return [s.public() for s in self._apps.values() if s.windows]

    # ------------------------------------------------------------------ device lifecycle (AppContext)

    async def on_device_bound(self, serial: str, android_api: int | None) -> None:
        """Device bound, or the transport switched (USB ↔ Wi-Fi). Every daemon greeting re-decides anyway
        (_on_daemon_connected), so this only has to pick the right state until then."""
        self._serial = serial
        if android_api is not None and android_api < MIN_API:
            log.info("🔈 [AppAudio] Android API %s < %d → tek akış (eski oturum sesi)", android_api, MIN_API)
            # Already legacy (transport switch): WindowManager.migrate_transport moves that stream itself.
            await self._set_mode("legacy")
            return
        if self._mode == "per_app":
            # Transport switch: the PCM link moves to the new serial now; the daemon client reconnects there and its
            # greeting re-establishes every capture.
            await self._link.start(serial)
            return
        if self._mode == "legacy":
            return      # same jar on a new transport: keep the stream the migration moves; a greeting may upgrade it
        await self._set_mode("pending")
        self._arm_fallback()
        daemon = self._daemon()
        if daemon is not None and daemon.is_connected:     # the greeting may have arrived before the bind finished
            await self._decide(daemon)

    async def on_device_unbound(self) -> None:
        self._serial = None
        self._standalone.clear()
        self._gone_since.clear()
        self._link_ms = None
        self._late_extra_ms = self._calm_reports = 0
        self._cancel_background()
        await self._set_mode("off")

    async def shutdown(self) -> None:
        self._cancel_background()
        await self._link.stop()

    # ------------------------------------------------------------------ user actions (REST)

    async def set_prefs(
        self, package: str, *, route: AudioRoute | None = None, volume: float | None = None,
        muted: bool | None = None, standalone: bool | None = None,
    ) -> dict[str, Any]:
        """Saves the package's preference and applies it. ``standalone`` is the Media Center's transfer: True plays the
        app's sound on the PC although it has no window (raises :class:`TransferRefused` when it cannot), False ends
        it. Choosing route "phone" ends a transfer as well — "send it back" has one meaning."""
        if route is not None and route not in AUDIO_ROUTES:
            raise ValueError(f"route must be one of {AUDIO_ROUTES}")
        if standalone:
            if self._mode != "per_app":
                raise TransferRefused("not_supported")
            if is_internal_package(package):
                raise TransferRefused("internal_package")
        if route == "phone" and standalone is None:
            standalone = False
        async with self._lock:
            tracked = package in self._apps
            state = self._apps.get(package) or await self._load(package)
            if standalone and route is None and state.route == "phone":
                route = "pc"                 # "transfer" from a phone-only preference means: bring it to the PC
            if route is not None:
                state.route = route
                state.restarts = 0
            if volume is not None:
                state.volume = max(0.0, min(1.0, float(volume)))
            if muted is not None:
                state.muted = bool(muted)
            state.explicit = True
            await settings_db.upsert_app_audio_pref(
                AppAudioPref(package=package, route=state.route, volume=state.volume, muted=state.muted)
            )
            if standalone is not None:
                changed, result = await self._set_standalone_locked(package, standalone)
                for other in changed:
                    await self._emit(other)
                return result
            if tracked:
                await self._apply_locked(state)
        if tracked:
            await self._emit(state)
        return state.public()

    async def _set_standalone_locked(self, package: str, on: bool) -> tuple[list[AppAudioState], dict[str, Any]]:
        """Starts/ends a transfer and lets the reconcile do the rest. A transfer the phone cannot carry out is taken back
        at once (no leftover mixer row): the caller gets the state WITH the error."""
        if on:
            self._standalone.add(package)
            self._gone_since.pop(package, None)
        else:
            self._standalone.discard(package)
            self._gone_since.pop(package, None)
        changed = await self._reconcile_locked()
        live = self._apps.get(package)
        result = live.public() if live is not None else self._last_public(package, changed)
        if on and live is not None and live.live_route == "phone" and live.error and not live.on_phone:
            result["standalone"] = False
            self._standalone.discard(package)
            changed += await self._reconcile_locked()
        return changed, result

    @staticmethod
    def _last_public(package: str, changed: list[AppAudioState]) -> dict[str, Any]:
        for state in changed:
            if state.package == package:
                return state.public()
        return AppAudioState(package=package).public()

    async def on_default_route_changed(self) -> None:
        """"Ses çıkışı" changed in the settings: apps without their own preference follow it."""
        route = await self._safe_default_route()
        changed: list[AppAudioState] = []
        async with self._lock:
            for state in self._apps.values():
                if not state.explicit and state.route != route:
                    state.route = route
                    changed.append(state)
        for state in changed:
            await self._emit(state)
        self.request_sync()

    # ------------------------------------------------------------------ reconcile

    def request_sync(self) -> None:
        """Coalesced, non-blocking. Safe from sync code (SessionTable listener) and outside an event loop."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._sync_task is not None and not self._sync_task.done():
            self._sync_again = True
            return
        self._sync_task = loop.create_task(self._sync_loop(), name="app-audio-sync")

    async def _sync_loop(self) -> None:
        while True:
            self._sync_again = False
            try:
                await self.sync()
            except Exception:  # noqa: BLE001 — the next trigger retries; never kill the loop owner
                log.exception("[AppAudio] senkronizasyon başarısız")
            if not self._sync_again:
                return

    async def sync(self) -> None:
        """Brings the phone's captures and the per-window broadcasters in line with the open windows."""
        async with self._lock:
            if self._mode != "per_app":
                return
            changed = await self._reconcile_locked()
        for state in changed:
            await self._emit(state)

    async def _reconcile_locked(self) -> list[AppAudioState]:
        wanted: dict[str, tuple[set[str], bool]] = {}
        for window_id, win in self._eligible_windows().items():
            windows, on_phone = wanted.get(win.package, (set(), False))
            windows.add(window_id)
            wanted[win.package] = (windows, on_phone or win.on_phone)

        self._expire_transfers()
        for package in self._standalone:
            windows, on_phone = wanted.get(package, (set(), False))
            if not windows:                              # a window of its own, when it has one, carries the channel
                wanted[package] = ({standalone_id(package)}, False)

        for package in wanted:
            if package not in self._apps:
                self._apps[package] = await self._load(package)

        before = {pkg: s.public() for pkg, s in self._apps.items()}
        for package, state in self._apps.items():
            windows, on_phone = wanted.get(package, (set(), False))
            for gone in state.windows - windows:
                self._broadcasters.remove(audio_key(gone))      # its WS consumer is told to close
            for new in windows - state.windows:
                self._broadcasters.get_or_create(audio_key(new), queue_size=AUDIO_QUEUE_CHUNKS, gop_aware=False)
            state.windows, state.on_phone = set(windows), on_phone
            state.standalone = package in self._standalone
            await self._apply_locked(state)

        changed = [s for pkg, s in self._apps.items() if before.get(pkg) != s.public()]
        for package in [p for p, s in self._apps.items() if not s.windows and s.live_route == "phone"]:
            del self._apps[package]          # its final (windows=[]) state is still emitted via `changed`
        return changed

    def _expire_transfers(self) -> None:
        """Ends the transfers whose app has been absent from the phone's media sessions for TRANSFER_GRACE_S: nothing is
        playing there any more, and the app must not stay silenced on the phone for sounds it makes later."""
        now = time.monotonic()
        for package in list(self._standalone):
            since = self._gone_since.get(package)
            if since is not None and now - since >= self.TRANSFER_GRACE_S:
                log.info("🔈 [AppAudio] %s: medya oturumu kalmadı → PC aktarımı sona erdi", package)
                self._standalone.discard(package)
                self._gone_since.pop(package, None)

    async def _on_media_update(self, **data: Any) -> None:
        """The phone's media snapshot. ``sessions`` (Android's live list) is only on FULL snapshots — without it there is
        no evidence either way, so nothing changes (the frontend reads the list under the same rule)."""
        sessions = data.get("sessions")
        if not self._standalone or not isinstance(sessions, list):
            return
        live = {s.get("package") for s in sessions if isinstance(s, dict)}
        now, missing = time.monotonic(), False
        for package in self._standalone:
            if package in live:
                self._gone_since.pop(package, None)
            elif package not in self._gone_since:
                self._gone_since[package] = now
                missing = True
        if missing:
            self._schedule_resync(self.TRANSFER_GRACE_S + 0.5)

    def _eligible_windows(self) -> dict[str, AudioWindow]:
        # Phone mirror / Workspace anchor: no app UID behind them (a "rest of the phone" stream for the mirror does not exist yet).
        return {wid: w for wid, w in self._windows().items() if w.package and not is_internal_package(w.package)}

    async def _apply_locked(self, state: AppAudioState, *, force: bool = False) -> None:
        if self._mode != "per_app":
            return
        target = state.target_route()
        if not force and target == state.live_route and (target == "phone" or state.stream_id is not None):
            return
        daemon = self._daemon()
        if daemon is None or not daemon.is_connected:
            self._set_error(state, "daemon_not_connected", target)
            return
        old = state.stream_id
        if old is not None:
            self._retiring.add(old)          # the daemon ends it (FLAG_END) — not a lost capture
        align = await self._alignment(daemon) if target == "both" else None
        if align is None:
            res = await daemon.audio_route(state.package, target)
        else:
            res = await daemon.audio_route(state.package, target, target_ms=align[1])
        if old is not None:
            self._by_stream.pop(old, None)
        if not res.get("ok"):
            # AudioRouter.setRoute keeps no capture for a package whose route change failed.
            state.stream_id, state.live_route = None, "phone"
            state.sync_requested, state.synced, state.target_ms, state.phone_ms = False, False, None, None
            error = str(res.get("error") or "audio_route_failed")
            self._set_error(state, error, target)
            if error == "timeout":
                self._schedule_resync(self.RETRY_AFTER_TIMEOUT_S)
            return
        new = res.get("stream_id")
        state.stream_id = int(new) if new is not None else None
        if state.stream_id is not None:
            self._retiring.discard(state.stream_id)
            self._by_stream[state.stream_id] = state.package
        state.live_route, state.error = target, None
        state.sync_requested = align is not None
        state.synced = align is not None and bool(res.get("sync"))
        state.target_ms, state.phone_ms = (align if state.synced else (None, None))
        log.info("🔊 [AppAudio] %s → %s (stream=%s%s)", state.package, target, state.stream_id,
                 f", ortak gecikme {state.target_ms} ms (telefon {state.phone_ms} ms)" if state.synced
                 else (", telefon kopyası eşlenemedi" if align is not None else ""))

    # ------------------------------------------------------------------ "İkisi": phone and PC heard together

    async def _sync_offset(self) -> int:
        if self._sync_offset_getter is None:
            return 0
        try:
            return int(await self._sync_offset_getter())
        except Exception:  # noqa: BLE001 — settings unreadable: no fine tune
            return 0

    async def _link_one_way_ms(self, daemon: Any | None, *, measure: bool = True) -> float:
        """Half the daemon round trip = the audio link's latency (control and audio ride the same adb transport)."""
        rtt = None
        if measure and daemon is not None:
            with contextlib.suppress(Exception):
                rtt = await daemon.ping()
        if rtt is not None:
            self._link_ms = float(rtt) / 2
        return self._link_ms if self._link_ms is not None else self.LINK_FALLBACK_MS

    def _common_target_ms(self, one_way_ms: float) -> int:
        """The least capture→speaker latency the DeX page can meet for every chunk (see the module docstring)."""
        floor = (self._pc_output_ms + self.CHUNK_MS + one_way_ms + self.RELAY_MS + self.JITTER_MARGIN_MS
                 + self._late_extra_ms)
        return int(max(self.MIN_TARGET_MS, min(self.MAX_TARGET_MS, round(floor))))

    async def _alignment(self, daemon: Any) -> tuple[int, int] | None:
        """(common target, the phone's target) for a "both" app; None = do not align (the jar cannot) and the app plays
        natively on the phone."""
        if not getattr(daemon, "supports_audio_playout", False):
            return None
        common = self._common_target_ms(await self._link_one_way_ms(daemon))
        phone = int(max(0, min(self.MAX_PHONE_TARGET_MS, common + await self._sync_offset())))
        return common, phone

    async def report_pc(self, output_ms: int | None = None, late_chunks: int = 0) -> None:
        """What the page measures about itself: its audio output latency (ms), and how many chunks of the last window
        reached it too late for the target (they were dropped or trimmed). Late chunks raise the margin, calm relaxes it."""
        changed = False
        if output_ms is not None:
            ms = max(0, min(2000, int(output_ms)))
            if abs(ms - self._pc_output_ms) >= self.REPORT_MIN_MS:
                self._pc_output_ms, changed = ms, True
        if late_chunks >= self.LATE_BUMP_AFTER:
            self._calm_reports = 0
            if self._late_extra_ms < self.LATE_BUMP_MAX_MS:
                self._late_extra_ms = min(self.LATE_BUMP_MAX_MS, self._late_extra_ms + self.LATE_BUMP_MS)
                changed = True
        elif late_chunks > 0:
            self._calm_reports = 0
        elif self._late_extra_ms > 0:
            self._calm_reports += 1
            if self._calm_reports >= self.CALM_REPORTS_TO_RELAX:
                self._calm_reports = 0
                self._late_extra_ms = max(0, self._late_extra_ms - self.RELAX_STEP_MS)
                changed = True
        if changed:
            await self.on_sync_changed()

    async def on_sync_changed(self) -> None:
        """The fine tune or the DeX side's latency changed: every live "both" capture follows — the phone's target retuned in
        place (and the new common target announced to the page), or the capture re-established when alignment became
        possible/impossible."""
        changed: list[AppAudioState] = []
        async with self._lock:
            daemon = self._daemon()
            if self._mode != "per_app" or daemon is None or not daemon.is_connected:
                return
            for state in self._apps.values():
                if state.live_route != "both" or state.stream_id is None:
                    continue
                align = await self._alignment(daemon)
                if (align is not None) != state.sync_requested:
                    await self._apply_locked(state, force=True)
                    changed.append(state)
                elif align is not None and state.synced and (
                    abs(align[1] - (state.phone_ms or 0)) >= self.RETUNE_MIN_MS or abs(align[0] - (state.target_ms or 0)) >= self.RETUNE_MIN_MS
                ):
                    res = await daemon.audio_target(state.package, align[1])
                    if res.get("ok"):
                        state.target_ms, state.phone_ms = align
                        changed.append(state)
                    elif res.get("error") == "not_syncing":
                        await self._apply_locked(state, force=True)
                        changed.append(state)
        for state in changed:
            await self._emit(state)

    # Calibration probe (the page plays its own tone and listens; see frontend/src/media/syncCalibration.js)
    PROBE_COUNT = 6
    PROBE_SPACING_MS = 500
    PROBE_LEAD_MS = 700           # from the daemon's answer to the first tone: covers the page's round trip + scheduling

    async def probe(self) -> dict[str, Any]:
        """Starts the phone's half of a calibration: test tones presented at the phone's CURRENT target (common target +
        the user's fine tune). The answer carries what the page needs to play its half at the matching instants:
        ``pts_us`` (device clock, one per tone), ``common_target_ms`` (what the DeX copy aims at), ``phone_target_ms`` and
        the fine tune in force. ``error``: ``not_supported`` (no per-app audio / old jar) or the daemon's own."""
        daemon = self._daemon()
        if self._mode != "per_app" or daemon is None or not getattr(daemon, "supports_audio_probe", False):
            return {"ok": False, "error": "not_supported"}
        common = self._common_target_ms(await self._link_one_way_ms(daemon))
        offset = await self._sync_offset()
        phone = int(max(0, min(self.MAX_PHONE_TARGET_MS, common + offset)))
        res = await daemon.audio_probe(phone, self.PROBE_COUNT, self.PROBE_SPACING_MS, self.PROBE_LEAD_MS)
        pts = res.get("pts_us")
        if not res.get("ok") or not isinstance(pts, list) or not pts:
            return {"ok": False, "error": str(res.get("error") or "probe_failed")}
        return {
            "ok": True, "pts_us": [int(p) for p in pts], "spacing_ms": int(res.get("spacing_ms", self.PROBE_SPACING_MS)),
            "common_target_ms": common, "phone_target_ms": int(res.get("target_ms", phone)), "offset_ms": phone - common,
        }

    async def sync_info(self) -> dict[str, Any]:
        """What the settings show about the alignment: can this device align, the fine tune, what is assumed (no daemon
        round trip: the link figure is the last one measured)."""
        daemon = self._daemon()
        supported = bool(daemon is not None and getattr(daemon, "supports_audio_playout", False))
        one_way = await self._link_one_way_ms(daemon, measure=False)
        return {
            "supported": supported,
            "offset_ms": await self._sync_offset(),
            "pc_output_ms": self._pc_output_ms,
            "link_ms": round(self._link_ms, 1) if self._link_ms is not None else None,
            "target_ms": self._common_target_ms(one_way) if supported else None,
            "late_extra_ms": self._late_extra_ms,
        }

    @staticmethod
    def _set_error(state: AppAudioState, error: str, target: str) -> None:
        if state.error != error:
            log.warning("🔇 [AppAudio] %s → %s başarısız: %s", state.package, target, error)
        state.error = error

    # ------------------------------------------------------------------ PCM from the phone (AppAudioLink)

    async def on_frame(self, stream_id: int, chunk: bytes) -> None:
        """Hot path (50×/s per app): never takes the lock, never awaits the daemon."""
        package = self._by_stream.get(stream_id)
        state = self._apps.get(package) if package is not None else None
        if state is None:
            return
        for window_id in state.windows:
            broadcaster = self._broadcasters.get(audio_key(window_id))
            if broadcaster is not None:
                await broadcaster.broadcast(chunk)

    async def on_end(self, stream_id: int) -> None:
        if stream_id in self._retiring:
            self._retiring.discard(stream_id)
            return
        package = self._by_stream.pop(stream_id, None)
        state = self._apps.get(package) if package is not None else None
        if state is None or state.stream_id != stream_id:
            return
        # Ended without us asking: audioserver restart, or the daemon handing apps back to the phone after
        # losing its control client. The phone plays the app again; restart the capture a few times.
        now = time.monotonic()
        if now - state.lost_at > self.RESTART_WINDOW_S:
            state.restarts = 0
        state.restarts += 1
        state.lost_at = now
        state.stream_id, state.live_route, state.error = None, "phone", "capture_lost"
        log.warning("🔇 [AppAudio] %s yakalaması kendiliğinden bitti (stream=%s, deneme=%d)",
                    state.package, stream_id, state.restarts)
        await self._emit(state)
        if state.restarts <= self.MAX_AUTO_RESTARTS:
            self._schedule_resync(self.RESTART_DELAY_S)

    # ------------------------------------------------------------------ daemon / mode

    async def _on_daemon_connected(self, **_: Any) -> None:
        daemon = self._daemon()
        if self._serial is None or daemon is None or not daemon.is_connected:
            return
        await self._decide(daemon)

    async def _decide(self, daemon: Any) -> None:
        """A daemon is (re)connected: pick per-app or legacy, and re-establish captures on a fresh daemon."""
        if "audio_route" not in getattr(daemon, "daemon_capabilities", ()):
            log.info("🔈 [AppAudio] Daemon audio_route bilmiyor (eski jar) → tek akış")
            await self._set_mode("legacy")
            return
        res = await daemon.audio_list()
        if not res.get("ok"):
            return                           # RPC hiccup: stay put; the fallback timer / next greeting decides
        if not res.get("supported"):
            log.info("🔈 [AppAudio] Cihaz uygulama başına sesi desteklemiyor (sdk=%s) → tek akış", res.get("sdk"))
            await self._set_mode("legacy")
            return
        self._cancel_fallback()
        async with self._lock:
            # A new daemon process has no captures; a reconnect to the same one answers idempotently with the
            # live stream ids. Either way: forget what we believed and let the reconcile ask again.
            for state in self._apps.values():
                state.stream_id, state.live_route = None, "phone"
            self._by_stream.clear()
            self._retiring.clear()
        if self._serial is not None:
            await self._link.start(self._serial)
        await self._set_mode("per_app")
        self.request_sync()

    async def _set_mode(self, mode: Mode) -> None:
        if mode == self._mode:
            return
        previous, self._mode = self._mode, mode
        log.info("🔊 [AppAudio] mod: %s → %s", previous, mode)
        if previous == "per_app":
            await self._forget_all()
        if mode in ("pending", "per_app"):
            await self._suppress_legacy()
        elif mode == "legacy":
            self._cancel_fallback()
            await self._resume_legacy()
        await self._events.emit("app_audio_mode", mode=mode, supported=mode == "per_app")

    async def _forget_all(self) -> None:
        """Leaving per-app mode: per-window broadcasters closed (their WS consumers are told), state dropped. The
        daemon side needs nothing — a new/other daemon has no captures, and an unbound device's daemon hands every
        app back to the phone once its control client is gone."""
        async with self._lock:
            for state in self._apps.values():
                for window_id in state.windows:
                    self._broadcasters.remove(audio_key(window_id))
            self._apps.clear()
            self._by_stream.clear()
            self._retiring.clear()
            self._standalone.clear()
            self._gone_since.clear()
        await self._link.stop()

    def _arm_fallback(self) -> None:
        self._cancel_fallback()

        async def _fallback() -> None:
            await asyncio.sleep(self.PENDING_FALLBACK_S)
            if self._mode == "pending":
                log.warning("🔈 [AppAudio] Daemon %.0f sn içinde hazır olmadı → tek akış", self.PENDING_FALLBACK_S)
                await self._set_mode("legacy")

        self._fallback_task = asyncio.create_task(_fallback(), name="app-audio-fallback")

    def _cancel_fallback(self) -> None:
        task, self._fallback_task = self._fallback_task, None
        if task is not None and not task.done() and task is not asyncio.current_task():
            task.cancel()

    def _schedule_resync(self, delay: float) -> None:
        async def _later() -> None:
            await asyncio.sleep(delay)
            self.request_sync()

        task = asyncio.create_task(_later(), name="app-audio-resync")
        self._timers.add(task)
        task.add_done_callback(self._timers.discard)

    def _cancel_background(self) -> None:
        self._cancel_fallback()
        for task in list(self._timers):
            task.cancel()
        self._timers.clear()
        if self._sync_task is not None and not self._sync_task.done() and self._sync_task is not asyncio.current_task():
            self._sync_task.cancel()
        self._sync_task = None

    # ------------------------------------------------------------------ events & helpers

    async def _on_handoff_event(self, **_: Any) -> None:
        # The session's handoff_to_phone flag is already updated when these fire: the sound follows the app.
        self.request_sync()

    async def _load(self, package: str) -> AppAudioState:
        pref: AppAudioPref | None = None
        with contextlib.suppress(Exception):
            pref = await settings_db.get_app_audio_pref(package)
        if pref is None:
            return AppAudioState(package=package, route=await self._safe_default_route())
        return AppAudioState(package=package, route=pref.route, volume=pref.volume, muted=pref.muted, explicit=True)

    async def _safe_default_route(self) -> AudioRoute:
        try:
            return await self._default_route()
        except Exception:  # noqa: BLE001 — settings unreadable: the product default (DeX)
            return "pc"

    async def _emit(self, state: AppAudioState) -> None:
        if self._mode == "per_app":
            await self._events.emit("app_audio_state", **state.public())
