"""Uygulama kilidi durum makinesi.

Saha raporu: (a) kilidi jestle İPTAL edince sistem "kilit açıldı" sanıyordu, (b) "Tekrar dene" kilidi
yeniden sormuyordu, (c) kilit açılmadan pencere kapanınca yanlış "kilit açıldı" bildirimi geliyordu.
"""
from __future__ import annotations

import asyncio
import logging
from types import SimpleNamespace

import pytest

from app.windows import window_manager as wm_module
from app.windows.window_lifecycle_coordinator import (
    applock_alive_probe,
    classify_focus,
    wait_for_app_lock_unlock,
)
from app.windows.window_manager import WindowManager

PKG = "com.android.vending"

LOCK_FOCUS = "mCurrentFocus=Window{1a2b u0 com.miui.securitycenter/com.miui.applicationlock.AppLockActivity}"
APP_FOCUS = f"mCurrentFocus=Window{{3c4d u0 {PKG}/com.google.android.finsky.activities.MainActivity}}"
HOME_FOCUS = "mCurrentFocus=Window{5e6f u0 com.miui.home/com.miui.home.launcher.Launcher}"


# ---------------------------------------------------------------- saf sınıflandırma
def test_classify_focus():
    assert classify_focus(LOCK_FOCUS, PKG) == "locked"
    assert classify_focus("...ConfirmDeviceCredentialActivity...", PKG) == "locked"
    assert classify_focus(APP_FOCUS, PKG) == "unlocked"
    assert classify_focus(HOME_FOCUS, PKG) == "other"      # ESKİ HATA: burası "açıldı" sayılıyordu


# ---------------------------------------------------------------- sahte altyapı
class _Adb:
    def __init__(self, focus_script):
        self._focus = list(focus_script)
        self.calls: list[str] = []

    async def shell(self, cmd, *, serial=None, timeout_s=3.0):
        self.calls.append(cmd)
        if "mCurrentFocus" in cmd:
            # betik bitince son değeri tekrarla
            return self._focus.pop(0) if len(self._focus) > 1 else self._focus[0]
        return ""


class _Events:
    def __init__(self):
        self.emitted: list[tuple[str, dict]] = []

    async def emit(self, type_, **payload):
        self.emitted.append((type_, payload))

    async def wait_for(self, type_, predicate=None, timeout=None):
        await asyncio.sleep(0)
        raise asyncio.TimeoutError

    def kinds(self):
        return [k for k, _ in self.emitted]


def _wlog():
    return logging.LoggerAdapter(logging.getLogger("test.applock"), {"window_id": "w1"})


@pytest.fixture(autouse=True)
def _no_real_task_lookup(monkeypatch):
    """Kilit açılınca görev arama/taşıma gerçek adb istemesin."""
    from app.device import deep_navigator

    async def _find(_adb, pkg, display_id=None, serial=None):
        return None

    monkeypatch.setattr(deep_navigator, "find_task_id_for_package", _find)


async def _run(adb, events, **kw):
    return await wait_for_app_lock_unlock(
        adb=adb, events=events, serial="S", sockets=None, wlog=_wlog(),
        pkg_name=PKG, win_id="w1", disp_id="7", p1_dpi=420, **kw,
    )


# ---------------------------------------------------------------- durum makinesi
@pytest.mark.asyncio
async def test_real_unlock_resolves_once():
    adb, ev = _Adb([LOCK_FOCUS, LOCK_FOCUS, APP_FOCUS]), _Events()
    assert await _run(adb, ev, timeout_s=5.0) is True
    assert ev.kinds() == ["app_lock_pending", "app_lock_resolved"]


@pytest.mark.asyncio
async def test_gesture_cancel_is_NOT_reported_as_unlocked():
    """REGRESYON (asıl hata): kilit ekranı kaybolup odak ana ekrana gidince 'açıldı' DENMEZ."""
    adb, ev = _Adb([LOCK_FOCUS, HOME_FOCUS]), _Events()
    assert await _run(adb, ev, timeout_s=5.0) is False
    kinds = ev.kinds()
    assert "app_lock_resolved" not in kinds
    assert kinds == ["app_lock_pending", "app_lock_cancelled"]
    msg = dict(ev.emitted)["app_lock_cancelled"]["message"]
    assert "Tekrar Dene" in msg


@pytest.mark.asyncio
async def test_window_closed_mid_wait_emits_no_notification():
    """REGRESYON: kilit açılmadan pencere kapanınca hiçbir 'kilit açıldı/iptal/zaman aşımı' bildirimi yok."""
    adb, ev = _Adb([LOCK_FOCUS, HOME_FOCUS]), _Events()
    ticks = {"n": 0}

    def alive():
        ticks["n"] += 1
        return ticks["n"] < 3          # birkaç yoklamadan sonra pencere kapandı

    assert await _run(adb, ev, timeout_s=5.0, is_alive=alive) is False
    kinds = ev.kinds()
    assert kinds == ["app_lock_pending"], kinds
    assert not {"app_lock_resolved", "app_lock_cancelled", "app_lock_timeout"} & set(kinds)


@pytest.mark.asyncio
async def test_still_locked_until_deadline_times_out():
    adb, ev = _Adb([LOCK_FOCUS]), _Events()
    assert await _run(adb, ev, timeout_s=0.05) is False
    assert ev.kinds()[-1] == "app_lock_timeout"


