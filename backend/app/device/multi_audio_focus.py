"""Telefonun "çoklu uygulama sesi" (multi audio focus): birden çok uygulamanın aynı anda çalması.

Sorun: Android bir uygulama ses odağını alınca öbürünü durdurur ya da odak isteğini reddeder. OpenDeX'in "her uygulama kendi
penceresinde, kendi sesiyle" vaadi (YouTube PC'de, YT Music telefonda) bununla çelişir. Telefonun çoklu ses odağı bunu kapatır.

Ölçülen (POCO X7 Pro · HyperOS 3.0 · Android 16, 2026-10-25): `settings global multi_audio_focus_enabled` 1 okunurken ses servisi
`Multi Audio Focus enabled :false` diyor ve o ayarı 0→1 çevirmek HİÇBİR şeyi değiştirmiyor — servis anahtarı okumuyor. Çalışan tek yol
servisin kendi `setMultiAudioFocusEnabled(boolean)` çağrısı (kabuk kullanıcısında `MODIFY_AUDIO_ROUTING` var). Okuma yöntemi yok:
durum yalnız servisin dökümündeki satırdan okunur. Bu yüzden her yazmadan sonra durum GERİ OKUNUR; çağrının sessizce dönmesi başarı
sayılmaz.

Bayrak telefonun çalışma zamanı durumudur (yeniden başlatmada sıfırlanması beklenir) ama telefonun TÜM ses davranışını değiştirir.
Bu yüzden `device/phone_awake.py` ile aynı kira deseni: yalnız kullanıcı onayladığında ve yalnız pencereler AÇIKKEN uygulanır; özgün
değer cihazda saklanır (`opendex_multi_focus_original`, arka uç çökse bile bir sonraki bağlanmada geri yüklenir); son pencere
kapanınca, cihaz ayrılınca ya da arka uç çıkınca eski hâline döner. Telefon bayrağı ZATEN açıksa (`owner="phone"`) ona dokunulmaz.

Politika (ProjectSettings.multi_audio_focus_policy): "ask" (varsayılan: yalnız kullanıcı onayladığında, o oturum için), "always"
(OpenDeX açıkken kendiliğinden), "never" (hiç uygulanmaz; yine de okunur). Hiçbir yerde yoklama döngüsü yoktur: okuma yalnız
bağlanma, "Yeniden kontrol et", bir yazma ve bir politika değişiminden sonra yapılır (telefonu ısıtma kuralı).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

MARKER_KEY = "opendex_multi_focus_original"  # özgün değerin cihazdaki yedeği: "0" / "1" (arka uç çökmesine dayanıklı)
_FLAG_RE = re.compile(r"Multi Audio Focus enabled\s*:\s*(true|false)")
_RETRY_AFTER_FAILURE_S = 30.0

# Bu hatalar "bu telefonda/yardımcıda yok" demektir (geçici değil): durum `unsupported`.
_UNSUPPORTED = frozenset({"daemon_too_old", "daemon_required", "flag_not_found", "method_missing", "permission_denied", "audio_service_missing"})

POLICIES = ("ask", "always", "never")


def parse_flag(text: str | None) -> bool | None:
    """`Multi Audio Focus enabled :true` → True / False; satır yoksa ya da değer bozuksa None (tahmin edilmez)."""
    if not text:
        return None
    m = _FLAG_RE.search(text)
    return None if m is None else m.group(1) == "true"


class MultiAudioFocusService:
    def __init__(
        self,
        adb: Any,
        serial_getter: Callable[[], str | None],
        daemon_getter: Callable[[], Any],
        live_getter: Callable[[], bool],
        policy_getter: Callable[[], Awaitable[str]],
        emit: Callable[..., Awaitable[None]],
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._adb = adb
        self._serial = serial_getter
        self._daemon = daemon_getter
        self._live = live_getter
        self._policy_of = policy_getter
        self._emit = emit
        self._clock = clock
        self._lock = asyncio.Lock()
        self._engaged = False        # False→True'yu BİZ yaptık: geri alma bizim
        self._session = False        # kullanıcı bu oturum için onayladı
        self._user_off = False       # kullanıcı açıkça kapattı: politika/onay değişene kadar kendiliğinden uygulanmaz
        self._busy = False
        self._phone_has_it = False   # bayrak telefonda zaten açık (biz açmadık): kira yeniden yazmaz, yeniden okumaz
        self._recovered_for: str | None = None
        self._last_failure_at: float | None = None
        self._task: asyncio.Task | None = None
        self._again = False
        self._refresh_wanted = False
        self._snap: dict[str, Any] = self._blank("ask")

    # ------------------------------------------------------------------ okunan model

    @staticmethod
    def _blank(policy: str) -> dict[str, Any]:
        return {"state": "unknown", "enabled": None, "owner": None, "checked_at": None, "error": None,
                "can_set": False, "policy": policy, "session": False, "busy": False}

    def snapshot(self) -> dict[str, Any]:
        return dict(self._snap)

    async def _publish(self, **changes: Any) -> dict[str, Any]:
        policy = await self._safe_policy()
        self._snap.update(changes)
        self._snap.update(policy=policy, session=self._session, busy=self._busy,
                          can_set=self._can_set())
        snap = self.snapshot()
        with contextlib.suppress(Exception):
            await self._emit("multi_audio_focus_update", **snap)
        return snap

    async def _safe_policy(self) -> str:
        try:
            policy = await self._policy_of()
        except Exception:  # noqa: BLE001 — ayar okunamazsa en güvenli varsayılan
            return "ask"
        return policy if policy in POLICIES else "ask"

    def _can_set(self) -> bool:
        daemon = self._daemon()
        return bool(daemon is not None and getattr(daemon, "supports_multi_audio_focus", False))

    # ------------------------------------------------------------------ cihaz okuma

    async def _read_raw(self, serial: str) -> tuple[bool | None, str | None]:
        """(enabled, error). Önce yardımcı (döküm içeride okunur); yoksa/eskiyse `dumpsys audio | grep` yedeği."""
        daemon = self._daemon()
        if daemon is not None and getattr(daemon, "supports_multi_audio_focus", False):
            res = await daemon.multi_audio_focus()
            if res.get("ok") and isinstance(res.get("enabled"), bool):
                return res["enabled"], None
            error = str(res.get("error") or "read_failed")
            if error == "flag_not_found":
                return None, error  # yedek de bulamaz: bu telefon satırı farklı yazıyor
        try:
            out = await self._adb.shell("dumpsys audio | grep 'Multi Audio Focus enabled'", serial=serial, timeout_s=8.0)
        except Exception as exc:  # noqa: BLE001
            return None, f"read_failed:{type(exc).__name__}"
        value = parse_flag(out)
        return (value, None) if value is not None else (None, "flag_not_found")

    async def read(self) -> dict[str, Any]:
        """Cihazdan TAZE okur ve yayınlar ("Yeniden kontrol et"). Hiçbir şeyi değiştirmez."""
        serial = self._serial()
        if not serial:
            return await self._publish(state="unknown", enabled=None, owner=None, error="no_device", checked_at=None)
        async with self._lock:
            return await self._read_locked(serial)

    async def _read_locked(self, serial: str) -> dict[str, Any]:
        enabled, error = await self._read_raw(serial)
        now = self._clock()
        if enabled is None:
            state = "unsupported" if error in _UNSUPPORTED else "unknown"
            return await self._publish(state=state, enabled=None, owner=None, error=error, checked_at=now)
        if enabled is False and self._engaged:
            # Telefon yeniden başladı ya da başka bir bileşen kapattı: bayrak çalışma zamanı durumudur. Kira artık elimizde değil;
            # onay sürüyorsa bir sonraki pencere değişiminde yeniden uygulanır.
            self._engaged = False
        owner = ("opendex" if self._engaged else "phone") if enabled else None
        self._phone_has_it = bool(enabled) and not self._engaged
        return await self._publish(state="on" if enabled else "off", enabled=enabled, owner=owner, error=None, checked_at=now)

    # ------------------------------------------------------------------ kullanıcı eylemleri

    async def enable(self) -> dict[str, Any]:
        """Kullanıcı bu oturum için onayladı: hemen uygula, doğrula. Başarısızsa `failed` + neden (başarı varsayılmaz)."""
        serial = self._serial()
        if not serial:
            return await self._publish(state="unknown", error="no_device")
        self._session = True
        self._user_off = False
        async with self._lock:
            return await self._apply_locked(serial, True)

    async def disable(self) -> dict[str, Any]:
        """Kullanıcı kapattı: onay düşer, bayrak geri alınır; politika/onay değişene kadar kendiliğinden açılmaz."""
        serial = self._serial()
        self._session = False
        self._user_off = True
        if not serial:
            return await self._publish(state="unknown", error="no_device")
        async with self._lock:
            return await self._apply_locked(serial, False)

    async def on_policy_changed(self) -> None:
        """Ayarlardan politika değişti (PUT /settings): kapatma bayrağı düşer, kira yeniden değerlendirilir."""
        self._user_off = False
        self.request_sync()

    # ------------------------------------------------------------------ kira (pencere ömrü)

    def request_sync(self, refresh: bool = False) -> None:
        """Birleştirilmiş, bloklamaz (oturum dinleyicisi senkron koddan çağırır). ``refresh``: sonunda durumu da yayınla."""
        if refresh:
            self._refresh_wanted = True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._task is not None and not self._task.done():
            self._again = True
            return
        self._task = loop.create_task(self._loop(), name="multi-audio-focus-sync")

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
        policy = await self._safe_policy()
        async with self._lock:
            if self._recovered_for != serial:
                self._recovered_for = serial
                if not self._live():
                    await self._release_locked(serial)  # önceki oturum çöktüyse özgün değer cihazda duruyordur
            want = policy != "never" and (policy == "always" or self._session) and not self._user_off and self._live()
            if want and not self._engaged and not self._phone_has_it:
                if self._last_failure_at is None or self._clock() - self._last_failure_at >= _RETRY_AFTER_FAILURE_S:
                    await self._apply_locked(serial, True)
            elif not want and self._engaged:
                await self._release_locked(serial)
            elif self._refresh_wanted:
                await self._read_locked(serial)
            self._refresh_wanted = False

    async def release(self, serial: str | None) -> None:
        """Cihaz ayrılırken / kapanışta: pencere kalmadığı için eski değer geri verilir ve onay düşer."""
        self._session = False
        self._user_off = False
        if not serial:
            return
        async with self._lock:
            await self._release_locked(serial)
            self._recovered_for = None
        await self._publish(state="unknown", enabled=None, owner=None, error="no_device", checked_at=None)

    # ------------------------------------------------------------------ cihaz yazma

    async def _marker(self, serial: str) -> str | None:
        out = (await self._adb.shell(f"settings get global {MARKER_KEY}", serial=serial, timeout_s=2.0)).strip()
        return None if out in ("", "null") else out

    async def _apply_locked(self, serial: str, want: bool) -> dict[str, Any]:
        """Kaydet → uygula → doğrula. Dönen anlık görüntü işlem BİTTİKTEN sonrakidir (busy=False)."""
        daemon = self._daemon()
        if daemon is None or not getattr(daemon, "supports_multi_audio_focus", False):
            return await self._publish(state="unsupported", error="daemon_required", checked_at=self._clock())
        self._busy = True
        await self._publish()
        try:
            await self._apply_inner(serial, want, daemon)
        finally:
            self._busy = False
        return await self._publish()

    async def _apply_inner(self, serial: str, want: bool, daemon: Any) -> dict[str, Any]:
        try:
            current, read_error = await self._read_raw(serial)
            if current is None:
                state = "unsupported" if read_error in _UNSUPPORTED else "failed"
                self._last_failure_at = self._clock()
                return await self._publish(state=state, enabled=None, owner=None, error=read_error, checked_at=self._clock())
            if want and current:
                # Telefon bayrağı zaten açık (ya da önceki çağrımız): yazılacak bir şey yok; kim açtıysa onun.
                self._phone_has_it = not self._engaged  # her pencere değişiminde yeniden okunmasın
                return await self._publish(state="on", enabled=True, owner="opendex" if self._engaged else "phone",
                                           error=None, checked_at=self._clock())
            if not want and not current:
                self._engaged = False
                self._phone_has_it = False
                await self._drop_marker(serial)
                return await self._publish(state="off", enabled=False, owner=None, error=None, checked_at=self._clock())
            if want and await self._marker(serial) is None:  # çökmüş oturumdan kalan özgün değer EZİLMEZ
                await self._adb.shell(f"settings put global {MARKER_KEY} {'1' if current else '0'}", serial=serial, timeout_s=2.0)
            res = await daemon.multi_audio_focus(want)
            applied = bool(res.get("ok")) and bool(res.get("applied"))
            if not applied:
                error = str(res.get("error") or "not_applied")
                self._last_failure_at = self._clock()
                if want:
                    await self._drop_marker(serial)  # bir şey değişmedi: yedeğe gerek yok
                return await self._publish(
                    state="unsupported" if error in _UNSUPPORTED else "failed",
                    enabled=res.get("enabled") if isinstance(res.get("enabled"), bool) else current,
                    owner=None, error=error, checked_at=self._clock())
            self._last_failure_at = None
            if want:
                self._engaged = True
                log.info("[MultiAudioFocus] uygulandı: telefon birden çok uygulamanın aynı anda çalmasına izin veriyor")
                return await self._publish(state="on", enabled=True, owner="opendex", error=None, checked_at=self._clock())
            self._engaged = False
            self._phone_has_it = False
            await self._drop_marker(serial)
            log.info("[MultiAudioFocus] kapatıldı")
            return await self._publish(state="off", enabled=False, owner=None, error=None, checked_at=self._clock())
        except Exception as exc:  # noqa: BLE001 — kullanıcı eylemi; hata gösterilir, akış bozulmaz
            log.warning("[MultiAudioFocus] uygulanamadı: %s", exc)
            self._last_failure_at = self._clock()
            return await self._publish(state="failed", error=f"{type(exc).__name__}", checked_at=self._clock())

    async def _drop_marker(self, serial: str) -> None:
        with contextlib.suppress(Exception):
            await self._adb.shell(f"settings delete global {MARKER_KEY}", serial=serial, timeout_s=2.0)

    async def _release_locked(self, serial: str) -> None:
        """Eski değere döner. Yalnız BİZ açtıysak ya da cihazda bizim bıraktığımız bir yedek varsa kapatılır."""
        self._phone_has_it = False
        engaged, self._engaged = self._engaged, False  # başarısız olsa da: yedek cihazda durur, sonraki bağlanma geri yükler
        try:
            marker = await self._marker(serial)
            if marker == "0" or (engaged and marker is None):
                daemon = self._daemon()
                if daemon is not None and getattr(daemon, "supports_multi_audio_focus", False):
                    current, _ = await self._read_raw(serial)
                    if current:
                        res = await daemon.multi_audio_focus(False)
                        if res.get("applied"):
                            log.info("[MultiAudioFocus] pencere kalmadı: çoklu uygulama sesi eski değere (kapalı) döndü")
            if marker is not None:
                await self._drop_marker(serial)
        except Exception as exc:  # noqa: BLE001 — cihaz çoktan ayrılmış olabilir; yedek cihazda durur
            log.warning("[MultiAudioFocus] özgün değer geri yazılamadı: %s", exc)
        else:
            if engaged:
                with contextlib.suppress(Exception):
                    await self._publish(state="off", enabled=False, owner=None, error=None, checked_at=self._clock())
