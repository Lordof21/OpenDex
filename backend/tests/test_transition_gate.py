"""TransitionGate: a resize runs with the phone's transition animations held at 0 (they leak a one-frame snapshot onto the
phone's own screen), and the user's value always comes back — even after a crash (marker file on the phone)."""
from __future__ import annotations

import asyncio

import pytest

from app.windows import transition_gate as tg
from app.windows.transition_gate import TransitionGate


class _FakeAdb:
    """Plays the phone's side of the two shell commands: a settings value and the marker file."""

    def __init__(self, scale: str = "1.0", fail: bool = False) -> None:
        self.scale = scale          # "null" = the setting does not exist
        self.marker: str | None = None
        self.fail = fail
        self.commands: list[str] = []

    async def shell(self, command: str, serial: str | None = None, timeout_s: float = 20.0) -> str:
        self.commands.append(command)
        if self.fail:
            raise RuntimeError("device offline")
        if command == tg._ENGAGE:
            if self.marker is None:
                self.marker = self.scale
            self.scale = "0"
        elif command == tg._RESTORE:
            if self.marker is not None:
                self.scale = "null" if self.marker in ("null", "") else self.marker
                self.marker = None
        return ""


def _gate(adb, **kw) -> TransitionGate:
    return TransitionGate(adb, serial_getter=lambda: "SER", tail_s=kw.pop("tail_s", 0.05), **kw)


async def _settle(gate: TransitionGate) -> None:
    await asyncio.sleep(0.15)


async def test_resize_holds_animation_scale_at_zero_and_restores_after_the_tail():
    adb = _FakeAdb("1.0")
    gate = _gate(adb)
    async with gate.hold():
        assert adb.scale == "0"
    assert adb.scale == "0"            # tail: still held right after the resize
    await _settle(gate)
    assert adb.scale == "1.0"
    assert adb.marker is None


async def test_a_burst_of_resizes_engages_once_and_restores_once():
    adb = _FakeAdb("1.0")
    gate = _gate(adb, tail_s=0.2)
    for _ in range(5):
        async with gate.hold():
            await asyncio.sleep(0.01)
    assert adb.commands.count(tg._ENGAGE) == 1
    await asyncio.sleep(0.4)
    assert adb.commands.count(tg._RESTORE) >= 1 and adb.scale == "1.0"


async def test_overlapping_holds_restore_only_after_the_last_one():
    adb = _FakeAdb("1.0")
    gate = _gate(adb, tail_s=0.01)
    async with gate.hold():
        async with gate.hold():
            pass
        await asyncio.sleep(0.1)
        assert adb.scale == "0"        # the outer hold is still running
    await _settle(gate)
    assert adb.scale == "1.0"


async def test_users_own_value_comes_back_and_an_unset_value_is_deleted():
    adb = _FakeAdb("0.5")
    gate = _gate(adb)
    async with gate.hold():
        pass
    await _settle(gate)
    assert adb.scale == "0.5"

    adb2 = _FakeAdb("null")
    gate2 = _gate(adb2)
    async with gate2.hold():
        pass
    await _settle(gate2)
    assert adb2.scale == "null"        # deleted → the system default again


async def test_a_marker_left_by_a_crashed_session_is_restored_on_the_first_hold():
    adb = _FakeAdb("0")                # the crashed backend left it at 0 ...
    adb.marker = "1.0"                 # ... with the user's real value in the marker
    gate = _gate(adb)
    async with gate.hold():
        assert adb.scale == "0"
        assert adb.marker == "1.0"     # the real value is never overwritten
    await _settle(gate)
    assert adb.scale == "1.0"


async def test_restore_now_puts_the_value_back_at_once():
    adb = _FakeAdb("1.0")
    gate = _gate(adb, tail_s=30)
    async with gate.hold():
        pass
    assert adb.scale == "0"
    await gate.restore_now()
    assert adb.scale == "1.0"


async def test_a_phone_that_fails_never_breaks_the_resize():
    adb = _FakeAdb("1.0", fail=True)
    gate = _gate(adb)
    ran = False
    async with gate.hold():
        ran = True
    assert ran and not gate.engaged


async def test_disabled_gate_touches_nothing():
    adb = _FakeAdb("1.0")
    gate = _gate(adb, enabled=False)
    async with gate.hold():
        pass
    await _settle(gate)
    assert adb.commands == [] and adb.scale == "1.0"


async def test_a_failed_restore_is_retried_by_the_next_hold():
    adb = _FakeAdb("1.0")
    gate = _gate(adb)
    async with gate.hold():
        pass
    adb.fail = True
    await _settle(gate)
    assert adb.scale == "0" and adb.marker == "1.0" and gate.engaged   # still engaged, marker intact
    adb.fail = False
    async with gate.hold():
        pass
    await _settle(gate)
    assert adb.scale == "1.0" and adb.marker is None


# ───────────────────────────────────────────────────────────────────── wiring: who resizes under the gate
async def test_user_resize_runs_under_the_gate_and_the_handoff_prelanding_does_not():
    from app.windows.session_reconfigure import SessionReconfigurer

    adb = _FakeAdb("1.0")
    gate = _gate(adb, tail_s=0.01)
    seen: list[tuple[bool, bool]] = []

    reconf = object.__new__(SessionReconfigurer)
    reconf._transition_gate = gate

    async def inner(window_id, width, height, dpi, *, project=None, settle=True):
        seen.append((settle, gate._holds))
        return "handle"

    reconf._resize = inner
    assert await reconf.resize("w", 800, 600, None) == "handle"                       # the user dragged a handle
    assert await reconf.resize("w", 800, 600, 400, settle=False) == "handle"          # the handoff's pre-landing
    assert seen == [(True, 1), (False, 0)]   # held only for the user-driven resize
    await _settle(gate)
    assert adb.scale == "1.0"


async def test_resize_without_a_gate_still_works():
    from app.windows.session_reconfigure import SessionReconfigurer

    reconf = object.__new__(SessionReconfigurer)
    reconf._transition_gate = None

    async def inner(*a, **k):
        return "ok"

    reconf._resize = inner
    assert await reconf.resize("w", 1, 1, None) == "ok"
