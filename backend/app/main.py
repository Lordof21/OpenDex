"""Application composition root — where every part is wired together.

Startup order (each step depends on the previous one):
  1. logging_config.setup()
  2. settings_db.init()                 → SQLite schema ready
  3. device bootstrap (background)      → list/wait, ANDROID_ID, profile probe,
                                          thermal + connection supervisor
Shutdown (finally block, never skipped):
  window_manager.close_all() → app_audio.shutdown() → session_audio.stop_session_audio()
  → thermal_monitor.stop() → connection_supervisor.stop()

The server must come up with NO device attached (the UI then shows QR pairing),
so device binding runs as a supervised background task, not inline in lifespan.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import logging_config
from .api import auth as api_auth
from .api.hardening import BodyLimitMiddleware, SecurityHeadersMiddleware
from .api.origin_guard import LOCAL_ORIGIN_REGEX, OriginGuardMiddleware
from .api.v1 import api_router
from .api.websockets import ws_router
from .apps.app_registry import AppRegistry
from .config import Settings, get_settings
from .device import daemon_auth
from .device.adb import Adb
from .device.capability_probe import CapabilityProbe
from .device.connection_supervisor import ConnectionSupervisor
from .device.device_daemon_client import HEALTH_CHECK_ATTEMPTS, HEALTH_CHECK_INTERVAL_S
from .device.device_manager import DeviceManager
from .device.device_tracker import DeviceTracker
from .device.display_power import DisplayPowerController
from .device import android_shell, daemon_registry, tools_jar
from .events import EventBus, spawn_background
from .fs.errors import FsError
from .fs.service import FsService
from .schemas import AudioRoute, DeviceInfo, DeviceState, KnownDevice, ThermalLevel, default_route_for
from .startup_state import StartupState
from .storage import settings_db
from .device.phone_awake import PhoneAwakeLease
from .streams.app_audio import AppAudioRouter
from .device.battery_health import BatteryHealthService
from .streams.app_audio_link import AppAudioLink
from .streams.audio_stream import SessionAudio
from .streams.broadcaster import BroadcasterRegistry, report_stream_health
from .telemetry import TelemetryHub
from .windows.display_ids import display_event_log
from .telemetry import markers as load_markers
from .telemetry.load_monitor import DeviceLoadMonitor
from .windows.thermal_monitor import ThermalMonitor
from .windows.window_manager import WindowManager
from .wireless.mdns_discovery import MdnsDiscovery
from .wireless.qr_pairing import PairingListener, QrPayload

log = logging.getLogger(__name__)

# Android's own address as a Wi-Fi hotspot (tethering default) — tried last when the phone reports no Wi-Fi IP.
HOTSPOT_DEFAULT_IP = "192.168.43.1"


def _transport_of(serial: str) -> str:
    return "wireless" if ":" in serial else "usb"


def _log_startup(**s) -> None:
    """One line per startup step — what a user's log shows when "it was slow to connect"."""
    log.info(
        "[STARTUP] cihaz=%s(%s) daemon=%s %d/%d servisler=%s",
        s["device"], s["transport"] or "-", s["daemon"], s["daemon_attempt"], s["daemon_attempts"], s["services"],
    )


class TransportSwitchError(RuntimeError):
    """The USB -> Wi-Fi switch could not prove a wireless link; the session stays on USB."""


