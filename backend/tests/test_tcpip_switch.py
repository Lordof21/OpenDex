"""USB -> Wi-Fi with `adb tcpip` (hata raporu: IP okuma yarışı + erken "kabloyu çıkarabilirsiniz" + pencerelerin kaybı).

adbd restarts on `adb tcpip`: every shell answers "error: closed" for ~1 s and every USB-started scrcpy server dies
(taking the apps on its virtual display with it). The switch therefore reads the IP first, parks the windows on the
phone before the restart, reports success only for a VERIFIED wireless device, and rebuilds the windows.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.config import Settings
from app.device import deep_navigator
from app.device.adb import AdbError
from app.device.device_manager import DeviceManager
from app.events import EventBus
from app.main import AppContext, TransportSwitchError
from app.schemas import DeviceInfo, DeviceState, WindowState
from app.windows import window_manager as wm_module
from app.windows.window_manager import WindowManager, WindowSession

WIFI = "192.168.1.34:5555"


# ---------------------------------------------------------------- IP reading
@pytest.mark.asyncio
async def test_wifi_ips_retry_error_closed_and_skip_mobile_data():
    adb = MagicMock()
    adb.shell = AsyncMock(side_effect=[
        AdbError(["shell"], 1, "error: closed"),  # adbd restarting
        "    inet 10.54.3.2/30 scope global rmnet_data0\n"
        "    inet 192.168.43.1/24 brd 192.168.43.255 scope global swlan0\n"
        "    inet 192.168.1.34/24 brd 192.168.1.255 scope global wlan0\n",
    ])
    ips = await DeviceManager(adb).get_device_wifi_ips("USB", attempts=3, retry_delay_s=0)
    assert ips == ["192.168.43.1", "192.168.1.34"]  # hotspot + Wi-Fi, never the rmnet address


# ---------------------------------------------------------------- the orchestration
def _ctx(*, tcp_port="-1", verified=True, other_phone=False):
    ctx = AppContext.__new__(AppContext)
    # __init__ is skipped: the device-state publisher it wires up (serial / transport_switching changes → devices_changed)
    # is not what these tests are about.
    ctx._serial, ctx._transport_switching = None, False
    ctx._schedule_device_state = lambda: None
    ctx.serial, ctx.android_id, ctx.transport_switching = "USB", "AID", False
    order: list[str] = []
    ctx.order = order

    async def shell(cmd, serial=None, timeout_s=0):
        return tcp_port if "tcp.port" in cmd else ""

    ctx.adb = MagicMock()
    ctx.adb.shell = AsyncMock(side_effect=shell)
    ctx.adb.tcpip = AsyncMock(side_effect=lambda *a, **k: order.append("tcpip"))
    ctx.adb.connect = AsyncMock(side_effect=lambda *a, **k: order.append("connect"))
    ctx.adb.disconnect = AsyncMock()

    async def ips(serial, **_):
        order.append("ips")
        return ["192.168.1.34"]

    async def devices():
        listed = [DeviceInfo(serial="USB", state=DeviceState.DEVICE)]
        if verified and "connect" in order:
            listed.append(DeviceInfo(serial=WIFI, state=DeviceState.DEVICE, transport="wireless"))
        return listed

    ctx.device_manager = MagicMock()
    ctx.device_manager.get_device_wifi_ips = AsyncMock(side_effect=ips)
    ctx.device_manager.list_devices = AsyncMock(side_effect=devices)
    ctx.device_manager.get_android_id = AsyncMock(return_value="OTHER" if other_phone else "AID")
    ctx.window_manager = MagicMock()
    ctx.window_manager.quiesce_for_transport_switch = AsyncMock(side_effect=lambda: order.append("quiesce"))
    ctx.window_manager.rebuild_after_transport_switch = AsyncMock()
    ctx.supervisor = MagicMock()
    ctx.supervisor.stop = AsyncMock(side_effect=lambda: order.append("supervisor_stop"))
    ctx.supervisor.start = AsyncMock()

    async def switch(serial):
        order.append("switch")
        ctx.serial = serial

    ctx.switch_transport = AsyncMock(side_effect=switch)
    return ctx


@pytest.fixture(autouse=True)
def _no_gateway(monkeypatch):
    from app.device import network_utils

    monkeypatch.setattr(network_utils, "get_windows_gateway_ip", AsyncMock(return_value=None))
    monkeypatch.setattr("app.main.asyncio.sleep", AsyncMock())


@pytest.mark.asyncio
async def test_reads_ip_and_parks_windows_BEFORE_adbd_restarts_then_moves_only_when_verified():
    ctx = _ctx()
    assert await ctx.switch_to_tcpip(5555) == WIFI
    assert ctx.order == ["ips", "supervisor_stop", "quiesce", "tcpip", "connect", "switch"]
    ctx.switch_transport.assert_awaited_once_with(WIFI)
    assert ctx.transport_switching is False


@pytest.mark.asyncio
async def test_unverified_wireless_link_is_an_error_and_the_windows_come_back_on_usb():
    ctx = _ctx(verified=False)
    with pytest.raises(TransportSwitchError, match="ÇIKARMAYIN"):
        await ctx.switch_to_tcpip(5555)
    ctx.switch_transport.assert_not_awaited()
    ctx.window_manager.rebuild_after_transport_switch.assert_awaited_once()
    ctx.supervisor.start.assert_awaited_once_with("USB", "AID")
    assert ctx.serial == "USB"


@pytest.mark.asyncio
async def test_a_different_phone_on_the_candidate_ip_is_never_adopted():
    ctx = _ctx(other_phone=True)
    with pytest.raises(TransportSwitchError):
        await ctx.switch_to_tcpip(5555)
    ctx.adb.disconnect.assert_awaited()


@pytest.mark.asyncio
async def test_adbd_already_listening_switches_live_without_restart():
    ctx = _ctx(tcp_port="5555")
    assert await ctx.switch_to_tcpip(5555) == WIFI
    ctx.adb.tcpip.assert_not_awaited()
    ctx.window_manager.quiesce_for_transport_switch.assert_not_awaited()


# ---------------------------------------------------------------- windows across the adbd restart
@pytest.mark.asyncio
async def test_windows_are_parked_on_the_phone_and_rebuilt_on_the_new_transport(monkeypatch):
    wm = WindowManager(MagicMock(), Settings(), EventBus(), MagicMock(), MagicMock(), MagicMock(), MagicMock())
    wm._session_audio.migrate_transport = AsyncMock()
    wm._serial = "USB"
    state = WindowState(window_id="w", package="com.a", width=1280, height=720, display_id="7")
    old_server = MagicMock(is_alive=True, display_id="7")
    wm._sessions["w"] = WindowSession(state=state, server=old_server)

    moves = []

    async def fake_move(_adb, task, disp, *, serial, daemon=None, timeout_s=2.0):
        moves.append((task, disp, serial))

    async def fake_find(_adb, _pkg, display_id=None, serial=None):
        return "42"

    async def fake_freeze(wid, reason="minimized"):
        wm._sessions[wid].state.frozen = True

    new_server = MagicMock(wait_for_display_id=AsyncMock(return_value="9"))

    async def fake_unfreeze(wid):
        wm._sessions[wid].server, wm._sessions[wid].state.frozen = new_server, False

    monkeypatch.setattr(wm_module, "move_task_to_display", fake_move)
    monkeypatch.setattr(deep_navigator, "find_task_id_for_package", fake_find)
    monkeypatch.setattr(wm_module.android_shell, "bring_to_front", AsyncMock())
    wm._reconfigure.freeze, wm._reconfigure.unfreeze = fake_freeze, fake_unfreeze
    wm._reconfigure.migrate_session_transport = AsyncMock()

    assert await wm.quiesce_for_transport_switch() == 1
    assert moves == [("42", "0", "USB")] and state.frozen and wm._handoff.paused

    wm._serial = WIFI
    await wm.migrate_transport("USB", WIFI)
    assert moves[-1] == ("42", "9", WIFI)  # the app back on its new virtual display, over Wi-Fi
    assert not state.frozen and not wm._handoff.paused
    wm._reconfigure.migrate_session_transport.assert_not_awaited()  # rebuilt, not "live-migrated" from a dead server
