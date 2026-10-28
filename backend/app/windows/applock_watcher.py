"""Uygulama kilidi, pencere AÇIKKEN de — olay güdümlü, yoklamasız.

Saha hatası (2026-10-26 19:31): pencere açıkken boyut/yoğunluk değişince Chrome kendini yeniden kurdu ve Xiaomi AppLock kilidi YENİDEN
sordu (sanal ekran 218'de `AppLockActivity`). Kilit katmanını yalnızca AÇILIŞ bekleyicisi (`wait_for_app_lock_unlock`) gösteriyordu ve o,
açılıştan sonra biter: pencere ~12 sn katmansız siyah kaldı.

Burada hiçbir şey yoklanmaz: daemon'un zaten ittiği `device_task_focused` olayı (display_id + paket + etkinlik) dinlenir. Bir pencerenin
sanal ekranında kilit etkinliği odağa gelirse `app_lock_pending`, aynı ekranda uygulama geri gelirse `app_lock_resolved`, başka bir şey
(ana ekran…) gelirse `app_lock_cancelled` yayınlanır — arayüzdeki katman aynı olaylarla çalışır (`dynamic: true` = geri sayım yok,
backend süre aşımı beklemiyor). Açılış bekleyicisi / "Tekrar dene" bekleyicisi çalışıyorsa o sahiptir; bu izleyici karışmaz.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from ..device import android_shell

log = logging.getLogger(__name__)

PENDING_MESSAGE = "Uygulama Kilitli: Lütfen telefonunuzdan parmak izinizi okutun veya şifrenizi girin."
CANCELLED_MESSAGE = 'Kilit iptal edildi. Uygulamayı açmak için "Tekrar Dene"ye basın — kilit yeniden sorulacak.'


class AppLockWatcher:
    def __init__(self, events: Any, sessions: Any) -> None:
        self._events = events
        self._sessions = sessions
        self._locked: dict[str, str] = {}      # window_id -> package: the lock this watcher announced and has not seen end

    def start(self) -> Callable[[], None]:
        """Registers on the event bus; returns the unsubscribe."""
        return self._events.on("device_task_focused", self.on_task_focused)

    def _session_on(self, display: str) -> Any | None:
        for session in list(self._sessions.values()):
            state = getattr(session, "state", None)
            if state is not None and str(getattr(state, "display_id", "") or "") == display:
                return session
        return None

    async def on_task_focused(self, display_id: Any = None, package: Any = None, activity: Any = None, **_: Any) -> None:
        # a window that is gone must not keep a lock alive
        self._locked = {wid: pkg for wid, pkg in self._locked.items() if wid in self._sessions}

        display = str(display_id) if display_id is not None else ""
        if not display or display == "0":
            return
        session = self._session_on(display)
        if session is None:
            return
        wid = session.state.window_id
        pkg = session.state.package
        waiter = getattr(session, "applock_task", None)
        if waiter is not None and not waiter.done():
            self._locked.pop(wid, None)        # the open-time / "Tekrar dene" waiter owns this window's lock
            return

        if android_shell.is_app_lock(f"{package}/{activity}"):
            if wid in self._locked:
                return
            self._locked[wid] = pkg
            log.info("🔒 [KİLİT: SONRADAN] %s penceresinde (display %s) kilit yeniden soruldu — katman gösteriliyor", pkg, display)
            await self._events.emit(
                "app_lock_pending", package=pkg, window_id=wid, display_id=display, message=PENDING_MESSAGE, dynamic=True,
            )
            return

        if wid not in self._locked:
            return
        self._locked.pop(wid, None)
        if package == pkg:
            log.info("🔓 [KİLİT: SONRADAN AÇILDI] %s penceresi (display %s) kilit ekranından döndü", pkg, display)
            await self._events.emit("app_lock_resolved", package=pkg, window_id=wid, display_id=display, dynamic=True)
        else:
            log.info("🚫 [KİLİT: SONRADAN İPTAL] %s penceresinde kilit kapandı ama uygulama gelmedi (odak=%s)", pkg, package)
            await self._events.emit(
                "app_lock_cancelled", package=pkg, window_id=wid, display_id=display, message=CANCELLED_MESSAGE, dynamic=True,
            )