class AppContext:
    """Singleton wiring stored at app.state (the spec's app.state singletons)."""

    def __init__(self, settings: Settings, daemon_token: str | None = None) -> None:
        self.settings = settings
        self.adb = Adb(settings.ADB_PATH, settings.ADB_SERIAL)
        self.event_bus = EventBus()
        self.device_manager = DeviceManager(self.adb)
        # One socket to the adb server that pushes the device list on change, instead of an `adb devices -l` process
        # every couple of seconds per poller (supervisor, /api/devices, bootstrap, transport switch).
        self.device_tracker = DeviceTracker(DeviceManager.parse_devices_output, port=settings.FS_ADB_PORT)
        self.device_manager.attach_tracker(self.device_tracker)
        self.capability_probe = CapabilityProbe(self.adb, self.device_manager, settings)
        self.broadcasters = BroadcasterRegistry()
        self.session_audio = SessionAudio(self.adb, settings, self.broadcasters)
        self.window_manager = WindowManager(
            self.adb,
            settings,
            self.event_bus,
            self.broadcasters,
            self.session_audio,
            self.capability_probe,
            self.device_manager,
        )
        self.thermal_monitor = ThermalMonitor(self.adb, settings)
        # How hard the phone works and why (app/telemetry): the Telefon Yükü panel.
        self.load_monitor = DeviceLoadMonitor(
            self.adb, settings,
            emit=self.event_bus.emit,
            streams_getter=self.window_manager.stream_inventory,
            packages_getter=self.window_manager.open_packages,
            record_dir_getter=logging_config.log_dir,
            temps_getter=self.thermal_monitor.fresh_temperatures,
            battery_getter=lambda: self.daemon_client.last_battery_state if self.daemon_client.is_connected else None,
            daemon_getter=lambda: self.daemon_client,
        )
        # The Battery page (health, charger, ETA, temperatures) — facts from the daemon, meaning from device/battery_health.
        self.battery_health = BatteryHealthService(
            daemon_getter=lambda: self.daemon_client,
            temps_getter=self.thermal_monitor.fresh_temperatures,
            thermal_level_getter=lambda: str(self.thermal_monitor.level),
        )
        self.supervisor = ConnectionSupervisor(
            self.device_manager, self.event_bus, settings, self.window_manager
        )
        self.window_manager.set_link_probe(self.supervisor.link_dropped)
        self.device_manager.on_change(self.supervisor.devices_changed)
        # The UI's device list / connection state is pushed (devices_changed), not polled: every change of adb's list,
        # of the bound serial and of a transport switch is published once, coalesced (device_state()).
        self.device_manager.on_change(self._on_device_list_changed)
        for lifecycle in ("device_connected", "device_lost", "device_reconnected"):
            self.event_bus.on(lifecycle, self._on_session_event)
        self._device_list_changed = asyncio.Event()  # wakes the bootstrap the moment a phone appears
        self._device_state_dirty = False
        self._device_state_task: asyncio.Task | None = None
        self._published_device_state: dict | None = None
        # Bind / switch / unbind each rewrite the whole session (serial, daemon, monitors, supervisor): one at a time. The
        # bootstrap loop, GET /api/devices (ensure_device) and a pairing listener can all try to bind the same phone.
        self._session_lock = asyncio.Lock()
        self._bind_failures = 0  # consecutive failed binds: spaces the retries and the user notices
        # time.monotonic() before which ensure_device() does not try to bind again. Without it every API call that needs a
        # phone (GET /api/apps …) re-tried a phone that adb lists but cannot talk to ("device offline") many times a second,
        # and each try flipped the device state, which made the UI reload and ask again — an endless loop.
        self._bind_retry_after = 0.0
        self._device_state_seq = 0  # every computed state is numbered: the UI drops one older than what it applied
        self.mdns = MdnsDiscovery()
        self.app_registry = AppRegistry(self.adb, settings)
        self.pairing = PairingListener(self.adb, self.mdns, self.device_manager)
        from .device.notification_service import NotificationSupervisor
        from .device.device_daemon_client import DeviceDaemonClient
        self.notifications = NotificationSupervisor(
            self.adb, self.event_bus, poll_interval_s=settings.NOTIFICATION_POLL_INTERVAL_S,
        )
        self.notifications.set_window_manager(self.window_manager)
        self.daemon_client = DeviceDaemonClient(self.adb, self.event_bus, token=daemon_token)
        # Every shell command the backend runs on the phone goes to the daemon first and to adb only when the daemon
        # cannot take it (device/adb.py). The daemon client is the transport; adb stays the fallback and the lifecycle.
        if settings.DAEMON_SHELL:
            self.adb.attach_shell_transport(self.daemon_client)
        self.window_manager.set_daemon_client(self.daemon_client)
        # The file manager: PC + phone providers, transfer engine, caches. Nothing here touches
        # the disk or the device until `fs.start()` runs in the lifespan.
        self.fs = FsService(
            settings=settings, adb=self.adb, daemon=self.daemon_client, events=self.event_bus,
            active_serial=lambda: self.serial,
        )
        # Everything that used to fork `dumpsys` / `logcat` / `ps` on the phone asks the daemon first (v1.2), the shell
        # only while it is not connected: notifications and thermal status are pushed; task/focus/event-log reads go
        # through daemon_registry.
        daemon_registry.register(self.daemon_client)
        self.notifications.attach_daemon(self.daemon_client)
        self.thermal_monitor.attach_daemon(self.daemon_client)
        # Per-window isolated audio. Legacy SessionAudio remains the
        # fallback for Android ≤12 / old daemon jars; the router suppresses it while it owns the device's audio.
        self.app_audio_link = AppAudioLink(
            self.adb,
            on_frame=lambda stream_id, chunk: self.app_audio.on_frame(stream_id, chunk),
            on_end=lambda stream_id: self.app_audio.on_end(stream_id),
        )
        self.app_audio = AppAudioRouter(
            self.broadcasters,
            self.event_bus,
            daemon_getter=lambda: self.daemon_client,
            link=self.app_audio_link,
            windows_getter=self.window_manager.audio_windows,
            default_route_getter=self._default_audio_route,
            suppress_legacy=self._suppress_legacy_audio,
            resume_legacy=self._resume_legacy_audio,
            sync_offset_getter=self._audio_sync_offset,
        )
        self.window_manager.set_app_audio(self.app_audio)
        # The phone must not fall asleep under open windows (keyguard + the OEM app lock would black them out):
        # held while windows exist, the user's own value is given back afterwards (device/phone_awake.py).
        self.phone_awake = PhoneAwakeLease(self.adb, lambda: self.serial, self.window_manager.has_windows)
        self.window_manager.subscribe_sessions(self.phone_awake.request_sync)
        self.telemetry = TelemetryHub(
            self.adb,
            serial_getter=lambda: self.serial,
            windows_getter=self.window_manager.list_windows,
            broadcasters=self.broadcasters,
            phone_tasks_getter=self._phone_tasks,
            daemon_getter=lambda: self.daemon_client,
        )

        self._serial: str | None = None
        # What the boot screen shows: device → daemon health check → services, as it happens (GET /api/startup).
        self.startup = StartupState(publish=self._on_startup_step)
        self.display_power = DisplayPowerController(
            self.adb, lambda: self.serial, lambda: self.daemon_client, self.event_bus
        )
        # The user changed the phone's display size / smallest width while connected: the daemon pushes it, the device
        # profile ("Telefon ölçeği", the frontend's phone metrics) follows at once instead of at the next reconnect.
        self.daemon_client.subscribe("display_update", self._on_phone_display_changed)
        # The daemon may have restored the panel by itself while we were away (its screen fail-safe).
        self.event_bus.on("device_daemon_connected", self.display_power.resync)
        # Second source for a window's virtual display id.
        self.event_bus.on("device_display_added", display_event_log.on_added)
        self.event_bus.on("device_display_removed", display_event_log.on_removed)
        self.android_id: str | None = None
        self.bootstrap_task: asyncio.Task | None = None
        self.pairing_listener_task: asyncio.Task | None = None
        self.stream_health_task: asyncio.Task | None = None

        # android_id's already sent a fresh opendex-tools.jar + forced
        # daemon restart during this backend process's lifetime — see
        # _ensure_tools_jar_and_daemon.
        self._daemon_deployed_android_ids: set[str] = set()

        # Short-lived link between a successful `adb pair` (6-digit code) and
        # the `pair_manual` connect that follows it a few seconds later in the
        # UI flow — the ONLY way _remember_device can attribute a 5555-lookalike
        # ip:port connection to real TLS wireless-debugging pairing (see
        # mark_wireless_debugging_paired / _remember_device below).
        self._last_wireless_pairing: tuple[str, float] | None = None  # (ip, monotonic_time)
        # True while switch_to_tcpip runs: adbd restarts and for a moment NO transport lists the phone — /api/devices
        # keeps reporting the bound device then, so the frontend doesn't take the blip for an unplug.
        self._transport_switching = False

    # -------------------------------------------------------------- device state (pushed to the UI)

    @property
    def serial(self) -> str | None:
        """The bound phone's adb serial (None: no session)."""
        return self._serial

    @serial.setter
    def serial(self, value: str | None) -> None:
        if value != self._serial:
            self._serial = value
            self._schedule_device_state()

    @property
    def transport_switching(self) -> bool:
        return self._transport_switching

    @transport_switching.setter
    def transport_switching(self, value: bool) -> None:
        if value != self._transport_switching:
            self._transport_switching = value
            self._schedule_device_state()

    def with_active(self, devices: list[DeviceInfo]) -> list[DeviceInfo]:
        """adb's list as the UI shows it: the bound phone marked active — and kept in the list when adb momentarily does
        not report it, so a blip is not taken for an unplug."""
        for device in devices:
            device.is_active = bool(self._serial) and device.serial == self._serial
        if self._serial and not any(d.is_active for d in devices):
            # The bound phone is not in adb's list right now: adbd restarting for `adb tcpip` (a planned gap), or a link blip
            # the supervisor is still giving its grace period. The session goes on, so the phone stays listed as it was
            # last seen (name, transport) — "offline" unless the gap is the planned one — instead of becoming "no device".
            phone = self.device_manager.last_seen(self._serial) or DeviceInfo(
                serial=self._serial, state=DeviceState.DEVICE, transport=_transport_of(self._serial),
            )
            phone.state = DeviceState.DEVICE if self._transport_switching else DeviceState.OFFLINE
            phone.is_active = True
            devices.append(phone)
        return devices

    def device_state(self) -> dict:
        """What the UI knows about phones — GET /api/devices/state and every `devices_changed` event: adb's list (the
        bound one marked) and the session's serial. The session, not the list, says "connected": a phone missing from
        the list for a moment while bound is a drop the supervisor handles (device_lost / device_reconnected), not the end
        of the session."""
        devices = self.with_active(self.device_manager.current())
        self._device_state_seq += 1
        return {
            "devices": [d.model_dump(mode="json") for d in devices],
            "active_serial": self._serial,
            "session": self._session_phase(),
            # Numbered when computed: the UI's read on (re)connect can arrive after a newer event — it must not undo it.
            "seq": self._device_state_seq,
        }

    def _session_phase(self) -> str | None:
        """None: no phone bound · "binding": being brought up · "ready" · "lost": bound, link down (the supervisor is
        reconnecting; windows stay with their last frame)."""
        if self._serial is None:
            return None
        if self.startup.current.device != "bound":
            return "binding"
        return "ready" if self.supervisor.connected else "lost"

    async def _on_startup_step(self, **snapshot) -> None:
        _log_startup(**snapshot)
        self._schedule_device_state()  # "binding" → "ready" is a session phase the UI follows

    def _on_session_event(self, **_payload) -> None:
        self._schedule_device_state()  # the session phase changed with it

    def _on_device_list_changed(self) -> None:
        self._device_list_changed.set()
        self._schedule_device_state()

    def _schedule_device_state(self) -> None:
        """Publishes device_state() once the current burst of changes is over (a cable re-seat is several pushes)."""
        self._device_state_dirty = True
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return  # constructing outside a loop: nothing to tell anyone yet
        if self._device_state_task is None or self._device_state_task.done():
            self._device_state_task = spawn_background(self._publish_device_state(), "device-state")

    async def _publish_device_state(self) -> None:
        while self._device_state_dirty:
            self._device_state_dirty = False
            await asyncio.sleep(0)  # let the rest of the burst land first
            state = self.device_state()
            content = {k: v for k, v in state.items() if k != "seq"}
            if content != self._published_device_state:
                self._published_device_state = content
                await self.event_bus.emit("devices_changed", **state)

    # -------------------------------------------------------------- bootstrap

    async def ensure_device(self) -> str | None:
        """Returns self.serial if bound. If not bound, immediately discovers and binds an attached ready device."""
        if self.serial:
            return self.serial
        if time.monotonic() < self._bind_retry_after:
            return None  # the last bind failed a moment ago: the bootstrap loop retries on its own schedule
        try:
            devices = await self.device_manager.list_devices()
            ready = [d for d in devices if d.state == DeviceState.DEVICE]
            if ready:
                wireless = [d for d in ready if ":" in d.serial]
                chosen = wireless[0] if wireless else ready[0]
                await self.bind_device(chosen.serial)
                return self.serial
        except Exception as exc:
            log.debug("ensure_device failed: %s", exc)
        return None

    async def bind_device(self, serial: str) -> None:
        """Brings a session up on `serial` — all or nothing. Any step that fails undoes the ones before it (nothing keeps
        running against a half-built session, `serial` is empty again) and the error propagates: the bootstrap loop
        retries with a growing pause, a caller from the API tells the user. The services that only add to a session
        (thermal, load, notifications, audio) may fail without ending it."""
        async with self._session_lock:
            if self.serial == serial and self.startup.current.device == "bound":
                return  # a second caller for the phone the first one just bound
            await self._bind_locked(serial)

    async def _bind_locked(self, serial: str) -> None:
        # A device may bind through USB/bootstrap polling while a QR-pairing
        # listener from an earlier-loaded pairing screen is still running —
        # that listener is now pointless (this method is the only thing it
        # was waiting to trigger) and would otherwise sit idle for its full
        # timeout before printing a harmless-but-alarming-looking traceback.
        if self.pairing_listener_task and not self.pairing_listener_task.done():
            self.pairing_listener_task.cancel()

        self.serial = serial
        try:
            await self.startup.reset("binding")
            await self.startup.update(transport=_transport_of(serial), model=self.device_manager.cached_model(serial))
            self.android_id = await self.device_manager.get_android_id(serial)
            # The daemon FIRST, and proven healthy before anything asks the phone anything: everything below (the profile
            # probe, thermal, load, notifications, the supervisor, audio) then goes through its one socket instead of a
            # burst of `adb shell` processes that the daemon's own snapshots repeat a moment later.
            await self._bring_up_daemon(serial)
            await self.startup.update(services="starting")
            profile = await self.window_manager.bind_device(serial, self.android_id)
            self.phone_awake.request_sync()  # also hands back a value a crashed earlier session left behind
            # Before device_connected: the frontend reads the profile (phone_scale metrics) right after that event.
            await self._optional("telefon ölçüleri", self.capability_probe.refresh_phone_metrics(serial, profile))
            await self._start_services(serial, profile)
            spawn_background(self._remember_device(serial))
            await self.event_bus.emit(
                "device_connected",
                android_id=self.android_id,
                transport=_transport_of(serial),
            )
            await self.startup.update(device="bound", services="ready")
        except BaseException as exc:
            await self._abort_bind(serial, exc)
            raise
        self._bind_failures = 0
        self._bind_retry_after = 0.0
        log.info(
            "device bound: serial=%s android_id=%s encoder_limit=%d daemon=%s",
            serial, self.android_id, profile.encoder_limit, self.startup.current.daemon,
        )

    async def _start_services(self, serial: str, profile) -> None:
        """What runs while a phone is bound. The supervisor (it heals a dropped link) is essential and raises; the rest is
        added value — a monitor that cannot start is logged and the session carries on without it."""
        await self._optional("termal izleme", self.thermal_monitor.start(serial, self._on_thermal))
        await self._optional("yük izleme", self.load_monitor.start(serial))
        await self.supervisor.start(serial, self.android_id)
        await self._optional("bildirimler", self._call_sync(self.notifications.start, serial))
        # Audio: per-app routing on Android 13+ once the daemon confirms it; otherwise the legacy session stream
        # (phone audio -> laptop, even with no window open). The router starts whichever applies.
        await self._optional("ses yönlendirme", self.app_audio.on_device_bound(serial, profile.android_api))

    @staticmethod
    async def _call_sync(fn, *args) -> None:
        fn(*args)

    @staticmethod
    async def _optional(name: str, awaitable) -> None:
        try:
            await awaitable
        except Exception as exc:  # noqa: BLE001 — the session does not depend on it
            log.warning("[BIND] %s başlatılamadı — oturum onsuz sürüyor: %s: %s", name, type(exc).__name__, exc)

    async def _stop_services(self, *, clear_notifications: bool = True) -> None:
        """Stops everything _start_services / the daemon client started, each independently (one failing stop must not
        leave the others running)."""
        for name, stop in (
            ("daemon", self.daemon_client.stop()),
            ("thermal", self.thermal_monitor.stop()),
            ("load", self.load_monitor.stop()),
            ("supervisor", self.supervisor.stop()),
            ("notifications", self.notifications.stop(clear_cache=clear_notifications)),
        ):
            try:
                await stop
            except Exception as exc:  # noqa: BLE001
                log.debug("[BIND] %s durdurulamadı: %s", name, exc)

    async def _abort_bind(self, serial: str, exc: BaseException) -> None:
        """A bind that failed (or was cancelled) leaves no session behind."""
        if isinstance(exc, Exception):
            log.warning("[BIND] %s bağlanamadı (%s: %s) — oturum temizleniyor", serial, type(exc).__name__, exc)
        await self._stop_services()
        for cleanup in (self.phone_awake.release(serial), self.app_audio.on_device_unbound(),
                        self.session_audio.stop_session_audio()):
            try:
                await cleanup
            except Exception as err:  # noqa: BLE001
                log.debug("[BIND] temizlik adımı başarısız: %s", err)
        self.serial = None
        self.android_id = None
        try:
            await self.startup.reset("waiting")
        except Exception:  # noqa: BLE001
            log.debug("[BIND] başlangıç durumu sıfırlanamadı", exc_info=True)
        if isinstance(exc, Exception):
            self._bind_failures += 1
            # 2 s, 4 s, 8 s … capped at 30 s: the same pause the bootstrap loop uses, so API callers do not out-run it.
            self._bind_retry_after = time.monotonic() + min(2.0 * (2 ** (self._bind_failures - 1)), 30.0)
            await self._announce_bind_failure(serial, exc)
            self._ensure_bootstrap()  # whoever called, something must keep trying

    async def _announce_bind_failure(self, serial: str, exc: Exception) -> None:
        """Tells the UI once, then again every 5th consecutive failure (not on every retry)."""
        if self._bind_failures == 1 or self._bind_failures % 5 == 0:
            await self.event_bus.emit(
                "device_bind_failed", serial=serial, reason=f"{type(exc).__name__}: {exc}"[:200], attempt=self._bind_failures,
            )

    def _ensure_bootstrap(self) -> None:
        """The bootstrap loop is what retries a bind; it ends after a successful one, so a bind started by something else
        (a pairing listener, an API call) that fails needs it running again. (A bind the loop itself started continues
        in the loop — its task is not done.)"""
        task = self.bootstrap_task
        if task is not None and not task.done():
            return
        self.bootstrap_task = asyncio.create_task(self.device_bootstrap(), name="device-bootstrap")

    async def switch_transport(self, new_serial: str) -> None:
        """Seamlessly switches active session from USB to Wi-Fi without dropping windows or flashing pairing UI. If the
        switch fails the session goes back to the previous link when that is still usable, else it ends cleanly (the
        bootstrap binds whatever is available) — never a session left half-moved."""
        async with self._session_lock:
            if self.serial == new_serial:
                return
            old_serial, old_android_id = self.serial, self.android_id
            try:
                await self._switch_locked(old_serial, new_serial)
            except Exception as exc:
                await self._recover_failed_switch(old_serial, old_android_id, new_serial, exc)
                raise

    async def _switch_locked(self, old_serial: str | None, new_serial: str) -> None:
        # Same rationale as bind_device: a pairing listener from a still-open
        # QR/pairing screen is now pointless once we're switching to a
        # concrete serial, and would otherwise idle out with an
        # alarming-looking (but harmless) traceback.
        if self.pairing_listener_task and not self.pairing_listener_task.done():
            self.pairing_listener_task.cancel()

        log.info("Seamlessly switching transport from %s to %s", old_serial, new_serial)
        self.serial = new_serial
        await self.startup.reset("binding")
        await self.startup.update(transport=_transport_of(new_serial), model=self.device_manager.cached_model(new_serial))
        self.android_id = await self.device_manager.get_android_id(new_serial)

        # Stop background services on old serial (preserve notification cache for dedup)
        await self._stop_services(clear_notifications=False)

        # The daemon over the new link BEFORE anything else: the process on the phone survived the switch, only the
        # forward and the socket are new — healthy in moments. Its greeting re-establishes per-app audio captures (the
        # phone keeps them for a few seconds after the old link dropped), and the migration's own commands use it.
        await self._bring_up_daemon(new_serial)
        await self.startup.update(services="starting")
        profile = await self.window_manager.bind_device(new_serial, self.android_id)
        await self._optional("ses yönlendirme", self.app_audio.on_device_bound(new_serial, profile.android_api))
        if old_serial:
            await self.window_manager.migrate_transport(old_serial, new_serial)

        await self._optional("termal izleme", self.thermal_monitor.start(new_serial, self._on_thermal))
        await self._optional("yük izleme", self.load_monitor.start(new_serial))
        await self.supervisor.start(new_serial, self.android_id)
        await self._optional("bildirimler", self._call_sync(self.notifications.start, new_serial))
        spawn_background(self._remember_device(new_serial))

        # Emit device_connected with new transport — NEVER emit device_lost!
        await self.event_bus.emit(
            "device_connected",
            android_id=self.android_id,
            transport=_transport_of(new_serial),
        )
        await self.startup.update(device="bound", services="ready")
        log.info("Seamless handover to %s complete! encoder_limit=%d", new_serial, profile.encoder_limit)

    async def _recover_failed_switch(
        self, old_serial: str | None, old_android_id: str | None, new_serial: str, exc: Exception,
    ) -> None:
        log.warning(
            "[SWITCH] %s → %s geçişi başarısız (%s: %s) — önceki bağlantıya dönülüyor", old_serial, new_serial,
            type(exc).__name__, exc,
        )
        self._bind_failures += 1
        await self._announce_bind_failure(new_serial, exc)
        await self._stop_services(clear_notifications=False)
        usable = bool(old_serial and old_android_id) and any(
            d.serial == old_serial and d.state == DeviceState.DEVICE for d in self.device_manager.current()
        )
        if usable:
            try:
                await self._resume_session(old_serial, old_android_id)
                log.info("[SWITCH] oturum %s üzerinde sürüyor", old_serial)
                return
            except Exception as err:  # noqa: BLE001
                log.warning("[SWITCH] önceki bağlantıya dönülemedi: %s: %s", type(err).__name__, err)
        # Nothing to go back to: end the session cleanly — windows closed, UI told, the bootstrap binds what is there.
        log.warning("[SWITCH] oturum sonlandırılıyor; açılış döngüsü kullanılabilir telefona yeniden bağlanacak")
        await self._unbind_locked(disconnect_adb=False, pause_bootstrap_s=1.0, reason="switch_failed")

    async def _resume_session(self, serial: str, android_id: str) -> None:
        """Services back on a link the session already had (its windows are still there)."""
        self.serial, self.android_id = serial, android_id
        await self.startup.reset("binding")
        await self.startup.update(transport=_transport_of(serial), model=self.device_manager.cached_model(serial))
        await self._bring_up_daemon(serial)
        profile = await self.window_manager.bind_device(serial, android_id)
        await self._start_services(serial, profile)
        await self.startup.update(device="bound", services="ready")

    async def switch_to_tcpip(self, port: int = 5555) -> str:
        """USB -> Wi-Fi with `adb tcpip`, windows included. Returns the verified wireless serial; raises
        TransportSwitchError (still on USB, windows restored) when no wireless link could be proven.

        1. The phone's Wi-Fi IPs are read over the still-stable USB link (right after `adb tcpip` adbd restarts and
           every shell answers "error: closed" for ~1 s — reading then is the reported race).
        2. adbd already listening on `port` (an earlier switch) → just connect; no restart, windows migrate live.
        3. Otherwise the restart would kill every USB-started scrcpy server and with it the apps on their displays:
           the device supervisor is stopped (the restart is not an unplug) and every window parked on the phone
           first (WindowManager.quiesce_for_transport_switch); then `adb tcpip`, wait for adbd, connect.
        4. Success = `ip:port` listed as `device` AND the same ANDROID_ID — only then does the session move
           (switch_transport rebuilds the windows over Wi-Fi). Candidates: the phone's own IPs, then the PC's gateway
           and the Android hotspot default (the PC on the phone's hotspot)."""
        usb = self.serial
        if usb is None:
            raise TransportSwitchError("Bağlı cihaz yok.")
        if ":" in usb:
            return usb  # already wireless
        ips = await self.device_manager.get_device_wifi_ips(usb, attempts=3)
        self.transport_switching = True
        quiesced = False
        try:
            if await self._adb_tcp_port(usb) == port:
                wireless = await self._connect_wireless(ips, port)
                if wireless:
                    await self.switch_transport(wireless)
                    return wireless
            await self.supervisor.stop()
            await self.window_manager.quiesce_for_transport_switch()
            quiesced = True
            await self.adb.tcpip(port, serial=usb)
            await self._wait_for_device(usb, timeout_s=8.0)  # adbd back on USB (cable still in)
            ips = ips or await self.device_manager.get_device_wifi_ips(usb, attempts=4)
            wireless = await self._connect_wireless(ips, port)
            if not wireless:
                raise TransportSwitchError(
                    "Kablosuz bağlantı doğrulanamadı — USB kablosunu ÇIKARMAYIN. Telefon ile bilgisayarın aynı ağda "
                    "olduğundan ve güvenlik duvarının 5555 portunu engellemediğinden emin olun."
                )
            await self.switch_transport(wireless)
            return wireless
        except BaseException:
            if quiesced and self.serial == usb:
                # Still on USB: bring the parked windows back here and resume supervision.
                with contextlib.suppress(Exception):
                    await self._wait_for_device(usb, timeout_s=5.0)
                    await self.window_manager.rebuild_after_transport_switch()
                with contextlib.suppress(Exception):
                    await self.supervisor.start(usb, self.android_id)
            raise
        finally:
            self.transport_switching = False

    async def _adb_tcp_port(self, serial: str) -> int | None:
        with contextlib.suppress(Exception):
            return int((await self.adb.shell("getprop service.adb.tcp.port", serial=serial, timeout_s=2.0)).strip())
        return None

    async def _wait_for_device(self, serial: str, timeout_s: float) -> bool:
        """True once `adb devices` lists `serial` as `device` (polled every 250 ms)."""
        deadline = time.monotonic() + timeout_s
        while True:
            with contextlib.suppress(Exception):
                devices = await self.device_manager.list_devices()
                if any(d.serial == serial and d.state == DeviceState.DEVICE for d in devices):
                    return True
            if time.monotonic() >= deadline:
                return False
            await asyncio.sleep(0.25)

    async def _connect_wireless(self, ips: list[str], port: int) -> str | None:
        """First candidate that becomes a `device` over TCP and is THIS phone (same ANDROID_ID) — a gateway/hotspot
        guess may well be another device. adbd needs a moment to listen after a restart: each gets 3 attempts."""
        from .device.network_utils import get_windows_gateway_ip

        fallbacks = [await get_windows_gateway_ip(timeout_s=2.0), HOTSPOT_DEFAULT_IP]
        for ip in dict.fromkeys([*ips, *(f for f in fallbacks if f)]):
            serial = f"{ip}:{port}"
            for attempt in range(3):
                try:
                    await self.adb.connect(ip, port, timeout_s=5.0)
                except Exception as exc:
                    log.info("[ADB Wireless] %s bağlanamadı (%d/3): %s", serial, attempt + 1, exc)
                    await asyncio.sleep(0.6)
                    continue
                if await self._wait_for_device(serial, timeout_s=4.0):
                    same = await self.device_manager.get_android_id(serial) == self.android_id
                    if same:
                        log.info("[ADB Wireless] %s doğrulandı (device, aynı ANDROID_ID)", serial)
                        return serial
                    log.warning("[ADB Wireless] %s başka bir cihaz — atlanıyor", serial)
                with contextlib.suppress(Exception):
                    await self.adb.disconnect(serial)
                break
        return None

    async def connect_and_activate(self, ip: str, port: int):
        """Connects to ip:port and makes it the active session: bind_device if
        no session was active, switch_transport (clean handover, no leaked
        background services — see Cihaz Geçiş Planı §2.5/§8.4) otherwise.
        Shared by the manual-IP pairing endpoint and the Known Devices
        'reconnect' endpoint so this policy lives in exactly one place."""
        device = await self.pairing.connect_manual(ip, port)
        if self.serial != device.serial:
            if self.serial:
                await self.switch_transport(device.serial)
            else:
                await self.bind_device(device.serial)
        return device

    async def _remember_device(self, serial: str) -> None:
        """Upserts this device into known_devices for one-click reconnect
        (Cihaz Geçiş Planı §3.3/§3.4) unless the user turned remembering off.
        Never overwrites wireless_debugging_paired — only the QR/pairing-code
        success handlers (mark_wireless_debugging_paired) may set that, since
        a plain USB or 5555 reconnect proves nothing about TLS pairing."""
        try:
            project_settings = await settings_db.get_project_settings()
            if not project_settings.remember_devices or not self.android_id:
                return
            existing = await settings_db.get_known_device(self.android_id)
            model = await self.device_manager.get_device_model(serial)
            is_wireless = ":" in serial
            ip: str | None = None
            port: int | None = None
            if is_wireless:
                ip, _, port_str = serial.partition(":")
                with contextlib.suppress(ValueError):
                    port = int(port_str)

            paired = bool(existing and existing.wireless_debugging_paired)
            if is_wireless and self._last_wireless_pairing:
                paired_ip, paired_at = self._last_wireless_pairing
                if paired_ip == ip and (time.time() - paired_at) < 180:
                    paired = True

            known = KnownDevice(
                android_id=self.android_id,
                model=model or (existing.model if existing else None),
                last_seen_at=time.time(),
                last_transport="wireless" if is_wireless else "usb",
                last_known_ip=ip or (existing.last_known_ip if existing else None),
                last_known_port=port or (existing.last_known_port if existing else None),
                wireless_debugging_paired=paired,
            )
            await settings_db.upsert_known_device(known)
        except Exception as exc:
            log.debug("[KnownDevices] remember_device failed for %s: %s", serial, exc)

    async def _ensure_tools_jar_and_daemon(self, serial: str) -> None:
        """Deploys opendex-tools.jar and (re)starts the daemon client.

        The push + forced restart only needs to happen ONCE per physical device
        (keyed by android_id) per backend process lifetime — the jar
        lives on the device's own storage, so a USB<->Wi-Fi transport switch of
        the SAME device never needs a re-push, and force-killing an already
        healthy daemon on every such switch defeated switch_transport's
        "seamless" handover. DeviceDaemonClient._ensure_daemon_spawned already
        owns the "is it alive / spawn if not" decision on every connect — this
        method's own pkill exists only to guarantee a stale JVM (already
        holding old bytecode in memory) doesn't keep serving after a fresh jar
        is deployed to a device we haven't seen yet this run.
        """
        if self.android_id and self.android_id not in self._daemon_deployed_android_ids:
            try:
                # The push itself is skipped when the device copy is already current (tools_jar compares md5).
                if await tools_jar.ensure_tools_jar(self.adb, serial):
                    with contextlib.suppress(Exception):
                        # Daemon lifecycle: through adb itself — the daemon would be killing its own shell.
                        await self.adb.shell_direct("pkill -f OpenDexDaemon", serial=serial, timeout_s=2.0)
                self._daemon_deployed_android_ids.add(self.android_id)
            except Exception as exc:  # noqa: BLE001 — no jar on the phone: the health check fails, adb carries on
                log.warning("[OpenDexDaemon] opendex-tools.jar telefona yüklenemedi: %s", exc)
        # Start daemon client connection
        with contextlib.suppress(Exception):
            await self.daemon_client.start(serial)

    async def _bring_up_daemon(self, serial: str) -> None:
        """Jar + daemon, then its health check (HEALTH_CHECK_ATTEMPTS tries × HEALTH_CHECK_INTERVAL_S, like a Docker
        healthcheck on a database). Healthy: everything that starts after this talks to the phone through the daemon.
        Unhealthy: the session still comes up — through adb — and the daemon client keeps reconnecting in the background;
        every subsystem moves over once it greets us (device_daemon_connected)."""
        await self.startup.update(daemon="checking", daemon_attempt=0, daemon_attempts=HEALTH_CHECK_ATTEMPTS)
        await self._ensure_tools_jar_and_daemon(serial)
        rtt = await self.daemon_client.health_check(
            serial, on_attempt=lambda attempt: self.startup.update(daemon_attempt=attempt),
        )
        if rtt is None:
            log.warning(
                "[OpenDexDaemon] Sağlık kontrolü başarısız (%d deneme × %.0f sn) — oturum ADB ile açılıyor; daemon arka "
                "planda yeniden bağlanmayı sürdürüyor.", HEALTH_CHECK_ATTEMPTS, HEALTH_CHECK_INTERVAL_S,
            )
            await self.startup.update(daemon="unavailable")
        else:
            log.info("[OpenDexDaemon] Sağlıklı (deneme %d, %.1f ms).", self.startup.current.daemon_attempt, rtt)
            await self.startup.update(daemon="healthy", daemon_rtt_ms=rtt)

    async def _on_phone_display_changed(self, snapshot: dict) -> None:
        profile = self.window_manager.profile
        display = android_shell.phone_display_from_snapshot(snapshot)
        if profile is None or display is None:
            return
        if await self.capability_probe.apply_phone_display(profile, display):
            await self.event_bus.emit("device_profile_changed", profile=profile.model_dump())

    def _phone_tasks(self) -> list[dict]:
        """The daemon's latest task snapshot (the apps in front on the phone's own display); empty without a daemon."""
        daemon = self.daemon_client
        if daemon is None or not daemon.is_connected:
            return []
        state = daemon.last_tasks_state
        if not state.get("ok"):
            return []
        return state.get("tasks") or []

    async def _default_audio_route(self) -> AudioRoute:
        """Route of an app without its own preference = the user's "Ses çıkışı" setting."""
        project = await settings_db.get_project_settings()
        return default_route_for(project.audio_output_mode, project.enable_audio)

    async def _audio_sync_offset(self) -> int:
        """"İkisi": the user's by-ear fine tune (ms) — read when a capture is (re)established or retuned."""
        return (await settings_db.get_project_settings()).audio_sync_offset_ms

    async def _suppress_legacy_audio(self) -> None:
        await self.session_audio.set_suppressed(True)

    async def _resume_legacy_audio(self) -> None:
        await self.session_audio.set_suppressed(False)
        if self.serial:
            spawn_background(self._start_session_audio_safe(self.serial))

    async def _start_session_audio_safe(self, serial: str) -> None:
        try:
            project = await settings_db.get_project_settings()
            if project.audio_output_mode in ("pc", "both"):
                await self.session_audio.start_session_audio(serial, output_mode=project.audio_output_mode)
        except Exception as exc:
            log.warning("Master session audio start failed on device bind (%s): %s", serial, exc)

    async def unbind_device(self, disconnect_adb: bool = True, pause_bootstrap_s: float = 4.0) -> None:
        async with self._session_lock:
            await self._unbind_locked(disconnect_adb=disconnect_adb, pause_bootstrap_s=pause_bootstrap_s)

    async def _unbind_locked(
        self, *, disconnect_adb: bool = True, pause_bootstrap_s: float = 4.0, reason: str = "user_disconnect",
    ) -> None:
        serial = self.serial
        if serial is None:
            return
        log.info("unbinding device: %s (disconnect_adb=%s)", serial, disconnect_adb)
        self.serial = None
        self.android_id = None
        tools_jar.forget(serial)
        await self.daemon_client.stop(kill_remote=True)
        await self.window_manager.close_all()
        await self.phone_awake.release(serial)
        await self.app_audio.on_device_unbound()
        await self.session_audio.stop_session_audio()
        await self.thermal_monitor.stop()
        await self.load_monitor.stop()
        await self.supervisor.stop()
        await self.notifications.stop()
        if disconnect_adb and serial:
            try:
                await self.adb.disconnect(serial if ":" in serial else None)
            except Exception as exc:
                log.debug("adb disconnect failed: %s", exc)
        await self.event_bus.emit("device_lost", reason=reason)
        await self.startup.reset("waiting")
        if self.bootstrap_task and not self.bootstrap_task.done():
            self.bootstrap_task.cancel()

        async def _delayed_bootstrap():
            if pause_bootstrap_s > 0:
                await asyncio.sleep(pause_bootstrap_s)
            await self.device_bootstrap()

        self.bootstrap_task = asyncio.create_task(
            _delayed_bootstrap(), name="device-bootstrap"
        )

    async def _on_thermal(self, level: ThermalLevel) -> None:
        """Proactive, automatic, no user setting."""
        load_markers.record("thermal", detail=level.value)
        await self.event_bus.emit("thermal_throttle", level=level.value)
        if level not in (ThermalLevel.NONE, ThermalLevel.LIGHT):
            await self.window_manager.reallocate()

    async def device_bootstrap(self) -> None:
        """Waits for the first usable device, then binds. Keeps polling quietly if none is attached — the UI meanwhile
        offers QR pairing. A bind that fails (bind_device undid it) is retried with a growing pause: 4 s, 8 s, 15 s."""
        failures = 0
        while self.serial is None:
            self._device_list_changed.clear()  # before looking: a change from here on wakes the wait below
            try:
                devices = await self.device_manager.list_devices()
            except Exception as exc:
                log.debug("bootstrap poll failed: %s", exc)
                devices = []
            ready = [d for d in devices if d.state == DeviceState.DEVICE]
            if ready:
                wireless = [d for d in ready if ":" in d.serial]
                chosen = wireless[0] if wireless else ready[0]
                try:
                    await self.bind_device(chosen.serial)
                    return
                except Exception:  # noqa: BLE001 — bind_device already logged why and undid its work
                    failures += 1
            if self.serial is None and not failures:
                await self.startup.update(device="waiting")  # nothing to bind: the UI offers pairing meanwhile
            pause = self.settings.DEVICE_POLL_INTERVAL_S * (2 ** min(failures, 3)) if failures else self.settings.DEVICE_POLL_INTERVAL_S
            # Woken the moment adb's list changes (a phone plugged in / paired); the interval is only the fallback for
            # an adb without device tracking, where this loop's own list_devices is what notices it.
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._device_list_changed.wait(), min(pause, 15.0))

    def spawn_pairing_listener(self, payload: QrPayload) -> asyncio.Task:
        if self.pairing_listener_task and not self.pairing_listener_task.done():
            self.pairing_listener_task.cancel()

        async def _on_paired(device) -> None:
            # QR pairing == TLS wireless-debugging pairing by definition — link
            # it to whatever connects to this ip next so _remember_device can
            # mark wireless_debugging_paired (mDNS rediscoverability).
            ip = device.serial.split(":")[0] if ":" in device.serial else device.serial
            self._last_wireless_pairing = (ip, time.time())
            if self.serial is None:
                await self.bind_device(device.serial)

        return asyncio.create_task(
            self.pairing.start_pairing_listener(payload, _on_paired),
            name="pairing-listener",
        )

    # -------------------------------------------------------------- shutdown

    async def shutdown(self) -> None:
        log.info("OpenDeX backend shutting down...")
        for task in (self.bootstrap_task, self.pairing_listener_task, self.stream_health_task):
            if task and not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task

        async def _safe_step(coro, name: str, timeout: float = 2.0):
            try:
                await asyncio.wait_for(coro, timeout=timeout)
            except asyncio.TimeoutError:
                log.warning("Shutdown step '%s' timed out (%.1fs); continuing...", name, timeout)
            except Exception as exc:
                log.warning("Shutdown step '%s' failed: %s; continuing...", name, exc)

        await _safe_step(self.window_manager.close_all(), "window_manager.close_all", timeout=2.5)
        await _safe_step(self.phone_awake.release(self.serial), "phone_awake.release", timeout=1.5)
        await _safe_step(self.app_audio.shutdown(), "app_audio.shutdown", timeout=1.0)
        await _safe_step(self.session_audio.stop_session_audio(), "session_audio.stop_session_audio", timeout=1.5)
        await _safe_step(self.thermal_monitor.stop(), "thermal_monitor.stop", timeout=1.0)
        await _safe_step(self.load_monitor.stop(), "load_monitor.stop", timeout=1.0)
        await _safe_step(self.supervisor.stop(), "supervisor.stop", timeout=1.0)
        await _safe_step(self.notifications.stop(), "notifications.stop", timeout=1.2)
        log.info("OpenDeX backend shutdown complete.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    ctx: AppContext = app.state.ctx
    logging_config.setup(ctx.settings.LOG_LEVEL)
    server_path = ctx.settings.SCRCPY_SERVER_PATH
    log.info(
        "📦 [scrcpy] sunucu: %s (%s)%s", ctx.settings.SCRCPY_SERVER_FLAVOR, server_path,
        "" if server_path.is_file() else " — DOSYA YOK",
    )
    await settings_db.init(ctx.settings.DB_PATH)
    ctx.device_tracker.start()
    if ctx.settings.FS_ENABLED:
        await ctx.fs.start()
    ctx.bootstrap_task = asyncio.create_task(
        ctx.device_bootstrap(), name="device-bootstrap"
    )
    ctx.stream_health_task = asyncio.create_task(
        report_stream_health(ctx.broadcasters), name="stream-health"
    )
    # Passive-only background listener (Cihaz Geçiş Planı §3.2/§7.1) — never
    # calls adb connect itself, just tracks which known devices are reachable
    # via Wireless Debugging so Device Center can offer a one-click hint.
    await ctx.mdns.start_persistent_connect_listener()
    try:
        yield {"ctx": ctx}
    finally:
        await ctx.mdns.stop_persistent_connect_listener()
        if ctx.settings.FS_ENABLED:
            await ctx.fs.stop()
        await ctx.shutdown()
        await ctx.device_tracker.stop()


def _load_daemon_token(settings: Settings) -> str | None:
    """The key the on-device daemon is started with (device/daemon_auth.py). If the key file cannot be read or written
    the backend still runs: no key means no daemon shell, so device commands simply keep going through adb."""
    try:
        return daemon_auth.load_or_create_token(settings.DAEMON_TOKEN_FILE)
    except OSError as exc:
        log.warning(
            "🔐 [Daemon] Anahtar dosyası kullanılamadı (%s): %s — cihaz kabuk komutları adb üzerinden çalışacak.",
            settings.DAEMON_TOKEN_FILE, exc,
        )
        return None


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    # Refuse to build an app that would listen beyond loopback without an explicit token (api_auth docstring).
    api_token, token_source = api_auth.load_or_create_token(settings)
    api_auth.check_bind_policy(settings, token_source)
    daemon_token = _load_daemon_token(settings)
    log.info("🔐 [Auth] API anahtarı kaynağı: %s (%s)", token_source, settings.API_TOKEN_FILE if token_source != "env" else "env")

    docs = settings.API_DOCS
    app = FastAPI(
        title="OpenDeX Backend", version="0.1.0", lifespan=lifespan,
        docs_url="/docs" if docs else None, redoc_url=None, openapi_url="/openapi.json" if docs else None,
    )
    # ONE live context object; routes and websockets read app.state.ctx so
    # mutable fields (serial, android_id) are never stale copies.
    app.state.ctx = AppContext(settings, daemon_token=daemon_token)
    app.state.api_token = api_token

    # Middleware order (add_middleware: last added = outermost). Request path, outer → inner:
    #   SecurityHeaders (nosniff / no-store on EVERY response — the 401/403/411/413 the layers below answer included)
    #   OriginGuard (foreign page / rebound host → 403/4403)
    #   BodyLimit   (oversized body → 413 before anything reads it)
    #   CORS        (answers preflights; decorates 401s so the UI can read them)
    #   ApiAuth     (bearer token → 401/4401 before any route)
    #   OpId, routes
    app.add_middleware(logging_config.OpIdMiddleware)
    app.add_middleware(api_auth.ApiAuthMiddleware, token=api_token)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_origin_regex=LOCAL_ORIGIN_REGEX,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.MAX_BODY_BYTES)
    app.add_middleware(
        OriginGuardMiddleware,
        allowed_origins=settings.CORS_ORIGINS,
        allowed_hosts=settings.ALLOWED_HOSTS,
    )
    app.add_middleware(SecurityHeadersMiddleware)
    @app.exception_handler(FsError)
    async def _fs_error(_request, exc: FsError):
        # `detail` stays the human sentence (what api.js shows); `code` is what the UI switches on.
        return JSONResponse(
            status_code=exc.status, content={"detail": exc.message, "code": exc.code, "path": exc.path, "reason": exc.detail},
        )

    for prefix in ("/api", "/api/v1"):
        app.include_router(api_auth.router, prefix=prefix)
        app.include_router(api_router, prefix=prefix)
    app.include_router(ws_router)
    return app


