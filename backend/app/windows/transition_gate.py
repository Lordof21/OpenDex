"""Resize sırasında telefonun fiziksel ekranına (Display 0) sızan "geçiş karesi" — tek kapı.

Saha hatası: bir sanal ekran (VD) yeniden boyutlandırılınca telefonun KENDİ ekranında, uygulamanın pencere içeriği anlık tek kare
olarak (sol üstte, VD'nin kendi piksel boyutunda, ~100 ms'de sönerek) beliriyordu.

Ölçüm (2026-10-15, POCO 2412DPC0AG, HyperOS 3 / Android 16; Display 0 `screenrecord` + kare farkı, 8 resize × 5 koşul):

    koşul                                   sızıntı
    ──────────────────────────────────────  ───────
    animasyon ölçekleri 1,0 (varsayılan)    5/8 ve 3/8 (iki koşuda)
    hepsi 0                                 0/8
    yalnız transition_animation_scale = 0   0/8  (iki ayrı koşuda)
    yalnız window_animation_scale = 0       1/8
    yalnız animator_duration_scale = 0      3/8
    yalnız resize'ın etrafında 0 (bu kapı)   0/8

Yani sızan şey, WM/Shell'in ekran-değişimi geçiş animasyonunun anlık görüntüsüdür; `transition_animation_scale` 0 iken animasyon hiç
kurulmaz. Ayarı KALICI kapatmak telefonun kendi geçişlerini de öldürürdü; bu yüzden yalnızca bir resize'ın (ve ardışık resize
yağmurunun) ETRAFINDA kapatılır, sessizlik süresi dolunca eski değerine döndürülür.

Güvenlik: asıl değer cihazdaki bir işaret dosyasında durur (`MARKER`). Backend ölürse/yeniden başlarsa bir sonraki `hold()` ya da
`recover()` onu geri yükler; ayar asla "0'da unutulmaz". Kapı yalnızca bir iyileştirmedir: herhangi bir hata resize'ı ASLA bozmaz.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging

log = logging.getLogger(__name__)

KEY = "transition_animation_scale"
MARKER = "/data/local/tmp/opendex-transition-scale"

# Kapıyı kapat: asıl değeri (yalnız işaret yoksa) işarete yaz, sonra 0 yap. İşaret zaten varsa (önceki oturum 0'da kaldı) üstüne
# YAZILMAZ — içinde hâlâ kullanıcının gerçek değeri durur.
_ENGAGE = f"f={MARKER}; [ -f $f ] || settings get global {KEY} > $f; settings put global {KEY} 0"
# Eski değeri döndür. "null" = ayar hiç yoktu → sil (varsayılan 1,0'a döner). İşaret yoksa yapılacak bir şey yok.
_RESTORE = (
    f"f={MARKER}; if [ -f $f ]; then v=$(cat $f); "
    f"if [ \"$v\" = null ] || [ -z \"$v\" ]; then settings delete global {KEY}; else settings put global {KEY} \"$v\"; fi; "
    "rm -f $f; fi"
)


class TransitionGate:
    """`async with gate.hold():` — içeride geçiş animasyonları kapalıdır; son tutucu çıkınca `tail_s` sonra geri açılır."""

    def __init__(self, adb, *, serial_getter, enabled: bool = True, tail_s: float = 1.0, allowed=None) -> None:
        self._adb = adb
        self._serial_getter = serial_getter
        self._enabled = enabled
        # Kullanıcı geçiş animasyonunu telefona bıraktıysa (device/phone_footprint.py) kapı hiç kapanmaz; geri yükleme her zaman çalışır.
        self._allowed = allowed or (lambda: True)
        self._tail_s = max(0.0, float(tail_s))
        self._holds = 0
        self._engaged = False
        self._restore_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()   # kapat/aç komutları sıralı: yarış, ayarı yanlış değerde bırakırdı
        self._recovered_for: str | None = None

    @property
    def engaged(self) -> bool:
        return self._engaged

    def hold(self) -> "_Hold":
        return _Hold(self)

    async def _shell(self, command: str) -> None:
        serial = self._serial_getter()
        await self._adb.shell(command, serial=serial, timeout_s=4.0)

    async def _engage(self) -> None:
        self._cancel_restore()
        async with self._lock:
            if self._engaged:
                return
            try:
                await self._shell(_ENGAGE)
                self._engaged = True
            except Exception as exc:  # noqa: BLE001 — iyileştirme; resize'ı bozmasın
                log.debug("[TransitionGate] kapatılamadı: %s", exc)

    def _cancel_restore(self) -> None:
        task = self._restore_task
        self._restore_task = None
        if task is not None and not task.done():
            task.cancel()

    def _schedule_restore(self) -> None:
        self._cancel_restore()
        self._restore_task = asyncio.create_task(self._restore_after_tail(), name="transition-gate-restore")

    async def _restore_after_tail(self) -> None:
        try:
            await asyncio.sleep(self._tail_s)
        except asyncio.CancelledError:
            return
        if self._holds == 0:
            await self.restore_now()

    async def restore_now(self) -> None:
        """Ayarı hemen eski değerine döndürür (idempotent). Kapanışta ve kurtarmada da kullanılır."""
        self._cancel_restore()
        async with self._lock:
            if not self._engaged:
                return
            try:
                await self._shell(_RESTORE)
                self._engaged = False
            except Exception as exc:  # noqa: BLE001
                # Dönemedi: işaret dosyası cihazda duruyor; bir sonraki hold()/recover() yeniden dener.
                log.warning("[TransitionGate] eski değer geri yüklenemedi (işaret cihazda duruyor): %s", exc)

    async def recover(self) -> None:
        """Önceki bir oturumdan işaret kaldıysa (backend 0'dayken öldü) ayarı geri yükler. Cihaz başına bir kez."""
        serial = self._serial_getter()
        if not self._enabled or not serial or self._recovered_for == serial:
            return
        self._recovered_for = serial
        async with self._lock:
            if self._engaged:
                return
            try:
                await self._shell(_RESTORE)   # işaret yoksa hiçbir şey yapmaz
            except Exception as exc:  # noqa: BLE001
                log.debug("[TransitionGate] kurtarma atlandı: %s", exc)
                self._recovered_for = None


class _Hold:
    def __init__(self, gate: TransitionGate) -> None:
        self._gate = gate
        self._counted = False

    async def __aenter__(self) -> "_Hold":
        gate = self._gate
        if not gate._enabled or not gate._allowed():
            return self
        gate._holds += 1
        self._counted = True
        try:
            await gate.recover()
            await gate._engage()
        except BaseException:   # iptal / hata: __aexit__ çağrılmaz, sayaç sızmasın
            gate._holds = max(0, gate._holds - 1)
            raise
        return self

    async def __aexit__(self, *_exc) -> None:
        gate = self._gate
        if not self._counted:
            return
        gate._holds = max(0, gate._holds - 1)
        if gate._holds == 0 and gate._engaged:
            gate._schedule_restore()


@contextlib.asynccontextmanager
async def no_gate():
    """Kapı verilmeyen yerler (testler) için boş bağlam."""
    yield
