"""Pencere açıkken yeniden sorulan uygulama kilidi (saha: 2026-10-26 19:31, Chrome yeniden kurulunca AppLockActivity sanal ekranda)."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.windows.applock_watcher import AppLockWatcher

LOCK = dict(package="com.miui.securitycenter", activity="com.miui.applicationlock.AppLockActivity")


class _Events:
    def __init__(self):
        self.emitted: list[tuple[str, dict]] = []
        self.handlers: dict[str, list] = {}

    def on(self, type_, cb):
        self.handlers.setdefault(type_, []).append(cb)
        return lambda: self.handlers[type_].remove(cb)

    async def emit(self, type_, **payload):
        self.emitted.append((type_, payload))


def _session(wid="w1", pkg="com.android.chrome", display="218", waiter=None):
    return SimpleNamespace(state=SimpleNamespace(window_id=wid, package=pkg, display_id=display), applock_task=waiter)


def _watcher(*sessions):
    events = _Events()
    table = {s.state.window_id: s for s in sessions}
    return AppLockWatcher(events, table), events, table


async def _focus(w, display, package, activity="x.Main"):
    await w.on_task_focused(display_id=display, package=package, activity=activity, task_id=1)


@pytest.mark.asyncio
async def test_registers_on_the_pushed_focus_event_only():
    w, events, _ = _watcher(_session())
    w.start()
    assert list(events.handlers) == ["device_task_focused"]       # olay güdümlü: yoklama / zamanlayıcı yok


@pytest.mark.asyncio
async def test_a_lock_on_the_windows_display_shows_the_overlay_once():
    w, events, _ = _watcher(_session())
    await _focus(w, 218, **LOCK)
    await _focus(w, 218, **LOCK)                                   # aynı kilit için tekrar gelen olay yeni bildirim üretmez
    assert [t for t, _ in events.emitted] == ["app_lock_pending"]
    payload = events.emitted[0][1]
    assert payload["window_id"] == "w1" and payload["package"] == "com.android.chrome" and payload["dynamic"] is True


@pytest.mark.asyncio
async def test_the_app_coming_back_to_its_display_resolves_it():
    w, events, _ = _watcher(_session())
    await _focus(w, 218, **LOCK)
    await _focus(w, 218, "com.android.chrome", "com.google.android.apps.chrome.Main")
    assert [t for t, _ in events.emitted] == ["app_lock_pending", "app_lock_resolved"]
    assert events.emitted[1][1]["dynamic"] is True
    await _focus(w, 218, "com.android.chrome")                     # bitti: tekrar "açıldı" denmez
    assert len(events.emitted) == 2


@pytest.mark.asyncio
async def test_something_else_coming_up_cancels_it():
    w, events, _ = _watcher(_session())
    await _focus(w, 218, **LOCK)
    await _focus(w, 218, "com.miui.home", "com.miui.home.launcher.Launcher")
    assert [t for t, _ in events.emitted] == ["app_lock_pending", "app_lock_cancelled"]


@pytest.mark.asyncio
async def test_a_focus_without_a_prior_lock_says_nothing():
    w, events, _ = _watcher(_session())
    await _focus(w, 218, "com.android.chrome")
    await _focus(w, 0, **LOCK)                                     # fiziksel ekran: pencerelerin değil
    await _focus(w, 999, **LOCK)                                   # hiçbir pencerenin ekranı değil
    assert events.emitted == []


@pytest.mark.asyncio
async def test_the_open_time_waiter_owns_the_lock_while_it_runs():
    waiter = asyncio.get_running_loop().create_future()            # done() == False → "çalışıyor"
    w, events, _ = _watcher(_session(waiter=waiter))
    await _focus(w, 218, **LOCK)
    assert events.emitted == []
    waiter.cancel()


@pytest.mark.asyncio
async def test_two_windows_are_told_apart_by_their_display():
    w, events, _ = _watcher(_session("w1", "com.android.chrome", "218"), _session("w2", "com.whatsapp", "219"))
    await _focus(w, 219, **LOCK)
    assert events.emitted[0][1]["window_id"] == "w2" and events.emitted[0][1]["package"] == "com.whatsapp"


@pytest.mark.asyncio
async def test_a_closed_window_forgets_its_lock():
    w, events, table = _watcher(_session())
    await _focus(w, 218, **LOCK)
    table.clear()                                                  # pencere kapandı
    await _focus(w, 218, "com.android.chrome")
    assert [t for t, _ in events.emitted] == ["app_lock_pending"]  # kapanmış pencere için "açıldı" denmez