# Process images this backend may terminate when they hold its port: its own frozen build and a dev interpreter.
_OWN_BACKEND_IMAGES = ("opendex-backend", "python")


def _is_own_backend_image(image_name: str | None) -> bool:
    """Only a previous OpenDeX backend is ever killed for holding the port — never whatever else happens to listen
    on 8710 (a user's own dev server, a different product)."""
    name = (image_name or "").strip().lower()
    return bool(name) and any(name.startswith(own) for own in _OWN_BACKEND_IMAGES)


def _windows_image_name(pid: int) -> str | None:
    """`tasklist` image name of `pid` (Windows only), None when unknown."""
    import csv
    import io
    import subprocess

    res = subprocess.run(
        ["tasklist", "/FI", f"PID eq {int(pid)}", "/FO", "CSV", "/NH"], capture_output=True, text=True, check=False,
    )
    for row in csv.reader(io.StringIO(res.stdout)):
        if len(row) >= 2 and row[1].strip() == str(pid):
            return row[0]
    return None


def _kill_stale_process_on_port(port: int) -> None:
    """If a previous orphaned instance of opendex-backend is holding port 8710,
    terminate it so the new code instance can bind cleanly."""
    import os
    import subprocess
    import time

    try:
        if os.name == "nt":
            # argv form (no shell): `port` is an int from Settings, but nothing here should ever be parsed by cmd.exe.
            cmd = [
                "powershell", "-NoProfile", "-Command",
                f"$p = Get-NetTCPConnection -LocalPort {int(port)} -State Listen -ErrorAction SilentlyContinue; "
                "if ($p) { $p | Select-Object -ExpandProperty OwningProcess }",
            ]
            res = subprocess.run(cmd, capture_output=True, text=True, check=False)
            killed = False
            for line in res.stdout.strip().splitlines():
                if not line.strip().isdigit():
                    continue
                pid = int(line.strip())
                if pid == os.getpid():
                    continue
                image = _windows_image_name(pid)
                if not _is_own_backend_image(image):
                    log.warning("Port %d is held by PID %d (%s) — not an OpenDeX backend, leaving it alone", port, pid, image)
                    continue
                log.info("Terminating stale backend process %s (PID %d) on port %d...", image, pid, port)
                subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, check=False)
                killed = True
            if killed:
                time.sleep(0.5)
    except Exception as exc:
        log.warning("Could not auto-kill stale process on port %d: %s", port, exc)


