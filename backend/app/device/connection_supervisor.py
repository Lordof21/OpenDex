"""Connection resilience (audit gap: reconnection existed in the MVP brief but was
missing from the full-product spec).

Policy on loss: windows are NOT closed — their state is preserved and the frontend
keeps showing the last frozen frames. A user working with three windows must not
lose everything because a cable slipped.

A drop of the adb link, however short (a cable re-seating, a Wi-Fi reconnect), kills every scrcpy server: each one lives
exactly as long as its adb session. So "the device is back" is not enough — what ran over the old link has to be rebuilt.
The supervisor therefore watches adb's TRANSPORT ID, not only whether the device is listed: a drop that was over before
the next poll still shows as a new id. Every cycle arms a heal, and the heal rebuilds the windows IN PLACE (same ids, same
geometry — WindowManager.heal_links), retrying a few times while the link settles.

Reconnection after a loss beyond the grace period follows RECONNECT_BACKOFF_MS; on success the ANDROID_ID is compared
before healing.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING

from ..config import Settings
from ..events import EventBus, cancel_and_wait, spawn_background
from ..schemas import DeviceInfo, DeviceState
from .device_manager import DeviceManager

if TYPE_CHECKING:
    from ..windows.window_manager import WindowManager

log = logging.getLogger(__name__)

# A heal that cannot finish (the link keeps flapping, the phone is not ready) is retried this often; after that the
# windows that could not be rebuilt stay frozen with their last frame — restoring one from the taskbar retries it.
MAX_HEAL_ATTEMPTS = 5

# Stalled-link detection. Video silent this long → ask the phone something small (a static screen sends no frames, so
# silence alone proves nothing). While it answers but the video stays silent the question repeats rarely; while it does
# not, often.
STALL_S = 5.0
PROBE_TIMEOUT_S = 2.0
PROBE_IDLE_S = 8.0
PROBE_WEAK_S = 3.0


class ConnectionSupervisor:
    def __init__(
        self,
        devices: DeviceManager,
        events: EventBus,
        settings: Settings,
        window_manager: "WindowManager | None" = None,
    ) -> None:
        self._devices = devices
        self._events = events
        self._settings = settings
        self._window_manager = window_manager
        self._task: asyncio.Task | None = None
        self._serial: str | None = None
        self._android_id: str | None = None
        self._connected = False
        self._unreachable_since: float | None = None
        # adb's id of the link the windows were built over; a different one means the link cycled since.
        self._transport_id: int | None = None
        self._heal_pending = False
        self._heal_attempts = 0
        self._next_heal_at = 0.0
        # The link's pulse (WindowManager.video_packets), when it last changed, when to ask the phone next, and whether
        # the UI was told the link is weak.
        self._pulse: int | None = None
        self._pulse_at = 0.0
        self._next_probe_at = 0.0
        self._weak = False
        # Wakes the watch loop out of its sleep: a window whose server just died asks for an immediate look.
        self._wake = asyncio.Event()
        # Tek-uçuşlu yeniden bağlanma: izleme döngüsü ve backoff görevi cihazı AYNI ANDA geri görebilir;
        # ikisi de heal çalıştırırsa pencereleri birbirinin altından kapatıp açar (yetim scrcpy
        # sunucusu + her yeniden açılışta telefonun uyandırılması).
        self._reconnect_lock = asyncio.Lock()

    @property
    def disconnect_grace_s(self) -> float:
        return self._settings.DEVICE_DISCONNECT_GRACE_S

    async def start(self, serial: str, android_id: str) -> None:
        self._serial = serial
        self._android_id = android_id
        self._connected = True
        self._unreachable_since = None
        self._heal_pending = False
        self._pulse = None
        info = await self._probe()
        self._transport_id = info.transport_id if info is not None else None
        self._task = asyncio.create_task(self._watch_loop(), name="connection-supervisor")

    async def stop(self) -> None:
        await cancel_and_wait(self._task)
        self._task = None
        self._unreachable_since = None
        self._heal_pending = False
        await self._set_weak(False)

    @property
    def connected(self) -> bool:
        return self._connected

    def devices_changed(self) -> None:
        """adb's device list changed (DeviceTracker push): look now instead of at the next poll — an unplug or a
        re-established link is seen the moment adb sees it."""
        if self._task is not None:
            self._wake.set()

    async def link_dropped(self) -> bool:
        """Did the adb link to the phone drop (and not yet get healed)? Asked when a window's server died: the apps the
        phone leaves behind must not be mistaken for the user opening them there, and a Workspace must keep its
        members. Only looks — the heal itself runs from the watch loop, woken at once."""
        if self._task is None:
            return False
        dropped = self._heal_pending or not self._connected or self._unreachable_since is not None
        if not dropped:
            info = await self._probe()
            dropped = not self._usable(info) or self._cycled(info)
        if dropped:
            self._wake.set()
        return dropped

    # ------------------------------------------------------------------ observation

    async def _probe(self) -> DeviceInfo | None:
        """The bound device's `adb devices -l` entry (None: not listed, or adb itself unreachable)."""
        try:
            devices = await self._devices.list_devices()
        except Exception:
            return None
        return next((d for d in devices if d.serial == self._serial), None)

    @staticmethod
    def _usable(info: DeviceInfo | None) -> bool:
        return info is not None and info.state == DeviceState.DEVICE

    def _cycled(self, info: DeviceInfo | None) -> bool:
        return (
            info is not None and info.transport_id is not None
            and self._transport_id is not None and info.transport_id != self._transport_id
        )

    async def _is_device_alive(self) -> bool:
        return self._usable(await self._probe())

    async def _watch_loop(self) -> None:
        while True:
            # Tolerans periyodunda (anlık kesinti şüphesi) ve heal beklerken cihazın durumunu hızla yakalamak için daha sık poll yap
            fast_poll = min(0.4, self._settings.DEVICE_POLL_INTERVAL_S)
            watchful = self._unreachable_since is not None or self._heal_pending
            poll_interval = fast_poll if watchful else self._settings.DEVICE_POLL_INTERVAL_S
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=poll_interval)
            self._wake.clear()
            # Bir turdaki hata (ör. heal istisnası) denetçiyi SESSİZCE öldürmemeli.
            try:
                await self._watch_tick()
            except Exception:
                log.exception("[SUPERVISOR] izleme turu başarısız oldu — döngü devam ediyor")

    async def _watch_tick(self) -> None:
        info = await self._probe()
        alive = self._usable(info)
        now = asyncio.get_event_loop().time()

        if self._connected:
            if alive:
                await self._on_link_up(info, now)
            elif self._unreachable_since is None:
                self._unreachable_since = now
                log.warning(
                    "⚠️ [SUPERVISOR] Cihaz (%s) anlık olarak ulaşılamaz oldu! %.1fs tolerans süresi başlatıldı...",
                    self._serial, self.disconnect_grace_s,
                )
            elif (now - self._unreachable_since) >= self.disconnect_grace_s:
                elapsed = now - self._unreachable_since
                log.warning(
                    "❌ [SUPERVISOR] Cihaz (%s) %.1fs boyunca geri gelmedi (tolerans doldu) -> Bağlantı kopması ilan ediliyor.",
                    self._serial, elapsed,
                )
                self._unreachable_since = None
                await self.on_connection_lost()
            else:
                log.debug(
                    "⏳ [SUPERVISOR] Cihaz (%s) hala çevrimdışı (%.1fs / %.1fs tolerans süresi)",
                    self._serial, now - self._unreachable_since, self.disconnect_grace_s,
                )
        elif alive:
            self._unreachable_since = None
            await self._try_reidentify()

    async def _on_link_up(self, info: DeviceInfo, now: float) -> None:
        """The device answers. If the link cycled meanwhile — seen as an unreachable spell or as a new transport id —
        the windows' servers died with it: arm a heal (once), and run it while one is pending."""
        cycled = self._cycled(info)
        if self._unreachable_since is not None:
            log.info(
                "✅ [SUPERVISOR] Cihaz (%s) anlık kesintiden %.2fs içinde geri bağlandı! Pencereler yerinde yeniden kuruluyor.",
                self._serial, now - self._unreachable_since,
            )
            self._unreachable_since = None
            cycled = True
        if info.transport_id is not None:
            self._transport_id = info.transport_id
        if cycled and not self._heal_pending:
            self._arm_heal()
        if self._heal_pending:
            await self._heal(now)
        else:
            await self._check_pulse(now)

    # ------------------------------------------------------------------ stalled link

    async def _check_pulse(self, now: float) -> None:
        """adb can keep calling a device "device" while its data path is stalled (a Wi-Fi hiccup): the windows then look
        alive but frozen, and nothing else notices. Video flowing proves the link, so while it flows this costs nothing;
        only a silent stream earns a question to the phone."""
        packets = self._window_manager.video_packets() if self._window_manager is not None else None
        if packets is None or packets != self._pulse:
            self._pulse, self._pulse_at, self._next_probe_at = packets, now, 0.0
            await self._set_weak(False)
            return
        if now - self._pulse_at < STALL_S or now < self._next_probe_at:
            return
        try:
            await asyncio.wait_for(self._devices.get_android_id(self._serial), PROBE_TIMEOUT_S)
            answered = True
        except Exception:  # noqa: BLE001 — a timeout or an adb error: the phone did not answer
            answered = False
        self._next_probe_at = now + (PROBE_IDLE_S if answered else PROBE_WEAK_S)
        await self._set_weak(not answered)

    async def _set_weak(self, weak: bool) -> None:
        if weak == self._weak:
            return
        self._weak = weak
        log.log(
            logging.WARNING if weak else logging.INFO,
            "[SUPERVISOR] bağlantı %s", "zayıf — telefon yanıt vermiyor, video sessiz" if weak else "toparlandı",
        )
        await self._events.emit("link_quality", weak=weak)

    # ------------------------------------------------------------------ heal

    def _arm_heal(self) -> None:
        self._heal_pending = True
        self._heal_attempts = 0
        self._next_heal_at = 0.0

    async def _heal(self, now: float) -> None:
        """One attempt to rebuild what the link drop killed (WindowManager.heal_links, idempotent). Success — or running
        out of attempts — disarms it; in between the next attempt waits RECONNECT_BACKOFF_MS."""
        if now < self._next_heal_at:
            return
        self._heal_attempts += 1
        try:
            dead = await self._window_manager.heal_links() if self._window_manager is not None else 0
        except Exception:
            log.exception("[SUPERVISOR] pencere onarımı başarısız oldu (deneme %d)", self._heal_attempts)
            dead = -1
        if dead == 0:
            self._heal_pending = False
            log.info("[SUPERVISOR] bağlantı sonrası pencereler yerinde yeniden kuruldu (deneme %d)", self._heal_attempts)
        elif self._heal_attempts >= MAX_HEAL_ATTEMPTS:
            self._heal_pending = False
            log.warning(
                "[SUPERVISOR] %d denemeden sonra pencereler kurulamadı — son karelerle donuk kalıyor (görev çubuğundan geri yüklenir)",
                self._heal_attempts,
            )
        else:
            backoff = self._settings.RECONNECT_BACKOFF_MS
            self._next_heal_at = now + backoff[min(self._heal_attempts - 1, len(backoff) - 1)] / 1000

    # ------------------------------------------------------------------ loss beyond the grace period

    async def on_connection_lost(self) -> None:
        self._connected = False
        log.warning("[SUPERVISOR] device %s lost — windows preserved, streams frozen", self._serial)
        await self._set_weak(False)  # the "reconnecting" notice takes over
        await self._events.emit("device_lost", reason="transport")
        # Windows are intentionally NOT closed; frontend renders frozen last frames.
        spawn_background(self._reconnect_with_backoff(), name="reconnect-backoff")

    async def _reconnect_with_backoff(self) -> None:
        for delay_ms in self._settings.RECONNECT_BACKOFF_MS:
            await asyncio.sleep(delay_ms / 1000)
            if await self._is_device_alive():
                await self._try_reidentify()
                return
        log.warning("[SUPERVISOR] backoff exhausted; supervisor keeps polling passively")

    async def _try_reidentify(self) -> None:
        assert self._serial is not None
        if self._reconnect_lock.locked():
            log.info("[SUPERVISOR] yeniden bağlanma zaten sürüyor — eşzamanlı ikinci çağrı yok sayıldı")
            return
        async with self._reconnect_lock:
            if self._connected:
                # Öteki yol (izleme döngüsü ⟷ backoff görevi) bağlantıyı bu arada tamamladı.
                return
            try:
                android_id = await self._devices.get_android_id(self._serial)
            except Exception:
                return
            await self.on_reconnected(android_id)

    async def on_reconnected(self, android_id: str) -> None:
        info = await self._probe()
        if info is not None and info.transport_id is not None:
            self._transport_id = info.transport_id
        try:
            if android_id == self._android_id:
                log.info("[SUPERVISOR] same device back (%s); rebuilding its windows in place", android_id)
                self._arm_heal()
                await self._heal(asyncio.get_event_loop().time())
            else:
                log.info("[SUPERVISOR] different device (%s); closing old session", android_id)
                if self._window_manager is not None:
                    await self._window_manager.close_all()
                self._android_id = android_id
        except Exception:
            # Cihaz ERİŞİLEBİLİR; pencerelerin kurulamaması bağlantıyı "kopuk" bırakmamalı — aksi halde her
            # yoklamada yeniden denenir (kapat/aç döngüsü, her açılışta telefon uyanır). _heal zaten yeniden dener.
            log.exception("[SUPERVISOR] cihaz değişimi/onarımı tamamlanamadı — cihaz yine de bağlı sayılıyor")
            self._android_id = android_id
        self._connected = True
        await self._events.emit("device_reconnected", android_id=android_id)