@pytest.mark.asyncio
async def test_empty_focus_reading_never_counts_as_cancel():
    """adb boş dönerse (okuma hatası) karar verilmez — sahte 'iptal' üretilmez."""
    adb, ev = _Adb(["", "", "", "", "  "]), _Events()
    assert await _run(adb, ev, timeout_s=0.05) is False
    assert ev.kinds()[-1] == "app_lock_timeout"


@pytest.mark.asyncio
async def test_retry_is_a_fresh_launch_that_forces_the_lock_prompt_again():
    """'Tekrar dene': önce zorla durdur (taze başlatma), sonra başlat — kilit yeniden sorulur."""
    adb, ev = _Adb([LOCK_FOCUS, APP_FOCUS]), _Events()
    assert await _run(adb, ev, timeout_s=5.0, fresh=True) is True
    stop_i = next(i for i, c in enumerate(adb.calls) if c == f"am force-stop {PKG}")
    launch_i = next(i for i, c in enumerate(adb.calls) if c.startswith(f"monkey -p {PKG}"))
    assert stop_i < launch_i


# ---------------------------------------------------------------- görev takibi
def test_alive_probe_goes_false_when_window_closes_or_a_retry_supersedes():
    s = SimpleNamespace(applock_gen=0)
    sessions = {"w1": s}
    probe = applock_alive_probe(sessions, "w1")
    assert probe() is True
    s.applock_gen += 1                     # yeni "Tekrar dene" başladı → eski bekleyici sessizce çıkar
    assert probe() is False
    probe2 = applock_alive_probe(sessions, "w1")
    assert probe2() is True
    sessions.pop("w1")                     # pencere kapandı
    assert probe2() is False


@pytest.mark.asyncio
async def test_closing_a_window_cancels_its_background_applock_tasks():
    async def _forever():
        await asyncio.sleep(3600)

    t1, t2 = asyncio.create_task(_forever()), asyncio.create_task(_forever())
    session = SimpleNamespace(applock_task=t1, lifecycle_task=t2)
    WindowManager._cancel_lifecycle_tasks(session)
    await asyncio.sleep(0)
    assert t1.cancelled() or t1.cancelling()
    assert t2.cancelled() or t2.cancelling()
    assert session.applock_task is None and session.lifecycle_task is None


@pytest.mark.asyncio
async def test_retry_app_lock_starts_a_fresh_waiter_and_supersedes_the_old_one(monkeypatch):
    captured: dict = {}

    async def _stub(**kw):
        captured.update(kw)

    monkeypatch.setattr(wm_module, "wait_for_app_lock_unlock", _stub)

    mgr = WindowManager.__new__(WindowManager)
    session = SimpleNamespace(
        state=SimpleNamespace(display_id="7", package=PKG),
        server=SimpleNamespace(sockets=None), dpi=420,
        applock_gen=0, applock_task=None, lifecycle_task=None,
    )
    mgr._sessions = {"w1": session}
    mgr._serial = "S"
    mgr._adb = object()
    mgr._events = object()
    mgr._daemon_client = None

    old_probe = applock_alive_probe(mgr._sessions, "w1")
    assert await mgr.retry_app_lock("w1") is True
    await asyncio.sleep(0)

    assert captured["fresh"] is True
    assert callable(captured["is_alive"]) and captured["is_alive"]() is True
    assert old_probe() is False                       # eski bekleyici artık geçersiz


@pytest.mark.asyncio
async def test_retry_app_lock_without_a_virtual_display_reports_failure():
    mgr = WindowManager.__new__(WindowManager)
    mgr._sessions = {"w1": SimpleNamespace(state=SimpleNamespace(display_id="0", package=PKG))}
    mgr._serial = "S"
    assert await mgr.retry_app_lock("w1") is False


# ---------------------------------------------------------------- Stealth DPI 2. faz × araya giren resize
@pytest.mark.parametrize("resized_dpi, applied", [(None, [("7", 240)]), (300, [])])
@pytest.mark.asyncio
async def test_stealth_phase2_never_overwrites_a_density_a_resize_already_set(monkeypatch, resized_dpi, applied):
    from app.windows import window_lifecycle_coordinator as coord

    calls = []

    async def fake_density(_adb, _serial, disp_id, dpi, daemon=None):
        calls.append((disp_id, dpi))

    async def no_sleep(_s):
        return None

    monkeypatch.setattr(coord.android_shell, "set_display_density", fake_density)
    monkeypatch.setattr(coord.asyncio, "sleep", no_sleep)

    async def display_id():
        return "7"

    server = SimpleNamespace(wait_for_display_id=display_id)
    session = SimpleNamespace(server=server, dpi=resized_dpi or 240, state=SimpleNamespace(display_id="", stealth_phase=True))
    await coord.coordinate_window_lifecycle(
        adb=_Adb([APP_FOCUS]), events=_Events(), sessions={"w": session}, serial="S", sockets=None,
        wlog=logging.getLogger("t"), pkg_name=PKG, target_server=server, win_id="w",
        p1_dpi=480, p2_dpi=240, stealth_active=True, auto_start=False, lock=asyncio.Lock(),
    )
    assert calls == applied
    assert session.dpi == (resized_dpi or 240) and session.state.stealth_phase is False