def run() -> None:
    import uvicorn

    settings = get_settings()
    _kill_stale_process_on_port(settings.HTTP_PORT)
    # A direct callable reference, not the string "app.main:create_app": the
    # string form makes uvicorn re-import the module by name at startup,
    # which PyInstaller's static import analysis (used to decide what a
    # frozen build bundles) cannot see through — a onefile sidecar build
    # would start, then fail with ModuleNotFoundError the moment uvicorn
    # tried that import from inside the frozen bundle. Passing the function
    # itself is equivalent here (no --reload, no multiple workers — the only
    # cases that actually require the string/re-import form) and works
    # identically in both the plain `python -m app.main` and frozen-exe paths.
    try:
        uvicorn.run(
            create_app,
            factory=True,
            host=settings.HTTP_HOST,
            port=settings.HTTP_PORT,
            log_level=settings.LOG_LEVEL.lower(),
            timeout_graceful_shutdown=2,
            # /ws/video, /ws/audio(/{id}) only ever send (server → client), so this bounds /ws/input and /ws/events:
            # small JSON control messages, except one real outlier — a clipboard paste (/ws/input's "clipboard"
            # message), which is arbitrary, uncapped text. The default (16 MB) would just let a client make the
            # backend allocate; settings.WS_MAX_MESSAGE_BYTES keeps a much smaller but still paste-safe ceiling.
            ws_max_size=settings.WS_MAX_MESSAGE_BYTES,
            server_header=False,
        )
    except api_auth.RemoteBindRefused as exc:
        log.error("🔐 [Auth] %s", exc)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    run()
