"""Closing a window must work exactly when the link is in trouble.

The reported failure: after a connection drop the user presses X, the window vanishes from the screen, but the backend
never closes it — the close queued behind the device lock that a link-recovery rebuild (or a hung adb call) held — and a
page reload shows the window again; reopening the app answered with the same dead session. What must hold now:

  * the user's decision is effective at once and lock-free: not listed, never reused by an open, never healed;
  * whatever is rebuilding the window is aborted; the teardown waits for the lock in the BACKGROUND and the request
    answers within a bounded time;
  * link recovery gives the lock back between windows and abandons a rebuild that never finishes;
  * a frozen leftover that cannot be woken is replaced by a fresh window instead of failing every open;
  * a teardown step that talks to the phone cannot hold the lock for ever.
"""
import asyncio
from unittest.mock import AsyncMock

import pytest

import test_window_manager_eco_workspace as _eco
from app.windows.window_manager import WindowManager

manager = _eco.manager  # the integration suite's fixtures, re-exposed (pytest finds them by module attribute)
_patch_deep_navigator = _eco._patch_deep_navigator
_patch_settings_db_profile_save = _eco._patch_settings_db_profile_save


def _kill(manager, session):
    """The link dropped: the server died with it, and (as ConnectionSupervisor does) handoff detection is held until the
    heal — the fake phone reports every app on display 0, which would otherwise read as "the app moved to the phone"."""
    _eco._kill(session)
    manager._handoff.hold("link_drop")


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    monkeypatch.setattr(WindowManager, "CLOSE_WAIT_S", 0.2)
    monkeypatch.setattr(WindowManager, "HEAL_WINDOW_TIMEOUT_S", 0.3)
    monkeypatch.setattr(WindowManager, "TEARDOWN_STEP_TIMEOUT_S", 0.3)


async def _settled():
    for _ in range(5):
        await asyncio.sleep(0)


# ---------------------------------------------------------------- the decision is effective at once


async def test_a_closed_window_is_gone_for_the_user_even_while_the_device_lock_is_held(manager):
    a = await manager.open_window("com.app.a")
    session = manager.get_session(a.window_id)
    await manager._lock.acquire()                       # someone else (a hung rebuild) holds the device lock
    try:
        await asyncio.wait_for(manager.close_window(a.window_id), 2.0)   # ...and the request still answers

        assert session.closing and not session.server.stopped            # teardown is still queued behind the lock
        assert manager.list_windows() == []                              # a page reload cannot bring it back
        assert manager.get_session_by_package("com.app.a") is None
    finally:
        manager._lock.release()

    await asyncio.wait_for(manager._closers[a.window_id], 2.0)           # the queued teardown now runs
    assert manager.get_session(a.window_id) is None and session.server.stopped
    assert manager._closers == {}


async def test_closing_with_a_free_lock_is_complete_when_the_call_returns(manager):
    a = await manager.open_window("com.app.a")
    server = manager.get_session(a.window_id).server

    await manager.close_window(a.window_id)

    assert manager.get_session(a.window_id) is None and server.stopped and manager._closers == {}


async def test_closing_twice_or_an_unknown_window_is_harmless(manager):
    a = await manager.open_window("com.app.a")
    server = manager.get_session(a.window_id).server

    await asyncio.gather(manager.close_window(a.window_id), manager.close_window(a.window_id))
    await manager.close_window(a.window_id)
    await manager.close_window("never-existed")

    assert server.stopped and _eco._FakeScrcpyServer.call_log.count(f"server.stop(display_id={server.display_id})") == 1


async def test_a_closing_workspace_member_disappears_too(manager):
    handle = await manager.open_window_in_workspace("com.app.a")
    await manager._lock.acquire()
    try:
        await manager.close_window(handle.window_id)
        assert [w for w in manager.list_windows() if w.window_id == handle.window_id] == []
    finally:
        manager._lock.release()
    await asyncio.wait_for(manager._closers[handle.window_id], 2.0)


# ---------------------------------------------------------------- reopening

