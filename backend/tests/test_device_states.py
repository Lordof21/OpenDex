"""GET /api/device/states: the daemon reads the toggles; when it cannot, adb answers with ONE command (not one `settings get`
per key — each is an `app_process` start on the phone), remembered for a few seconds, and the daemon's own reason is logged."""
from __future__ import annotations

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.api.v1.endpoints import devices
from app.main import create_app

GLOBAL_SETTINGS = "airplane_mode_on=0\nbluetooth_on=1\nmobile_data=1\nmode_ringer=2\nwifi_on=1\n"
SECURITY_ERROR = "SecurityException: Given calling package android does not match caller's uid 2000"


@pytest.fixture(autouse=True)
def _fresh_caches():
    devices._states_fallback.clear()
    devices._states_errors_logged.clear()
    yield
    devices._states_fallback.clear()
    devices._states_errors_logged.clear()


def _client(*, daemon_reply, shell_out=GLOBAL_SETTINGS):
    client = TestClient(create_app())
    ctx = client.app.state.ctx
    ctx.serial = "SER"
    ctx.daemon_client = SimpleNamespace(is_connected=daemon_reply is not None, get_hardware_states=AsyncMock(return_value=daemon_reply))
    ctx.adb = SimpleNamespace(shell=AsyncMock(return_value=shell_out))
    ctx.display_power = SimpleNamespace(state=AsyncMock(return_value={"on": True}))
    return client, ctx


def test_a_daemon_that_answers_is_the_only_source():
    daemon = {"ok": True, "type": "states_update", "states": {"wifi": True, "bluetooth": False}}
    client, ctx = _client(daemon_reply=daemon)
    body = client.get("/api/device/states").json()
    assert body["states"] == {"wifi": True, "bluetooth": False, "screen_on": True}
    ctx.adb.shell.assert_not_awaited()                                   # nothing is run on the phone


def test_when_the_daemon_cannot_answer_adb_reads_every_key_with_one_command():
    client, ctx = _client(daemon_reply={"type": "states_update", "ok": False, "error": SECURITY_ERROR})
    body = client.get("/api/device/states").json()
    assert body["ok"] is True
    assert body["states"] == {
        "wifi": True, "bluetooth": True, "mobile_data": True, "mute": False, "airplane_mode": False,
        "rotation_lock": False, "torch": False, "screen_on": True,
    }
    assert body["wifi"] is True                                          # the flat copy older clients read
    assert ctx.adb.shell.await_count == 1                                # was four `settings get` per read
    assert ctx.adb.shell.await_args.args[0] == devices._STATES_SCRIPT


def test_the_fallback_reads_what_each_key_really_says():
    client, _ = _client(daemon_reply=None, shell_out="wifi_on=0\nmode_ringer=0\nairplane_mode_on=1\n")   # bluetooth/mobile_data absent
    states = client.get("/api/device/states").json()["states"]
    assert (states["wifi"], states["bluetooth"], states["mobile_data"], states["mute"], states["airplane_mode"]) == (
        False, False, False, True, True)


def test_a_second_read_within_a_few_seconds_costs_the_phone_nothing_and_a_toggle_forgets_it(monkeypatch):
    client, ctx = _client(daemon_reply=None)
    client.get("/api/device/states")
    client.get("/api/device/states")
    assert ctx.adb.shell.await_count == 1                                # the second read came from the cache

    async def set_state(*_a, **_k):
        return True

    monkeypatch.setattr(devices.android_shell, "set_hardware_state", set_state)
    assert client.post("/api/device/states", json={"key": "wifi", "value": False}).json()["ok"] is True
    ctx.adb.shell.return_value = GLOBAL_SETTINGS.replace("wifi_on=1", "wifi_on=0")
    assert client.get("/api/device/states").json()["states"]["wifi"] is False        # fresh, not the 3-second-old copy
    assert ctx.adb.shell.await_count == 2


def test_the_cache_expires(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(devices.time, "monotonic", lambda: now[0])
    client, ctx = _client(daemon_reply=None)
    client.get("/api/device/states")
    now[0] += devices._STATES_FALLBACK_TTL_S + 0.1
    client.get("/api/device/states")
    assert ctx.adb.shell.await_count == 2


def test_the_daemons_own_reason_is_logged_once_not_thrown_away_and_not_every_poll(caplog):
    client, _ = _client(daemon_reply={"type": "states_update", "ok": False, "error": SECURITY_ERROR})
    with caplog.at_level(logging.WARNING, logger=devices.__name__):
        for _ in range(5):
            client.get("/api/device/states")
    lines = [r.getMessage() for r in caplog.records if "states_get" in r.getMessage()]
    assert len(lines) == 1
    assert "Given calling package android does not match caller's uid 2000" in lines[0]


def test_an_unreadable_phone_is_a_failure_not_a_made_up_answer():
    client, ctx = _client(daemon_reply=None)
    ctx.adb.shell.side_effect = RuntimeError("device offline")
    body = client.get("/api/device/states").json()
    assert body["ok"] is False and "offline" in body["error"]
