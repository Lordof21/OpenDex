"""Pencereler açıkken telefonun UYUMAMASI — oturum kapsamlı kira.

Saha hatası: telefon ekranı kapanıp kilit ekranı gelince VD penceresi siyah oluyor ve uygulama kilidi yeniden soruluyordu
(eskiden sormazdı). Kök neden: telefon GERÇEKTEN uyuyordu. Gerçek uyku iki şeyi birlikte getirir: kilit ekranı (keyguard) ve
OEM uygulama kilidinin "ekran kapanınca yeniden kilitle" davranışı (HyperOS AppLock). Sanal ekrandaki uygulama, kilit
arayüzünün güvenli (FLAG_SECURE) penceresi altında kalır: yayında siyah görünür, kimlik doğrulama fiziksel telefonda istenir.
Bunu önleyen şey telefonun uyumamasıdır; `bind_device` bunu `stay_on_while_plugged_in 7` ile yapıyordu, 17 Eylül'de
"fiziksel ekran uyuyabilsin" diye `0`'a çekildi ve her bağlantıda kalıcı olarak yazılıyordu.

Şimdi: yalnız OpenDex pencereleri AÇIKKEN `7` (AC | USB | kablosuz şarj) tutulur; son pencere kapanınca, cihaz ayrılınca ya da
arka uç kapanınca kullanıcının KENDİ değeri geri yazılır. Özgün değer cihazda saklanır (`opendex_stay_on_original`): arka uç
çökse bile bir sonraki bağlanmada geri yüklenir. Ekranı karartmak isteyen kullanıcı için doğru yol uykuya DALMAYAN ham
karartmadır (`screen_off_while_mirroring` / `DisplayPowerController`).

Sınır: ayar yalnız ŞARJDAYKEN etkilidir. Şarjda olmayan telefon, ekran zaman aşımıyla uyur (Android'in kendi davranışı).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Callable

log = logging.getLogger(__name__)

SETTING = "stay_on_while_plugged_in"
ORIGINAL_KEY = "opendex_stay_on_original"  # özgün değerin cihazdaki yedeği (arka uç çökmesine dayanıklı)
HOLD_VALUE = "7"                           # BATTERY_PLUGGED_AC | USB | WIRELESS


class PhoneAwakeLease:
    def __init__(self, adb: Any, serial_getter: Callable[[], str | None], live_getter: Callable[[], bool]) -> None:
        self._adb = adb
        self._serial = serial_getter
        self._live = live_getter
        self._lock = asyncio.Lock()
        self._engaged = False
        self._recovered_for: str | None = None  # bu cihaz için "çökmüş bir önceki oturum" bir kez denetlendi
        self._task: asyncio.Task | None = None
        self._again = False

    def request_sync(self) -> None:
        """Birleştirilmiş, bloklamaz (SessionTable dinleyicisi senkron koddan çağırır)."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._task is not None and not self._task.done():
            self._again = True
            return
        self._task = loop.create_task(self._loop(), name="phone-awake-sync")

    async def _loop(self) -> None:
        while True:
            self._again = False
            with contextlib.suppress(Exception):
                await self.sync()
            if not self._again:
                return

    async def sync(self) -> None:
        serial = self._serial()
        if not serial:
            return
        async with self._lock:
            if self._recovered_for != serial:
                self._recovered_for = serial
                if not self._live():
                    await self._release(serial)  # önceki oturum çöktüyse özgün değer cihazda duruyordur
            want = self._live()
            if want and not self._engaged:
                await self._engage(serial)
            elif not want and self._engaged:
                await self._release(serial)

    async def release(self, serial: str | None) -> None:
        """Cihaz ayrılırken / kapanışta: pencere kalmadığı için kullanıcının değeri geri verilir."""
        if serial:
            async with self._lock:
                await self._release(serial)
                self._recovered_for = None

    # ------------------------------------------------------------------ cihaz tarafı

    async def _get(self, serial: str, key: str) -> str | None:
        out = (await self._adb.shell(f"settings get global {key}", serial=serial, timeout_s=2.0)).strip()
        return None if out in ("", "null") else out

    async def _engage(self, serial: str) -> None:
        try:
            if await self._get(serial, ORIGINAL_KEY) is None:  # çökmüş oturumdan kalan özgün değer EZİLMEZ
                current = await self._get(serial, SETTING)
                await self._adb.shell(f"settings put global {ORIGINAL_KEY} {current or '0'}", serial=serial, timeout_s=2.0)
            await self._adb.shell(f"settings put global {SETTING} {HOLD_VALUE}", serial=serial, timeout_s=2.0)
            self._engaged = True
            log.info("[PhoneAwake] pencereler açık: telefon şarjdayken uyutulmaz (%s=%s)", SETTING, HOLD_VALUE)
        except Exception as exc:  # noqa: BLE001 — konfor ayarı; pencere akışını asla bozmaz, sonraki değişim yeniden dener
            log.warning("[PhoneAwake] uyanık tutma uygulanamadı: %s", exc)

    async def _release(self, serial: str) -> None:
        self._engaged = False  # başarısız olsa da: yedek cihazda durur, sonraki bağlanma geri yükler
        try:
            original = await self._get(serial, ORIGINAL_KEY)
            if original is not None:
                await self._adb.shell(f"settings put global {SETTING} {original}", serial=serial, timeout_s=2.0)
                await self._adb.shell(f"settings delete global {ORIGINAL_KEY}", serial=serial, timeout_s=2.0)
                log.info("[PhoneAwake] pencere kalmadı: %s özgün değere döndü (%s)", SETTING, original)
        except Exception as exc:  # noqa: BLE001 — cihaz çoktan ayrılmış olabilir; yedek cihazda durur, sonraki bağlanma geri yükler
            log.warning("[PhoneAwake] özgün değer geri yazılamadı: %s", exc)