async def test_reopening_the_app_never_reuses_a_window_that_is_being_closed(manager, monkeypatch):
    a = await manager.open_window("com.app.a")
    old = manager.get_session(a.window_id)
    monkeypatch.setattr(manager, "_teardown", AsyncMock())   # its teardown is stuck somewhere behind

    await manager.close_window(a.window_id)
    again = await manager.open_window("com.app.a")

    assert again.window_id != a.window_id                    # a FRESH window, not the closing one
    assert manager.get_session(a.window_id) is None and old.server.stopped   # and the leftover was finished first
    assert [w.window_id for w in manager.list_windows()] == [again.window_id]


async def test_the_reuse_check_itself_skips_a_closing_window(manager):
    a = await manager.open_window("com.app.a")
    manager.get_session(a.window_id).closing = True

    assert await manager._reuse_existing_window_if_open("com.app.a", False, True) is None


async def test_a_frozen_window_that_cannot_be_woken_is_replaced_not_reported_on_every_open(manager, monkeypatch):
    a = await manager.open_window("com.app.a")
    await manager.freeze_window(a.window_id, reason="link")
    monkeypatch.setattr(manager._reconfigure, "unfreeze", AsyncMock(side_effect=RuntimeError("telefon hazır değil")))

    fresh = await manager.open_window("com.app.a")

    assert fresh.window_id != a.window_id
    assert manager.get_session(a.window_id) is None
    assert [w.window_id for w in manager.list_windows()] == [fresh.window_id]


# ---------------------------------------------------------------- link recovery


async def test_closing_a_window_aborts_its_rebuild_and_frees_the_lock(manager, monkeypatch):
    a = await manager.open_window("com.app.a")
    session = manager.get_session(a.window_id)
    _kill(manager, session)
    started = asyncio.Event()

    async def hang(*_a, **_kw):
        started.set()
        await asyncio.sleep(3600)

    monkeypatch.setattr(manager._reconfigure, "unfreeze", hang)
    monkeypatch.setattr(WindowManager, "HEAL_WINDOW_TIMEOUT_S", 3600)   # the timeout must NOT be what ends it
    heal = asyncio.create_task(manager.heal_links())
    await asyncio.wait_for(started.wait(), 2.0)
    assert manager._lock.locked() and session.heal_task is not None

    await asyncio.wait_for(manager.close_window(a.window_id), 2.0)

    assert await asyncio.wait_for(heal, 2.0) == 0            # the heal ended: nothing of it is left to retry
    assert manager.get_session(a.window_id) is None and not manager._lock.locked()


async def test_a_rebuild_that_never_finishes_is_abandoned_and_the_lock_released(manager, monkeypatch):
    a = await manager.open_window("com.app.a")
    _kill(manager, manager.get_session(a.window_id))

    async def hang(*_a, **_kw):
        await asyncio.sleep(3600)

    monkeypatch.setattr(manager._reconfigure, "unfreeze", hang)

    assert await asyncio.wait_for(manager.heal_links(), 3.0) == 1      # still dead: the supervisor retries
    assert not manager._lock.locked() and manager.get_session(a.window_id).heal_task is None


async def test_the_lock_is_free_between_two_windows_of_one_heal(manager, monkeypatch):
    """A close queued while window A is rebuilt is served BEFORE window B's rebuild: B was closed, so it is never rebuilt."""
    manager._profile.encoder_limit = 3
    a = await manager.open_window("com.app.a")
    b = await manager.open_window("com.app.b")
    for wid in (a.window_id, b.window_id):
        _kill(manager, manager.get_session(wid))
    rebuilt = []
    a_running = asyncio.Event()
    release_a = asyncio.Event()
    real_unfreeze = manager._reconfigure.unfreeze

    async def unfreeze(window_id, **kw):
        rebuilt.append(window_id)
        if window_id == a.window_id:
            a_running.set()
            await release_a.wait()
        return await real_unfreeze(window_id, **kw)

    monkeypatch.setattr(manager._reconfigure, "unfreeze", unfreeze)
    monkeypatch.setattr(WindowManager, "CLOSE_WAIT_S", 3.0)
    heal = asyncio.create_task(manager.heal_links())
    await asyncio.wait_for(a_running.wait(), 2.0)

    closing_b = asyncio.create_task(manager.close_window(b.window_id))   # queues behind A's rebuild
    await _settled()
    assert manager.list_windows() and b.window_id not in {w.window_id for w in manager.list_windows()}
    release_a.set()

    await asyncio.wait_for(closing_b, 3.0)
    assert await asyncio.wait_for(heal, 3.0) == 0
    assert rebuilt == [a.window_id]                                      # B was never rebuilt
    assert manager.get_session(b.window_id) is None
    assert manager.get_session(a.window_id).server.is_alive


