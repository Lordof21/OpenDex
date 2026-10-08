"""Fiziksel telefon ekranının gücü — TEK yetkili kontrol noktası.

Saha hatası: telefon ekranı "bir anda kapanıp açılıyordu". Kök neden zinciri:
  1. "Kapat" komutunun son çaresi KEYCODE_POWER'dı. Bu bir TOGGLE'dır: ekran zaten kapalıysa AÇAR.
  2. Arayüz ekran durumunu hiç okumuyordu (`screen_on` sahte `true`, tıklamada iyimser çevirme),
     kullanıcı gerçek durumu göremeden art arda "aç/kapat" gönderebiliyordu.
  3. scrcpy oturumu açılırken telefonu uyandırabilir; bu değişiklik arayüze hiç yansımıyordu.

Bu modül üç garanti verir:
  * Hiçbir yerde toggle tuşu yok. Yalnızca "set" semantiği olan komutlar kullanılır
    (KEYCODE_WAKEUP / KEYCODE_SLEEP ve daemon'un ham ekran-güç kipi).
  * İdempotent: hedef durumdaysa komut GÖNDERİLMEZ; aynı hedef kısa sürede tekrar gelirse yutulur.
  * Dürüst: komuttan sonra gerçek durum okunur; okunamıyorsa `on=None` (bilinmiyor) döner.

Bilinen sınır: daemon'un ham güç kipi (SurfaceControl) PowerManager'a görünmez. Paneli kendimiz
karartırsak bunu `raw_blanked` ile biz hatırlarız; kullanıcı telefonun fiziksel güç tuşuna basarsa
(PowerManager uyur → uyanır) bu hatıra bir sonraki okumaya kadar bayat kalabilir. Sonucu: en fazla
bir "boşa" tıklama; asla beklenmedik açılıp kapanma değil.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

# Android tuş kodları — ikisi de "set" semantiğindedir (basınca durum TERS DÖNMEZ).
_CMD_WAKEUP = "input keyevent 224"
_CMD_SLEEP = "input keyevent 223"

_WAKE_RE = re.compile(r"mWakefulness\s*=\s*(\w+)", re.IGNORECASE)
_DISP_RE = re.compile(r"Display Power:\s*state\s*=\s*(\w+)", re.IGNORECASE)

_WAKE_LIT = {"awake", "dreaming"}
_WAKE_DARK = {"asleep", "dozing"}
_DISP_LIT = {"on", "on_suspend", "vr"}
_DISP_DARK = {"off", "doze", "doze_suspend"}


@dataclass(frozen=True)
class PowerReading:
    wakefulness: str | None = None    # awake | asleep | dozing | dreaming
    display_state: str | None = None  # on | off | doze | ...

    @property
    def panel_on(self) -> bool | None:
        """Panel yanıyor mu? Ekran durumu (DPC) uyanıklıktan (PowerManager) önceliklidir:
        yakınlık sensörü / çağrı sırasında cihaz "awake" iken panel kapalı olabilir."""
        if self.display_state in _DISP_LIT:
            return True
        if self.display_state in _DISP_DARK:
            return False
        if self.wakefulness in _WAKE_LIT:
            return True
        if self.wakefulness in _WAKE_DARK:
            return False
        return None


def parse_power_state(dump: str) -> PowerReading:
    """`dumpsys power` çıktısından uyanıklık + ekran durumunu okur (bulunamayan alan None)."""
    text = dump or ""
    wake = _WAKE_RE.search(text)
    disp = _DISP_RE.search(text)
    return PowerReading(
        wakefulness=wake.group(1).lower() if wake else None,
        display_state=disp.group(1).lower() if disp else None,
    )


@dataclass
class _LastCommand:
    target: bool
    at: float


class DisplayPowerController:
    """Telefon ekranını açma/kapama ve gerçek durumunu okuma (bkz. modül açıklaması)."""

    def __init__(
        self,
        adb: Any,
        serial_getter: Callable[[], str | None],
        daemon_getter: Callable[[], Any | None],
        events: Any | None = None,
        *,
        settle_s: float = 1.5,
        verify_delay_s: float = 0.7,
        cache_ttl_s: float = 2.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._adb = adb
        self._serial = serial_getter
        self._daemon = daemon_getter
        self._events = events
        self._settle_s = settle_s
        self._verify_delay_s = verify_delay_s
        self._cache_ttl_s = cache_ttl_s
        self._clock = clock
        self._sleep = sleep

        self._lock = asyncio.Lock()
        self._state_serial: str | None = None
        self._cache: PowerReading | None = None
        self._cache_at = 0.0
        self._raw_blanked = False
        self._last_cmd: _LastCommand | None = None
        self._inflight_target: bool | None = None

    # ------------------------------------------------------------------ okuma
    def _adopt_serial(self, serial: str | None) -> None:
        """Cihaz değişince önceki cihazın önbelleği/karartma hatırası taşınmaz."""
        if serial != self._state_serial:
            self._state_serial = serial
            self._cache = None
            self._cache_at = 0.0
            self._raw_blanked = False
            self._last_cmd = None

    async def _read(self, *, fresh: bool) -> PowerReading | None:
        serial = self._serial()
        self._adopt_serial(serial)
        if not serial:
            return None
        now = self._clock()
        if not fresh and self._cache is not None and now - self._cache_at < self._cache_ttl_s:
            return self._cache
        daemon = self._daemon()
        if daemon is not None and hasattr(daemon, "power_state") and daemon.supports("power_get"):
            state = await daemon.power_state()
            reading = PowerReading(
                wakefulness=state.get("wakefulness"), display_state=state.get("display_state"),
            ) if state else None
            if reading is not None and reading.panel_on is not None:
                self._cache = reading
                self._cache_at = now
                return reading
        try:
            out = await self._adb.shell("dumpsys power", serial=serial, timeout_s=3.0)
        except Exception as exc:
            log.warning("[DisplayPower] güç durumu okunamadı: %s", exc)
            return None
        reading = parse_power_state(out)
        if reading.panel_on is None:
            log.warning("[DisplayPower] `dumpsys power` çıktısında ekran durumu bulunamadı")
            return None
        self._cache = reading
        self._cache_at = now
        return reading

    def _effective_on(self, reading: PowerReading | None) -> bool | None:
        panel = reading.panel_on if reading is not None else None
        if self._raw_blanked:
            if panel is False:
                # PowerManager'ın kendisi uyudu: ham karartma hatırası anlamsız (uyanınca panel yeniden yanar).
                self._raw_blanked = False
            return False
        return panel

    def _snapshot(self, on: bool | None, reading: PowerReading | None, *, pending: bool = False) -> dict[str, Any]:
        return {
            "on": on,
            "known": on is not None,
            "pending": pending,
            "wakefulness": reading.wakefulness if reading else None,
            "display_state": reading.display_state if reading else None,
            "raw_blanked": self._raw_blanked,
        }

    async def state(self, *, fresh: bool = False) -> dict[str, Any]:
        """Gerçek ekran durumu. Komut sürerken hedef durumu `pending=True` ile bildirir."""
        if self._inflight_target is not None:
            return self._snapshot(self._inflight_target, self._cache, pending=True)
        reading = await self._read(fresh=fresh)
        return self._snapshot(self._effective_on(reading), reading)

    # ------------------------------------------------------------------ yazma
    async def set(self, on: bool, *, source: str = "api") -> dict[str, Any]:
        """Ekranı `on` durumuna getirir. Hedefteyse hiçbir komut göndermez (idempotent)."""
        on = bool(on)
        if not self._serial():
            return {"ok": False, "on": None, "changed": False, "error": "no_device"}
        async with self._lock:
            return await self._set_locked(on, source)

    async def _set_locked(self, on: bool, source: str) -> dict[str, Any]:
        before = await self._read(fresh=True)
        before_on = self._effective_on(before)
        tag = "aç" if on else "kapat"

        last = self._last_cmd
        if last is not None and last.target == on and self._clock() - last.at < self._settle_s:
            log.info("[DisplayPower] %s (%s) yutuldu: aynı hedef %.1f sn içinde zaten gönderildi", tag, source, self._settle_s)
            return self._result(True, before_on if before_on is not None else on, False, reason="settling")

        if before_on is on:
            log.info("[DisplayPower] %s (%s): ekran zaten hedef durumda, komut gönderilmedi", tag, source)
            return self._result(True, on, False, reason="already")

        self._inflight_target = on
        try:
            path = await self._send(on, before_on)
            self._last_cmd = _LastCommand(on, self._clock())
            await self._sleep(self._verify_delay_s)
            after = await self._read(fresh=True)
        except Exception as exc:
            log.warning("[DisplayPower] %s (%s) komutu başarısız: %s", tag, source, exc)
            return self._result(False, before_on, False, error=str(exc))
        finally:
            self._inflight_target = None

        result = self._settle_outcome(on, path, after)
        log.info(
            "[DisplayPower] %s (%s): önce=%s yol=%s sonra=%s → on=%s ok=%s",
            tag, source, before_on, path, after.panel_on if after else None, result["on"], result["ok"],
        )
        await self._publish(result["on"])
        return result

    async def _send(self, on: bool, before_on: bool | None) -> str:
        """Hedef durum için SET semantiğinde komut gönderir; hangi yolun kullanıldığını döner."""
        daemon = self._daemon()
        # Daemon'un KAPAT yolunun son çaresi eski jar'larda toggle'dır: yalnızca ekranın YANDIĞINI
        # doğrulamışsak kullanılır. Durum bilinmiyorsa belirleyici SLEEP tuşuna düşülür.
        if daemon is not None and getattr(daemon, "is_connected", False) and (on or before_on is True):
            try:
                if await daemon.set_display_power(on):
                    return "daemon"
            except Exception as exc:
                log.warning("[DisplayPower] daemon ekran gücü çağrısı başarısız, adb'ye düşülüyor: %s", exc)

        serial = self._serial()
        if on:
            if self._raw_blanked:
                # Panel ham kipte karartılmış ama PowerManager "awake": WAKEUP tuşu etkisiz kalır;
                # uyku→uyanış döngüsü DPC üzerinden paneli yeniden yakar.
                await self._adb.shell(_CMD_SLEEP, serial=serial, timeout_s=2.0)
                await self._sleep(0.3)
            await self._adb.shell(_CMD_WAKEUP, serial=serial, timeout_s=2.0)
        else:
            await self._adb.shell(_CMD_SLEEP, serial=serial, timeout_s=2.0)
        return "adb"

    def _settle_outcome(self, on: bool, path: str, after: PowerReading | None) -> dict[str, Any]:
        after_panel = after.panel_on if after is not None else None
        if on:
            self._raw_blanked = False
            if after_panel is False:
                return self._result(False, False, True, path=path, error="screen_did_not_wake")
            return self._result(True, True, True, path=path, verified=after_panel is True)

        if after_panel is False:
            self._raw_blanked = False
            return self._result(True, False, True, path=path, verified=True)
        if path == "daemon":
            # PowerManager hâlâ "awake" ⇒ daemon paneli ham kipte karartmıştır (PM'e görünmez).
            self._raw_blanked = True
            return self._result(True, False, True, path=path, verified=False)
        if after_panel is True:
            return self._result(False, True, True, path=path, error="screen_did_not_sleep")
        return self._result(True, False, True, path=path, verified=False)

    async def resync(self, screen_blanked: bool | None = None, **_: Any) -> None:
        """Daemon (re)connected (its greeting). While the panel is RAW-blanked PowerManager still reports "awake/on",
        so a fresh `dumpsys power` cannot tell "still blanked" from "the daemon lit it again" (its fail-safe: 30 s
        without a control client, shutdown, a crashed predecessor). Only the daemon knows: its
        greeting carries `screen_blanked`, which replaces our memory. Old jars send nothing → memory kept."""
        if not self._serial():
            return
        async with self._lock:
            reading = await self._read(fresh=True)       # first: adopts the serial (a new device resets the memory)
            if screen_blanked is not None:
                if self._raw_blanked and not screen_blanked:
                    log.info("[DisplayPower] daemon paneli kendisi yaktı (fail-safe); karartma hatırası silindi")
                self._raw_blanked = bool(screen_blanked)
            on = self._effective_on(reading)
        await self._publish(on)

    @staticmethod
    def _result(ok: bool, on: bool | None, changed: bool, **extra: Any) -> dict[str, Any]:
        return {"ok": ok, "on": on, "changed": changed, **extra}

    async def _publish(self, on: bool | None) -> None:
        if self._events is None or on is None:
            return
        try:
            await self._events.emit("device_states_update", states={"screen_on": on})
        except Exception as exc:
            log.debug("[DisplayPower] durum olayı yayınlanamadı: %s", exc)
