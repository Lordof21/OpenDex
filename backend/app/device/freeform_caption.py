"""HyperOS / MIUI serbest pencere başlığını (Miui Caption + alt tutamaç) OpenDex pencereleri açıkken gizleyen kira.

HyperOS, serbest kipteki (windowingMode 5) her görevin üstüne bir başlık hapı (`Miui Caption of Task=<id>`), altına bir
tutamaç (`Miui Bottom Caption`) çizer. Bunları WindowManager değil MiuiSystemUI içindeki WM Shell (`MiuiDecorationDot`)
üretir ve Workspace görüntüsünde uygulamanın üstünde/altında gri çizgi olarak görünürler. MiuiSystemUI'nin
`MulWinSwitchSettingsObserver`'ı `Settings.Secure.disable_decoration_dot`'u dinler: 1 olunca açık pencerelerin başlıkları
anında SurfaceFlinger'dan atılır, uygulamanın kendisi (kardeş katman) ve dokunmaları etkilenmez
(docs/research/XIAOMI_FREEFORM_CAPTION_SUPPRESSION.md).

Ayar telefonun GENELİDİR: telefonun kendi ekranındaki küçük pencereler de tutamacını kaybeder. Bu yüzden `phone_awake` ile
aynı kira deseni — yalnız istendiğinde (OpenDex pencereleri açık ve telefonda serbest kipte aktarılmış bir uygulama yokken)
uygulanır, istenmeyince kullanıcının KENDİ değeri geri yazılır. Özgün değer cihazda saklanır
(`opendex_decoration_dot_original`, hiç yoksa `unset`): arka uç çökse bile sonraki bağlanmada geri yüklenir.
Yazma ve geri yükleme tek kabuk çağrısıdır (daemon üzerinden, `sh -c`).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Awaitable, Callable

from app.device import android_shell

log = logging.getLogger(__name__)

SETTING = "disable_decoration_dot"
ORIGINAL_KEY = "opendex_decoration_dot_original"
UNSET = "unset"  # ayar cihazda hiç yoktu: geri yüklemede silinir

# Yedek yoksa (çökmüş bir oturumun yedeği EZİLMEZ) özgün değeri saklar, sonra başlıkları kapatır.
ENGAGE_CMD = (
    f'b=$(settings get secure {ORIGINAL_KEY}); '
    f'if [ "$b" = null ]; then o=$(settings get secure {SETTING}); '
    f'[ "$o" = null ] && o={UNSET}; settings put secure {ORIGINAL_KEY} "$o"; fi; '
    f'settings put secure {SETTING} 1'
)
# Yedek varsa özgün değeri geri yazar (hiç yoktuysa siler) ve yedeği kaldırır; yedek yoksa hiçbir şeye dokunmaz.
RELEASE_CMD = (
    f'o=$(settings get secure {ORIGINAL_KEY}); '
    f'if [ "$o" != null ]; then '
    f'if [ "$o" = {UNSET} ]; then settings delete secure {SETTING}; else settings put secure {SETTING} "$o"; fi; '
    f'settings delete secure {ORIGINAL_KEY}; fi'
)


class FreeformCaptionLease:
    def __init__(
        self,
        adb: Any,
        serial_getter: Callable[[], str | None],
        wanted: Callable[[], Awaitable[bool]],
        *,
        is_xiaomi: Callable[[Any, str], Awaitable[bool]] = android_shell.is_miui_or_hyperos,
    ) -> None:
        self._adb = adb
        self._serial = serial_getter
        self._wanted = wanted
        self._is_xiaomi = is_xiaomi
        self._lock = asyncio.Lock()
        self._engaged = False
        self._recovered_for: str | None = None  # bu cihaz için "çökmüş bir önceki oturum" bir kez denetlendi
        self._task: asyncio.Task | None = None
        self._again = False

    @property
    def engaged(self) -> bool:
        return self._engaged

    def request_sync(self, *_: Any, **__: Any) -> None:
        """Birleştirilmiş, bloklamaz: oturum tablosu dinleyicisi ve olay veriyolu (yükü yok sayılır) senkron koddan çağırır."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._task is not None and not self._task.done():
            self._again = True
            return
        self._task = loop.create_task(self._loop(), name="freeform-caption-sync")

    async def _loop(self) -> None:
        while True:
            self._again = False
            with contextlib.suppress(Exception):
                await self.sync()
            if not self._again:
                return

    async def sync(self) -> None:
        serial = self._serial()
        if not serial or not await self._is_xiaomi(self._adb, serial):
            return
        async with self._lock:
            want = await self._wanted()
            if self._recovered_for != serial:
                self._recovered_for = serial
                if not want:
                    await self._release(serial)  # önceki oturum çöktüyse özgün değer cihazda duruyordur
            if want and not self._engaged:
                await self._engage(serial)
            elif not want and self._engaged:
                await self._release(serial)

    async def release(self, serial: str | None) -> None:
        """Cihaz ayrılırken / kapanışta: kullanıcının değeri geri verilir."""
        if serial and self._engaged:
            async with self._lock:
                await self._release(serial)
        self._recovered_for = None

    async def _engage(self, serial: str) -> None:
        try:
            await self._adb.shell(ENGAGE_CMD, serial=serial, timeout_s=3.0)
            self._engaged = True
            log.info("[FreeformCaption] HyperOS serbest pencere başlığı ve alt tutamacı gizlendi (%s=1)", SETTING)
        except Exception as exc:  # noqa: BLE001 — görünüm ayarı; pencere akışını asla bozmaz, sonraki değişim yeniden dener
            log.warning("[FreeformCaption] başlık gizlenemedi: %s", exc)

    async def _release(self, serial: str) -> None:
        self._engaged = False  # başarısız olsa da: yedek cihazda durur, sonraki bağlanma geri yükler
        try:
            await self._adb.shell(RELEASE_CMD, serial=serial, timeout_s=3.0)
            log.info("[FreeformCaption] HyperOS serbest pencere başlığı kullanıcının ayarına döndü")
        except Exception as exc:  # noqa: BLE001 — cihaz çoktan ayrılmış olabilir; yedek cihazda durur
            log.warning("[FreeformCaption] özgün değer geri yazılamadı: %s", exc)