async def test_another_request_runs_between_the_windows_of_one_heal(manager, monkeypatch):
    """The lock is released after each window: an open that queued behind window A's rebuild is served BEFORE window B's."""
    manager._profile.encoder_limit = 3
    a = await manager.open_window("com.app.a")
    b = await manager.open_window("com.app.b")
    for wid in (a.window_id, b.window_id):
        _kill(manager, manager.get_session(wid))
    order = []
    a_running = asyncio.Event()
    release_a = asyncio.Event()
    real_unfreeze = manager._reconfigure.unfreeze
    real_open = manager._open_window_locked

    async def unfreeze(window_id, **kw):
        order.append(f"heal:{'a' if window_id == a.window_id else 'b'}")
        if window_id == a.window_id:
            a_running.set()
            await release_a.wait()
        return await real_unfreeze(window_id, **kw)

    async def open_locked(package, **kw):
        order.append(f"open:{package}")
        return await real_open(package, **kw)

    monkeypatch.setattr(manager._reconfigure, "unfreeze", unfreeze)
    monkeypatch.setattr(manager, "_open_window_locked", open_locked)
    heal = asyncio.create_task(manager.heal_links())
    await asyncio.wait_for(a_running.wait(), 2.0)

    opening = asyncio.create_task(manager.open_window("com.app.c"))     # queues behind A's rebuild
    await _settled()
    release_a.set()

    await asyncio.wait_for(opening, 3.0)
    assert await asyncio.wait_for(heal, 3.0) == 0
    assert order == ["heal:a", "open:com.app.c", "heal:b"]


async def test_a_dead_window_that_is_being_closed_is_never_rebuilt(manager, monkeypatch):
    a = await manager.open_window("com.app.a")
    session = manager.get_session(a.window_id)
    _kill(manager, session)
    monkeypatch.setattr(manager, "_teardown", AsyncMock())   # its teardown has not run yet
    await manager.close_window(a.window_id)
    unfreeze = AsyncMock()
    monkeypatch.setattr(manager._reconfigure, "unfreeze", unfreeze)

    assert manager._needs_heal(session) is False
    assert await manager.heal_links() == 0
    unfreeze.assert_not_awaited()


# ---------------------------------------------------------------- teardown never wedges the lock


async def test_a_server_that_will_not_stop_does_not_hold_the_lock_for_ever(manager):
    a = await manager.open_window("com.app.a")
    server = manager.get_session(a.window_id).server

    async def wedged(*, evacuate=None):
        await asyncio.sleep(3600)

    server.stop = wedged
    await manager.close_window(a.window_id)
    await asyncio.wait_for(manager._closers.get(a.window_id) or asyncio.sleep(0), 3.0)

    assert manager.get_session(a.window_id) is None and not manager._lock.locked()


async def test_a_teardown_that_raises_still_drops_the_session(manager, monkeypatch):
    a = await manager.open_window("com.app.a")
    monkeypatch.setattr(manager, "_close_window_locked", AsyncMock(side_effect=RuntimeError("adb gitti")))

    await manager.close_window(a.window_id)

    assert manager.get_session(a.window_id) is None and manager._closers == {} and manager.list_windows() == []
