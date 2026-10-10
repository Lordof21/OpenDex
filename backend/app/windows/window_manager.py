"""Window orchestration.

One scrcpy server instance per window (own scid, own virtual display via
``new_display``), plus the shared session audio owned by
:class:`~app.streams.audio_stream.SessionAudio`.

This module is the composition root and public API surface for window
lifecycle (open/close/bind) — the actual heavy logic for the other lifecycle
concerns lives in sibling modules this class composes:
  * session_reconfigure.py — freeze/unfreeze/resize, the video pump
  * budget_reallocator.py  — visibility/focus-driven FPS budget, quality settings
  * handoff_manager.py     — PC<->phone handoff/reclaim, focus watchdog
  * window_lifecycle_coordinator.py — AppLock wait + Stealth DPI + task migration

Every public method above delegates to the matching composed object while
holding ``self._lock`` for the duration of the call.

Concurrency: every public method that touches a window's lifecycle (open,
close, freeze, unfreeze, resize, visibility/focus reallocation) acquires
``self._lock`` exactly once. This is not incidental — it fixes a real crash:
opening two windows in quick succession (each independently triggering an
auto-resize when the "gerçek çözünürlük" setting is on) used to run their
freeze+unfreeze cycles concurrently, since only ``open_window`` was ever
guarded. Two encoder teardown/setup sequences interleaving could transiently
ask the device for more simultaneous MediaCodec sessions than its hardware
limit — observed on a real device as the scrcpy server process dying with a
bare "Aborted" (a native abort, not a clean Java exception). Serializing
every lifecycle operation through one lock guarantees the device never sees
more than one in-flight open/close/reconfigure at a time, regardless of how
many concurrent HTTP requests the frontend fires.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass
from collections.abc import Awaitable, Callable
from typing import Any, Literal

from ..config import Settings
from ..device import android_shell, daemon_registry
from ..device.adb import Adb
from ..device.capability_probe import CapabilityProbe
from ..device.device_manager import DeviceManager, DeviceNotBoundError
from ..events import EventBus, cancel_and_wait, spawn_background
from ..logging_config import window_logger
from ..schemas import (
    DeviceProfile,
    EncoderStressTestResult,
    ProjectSettings,
    VisibilityState,
    WindowHandle,
    WindowState,
)
from ..storage import settings_db
from ..streams.app_audio import AudioWindow
from ..streams.broadcaster import BroadcasterRegistry
from ..streams.audio_stream import SessionAudio
from ..telemetry import markers as load_markers
from . import resource_budget
from .budget_reallocator import BudgetReallocator
from .density_reconciler import DensityReconciler, RefreshOutcome, Snapshot
from .display_ids import is_virtual_display_id, known_display_id
from .dpi_policy import negotiate_dpi
from .eco_workspace import ANCHOR_MARKER, EcoWorkspaceManager, MemberCheck
from .encoder_stress_test import StressTestBusyError, run_encoder_stress_test  # noqa: F401 (StressTestBusyError re-exported: app/api/v1/endpoints/devices.py imports it from here)
from .app_presence import AppPresenceMonitor
from .app_restart import AppRestartOutcome, restart_app
from .handoff_manager import HandoffManager
from .mirror_packages import is_internal_package, is_mirror_package
from .resize_gate import ResizeGate
from .session_table import SessionTable
from .spawn_profile import bring_up_server, spawn_window_server
from .session_reconfigure import (  # noqa: F401 (FlexResizeUnsupportedError re-exported: tests import it from here)
    FlexResizeUnsupportedError,
    SessionReconfigurer,
    resolution_aware_bitrate,
)
from .task_movement import move_task_to_display
from .task_teleporter import TaskTeleporter
from .window_lifecycle_coordinator import (
    applock_alive_probe,
    coordinate_window_lifecycle,
    wait_for_app_lock_unlock,
)
from .scrcpy_launcher import ControlSocket, ScrcpyServer, live_servers, serialize_start_app

log = logging.getLogger(__name__)

# Android 10+ restricts activity starts on virtual displays; scrcpy's TRUSTED
# display + shell context lifts it. Below API 29
# there is no pre-check API and starts raise SecurityException — we refuse with
# an actionable error instead of letting the user hit a raw crash.
MIN_API_FOR_VIRTUAL_DISPLAY_LAUNCH = 29

DEFAULT_DISPLAY_W = 1280
DEFAULT_DISPLAY_H = 720


class EncoderLimitError(RuntimeError):
    """All hardware encoder sessions are in use — close/minimize a window first."""


class UnsupportedDeviceError(RuntimeError):
    pass


@dataclass
class WindowSession:
    state: WindowState
    server: ScrcpyServer
    pump_task: asyncio.Task | None = None
    target_display_w: int = DEFAULT_DISPLAY_W  # Requested virtual display width (Android VD size)
    target_display_h: int = DEFAULT_DISPLAY_H  # Requested virtual display height (Android VD size)
    stream_w: int = DEFAULT_DISPLAY_W          # Negotiated video stream width (max_size scaled)
    stream_h: int = DEFAULT_DISPLAY_H          # Negotiated video stream height (max_size scaled)
    # "Sticky" per-session — freeze/unfreeze (budget reallocation, minimize
    # restore) must reuse whatever dpi a resize last set, not silently revert
    # to the phone default. Set properly whenever the session is constructed.
    dpi: int = 0
    # Same stickiness for encoder quality (the Settings panel). Read once
    # from the persisted ProjectSettings when the session is created/last
    # explicitly updated, then reused on every ordinary freeze/unfreeze
    # (minimize-restore, resize) — a trivial minimize should not need a DB
    # round-trip, and it must not silently drift back to some other default.
    max_fps: int = 0
    video_bit_rate: int = 0
    max_size: int = 0
    # Uygulama kilidi: "Tekrar dene" her seferinde `applock_gen`'i artırır → eski bekleyici
    # sessizce çıkar. `lifecycle_task`/`applock_task` eskiden başıboştu; pencere kapanırken İPTAL edilirler
    # (kapanmış pencere için yanlış "kilit açıldı" bildirimi yayınlanmasın).
    applock_gen: int = 0
    lifecycle_task: asyncio.Task | None = None
    applock_task: asyncio.Task | None = None
    # When this window's server was last asked for a keyframe (monotonic; SessionReconfigurer.request_keyframe).
    keyframe_requested_at: float = float("-inf")
    # Set while the window's app stands on the PHONE after a pre-landing resized this window's display to the phone's own
    # size and density (handoff_manager.Landing): what the display has to return to before the app comes back.
    landing: Any = None
    # The user closed this window (window_manager.close_window): from that instant it is not listed, never reused by an
    # open, never healed — whatever the teardown behind it is still waiting for (the device lock, a stuck adb call).
    closing: bool = False
    # The in-place rebuild of this window after a link drop (heal_links), so closing it can abort the rebuild.
    heal_task: asyncio.Task | None = None

    def handle(self, **extra: Any) -> WindowHandle:
        """The window as the frontend sees it. An Eco member's stream lives on the ANCHOR (state.ws_url);
        /ws/video/{member_id} does not exist for it."""
        return WindowHandle(
            window_id=self.state.window_id,
            package=self.state.package,
            ws_url=self.state.ws_url or f"/ws/video/{self.state.window_id}",
            display_w=self.stream_w,
            display_h=self.stream_h,
            **extra,
        )

    @property
    def display_w(self) -> int:
        """Negotiated video stream width used for touch coordinate injection."""
        return self.stream_w

    @property
    def display_h(self) -> int:
        """Negotiated video stream height used for touch coordinate injection."""
        return self.stream_h

    @property
    def control(self) -> ControlSocket | None:
        return self.server.sockets.control if self.server.sockets else None


class WindowManager:
    def __init__(
        self,
        adb: Adb,
        settings: Settings,
        events: EventBus,
        broadcasters: BroadcasterRegistry,
        session_audio: SessionAudio,
        capability_probe: CapabilityProbe,
        device_manager: DeviceManager,
        daemon_client: Any = None,
    ) -> None:
        self._adb = adb
        self._settings = settings
        self._events = events
        self._broadcasters = broadcasters
        self._session_audio = session_audio
        self._probe = capability_probe
        self._devices = device_manager
        self._daemon_client = daemon_client
        # Shared by reference with every composed component below; membership changes are observable (per-window
        # audio follows them — see set_app_audio).
        self._sessions: SessionTable = SessionTable()
        self._app_audio_unsubscribe: Any = None
        self._serial: str | None = None
        self._android_id: str | None = None
        self._profile: DeviceProfile | None = None
        self._z_counter = 0
        self._handoff_monitor_task: asyncio.Task | None = None
        self._orphan_reaper_task: asyncio.Task | None = None
        # Serializes ALL window lifecycle operations device-wide — see module
        # docstring. asyncio.Lock is not reentrant, so any method that needs
        # to call another lifecycle operation while already holding it must
        # call the composed object's method directly, never a public wrapper
        # (that would try to reacquire the lock and deadlock).
        self._lock = asyncio.Lock()
        # package -> monotonic deadline: while it runs, focusing that app's window does NOT send the launcher START_APP (see hold_launch).
        self._launch_held: dict[str, float] = {}
        # window_id -> its teardown task, from the moment the user closed it (close_window) until it is gone.
        self._closers: dict[str, asyncio.Task] = {}
        # heal_links runs one window at a time under `_lock` (so a close/open can interleave between windows); this keeps
        # two heals from interleaving with EACH OTHER.
        self._heal_lock = asyncio.Lock()
        # Per-window resize safety belt (resize_gate.py): waited out BEFORE `_lock`, so a window sitting out its
        # interval never delays another window. Keys: window_id (display resize), "task:<window_id>" (Workspace task).
        self._resize_gates: dict[str, ResizeGate] = {}
        # Set between quiesce_for_transport_switch and the rebuild: window_id -> the task parked on display 0 (None:
        # none found) for standalone windows, and the Workspace members parked alongside.
        self._switch_windows: dict[str, str | None] | None = None
        self._switch_workspace: list[str] = []
        # async () -> bool (ConnectionSupervisor.link_dropped), set by set_link_probe; None: nothing watches the link.
        self._link_probe: Callable[[], Awaitable[bool]] | None = None

        # The one place that decides when an app PROCESS must be reborn because the density it lives under changed
        # (density_reconciler.py). Shared by every component that changes a density: open/warm transfer, live DPI,
        # handoff, reclaim, Workspace<->phone.
        self._density = DensityReconciler(
            adb, settings,
            serial_getter=lambda: self._serial,
            daemon_getter=lambda: self._daemon_client,
            api_level_getter=lambda: self._profile.android_api if self._profile is not None else None,
            inplace_getter=lambda: self._profile.density_inplace_relaunch if self._profile is not None else None,
            inplace_setter=self._learn_inplace_relaunch,
        )
        self._reconfigure = SessionReconfigurer(
            adb, settings, events, broadcasters, self._sessions,
            serial_getter=lambda: self._serial,
            profile_getter=lambda: self._profile,
            android_id_getter=lambda: self._android_id,
            daemon_client_getter=lambda: self._daemon_client,
            density=self._density,
            # Lazy lambda: self._eco_workspace is constructed BELOW this
            # point (it itself depends on self._reconfigure.start_video_pump),
            # so it cannot be referenced eagerly here — only by the time this
            # callback actually fires at runtime is it guaranteed to exist.
            # (never during a transport switch: the shared display is being moved on purpose, its members survive)
            on_anchor_pump_terminated=lambda window_id: (
                None if self._switch_windows is not None
                else self._eco_workspace.notify_anchor_pump_terminated(window_id)
            ),
            # Same lazy reason: the handoff decision belongs to HandoffManager, constructed below.
            on_window_pump_ended=lambda session: self._handoff.on_pump_ended(session),
            link_dropped=lambda: self._link_dropped(),
        )
        self._budget = BudgetReallocator(
            events, settings, self._sessions,
            profile_getter=lambda: self._profile,
            bump_z=self._bump_z,
            freeze_locked=self._reconfigure.freeze,
            unfreeze_locked=self._reconfigure.unfreeze,
        )
        self._handoff = HandoffManager(
            adb, settings, events, self._sessions,
            serial_getter=lambda: self._serial,
            unfreeze_locked=self._reconfigure.unfreeze,
            daemon_client_getter=lambda: self._daemon_client,
            on_eco_member_on_phone=self._schedule_eco_member_on_phone,
            lock=self._lock,
            density=self._density,
            resize_display=self._resize_display_for_handoff,
        )
        self._eco_workspace = EcoWorkspaceManager(
            adb, settings, events, self._sessions,
            serial_getter=lambda: self._serial,
            profile_getter=lambda: self._profile,
            start_video_pump=self._reconfigure.start_video_pump,
            broadcasters=broadcasters,
            daemon_client_getter=lambda: self._daemon_client,
        )
        self._teleporter = TaskTeleporter(
            adb, settings, events, self._sessions, self._eco_workspace,
            serial_getter=lambda: self._serial,
            start_video_pump=self._reconfigure.start_video_pump,
            daemon_client_getter=lambda: self._daemon_client,
            density=self._density,
        )
        # "The app of this window was closed on the phone": task snapshots from the daemon.
        self._presence = AppPresenceMonitor(
            events, self._sessions,
            workspace_display_getter=lambda: self._eco_workspace.display_id,
            # A transport switch parks every app on the phone for a few seconds: not "closed by the user".
            is_parked=lambda wid: self._switch_windows is not None or self._is_parked_member(wid),
            close_window=self.close_window,
            behavior_getter=self._app_closed_behavior,
            request_snapshot=self._request_tasks_snapshot,
        )

    async def _resize_display_for_handoff(
        self, window_id: str, width: int, height: int, dpi: int, *, in_place_only: bool,
    ) -> bool:
        """HandoffManager's hook: the window's display to ``width``×``height`` @ ``dpi`` — size and density in ONE step —
        under the lifecycle lock the caller already holds (never `resize_window`: it would queue for that lock). The
        density is the caller's to settle (``settle=False``). ``in_place_only``: only a resize that keeps the display and
        the app on it (flex); False lets the rebuild fallback run too. Returns whether the display now has the geometry."""
        session = self._sessions.get(window_id)
        profile = self._profile
        if session is None or session.state.frozen or session.control is None:
            return False
        project = await settings_db.get_project_settings()
        if in_place_only and not (profile is not None and self._reconfigure.flex_display_ok(profile, project)):
            return False
        await self._reconfigure.resize(window_id, width, height, dpi, project=project, settle=False)
        return (session.target_display_w, session.target_display_h, session.dpi) == (width, height, dpi)

    def _is_parked_member(self, window_id: str) -> bool:
        task = self._eco_workspace.get_task(window_id)
        return bool(task and task.parked)

    @staticmethod
    async def _app_closed_behavior() -> str:
        return (await settings_db.get_project_settings()).app_closed_behavior

    async def _request_tasks_snapshot(self) -> bool:
        daemon = self._daemon_client
        return bool(daemon is not None and await daemon.request_tasks_snapshot())

    def _bump_z(self) -> int:
        """Shared z-index counter — also incremented directly by
        `_open_window_locked` for a freshly created session; exposed as a
        callback so budget_reallocator.py's `focus()` can bump the SAME
        counter without owning it."""
        self._z_counter += 1
        return self._z_counter

    # ------------------------------------------------------------------ session

    async def bind_device(self, serial: str, android_id: str) -> DeviceProfile:
        self._serial = serial
        self._android_id = android_id
        self._profile = await self._probe.get_or_probe(serial, android_id)
        # ONE adb round trip; `;` keeps each setting independent of the others' failure:
        #  * stay_on_while_plugged_in is NOT touched here: it is held only while windows are open (device/phone_awake.py);
        #  * freeform + forced-resizable activities (windows and the Workspace);
        #  * force_desktop_mode_on_external_displays 0 — dedicated virtual displays open fullscreen, not freeform;
        #  * never lock Display 0's orientation globally (WindowManagerService watchdog deadlocks / reboots on
        #    HyperOS/MIUI) — virtual displays handle orientation per display (-d);
        #  * no leftover overlay displays.
        with contextlib.suppress(Exception):
            await self._adb.shell(
                "settings put global enable_freeform_support 1; "
                "settings put global force_resizable_activities 1; "
                "settings put global force_desktop_mode_on_external_displays 0; "
                "cmd window set-ignore-orientation-request false; settings put global overlay_display_devices none",
                serial=serial,
            )
        if self._handoff_monitor_task is None or self._handoff_monitor_task.done():
            self._handoff_monitor_task = asyncio.create_task(self._handoff.run_monitor_loop(), name="handoff-watchdog")
        if self._orphan_reaper_task is None or self._orphan_reaper_task.done():
            self._orphan_reaper_task = asyncio.create_task(self._run_orphan_reaper(), name="orphan-server-reaper")
        return self._profile

    @property
    def profile(self) -> DeviceProfile | None:
        return self._profile

    def list_windows(self) -> list[WindowState]:
        # "eco-anchor" is EcoWorkspaceManager's own internal video-pump/WS
        # routing session (see eco_workspace.py) — not a real window, must
        # never leak to the frontend.
        return [s.state for s in self._sessions.values() if s.state.workspace_id != ANCHOR_MARKER and not s.closing]

    def get_session(self, window_id: str) -> WindowSession | None:
        return self._sessions.get(window_id)

    def get_session_by_package(self, package: str) -> WindowSession | None:
        """Finds active window session for a given Android package name."""
        for s in self._sessions.values():
            if s.state.package == package and not s.closing:
                return s
        return None

    def set_daemon_client(self, daemon_client: Any) -> None:
        """Attaches the device daemon client for sub-millisecond Binder IPC operations."""
        self._daemon_client = daemon_client

    def set_link_probe(self, probe: Callable[[], Awaitable[bool]]) -> None:
        """The connection supervisor's "did the adb link drop?" question, asked when a window's server dies."""
        self._link_probe = probe

    async def _link_dropped(self) -> bool:
        """True while a link drop is being recovered. Handoff detection is held (with a lease) from the first sign of it:
        whatever the phone does with the dead displays' apps meanwhile is the drop's doing, not the user opening them
        there (a completed heal_links lifts the hold)."""
        dropped = self._link_probe is not None and await self._link_probe()
        if dropped:
            self._handoff.hold("link_drop", lease_s=self.LINK_DROP_HOLD_S)
        return dropped

    def subscribe_sessions(self, listener: Callable[[], None]) -> Callable[[], None]:
        """`listener` runs (synchronously, cheap) whenever a session is added or dropped, by any component."""
        return self._sessions.subscribe(listener)

    def has_windows(self) -> bool:
        return any(s.state.workspace_id != ANCHOR_MARKER for s in list(self._sessions.values()))

    def set_app_audio(self, app_audio: Any) -> None:
        """Per-window audio (streams/app_audio.py) follows the open windows: every session added or dropped — by
        any component sharing the table — requests one coalesced reconcile. Never awaited here: a daemon RPC must
        not run under the window lifecycle lock."""
        if self._app_audio_unsubscribe is not None:
            self._app_audio_unsubscribe()
        self._app_audio_unsubscribe = (
            self._sessions.subscribe(app_audio.request_sync) if app_audio is not None else None
        )

    def stream_inventory(self) -> list[dict[str, Any]]:
        """Every live video stream with its broadcaster's cumulative byte/packet counters (the Telefon Yükü panel turns
        them into Mbps and packets/s). An Eco member has no stream of its own: the anchor carries the shared one."""
        out: list[dict[str, Any]] = []
        for wid, s in list(self._sessions.items()):
            if s.state.workspace_id == "eco":
                continue
            broadcaster = self._broadcasters.get(wid)
            stats = broadcaster.stats() if broadcaster is not None else {}
            out.append({
                "window_id": wid,
                "package": "Eco Workspace" if s.state.workspace_id == ANCHOR_MARKER else s.state.package,
                "w": s.stream_w, "h": s.stream_h, "target_fps": s.max_fps or s.state.fps, "dpi": s.dpi or None,
                "paused": bool(s.state.frozen),
                "bytes": stats.get("bytes_total", 0), "packets": stats.get("packets_total", 0),
            })
        return out

    def open_packages(self) -> list[str]:
        """Apps currently shown in OpenDeX (window or Workspace member): the load monitor tracks their processes."""
        return sorted({
            s.state.package for s in self._sessions.values()
            if s.state.workspace_id != ANCHOR_MARKER and not is_internal_package(s.state.package)
        })

    def audio_windows(self) -> dict[str, AudioWindow]:
        """window_id → AudioWindow(package, on_phone) for every real window (the Workspace anchor is plumbing)."""
        return {
            wid: AudioWindow(package=s.state.package, on_phone=bool(s.state.handoff_to_phone))
            for wid, s in list(self._sessions.items())
            if s.state.workspace_id != ANCHOR_MARKER
        }

    @property
    def active_window_count(self) -> int:
        return len(self._sessions)

    def _active_encoder_count(self) -> int:
        # Eco Workspace üyeleri (workspace_id == "eco") PAYLAŞIMLI TEK bir
        # encoder'ı kullanıyor — bu maliyet zaten "eco-anchor" işaretli TEK
        # session tarafından temsil ediliyor. Üyeleri burada da saymak O(N)
        # sayardı ve Eco Workspace'in tüm amacını (encoder tasarrufu) fiilen
        # iptal ederdi (bkz. eco_workspace.py).
        count = 0
        for s in self._sessions.values():
            if s.state.frozen:
                continue
            if s.state.workspace_id == "eco":
                continue
            if s.state.workspace_id == ANCHOR_MARKER and not s.server.is_alive:
                # Güvenlik ağı: paylaşımlı VD'nin video pompası dış etkenle
                # (örn. Android tarafında VD çökmesi) koptuysa ama hayalet
                # anchor session henüz temizlenmediyse, ölü encoder'ı
                # bütçede saymaya devam etmeyelim.
                continue
            count += 1
        return count

    # ------------------------------------------------------------------ open

    async def open_window(
        self,
        package: str,
        *,
        display_w: int = DEFAULT_DISPLAY_W,
        display_h: int = DEFAULT_DISPLAY_H,
        dpi: int | None = None,
        display_mode: Literal["maximized", "windowed"] = "windowed",
        auto_start_app: bool = True,
    ) -> WindowHandle:
        async with self._lock:
            return await self._open_window_locked(
                package,
                display_w=display_w,
                display_h=display_h,
                dpi=dpi,
                display_mode=display_mode,
                auto_start_app=auto_start_app,
            )

    async def _reuse_existing_window_if_open(
        self, package: str, is_mirror: bool, auto_start_app: bool,
    ) -> WindowHandle | None:
        """If a window for this package is already open, bring it to focus
        (unfreezing / reclaiming from phone / restarting the app as needed)
        and return its handle — the caller must return this instead of
        opening a second window for the same package."""
        for s in list(self._sessions.values()):
            if s.state.package != package or s.closing:
                continue
            wlog = window_logger(__name__, s.state.window_id)
            wlog.info("existing window for %s found (%s); bringing to focus", package, s.state.window_id)
            # Telefona park edilmiş Workspace üyesinin sunucusu BİLEREK yoktur (paylaşımlı VD, canlı
            # üye kalmayınca serbest bırakıldı) — "ölü oturum" sayılıp kapatılırsa telefondaki uygulama
            # force-stop edilirdi.
            parked_eco = s.state.workspace_id == "eco" and s.state.handoff_to_phone
            # If server process has unexpectedly died or crashed, clean up the stale session so it can reopen fresh
            if not s.state.frozen and not parked_eco and not s.server.is_alive:
                wlog.warning("existing session for %s is dead (server process not alive); closing to reopen fresh", package)
                # Runs under open_window's lock: the LOCKED body, never the public close_window (asyncio.Lock is not
                # reentrant — calling the wrapper here waited on itself forever and froze every window operation).
                await self._close_window_locked(s.state.window_id)
                return None
            if s.state.frozen:
                try:
                    await self._reconfigure.unfreeze(s.state.window_id)
                except Exception:
                    # A window frozen by a link drop whose rebuild keeps failing would otherwise answer EVERY open of this
                    # app with the same error: the user could neither close it nor reopen the app. Its server is gone
                    # anyway, so drop the leftover and open the app fresh (a link that is really down fails that open
                    # honestly — with the broken window already out of the way).
                    wlog.warning("frozen window for %s could not be woken; dropping it to open fresh", package, exc_info=True)
                    await self._close_window_locked(s.state.window_id)
                    return None
            elif s.state.handoff_to_phone:
                await self._reclaim_locked(s.state.window_id)
            else:
                task_on_d0 = None
                if self._adb and self._serial and not is_mirror:
                    with contextlib.suppress(Exception):
                        from app.device.deep_navigator import find_task_id_for_package
                        task_on_d0 = await find_task_id_for_package(self._adb, package, display_id="0", serial=self._serial)
                if task_on_d0:
                    wlog.info("Task for %s is on phone (Display 0); reclaiming via Stealth DPI...", package)
                    await self._reclaim_locked(s.state.window_id)
                elif s.control is not None and not is_mirror and auto_start_app:
                    with contextlib.suppress(Exception):
                        await s.control.send(serialize_start_app(package))
            await self._budget.focus(s.state.window_id)
            return s.handle()
        return None

    async def _ensure_encoder_budget_available(self, project: ProjectSettings) -> None:
        """Raises EncoderLimitError if opening one more window would exceed
        this device's probed (not assumed) concurrent-encoder limit."""
        effective_limit = resource_budget.get_effective_encoder_limit(
            self._profile, project.custom_encoder_limit
        )
        if self._active_encoder_count() >= effective_limit:
            log.warning(
                "encoder_limit_hit: %d/%d sessions active, packages=%s",
                self._active_encoder_count(),
                effective_limit,
                [(s.state.window_id, s.state.package) for s in self._sessions.values()],
            )
            await self._events.emit(
                "encoder_limit_hit", max_windows=effective_limit
            )
            raise EncoderLimitError(
                f"Encoder limiti dolu ({effective_limit}); "
                "önce bir pencere kapatın veya küçültün."
            )

    def _negotiate_dpi_and_bitrate(
        self,
        display_w: int,
        display_h: int,
        dpi: int | None,
        project: ProjectSettings,
        wlog: logging.LoggerAdapter,
    ) -> tuple[int, int]:
        """Resolves the DPI to spawn at (explicit override > custom DPI >
        target-dp-derived > device default) and the bitrate floor for this
        resolution (see resolution_aware_bitrate's docstring)."""
        chosen_dpi = negotiate_dpi(display_w, display_h, dpi, project, self._settings.VIRTUAL_DISPLAY_DPI)

        wlog.debug(
            "dpi_negotiation_diagnostic: display=%dx%d, passed_dpi=%s, db_custom_dpi=%s, db_target_dp=%s => resolved chosen_dpi=%d (calculated smallestWidthDp=%.1f dp)",
            display_w, display_h, dpi, project.custom_dpi, project.target_dp, chosen_dpi, (min(display_w, display_h) * 160.0 / (chosen_dpi or 160))
        )
        chosen_bitrate = resolution_aware_bitrate(
            display_w, display_h, project.max_fps, project.video_bit_rate, self._settings
        )
        if chosen_bitrate != project.video_bit_rate:
            wlog.debug(
                "bitrate_floor_applied: configured=%d raised to %d for %dx%d@%dfps",
                project.video_bit_rate, chosen_bitrate, display_w, display_h, project.max_fps,
            )
        return chosen_dpi, chosen_bitrate

    async def _compute_stealth_dpi_phases(
        self,
        is_mirror: bool,
        chosen_dpi: int,
        wlog: logging.LoggerAdapter,
        package: str = "",
        stealth_enabled: bool = True,
    ) -> tuple[int, int, bool]:
        """2-Aşamalı DPI (Stealth DPI) Mekanizması:
        Faz 1: Sanal display telefonun fiziksel DPI'ı ile doğar (Display 0).
        Böylece taşınan görev (Task) display değiştirirken DPI şoku yaşamaz ve
        Chrome scroll/state korunur.
        Faz 2: Uygulama sanal display'e yerleştikten sonra display hedef
        DPI'ya çekilir.

        NOT: Yalnızca telefonda (Display 0) zaten çalışmakta olan bir görev (Task)
        varsa ve Stealth DPI kullanıcı ayarlarında aktifse devreye girer.
        Soğuk başlatmada (Cold start) sanal ekran doğrudan hedef chosen_dpi ile doğar;
        böylece 172dp dar viewport ve arayüz kırılma sorunu kökten engellenir.
        """
        phase1_dpi = chosen_dpi
        phase2_dpi = chosen_dpi
        is_stealth_active = False

        if not stealth_enabled:
            return phase1_dpi, phase2_dpi, False

        if not is_mirror and self._serial and self._adb:
            from app.device.deep_navigator import find_task_id_for_package
            try:
                task_on_phone = await find_task_id_for_package(
                    self._adb, package, display_id="0", serial=self._serial
                )
            except Exception as exc:
                wlog.debug("[STEALTH DPI] Display 0 task kontrolü hatası: %s; soğuk başlatma kabul ediliyor", exc)
                task_on_phone = None

            if not task_on_phone:
                wlog.info(
                    "❄️ [STEALTH DPI: COLD START] %s telefonda (Display 0) çalışmıyor. Sanal ekran doğrudan hedef %d DPI ile doğacak.",
                    package, chosen_dpi
                )
                return chosen_dpi, chosen_dpi, False

            physical_dpi = await android_shell.phone_density(self._adb, self._serial)
            if physical_dpi and physical_dpi != chosen_dpi:
                phase1_dpi = physical_dpi
                phase2_dpi = chosen_dpi
                is_stealth_active = True
                wlog.info(
                    "🚀 [STEALTH DPI: WARM TRANSFER] %s görevi (task_id=%s) telefondan taşınıyor: Faz 1 (fiziksel)=%d DPI -> Faz 2 (hedef)=%d DPI",
                    package, task_on_phone, phase1_dpi, phase2_dpi
                )
        return phase1_dpi, phase2_dpi, is_stealth_active

    async def _open_window_locked(
        self,
        package: str,
        *,
        display_w: int,
        display_h: int,
        dpi: int | None = None,
        display_mode: Literal["maximized", "windowed"] = "windowed",
        auto_start_app: bool = True,
    ) -> WindowHandle:
        if not (self._serial and self._profile):
            raise DeviceNotBoundError()
        is_mirror = is_mirror_package(package)
        if not is_mirror:
            self.hold_handoff(package, seconds=4.0)

        # 1. Activity-start pre-check equivalent — API gate.
        if not is_mirror and self._profile.android_api < MIN_API_FOR_VIRTUAL_DISPLAY_LAUNCH:
            raise UnsupportedDeviceError(
                "Sanal ekranda uygulama başlatma Android 10+ gerektirir "
                f"(cihaz API {self._profile.android_api})."
            )
        # 0. Windows the user already closed but whose teardown is still queued behind the lock: finish them now (their
        #    encoder slot and display must be free before a new window asks for one — usually the very app reopened).
        await self._reap_closing_locked()
        # 1. Existing window reuse check: if an open window for this package exists, bring to focus
        reused = await self._reuse_existing_window_if_open(package, is_mirror, auto_start_app)
        if reused is not None:
            return reused

        # 2. Encoder budget (probed, not assumed).
        project = await settings_db.get_project_settings()
        await self._ensure_encoder_budget_available(project)

        window_id = uuid.uuid4().hex[:12]
        wlog = window_logger(__name__, window_id)

        # 3. Virtual display via scrcpy spawn (or physical display 0 for phone mirror)
        chosen_dpi, chosen_bitrate = self._negotiate_dpi_and_bitrate(display_w, display_h, dpi, project, wlog)
        phase1_dpi, phase2_dpi, is_stealth_active = await self._compute_stealth_dpi_phases(
            is_mirror, chosen_dpi, wlog, package=package, stealth_enabled=project.stealth_dpi_enabled,
        )

        # Density birth guarantee (density_reconciler.py). The process of an app whose density changes while it lives
        # (phone 520 → window 200) is the one that keeps the phone-sized UI, so its identity is noted BEFORE anything
        # touches its density and re-checked after the move/phase 2 settled. A live process with NO task anywhere is
        # a cached leftover born under some other display's density: discard it so this launch is a real cold birth
        # ("no task on display 0" is not "no process"). With a phone task the process is warm — the coordinator
        # settles it after the move.
        density_before: Snapshot | None = None
        if not is_mirror:
            density_before = await self._density.snapshot(package)
            if density_before.identity is not None and not is_stealth_active:
                if await self._density.discard_stale_cached_process(package) == "killed":
                    density_before = Snapshot(package, None)

        server = ScrcpyServer(self._adb, self._settings, self._serial, daemon=self._daemon_client)
        try:
            sockets = await bring_up_server(
                server,
                lambda: spawn_window_server(
                    server,
                    package=package,
                    project=project,
                    settings=self._settings,
                    display_w=display_w,
                    display_h=display_h,
                    dpi=phase1_dpi if is_stealth_active else chosen_dpi,
                    max_size=project.max_size,
                    video_bit_rate=chosen_bitrate,
                    max_fps=project.max_fps,
                ),
                start_app=package if not is_mirror and auto_start_app else None,
            )
        except Exception:
            wlog.exception("failed to bring up %s; cleaning up", package)
            raise

        # 4. Legacy fallback (Android ≤12 / old jar): the ONE session audio, if enabled and DeX (pc) or İkisi (both). While per-app
        #    audio owns the device (Android 13+) SessionAudio is suppressed and this is a no-op; the window's own
        #    audio follows from the session table instead (streams/app_audio.py).
        if (
            project.enable_audio
            and project.audio_output_mode in ("pc", "both")
            and not self._session_audio.running
            and self._serial
        ):
            try:
                await self._session_audio.start_session_audio(self._serial, output_mode=project.audio_output_mode)
            except Exception as exc:
                wlog.warning("session audio unavailable: %s", exc)

        wlog.info("Server started for %s (is_mirror=%s)", package, is_mirror)
        self._z_counter += 1
        disp_id_str = str(server.display_id or "")

        state = WindowState(
            window_id=window_id,
            package=package,
            width=display_w,
            height=display_h,
            z_index=self._z_counter,
            display_mode=display_mode,
            focused=True,
            fps=project.max_fps,
            ws_url=f"/ws/video/{window_id}",
            display_id=disp_id_str,
            stealth_phase=is_stealth_active,
        )
        session = WindowSession(
            state=state,
            server=server,
            target_display_w=display_w,
            target_display_h=display_h,
            # Touch/scroll coordinates MUST carry the server's ACTUAL video size (the scrcpy position mapper drops any
            # event whose screen size differs), not the requested target.
            stream_w=sockets.video_meta.width if sockets.video_meta else display_w,
            stream_h=sockets.video_meta.height if sockets.video_meta else display_h,
            dpi=chosen_dpi,
            max_fps=project.max_fps,
            video_bit_rate=chosen_bitrate,
            max_size=project.max_size,
        )
        self._sessions[window_id] = session
        self._reconfigure.start_video_pump(session)
        if self._handoff_monitor_task is None or self._handoff_monitor_task.done():
            self._handoff_monitor_task = asyncio.create_task(self._handoff.run_monitor_loop(), name="handoff-watchdog")
        wlog.info("window opened for %s (%dx%d, target=%dx%d)", package, session.stream_w, session.stream_h, display_w, display_h)
        load_markers.record("window_open", package=package, detail=f"{session.stream_w}×{session.stream_h} @ {chosen_dpi} DPI")

        # Zero-Blink Task Migration, AppLock Coordinator & 2-Stage Stealth DPI Manager
        # (window_lifecycle_coordinator.py) — fire-and-forget background task.
        if not is_mirror and self._serial:
            session.lifecycle_task = asyncio.create_task(
                coordinate_window_lifecycle(
                    adb=self._adb,
                    events=self._events,
                    sessions=self._sessions,
                    serial=self._serial,
                    sockets=sockets,
                    wlog=wlog,
                    pkg_name=package,
                    target_server=server,
                    win_id=window_id,
                    p1_dpi=phase1_dpi,
                    p2_dpi=phase2_dpi,
                    stealth_active=is_stealth_active,
                    auto_start=auto_start_app,
                    daemon=self._daemon_client,
                    lock=self._lock,
                    density=self._density,
                    density_before=density_before,
                ),
                name=f"window-coord-{window_id}"
            )

        # 7. display_w/h in the response — frontend coordinate mapping needs it.
        return session.handle(stealth_phase=is_stealth_active)

    # ------------------------------------------------------------------ close

    # How long a close request waits for the teardown before answering anyway (it carries on in the background).
    CLOSE_WAIT_S = 4.0
    # One teardown step that talks to the phone (stopping the scrcpy server): past this it is abandoned — the orphan reaper
    # collects what it left — so a wedged adb can never hold the device lock for ever.
    TEARDOWN_STEP_TIMEOUT_S = 10.0
    # One window's in-place rebuild after a link drop.
    HEAL_WINDOW_TIMEOUT_S = 60.0

    async def close_window(self, window_id: str) -> None:
        """The user closed the window. Two phases, because the device lock can be held for a long time by someone else (a
        link-recovery rebuild, a resize whose adb calls hang) exactly when the link is in trouble:

          1. NOW, without the lock: the window is marked ``closing`` — gone from the window list (a page reload cannot
             bring it back), never reused by an open, never healed — and whatever is rebuilding it is aborted;
          2. the teardown (stop the server, free the display) runs as a background task under the lock; this call waits
             for it at most CLOSE_WAIT_S and then answers: the user's decision is already effective.

        Idempotent; never raises for a window that is already gone."""
        session = self._sessions.get(window_id)
        if session is None:
            return
        session.closing = True
        self._abort_inflight_work(session)
        task = self._closers.get(window_id)
        if task is None:
            # Referenced by `_closers` until it finishes (asyncio holds tasks weakly); `_teardown` never raises.
            task = self._closers[window_id] = asyncio.get_running_loop().create_task(
                self._teardown(window_id), name=f"close-{window_id}",
            )
        await asyncio.wait({task}, timeout=self.CLOSE_WAIT_S)

    async def _teardown(self, window_id: str) -> None:
        try:
            async with self._lock:
                await self._close_window_locked(window_id)
        except Exception:
            window_logger(__name__, window_id).exception("[WindowManager:CLOSE] kapatma tamamlanamadı — oturum kayıttan düşürüldü")
            self._sessions.pop(window_id, None)
        finally:
            self._closers.pop(window_id, None)

    def _abort_inflight_work(self, session: WindowSession) -> None:
        """Lock-free: stop what would rebuild or re-launch a window that is being closed."""
        self._cancel_lifecycle_tasks(session)
        self._density.cancel(session.state.window_id)
        task = session.heal_task
        if task is not None and not task.done():
            task.cancel()

    async def _reap_closing_locked(self) -> None:
        """Under the lock: tear down every window the user closed whose teardown has not got the lock yet."""
        for window_id, session in list(self._sessions.items()):
            if session.closing:
                await self._close_window_locked(window_id)

    async def _close_window_locked(self, window_id: str) -> None:
        """Order matters: signal WS clients first, then tear down resources."""
        session = self._sessions.get(window_id)
        if session is None:
            return

        # Başıboş kalan AppLock/yaşam döngüsü görevlerini pencere kapanırken İPTAL et.
        self._cancel_lifecycle_tasks(session)
        self._density.cancel(window_id)  # bekleyen yoğunluk uzlaştırması: pencere yok, süreç yenilenmez
        # A request still waiting at the gate takes the lock after this and finds no session (404) — correct.
        self._resize_gates.pop(window_id, None)
        self._resize_gates.pop(f"task:{window_id}", None)

        if session.state.workspace_id != ANCHOR_MARKER:
            load_markers.record("window_close", package=session.state.package)

        if session.state.workspace_id == ANCHOR_MARKER:
            # EcoWorkspaceManager's own internal video-pump/WS-routing
            # session — never torn down directly here. Because it's
            # inserted into `_sessions` BEFORE any real Eco member (see
            # eco_workspace.py._ensure_shared_display), close_all()'s
            # snapshot-iteration would otherwise reach it first and stop the
            # shared server out from under still-live members. Just drop the
            # bookkeeping entry; EcoWorkspaceManager cleans up the real
            # server/pump itself once its LAST real member is removed (via
            # the "eco" branch below, later in this same sweep).
            self._sessions.pop(window_id, None)
            return

        if session.state.workspace_id == "eco":
            # Eco Workspace üyesi: server PAYLAŞIMLI, bu session'ın KENDİ
            # pump_task'ı hiç yoktur (video pump'ı EcoWorkspaceManager'ın
            # kendi dahili "anchor" session'ına bağlı, bkz. eco_workspace.py)
            # — burada cancel edilecek/broadcaster'dan düşürülecek bir şey
            # yok. EcoWorkspaceManager, son üye kalıp kalmadığına göre
            # paylaşımlı VD'yi (ve anchor'ın pump'ını) imha edip
            # etmeyeceğine kendi karar verir.
            window_logger(__name__, window_id).info("🚪 [WindowManager:CLOSE ❌] Eco Workspace üyesi %s (%s) kapatılıyor", window_id, session.state.package)
            self._sessions.pop(window_id, None)
            await self._eco_workspace.remove_task(window_id)
            return

        self._sessions.pop(window_id, None)
        window_logger(__name__, window_id).info("🚪 [WindowManager:CLOSE ❌] Window %s (%s) kapatılıyor", window_id, session.state.package)
        self._broadcasters.remove(window_id)  # WS endpoints observe and close
        await cancel_and_wait(session.pump_task)
        # Reverse Stealth DPI: Before destroying the virtual display,
        # equalize its density to phone physical DPI.
        # Dipnot: Çarpıya (X) basıldığında Stealth DPI eşitlemesi yapılır; bu sayede kullanıcı telefona geçtiğinde veya son uygulamalardan (Recents) girdiğinde DPI şoku ve reflow yaşanmadan sorunsuz bir deneyim sağlanır. Ancak Display 0'a taşıma (display move) yapılmaz; Display 0'a taşıma yalnızca kullanıcı 'Telefona Geç' (Handoff) yaptığında çalışır.
        if self._adb and self._serial:
            with contextlib.suppress(Exception):
                disp_id = known_display_id(session)
                pkg = session.state.package
                if disp_id and not is_internal_package(pkg):
                    phys_dpi = await android_shell.phone_density(self._adb, self._serial)
                    if phys_dpi:  # unread → the display closes as it is; a guessed density would be worse
                        await android_shell.set_display_density(
                            self._adb, self._serial, disp_id, phys_dpi, daemon=self._daemon_client, timeout_s=1.5,
                        )
                        await asyncio.sleep(0.2)

        # Stop the session cleanly without moving task to Display 0 (evacuate=None)
        try:
            await asyncio.wait_for(session.server.stop(evacuate=None), self.TEARDOWN_STEP_TIMEOUT_S)
        except asyncio.TimeoutError:
            window_logger(__name__, window_id).warning(
                "[WindowManager:CLOSE] sunucu %.0f sn içinde durmadı (adb takılı?) — bırakıldı; öksüz süpürücü toplayacak",
                self.TEARDOWN_STEP_TIMEOUT_S,
            )
        window_logger(__name__, window_id).info("🚪 [WindowManager:CLOSED ✅] Pencere tamamen kapatıldı (%s)", session.state.package)
        # The display (and, with vd_destroy_content, the app's tasks) is gone but the app's PROCESS can linger cached,
        # born under this window's density. Whatever opens the app next — the phone's launcher, Recents, another
        # window — would inherit that stale process (phone showing a 200 dpi UI: the "close it in Recents and reopen
        # it" ritual). `am kill` only ever removes processes that are safe to kill; skipped when any task remains.
        pkg = session.state.package
        if not (is_internal_package(pkg) or is_mirror_package(pkg)) and self._serial:
            spawn_background(self._discard_cached_process_later(pkg), name=f"density-discard-{window_id}")
        # Note: Do NOT execute 'wm density reset' on Display 0.
        # Virtual displays are destroyed via their own display id, leaving the physical phone's DPI 100% untouched.
        # Note: Master session audio is device-wide and persists even when all windows are closed; per-app audio
        # hands this app's sound back to the phone on its own (the session table drop above triggers it).

    async def close_all(self) -> None:
        await self._presence.shutdown()
        async with self._lock:
            for window_id in list(self._sessions):
                await self._close_window_locked(window_id)
            await cancel_and_wait(self._handoff_monitor_task)
            self._handoff_monitor_task = None
            await cancel_and_wait(self._orphan_reaper_task)
            self._orphan_reaper_task = None
            await self._density.shutdown()
            self._handoff.release("link_drop")  # must not outlive the windows it was for

    # ------------------------------------------------------------------ orphan server reaper

    ORPHAN_MIN_AGE_S = 20.0
    # How long a link drop holds handoff detection if its heal never lifts the hold (see _link_dropped).
    LINK_DROP_HOLD_S = 60.0
    ORPHAN_SWEEP_INTERVAL_S = 30.0

    def _owned_servers(self) -> set[int]:
        owned = {id(s.server) for s in self._sessions.values()}
        if self._eco_workspace.server is not None:
            owned.add(id(self._eco_workspace.server))
        audio_server = self._session_audio.active_server
        if audio_server is not None:
            owned.add(id(audio_server))
        return owned

    async def reap_orphan_servers(self, min_age_s: float | None = None) -> list[str]:
        """Hiçbir oturumun, Workspace'in ya da oturum sesinin sahiplenmediği CANLI scrcpy
        sunucularını durdurur (telefonda sahipsiz kalıp bir sanal ekran + donanım encoder'ı
        tutuyorlardı; cihazda canlı olarak görüldü: arayüzde hiç pencere yokken 6+ dk yaşayan,
        backend'e bağlı bir sunucu). Pencere yaşam döngüsü kilidi altında çalışır — devam eden
        bir open/dock/popout/migrate sırasında yeni doğmuş bir sunucuyu yanlışlıkla öldürmez;
        yine de `min_age_s`'den genç sunucular dokunulmaz. Döner: durdurulan scid'ler."""
        min_age = self.ORPHAN_MIN_AGE_S if min_age_s is None else min_age_s
        reaped: list[str] = []
        async with self._lock:
            owned = self._owned_servers()
            now = time.monotonic()
            for srv in live_servers():
                if id(srv) in owned:
                    continue
                age = now - (srv.spawned_at or now)  # bilinmiyorsa 'genç' say: dokunma
                if age < min_age:
                    continue
                log.warning(
                    "🧹 [OrphanReaper] sahipsiz scrcpy sunucusu durduruluyor: scid=%s display=%s yaş=%.0fs yaratan=%s",
                    srv.scid, srv.display_id, age, srv.created_by,
                )
                with contextlib.suppress(Exception):
                    await srv.stop()
                reaped.append(srv.scid)
        return reaped

    async def _run_orphan_reaper(self) -> None:
        while True:
            try:
                await asyncio.sleep(self.ORPHAN_SWEEP_INTERVAL_S)
                await self.reap_orphan_servers()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.debug("orphan reaper error: %s", exc)

    # ------------------------------------------------------------------ continuity, handoff & reclaim
    # See handoff_manager.py — HandoffManager shares this instance's
    # `_sessions` dict by reference and reads `_serial` live via a getter, so
    # it always observes the exact state these locked wrappers are guarding.

    async def handoff_window_to_phone(self, window_id: str) -> bool:
        """PC ➔ phone handoff, Stealth DPI (see HandoffManager.handoff_to_phone).

        Eco Workspace üyesi ise TEK fark: görev telefona "park edilir" (yeri korunur) —
        bkz. TaskTeleporter.workspace_to_phone. Çağıran için fiil aynıdır (tek buton)."""
        async with self._lock:
            session = self._sessions.get(window_id)
            if session is not None and session.state.workspace_id == "eco":
                return await self._teleporter.workspace_to_phone(window_id)
            return await self._handoff.handoff_to_phone(window_id)

    async def reclaim_window(self, window_id: str, bounds: tuple[int, int, int, int] | None = None) -> bool:
        """Phone ➔ PC reclaim, Stealth DPI (see HandoffManager.reclaim). Görev DOĞDUĞU YERE
        döner: Eco Workspace üyesi park edildiği slota (`bounds` frontend'de sürüklenmişse
        yeni slot), bağımsız pencere kendi VD'sine."""
        async with self._lock:
            return await self._reclaim_locked(window_id, bounds)

    async def _reclaim_locked(self, window_id: str, bounds: tuple[int, int, int, int] | None = None) -> bool:
        """reclaim_window'un KİLİTSİZ gövdesi. asyncio.Lock reentrant DEĞİL: kilidi zaten tutan
        bir yol (open_window → _reuse_existing_window_if_open) public sarmalayıcıyı çağırırsa
        kendi kilidinde sonsuza dek bekler — bu yüzden onlar BUNU çağırır."""
        session = self._sessions.get(window_id)
        if session is not None and session.state.workspace_id == "eco":
            return await self._teleporter.phone_to_workspace(window_id, bounds)
        return await self._handoff.reclaim(window_id)

    def _schedule_eco_member_on_phone(self, window_id: str) -> None:
        """HandoffManager'ın Display 0 odak olayı / watchdog'u bir Workspace üyesinin
        telefonda göründüğünü bildirdiğinde çağrılır (kilitsiz, olay bağlamı). İş, açık
        kullanıcı isteklerinden ayrı bir görevde ve KİLİT ALTINDA yapılır."""
        spawn_background(self._eco_member_on_phone_locked(window_id), name=f"eco-on-phone-{window_id}")

    async def _eco_member_on_phone_locked(self, window_id: str) -> None:
        try:
            async with self._lock:
                session = self._sessions.get(window_id)
                if session is None or session.state.workspace_id != "eco" or session.state.handoff_to_phone:
                    return  # bu arada kapandı / açık istek zaten park etti (idempotent)
                await self._teleporter.workspace_to_phone(window_id, already_on_phone=True)
        except Exception:
            window_logger(__name__, window_id).exception("[Handoff] eco üyesi telefonda tespit edildi ama park edilemedi")

    async def _discard_cached_process_later(self, package: str) -> None:
        await asyncio.sleep(1.2)  # let the display teardown finish and the task list settle
        await self._density.discard_stale_cached_process(package)

    @staticmethod
    def _cancel_lifecycle_tasks(session: "WindowSession") -> None:
        """AppLock bekleyicisi + yaşam döngüsü koordinatörü görevlerini iptal eder (idempotent)."""
        current = asyncio.current_task()
        for task in (session.applock_task, session.lifecycle_task):
            if task is not None and task is not current and not task.done():
                task.cancel()
        session.applock_task = None
        session.lifecycle_task = None

    async def retry_app_lock(self, window_id: str) -> bool:
        """AppLockOverlay's "Tekrar Dene" button: re-runs the up-to-15s
        unlock-wait sequence (see window_lifecycle_coordinator.wait_for_app_lock_unlock)
        for a window still stuck behind an OEM lock screen, instead of
        forcing the user to close and cold-relaunch the whole app after a
        failed fingerprint/PIN attempt.

        Fire-and-forget, same as the initial coordinate_window_lifecycle
        call — deliberately NOT under self._lock, since that would block
        every other window operation for up to 15s while this polls."""
        session = self._sessions.get(window_id)
        if session is None or not self._serial:
            return False
        disp_id = session.state.display_id
        if not disp_id or disp_id in ("0", "None"):
            window_logger(__name__, window_id).warning("[AppLock:RETRY] sanal ekran kimliği geçersiz (display_id=%r) — yeniden istenemedi", disp_id)
            return False
        wlog = window_logger(__name__, window_id)
        # Önceki (henüz bitmemiş) bekleyici yeni denemeden SONRA sessizce çıksın: nesil sayacı.
        session.applock_gen += 1
        if session.applock_task is not None and not session.applock_task.done():
            session.applock_task.cancel()
        session.applock_task = asyncio.create_task(
            wait_for_app_lock_unlock(
                adb=self._adb,
                events=self._events,
                serial=self._serial,
                sockets=session.server.sockets,
                wlog=wlog,
                pkg_name=session.state.package,
                win_id=window_id,
                disp_id=disp_id,
                p1_dpi=session.dpi,
                daemon=self._daemon_client,
                is_alive=applock_alive_probe(self._sessions, window_id),
                fresh=True,
            ),
            name=f"window-applock-retry-{window_id}",
        )
        return True

    # ------------------------------------------------------------------ eco workspace & teleportation
    # See eco_workspace.py / task_teleporter.py — same "shares this instance's
    # _sessions dict by reference" contract as handoff_manager.py above.

    async def open_window_in_workspace(self, package: str) -> WindowHandle:
        """PC'de paylaşımlı Eco Workspace'te yeni bir freeform pencere açar —
        workspace zaten ayaktaysa YENİ ENCODER MALİYETİ YOK (Karar: Hibrit
        Pencereleme Faz 3)."""
        async with self._lock:
            window_id = uuid.uuid4().hex[:12]
            ws_url, stream_w, stream_h, bounds = await self._eco_workspace.open_in_workspace(package, window_id)
            return self._register_eco_member(window_id, package, ws_url, stream_w, stream_h, bounds)

    def _register_eco_member(
        self, window_id: str, package: str, ws_url: str, stream_w: int, stream_h: int,
        bounds: tuple[int, int, int, int],
    ) -> WindowHandle:
        """Workspace'e az önce kaydolmuş bir task için WindowState/WindowSession kurar
        (open_window_in_workspace ve adopt_phone_app_into_workspace ortak kuyruğu)."""
        task = self._eco_workspace.get_task(window_id)
        scale = list(task.render_scale) if task else [1.0, 1.0]
        self._z_counter += 1
        state = WindowState(
            window_id=window_id, package=package,
            width=stream_w, height=stream_h, z_index=self._z_counter,
            display_mode="windowed", focused=True, ws_url=ws_url,
            display_id=self._eco_workspace.display_id,
            workspace_id="eco", task_bounds=list(bounds),
            workspace_vd_w=self._eco_workspace.vd_w,
            workspace_vd_h=self._eco_workspace.vd_h,
            render_scale=scale,
            task_density=task.density if task else None,
            task_density_mode=task.density_mode if task else None,
        )
        session = WindowSession(
            state=state, server=self._eco_workspace.server,
            target_display_w=stream_w, target_display_h=stream_h,
            stream_w=stream_w, stream_h=stream_h,
            dpi=self._settings.ECO_WORKSPACE_DPI,
            max_fps=self._settings.DEFAULT_MAX_FPS,
            video_bit_rate=self._settings.DEFAULT_VIDEO_BIT_RATE,
            max_size=0,
        )
        self._sessions[window_id] = session
        return WindowHandle(
            window_id=window_id, package=package, ws_url=ws_url,
            display_w=self._settings.ECO_WORKSPACE_DISPLAY_W,
            display_h=self._settings.ECO_WORKSPACE_DISPLAY_H,
            workspace_id="eco", task_bounds=list(bounds),
            render_scale=scale,
            task_density=task.density if task else None,
            task_density_mode=task.density_mode if task else None,
        )

    async def adopt_phone_app_into_workspace(self, package: str) -> WindowHandle:
        """"Buraya Yolla": telefonun Display 0'ında şu an çalışan bir uygulamayı Eco Workspace'e
        alır. Uygulama OpenDeX'te zaten bir pencereyse doğru mevcut yola yönlendirilir:
        park edilmiş Workspace üyesi → phone_to_workspace, telefondaki bağımsız pencere →
        dock_to_workspace (doğrudan kenar; reclaim + dock'un iki adımlı VD döngüsü yok)."""
        async with self._lock:
            existing = self.get_session_by_package(package)
            if existing is not None:
                wid = existing.state.window_id
                if existing.state.workspace_id == "eco" and existing.state.handoff_to_phone:
                    await self._teleporter.phone_to_workspace(wid)
                elif existing.state.workspace_id is None and existing.state.handoff_to_phone:
                    await self._teleporter.dock_to_workspace(wid)
                else:
                    raise RuntimeError(f"{package} zaten OpenDeX'te açık ({existing.state.locus}).")
                s = self._sessions[wid]
                return WindowHandle(
                    window_id=wid, package=package, ws_url=s.state.ws_url or "",
                    display_w=s.state.workspace_vd_w or self._settings.ECO_WORKSPACE_DISPLAY_W,
                    display_h=s.state.workspace_vd_h or self._settings.ECO_WORKSPACE_DISPLAY_H,
                    workspace_id="eco", task_bounds=s.state.task_bounds,
                )
            if not self._serial:
                raise RuntimeError("Cihaz bağlı değil.")
            from ..device.deep_navigator import find_task_id_for_package
            task_id = await find_task_id_for_package(self._adb, package, display_id="0", serial=self._serial)
            if not task_id:
                raise RuntimeError(f"{package} telefonda çalışmıyor; önce telefonda açın.")
            window_id = uuid.uuid4().hex[:12]
            ws_url, stream_w, stream_h, bounds = await self._eco_workspace.attach_existing_task(package, window_id, task_id)
            return self._register_eco_member(window_id, package, ws_url, stream_w, stream_h, bounds)

    async def popout_window_to_desktop(self, window_id: str) -> WindowHandle:
        """Eco Workspace üyesini bağımsız pencereye tomurcuklar."""
        async with self._lock:
            session = await self._teleporter.popout_to_desktop(window_id)
            return session.handle()

    async def dock_window_to_workspace(self, window_id: str, bounds: tuple[int, int, int, int] | None = None) -> None:
        """Bağımsız pencereyi Eco Workspace'e geri gönderir (dock)."""
        async with self._lock:
            await self._teleporter.dock_to_workspace(window_id, bounds)

    def _sync_task_state(self, window_id: str) -> None:
        """Görevin GÜNCEL bounds/ölçek/yoğunluğunu pencere oturumunun durumuna yansıtır: `GET /api/windows`
        (Sub-PiP'in başlangıç kaynağı) bayat yoğunluk göstermesin."""
        session = self._sessions.get(window_id)
        task = self._eco_workspace.get_task(window_id)
        if not session or not task:
            return
        session.state.task_bounds = list(task.bounds)
        session.state.render_scale = list(task.render_scale)
        session.state.task_density = task.density
        session.state.task_density_mode = task.density_mode

    async def resize_workspace_task(
        self, window_id: str, bounds: tuple[int, int, int, int], density: int | None = None,
        density_mode: str | None = None,
    ) -> tuple[int, int, int, int] | None:
        """The bounds Android settled on, so the caller (a DeX crop window / PiP that sized itself to the task) can fit
        to what was really granted instead of waiting for the event. None: nothing was applied — a newer request for
        the same task overtook this one at the gate, or the task is parked / unknown."""
        async with self._resize_gate(f"task:{window_id}").slot() as go:
            if not go:
                return None
            async with self._lock:
                before = await self._workspace_density_snapshot(window_id, density)
                effective = await self._eco_workspace.resize_task(
                    window_id, bounds, density=density, density_mode=density_mode,
                )
                self._sync_task_state(window_id)
                if before:
                    self._schedule_workspace_settle(window_id, *before)
            return effective

    async def verify_workspace_task(self, window_id: str) -> MemberCheck:
        """The user pressed on a Workspace member: the real task is checked against the ledger and put back if the OS
        collapsed it (EcoWorkspaceManager.verify_member). A short-lived hold on the global lock like every display change;
        a healthy task costs one daemon read."""
        async with self._lock:
            check = await self._eco_workspace.verify_member(window_id)
            if check.status == "healed":
                self._sync_task_state(window_id)
            return check

    async def set_workspace_task_density(self, window_id: str, density: int, mode: str = "manual") -> bool:
        """Eco Workspace içindeki bir görevin (task) densityDpi Configuration override'ını ayarlar."""
        async with self._lock:
            before = await self._workspace_density_snapshot(window_id, density)
            ok = await self._eco_workspace.set_task_density(window_id, density, mode=mode)
            if ok:
                self._sync_task_state(window_id)
                self._schedule_workspace_settle(window_id, *before)
            return ok

    async def _workspace_density_snapshot(
        self, window_id: str, new_density: int | None,
    ) -> tuple[Snapshot | None, float | None]:
        """(process identity, device-clock mark) of a Workspace member right BEFORE its task density changes;
        (None, None) when no change is about to happen."""
        task = self._eco_workspace.get_task(window_id)
        if task is None or task.parked or not new_density or new_density <= 0 or new_density == task.density:
            return None, None
        return await self._density.snapshot(task.package), await self._density.mark()

    def _schedule_workspace_settle(self, window_id: str, before: Snapshot | None, changed_at: float | None) -> None:
        """A task-level density change reaches the app's process exactly like a display-level one."""
        if before is None:
            return
        self._density.schedule_settle(
            window_id, before.package, before,
            display=lambda: self._eco_workspace.display_id, reason="workspace_density", changed_at=changed_at,
        )

    async def _learn_inplace_relaunch(self, works: bool) -> None:
        """DensityReconciler learned whether `am update-appinfo` relaunches activities on this device: kept in the device
        profile so the next backend start does not pay the failing attempt (and its extra refresh) again."""
        profile = self._profile
        if profile is None or profile.density_inplace_relaunch == works:
            return
        profile.density_inplace_relaunch = works
        if self._android_id:
            await settings_db.save_device_profile(self._android_id, profile)

    async def close_workspace_task(self, window_id: str) -> None:
        await self.close_window(window_id)  # _close_window_locked already branches on workspace_id

    # ------------------------------------------------------------------ freeze & resize
    # See session_reconfigure.py — SessionReconfigurer owns the video pump,
    # freeze/unfreeze, and resize (flex + legacy) mechanics.

    async def freeze_window(self, window_id: str, reason: str = "minimized") -> None:
        async with self._lock:
            await self._reconfigure.freeze(window_id, reason)

    async def unfreeze_window(self, window_id: str) -> None:
        async with self._lock:
            await self._reconfigure.unfreeze(window_id)

    async def resize_window(
        self, window_id: str, width: int, height: int, dpi: int | None = None,
        *, project: ProjectSettings | None = None,
    ) -> WindowHandle:
        """``project``: the settings the caller already read (the HTTP endpoint does) — passed down so one resize reads
        them once, not once per layer.

        Goes through the window's resize gate first (resize_gate.py), OUTSIDE the global lock: a calm resize passes at
        once; one that a newer request for the same window overtook answers ``superseded=True`` and touches nothing."""
        async with self._resize_gate(window_id).slot() as go:
            if not go:
                async with self._lock:
                    session = self._sessions.get(window_id)
                    if session is None:
                        raise KeyError(window_id)
                    return session.handle(superseded=True)
            async with self._lock:
                return await self._reconfigure.resize(window_id, width, height, dpi, project=project)

    def _resize_gate(self, key: str) -> ResizeGate:
        gate = self._resize_gates.get(key)
        if gate is None:
            gate = self._resize_gates[key] = ResizeGate(self._settings.RESIZE_MIN_INTERVAL_S)
        return gate

    async def refresh_window_density_outcome(self, window_id: str) -> RefreshOutcome | None:
        """The user's explicit "refresh this window": a state-preserving restart of the app's PROCESS under the window's
        CURRENT density (density_reconciler.py, ``force``). None: no such window. The restart plus its verification can
        take seconds, so the global window lock is NOT held for it."""
        async with self._lock:
            session = self._sessions.get(window_id)
            if session is None:
                return None
            package = session.state.package
            display = session.state.display_id or None
        return await self._density.settle(package, before=None, display=display, reason="manual", force=True)

    async def refresh_window_density(self, window_id: str) -> bool:
        outcome = await self.refresh_window_density_outcome(window_id)
        return bool(outcome and outcome.refreshed)

    async def restart_window_app(self, window_id: str) -> AppRestartOutcome | None:
        """Hub → "Uygulamayı yeniden başlat" (app_restart.py): rebuild the APP inside the same window — process restart,
        else onDestroy→onCreate in place, else a cold start when nothing runs. None: no such window. Like the density
        refresh it takes seconds, so the global window lock is held only to read the session, never for the restart."""
        async with self._lock:
            session = self._sessions.get(window_id)
            if session is None:
                return None
            eco = session.state.workspace_id == "eco"
            display = self._eco_workspace.display_id if eco else known_display_id(session)
            display = str(display) if is_virtual_display_id(display) else None
        return await restart_app(
            session, density=self._density, display=display,
            start_app=self._start_app, task_on_display=self._task_on_display,
        )

    async def _start_app(self, session: WindowSession) -> None:
        """The app's launcher intent into the window (what a click on a window with no app task sends)."""
        if session.control is not None:
            await session.control.send(serialize_start_app(session.state.package))

    async def _task_on_display(self, package: str, display: str) -> bool:
        if not (self._adb and self._serial):
            return False
        from app.device.deep_navigator import find_task_id_for_package

        return bool(await find_task_id_for_package(self._adb, package, display_id=display, serial=self._serial))

    # ------------------------------------------------------------------ budget
    # See budget_reallocator.py — BudgetReallocator owns the visibility/focus
    # -driven FPS budget algorithm and live quality-settings application.

    async def set_visibility(self, window_id: str, state: VisibilityState) -> None:
        async with self._lock:
            await self._budget.set_visibility(window_id, state)

    async def set_display_mode(self, window_id: str, mode: str) -> None:
        async with self._lock:
            await self._budget.set_display_mode(window_id, mode)

    async def focus_window(self, window_id: str) -> None:
        async with self._lock:
            await self._budget.focus(window_id)
            session = self._sessions.get(window_id)
            # Telefona park edilmiş Workspace üyesi: paylaşımlı sunucunun control soketine
            # START_APP göndermek uygulamayı telefondan geri çekip (defter kaydı OLMADAN) VD'de
            # yeniden başlatırdı — geri dönüş yalnızca phone_to_workspace ile yapılır.
            parked_eco = bool(session and session.state.workspace_id == "eco" and session.state.handoff_to_phone)
            launchable = bool(session and session.control and not parked_eco and not is_mirror_package(session.state.package))
        if launchable:
            await self._launch_if_absent(session)          # outside the lock: it asks the phone

    def hold_launch(self, package: str, seconds: float = 10.0) -> None:
        """For `seconds`, focusing `package`'s window sends no launcher START_APP. A tapped notification opens its target by firing its
        own PendingIntent into the window's display; a focus that lands first — the window has no task yet, so `_launch_if_absent`
        would start the app's main page — races it, and the launcher intent arriving last leaves the app on its home screen
        (Gmail's inbox instead of the mail)."""
        self._launch_held[package] = time.monotonic() + seconds

    def release_launch_hold(self, package: str) -> None:
        """Immediately releases any launch hold on `package`."""
        self._launch_held.pop(package, None)

    def hold_handoff(self, package: str, seconds: float = 5.0) -> None:
        """Suspends continuity handoff-to-phone for `package` during window creation / navigation."""
        if hasattr(self, "_handoff") and self._handoff:
            self._handoff.hold(f"pkg_{package}", lease_s=seconds)

    def release_handoff_hold(self, package: str) -> None:
        """Immediately releases handoff hold on `package`."""
        if hasattr(self, "_handoff") and self._handoff:
            self._handoff.release(f"pkg_{package}")

    async def start_app_in_window(self, package: str) -> bool:
        """Starts `package`'s own launcher page in its window (START_APP), whatever hold_launch says. For a notification that is no
        longer on the phone: there is no target left to open, and the window must not stay a black display."""
        session = self.get_session_by_package(package)
        if session is None or session.control is None or is_mirror_package(package):
            return False
        with contextlib.suppress(Exception):
            await session.control.send(serialize_start_app(package))
            return True
        return False

    def _launch_is_held(self, package: str) -> bool:
        until = self._launch_held.get(package)
        if until is None:
            return False
        if time.monotonic() >= until:
            self._launch_held.pop(package, None)
            return False
        return True

    async def _launch_if_absent(self, session: WindowSession) -> None:
        """Focus (every click on a window) must not LAUNCH anything on an app that is already there. START_APP is the app's
        LAUNCHER intent: on a running app whose task stands on a deeper screen — the chat a notification just opened —
        it lands on the app's main page ("returns to the home page"). So the intent is sent only when the app has no
        task on this window's display (the user closed it inside the window, or it never started). When that cannot be
        told (the display id is not known yet), the old behaviour stays. A held package (hold_launch) is never launched."""
        if self._launch_is_held(session.state.package):
            return
        display = known_display_id(session)
        if display and self._adb and self._serial:
            with contextlib.suppress(Exception):
                from app.device.deep_navigator import find_task_id_for_package

                if await find_task_id_for_package(self._adb, session.state.package, display_id=display, serial=self._serial):
                    return
        with contextlib.suppress(Exception):
            if session.control is not None:
                await session.control.send(serialize_start_app(session.state.package))

    async def reallocate(self) -> None:
        """Runs the budget algorithm and applies the result."""
        async with self._lock:
            await self._budget.reallocate()

    async def apply_fps_allocation(self, allocation: dict[str, int]) -> None:
        async with self._lock:
            await self._budget.apply_fps_allocation(allocation)

    async def apply_quality_settings(self) -> None:
        """Live-applies the current persisted ProjectSettings to every open
        window — see budget_reallocator.py's own docstring."""
        async with self._lock:
            await self._budget.apply_quality_settings()

    # ------------------------------------------------------------------ capacity probing

    async def run_encoder_stress_test(self) -> EncoderStressTestResult:
        """Empirically measures how many concurrent virtual-display/encoder
        sessions this device actually supports (see encoder_stress_test.py).
        Opt-in and manually triggered only — never called from anywhere but
        the dedicated endpoint."""
        async with self._lock:
            if self._serial is None or self._android_id is None or self._profile is None:
                raise DeviceNotBoundError()
            return await run_encoder_stress_test(
                self._adb, self._settings, self._serial, self._android_id,
                self._profile, has_open_sessions=bool(self._sessions),
            )

    # ------------------------------------------------------------------ link recovery

    def _needs_heal(self, session: WindowSession) -> bool:
        """A standalone window that should be streaming but whose server is gone. Minimized windows are frozen on
        purpose, a phone-parked one lives on the phone on purpose, Workspace members follow the shared display."""
        state = session.state
        return (
            state.workspace_id is None and not session.closing and not state.minimized
            and not state.handoff_to_phone and not session.server.is_alive
        )

    def video_packets(self) -> int | None:
        """Media packets received from the phone so far over every streaming window — the link's pulse for
        ConnectionSupervisor (it changes while video flows). None: nothing is streaming, so nothing can stall."""
        total = None
        for s in self._sessions.values():
            broadcaster = self._broadcasters.get(s.state.window_id)
            if broadcaster is not None and s.server.is_alive and not (s.state.frozen or s.state.minimized):
                total = (total or 0) + broadcaster.packets_total
        return total

    def _workspace_dead(self) -> bool:
        eco = self._eco_workspace
        return bool(eco.live_task_ids()) and (eco.server is None or not eco.server.is_alive)

    async def heal_links(self) -> int:
        """The adb link to the phone came back after a drop (ConnectionSupervisor saw its transport cycle). A scrcpy
        server lives exactly as long as its adb session, so every server died with the old link — and a display that
        dies with its server destroys its apps' tasks (scrcpy's default vd_destroy_content; see
        quiesce_for_transport_switch). Rebuild what died IN PLACE — same window ids, same geometry, the frontend keeps
        the last frame meanwhile; the apps are started again on the fresh display:
          * a standalone window: frozen, then unfrozen (as on a taskbar restore);
          * the Workspace: its members parked and returned onto a fresh shared display (the transport-switch path:
            a task that is gone is started anew in its remembered slot);
          * the session audio restarts.
        Idempotent: a healthy window is left exactly as it is (every scrcpy start also wakes the phone). Returns how many
        are STILL dead — the supervisor retries while that is not 0."""
        async with self._heal_lock:
            async with self._lock:
                serial = self._serial
                if serial is None or self._switch_windows is not None:
                    return 0
                self._handoff.hold("heal")
                dead_windows = [s for s in self._sessions.values() if self._needs_heal(s)]
            try:
                # ONE window per lock hold: a rebuild that hangs on a dead link used to keep the device lock for every
                # window in turn (and the Workspace and the audio after them) — a close or an open of any window
                # waited behind all of it. Between windows the lock is free for whoever queued.
                for session in dead_windows:
                    async with self._lock:
                        if (
                            self._switch_windows is not None
                            or self._sessions.get(session.state.window_id) is not session
                            or not self._needs_heal(session)  # closed, or healed by a restore, meanwhile
                        ):
                            continue
                        await self._heal_window(session)
                async with self._lock:
                    if self._switch_windows is None:
                        if self._workspace_dead():
                            await self._return_workspace(await self._park_workspace_on_phone())
                        if not self._session_audio.running:
                            with contextlib.suppress(Exception):
                                await self._session_audio.migrate_transport(serial)
            finally:
                self._handoff.release("heal")
            dead = sum(self._needs_heal(s) for s in self._sessions.values()) + int(self._workspace_dead())
            if dead == 0:
                self._handoff.release("link_drop")
            return dead

    async def _heal_window(self, session: WindowSession) -> None:
        """Rebuilds one window in place, as its own task: closing the window aborts it (``session.heal_task``) and a rebuild
        that never finishes is abandoned after HEAL_WINDOW_TIMEOUT_S — the lock is not held hostage by a dead link."""
        window_id = session.state.window_id
        task = asyncio.get_running_loop().create_task(self._rebuild_in_place(session), name=f"heal-{window_id}")
        session.heal_task = task
        try:
            done, _ = await asyncio.wait({task}, timeout=self.HEAL_WINDOW_TIMEOUT_S)
            if not done:
                window_logger(__name__, window_id).warning(
                    "[LINK] yerinde yeniden kurma %.0f sn içinde bitmedi — bırakıldı, denetçi yeniden dener",
                    self.HEAL_WINDOW_TIMEOUT_S,
                )
                await cancel_and_wait(task)
        except asyncio.CancelledError:
            await cancel_and_wait(task)
            raise
        finally:
            session.heal_task = None

    async def _rebuild_in_place(self, session: WindowSession) -> None:
        window_id = session.state.window_id
        try:
            if not session.state.frozen:
                await self._reconfigure.freeze(window_id, reason="link")
            await self._reconfigure.unfreeze(window_id)
        except Exception:
            # Stays frozen with its last frame (a failed unfreeze leaves the session as it was): the supervisor retries,
            # and so does restoring the window from the taskbar.
            window_logger(__name__, window_id).exception("[LINK] yerinde yeniden kurulamadı — donmuş kalıyor")

    def get_display_for_session(self, session: WindowSession) -> str | None:
        """Resolves the virtual display ID for this session (handling both Eco Workspace and dedicated displays)."""
        eco = getattr(session.state, "workspace_id", None) == "eco"
        display = self._eco_workspace.display_id if eco else known_display_id(session)
        return str(display) if is_virtual_display_id(display) else None

    async def is_package_alive_on_display(self, package: str, display_id: str | None) -> bool:
        """Returns True if the given package has an active task on display_id (or anywhere if display_id is None)."""
        alive, _ = await self.is_package_visible_on_display(package, display_id)
        return alive

    async def is_package_visible_on_display(self, package: str, display_id: str | None) -> tuple[bool, bool]:
        """Returns (alive, visible) for the given package on display_id.
        If the app was closed/finished at root, alive will be False or visible will be False.
        """
        if not (self._adb and self._serial):
            return False, False

        daemon = daemon_registry.live("find_task")
        if daemon is not None:
            disp = int(display_id) if display_id and str(display_id).isdigit() else None
            try:
                found = await daemon.find_task(package, disp) if disp is not None else await daemon.find_task(package)
                if found and found.get("found"):
                    return True, bool(found.get("visible", True))
                return False, False
            except Exception as e:
                log.debug("[is_package_visible_on_display] daemon check failed: %s", e)

        # Fallback via deep_navigator / adb
        from app.device.deep_navigator import find_task_id_for_package
        try:
            task_id = await find_task_id_for_package(self._adb, package, display_id=display_id, serial=self._serial)
            if not task_id:
                return False, False
            raw = await self._adb.shell("dumpsys activity activities", serial=self._serial, timeout_s=2.0)
            for line in raw.splitlines():
                if f"Task{{{task_id}" in line or (package in line and "Task{" in line):
                    visible = "visible=true" in line
                    return True, visible
            return True, True
        except Exception as e:
            log.debug("[is_package_visible_on_display] check failed: %s", e)
            return True, True

    async def is_window_at_root(self, window_id: str) -> bool:
        """Checks if the window's app is already stopped or has no active task on its display.
        Note: Modern Android apps use Single-Activity Architecture where num_activities == 1
        regardless of backstack depth (fragments, compose, webview history).
        Therefore, an active task cannot be presumed to be at root prior to injecting KEYCODE_BACK.
        """
        session = self._sessions.get(window_id)
        if not session or not session.state.package or not self._serial:
            return False

        pkg = session.state.package
        disp = self.get_display_for_session(session)
        is_alive = await self.is_package_alive_on_display(pkg, disp)
        return not is_alive

    async def migrate_transport(self, old_serial: str, new_serial: str) -> None:
        """Wi-Fi <-> USB geçişi sırasında açık olan tüm pencereleri ve
        sistem sesini yeni seri numarasına kesintisiz aktarır.

        Kritik İnvaryant: Tüm yaşam döngüsü operasyonları gibi bu metot da
        `self._lock` holding altında çalışır; resize veya minimize ile yarışamaz.
        """
        async with self._lock:
            # 1. Sistem Sesini (Session Audio) Yeni Taşıyıcıya Aktar
            if self._session_audio:
                with contextlib.suppress(Exception):
                    await self._session_audio.migrate_transport(new_serial)

            if self._switch_windows is not None:
                # `adb tcpip`: the windows were parked on the phone before adbd restarted — rebuild them here.
                log.info("🔄 [WindowManager] Taşıyıcı aktarımı (%s -> %s): park edilen pencereler yeniden kuruluyor", old_serial, new_serial)
                await self._rebuild_after_transport_switch_locked()
                return

            # Workspace members share the anchor's server: they move with the shared display (step 4), never alone.
            active_sessions = [
                s for s in self._sessions.values()
                if not s.state.frozen and s.server.is_alive and s.state.workspace_id is None
            ]
            log.info(
                "🔄 [WindowManager] Taşıyıcı aktarımı başlatıldı (%s -> %s). Aktif pencere sayısı: %d",
                old_serial, new_serial, len(active_sessions),
            )

            # 2. UX: Tüm pencereler için derhal KUYRUKTA olayı fırlat (Rolling reveal yanılgısını önler)
            for s in active_sessions:
                await self._events.emit(
                    "migration_queued",
                    window_id=s.state.window_id,
                    old_serial=old_serial,
                    new_serial=new_serial,
                )

            # 3. Pencereleri TEK TEK taşı: her taşıma bir encoder'ı kapatıp yenisini açar ve cihaz aynı anda iki
            # teardown/setup görmemeli (modül docstring'i — HyperOS'ta native "Aborted").
            results: list[bool | BaseException] = []
            for s in active_sessions:
                window_id = s.state.window_id
                await self._events.emit("migration_started", window_id=window_id, new_serial=new_serial)
                try:
                    ok = await self._reconfigure.migrate_session_transport(window_id, new_serial)
                except Exception as exc:
                    results.append(exc)
                    continue
                results.append(ok)
                await self._events.emit(
                    "migration_completed" if ok else "migration_failed", window_id=window_id, new_serial=new_serial,
                )
            log.info("🔄 [WindowManager] Taşıyıcı aktarımı bitti. Sonuçlar: %s", results)

            # 4. The shared Workspace display still runs on the OLD transport's server: park its apps on the phone and
            # return them onto a fresh shared display over the new transport (the phone→Workspace path).
            if self._eco_workspace.live_task_ids():
                self._handoff.hold("transport")
                try:
                    await self._return_workspace(await self._park_workspace_on_phone())
                finally:
                    self._handoff.release("transport")

    # ------------------------------------------------------------------ transport switch that restarts adbd (`adb tcpip`)

    async def quiesce_for_transport_switch(self) -> int:
        """`adb tcpip` restarts the phone's adbd, which kills every scrcpy server started over USB — and a virtual
        display that dies with its server takes its apps with it (scrcpy destroys a removed display's content). So,
        BEFORE the restart, under the lifecycle lock: each live window's app is moved onto the phone's own screen
        (display 0) and its server stopped cleanly — a standalone window becomes a frozen session (the frontend keeps
        its last frame), a Workspace member a parked one. Handoff detection is paused meanwhile: those apps on the
        phone are our move, not a handoff. migrate_transport (or, if the switch fails, rebuild_after_transport_switch)
        brings every one back on the transport bound by then. Returns how many windows were parked."""
        async with self._lock:
            if self._switch_windows is not None:
                return 0
            self._switch_windows = {}
            self._handoff.hold("transport")
            for s in list(self._sessions.values()):
                if s.state.workspace_id is not None or s.state.frozen or not s.server.is_alive:
                    continue
                wid = s.state.window_id
                self._switch_windows[wid] = await self._park_on_phone(s)
                await self._reconfigure.freeze(wid, reason="transport")
            self._switch_workspace = await self._park_workspace_on_phone()
            parked = len(self._switch_windows) + len(self._switch_workspace)
            log.info("🔌 [TRANSPORT] adbd yeniden başlamadan önce %d pencere telefona park edildi", parked)
            return parked

    async def rebuild_after_transport_switch(self) -> None:
        """The switch failed after quiesce_for_transport_switch: bring the parked windows back on the current (old)
        transport."""
        async with self._lock:
            await self._rebuild_after_transport_switch_locked()

    async def _rebuild_after_transport_switch_locked(self) -> None:
        windows, self._switch_windows = self._switch_windows or {}, None
        workspace, self._switch_workspace = self._switch_workspace, []
        try:
            for wid, task_id in windows.items():
                session = self._sessions.get(wid)
                if session is None or not session.state.frozen:
                    continue
                try:
                    await self._reconfigure.unfreeze(wid)
                    disp = await session.server.wait_for_display_id()
                    if task_id and is_virtual_display_id(disp) and self._serial:
                        with contextlib.suppress(Exception):
                            await move_task_to_display(self._adb, task_id, disp, serial=self._serial, daemon=self._daemon_client)
                        with contextlib.suppress(Exception):
                            await android_shell.bring_to_front(self._adb, self._serial, session.state.package, disp)
                except Exception:
                    # Stays frozen with its last frame: restoring it from the taskbar retries the unfreeze.
                    log.exception("[TRANSPORT] %s yeni taşıyıcıda yeniden kurulamadı — donmuş kalıyor", wid)
            await self._return_workspace(workspace)
        finally:
            self._handoff.release("transport")

    async def _park_on_phone(self, session: WindowSession) -> str | None:
        """Moves the window's task onto display 0 so it outlives its virtual display; the task id (None: the phone
        mirror, or no task found)."""
        pkg, disp = session.state.package, known_display_id(session)
        if is_mirror_package(pkg) or not disp or not self._serial:
            return None
        from ..device.deep_navigator import find_task_id_for_package

        task_id = await find_task_id_for_package(self._adb, pkg, display_id=disp, serial=self._serial)
        if task_id:
            with contextlib.suppress(Exception):
                await move_task_to_display(self._adb, task_id, "0", serial=self._serial, daemon=self._daemon_client)
        return task_id

    async def _park_workspace_on_phone(self) -> list[str]:
        """Every live Workspace member's task onto display 0 and parked (its slot kept); the last one releases the
        shared display. The members to return, in order."""
        parked: list[str] = []
        for wid in self._eco_workspace.live_task_ids():
            task = self._eco_workspace.get_task(wid)
            if task is not None and self._serial:
                with contextlib.suppress(Exception):
                    await move_task_to_display(self._adb, task.task_id, "0", serial=self._serial, daemon=self._daemon_client)
            await self._eco_workspace.park_task(wid)
            parked.append(wid)
        return parked

    async def _return_workspace(self, members: list[str]) -> None:
        for wid in members:
            try:
                await self._teleporter.phone_to_workspace(wid, announce=False)
            except Exception:
                log.exception("[TRANSPORT] Workspace üyesi %s geri alınamadı — telefonda park halinde kalıyor", wid)
