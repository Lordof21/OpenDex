"""The user controls the session: a disconnect stays a disconnect, a pick is honoured, another phone is a clean change.

Before: "Bağlantıyı kes" closed the windows and four seconds later the bootstrap bound whatever adb still listed (the cable
was still in, the Wi-Fi link still up) — the session came straight back. On USB the "disconnect" also ran a bare
`adb disconnect`, which drops EVERY wireless link adb holds. Picking another phone's link tried to migrate this phone's
windows onto it. These tests pin what replaced that (docs/design/DEVICE_MANAGER.md, K1/K3/K4).
"""
import asyncio
import contextlib
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints import devices as ep
from app.device.device_manager import DeviceManager
from app.schemas import DeviceInfo, DeviceState, KnownDevice
from app.storage import settings_db
from app.main import AppContext
from tests.test_session_lifecycle import SERIAL, WIFI, Harness

OTHER_PHONE = "R9XY999"


@pytest.fixture
async def h(monkeypatch):
    # Async on purpose: the bootstrap task the test left running is cancelled INSIDE the test's event loop and awaited. A sync
    # fixture tore down after that loop had closed, and `task.cancel()` raised "Event loop is closed" (8 teardown errors).
    harness = Harness(monkeypatch)
    harness.ctx.adb.disconnect = AsyncMock()
    yield harness
    task = harness.ctx.bootstrap_task
    if task is not None and not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


async def _bound(h, serial=SERIAL, *listed):
    h.listed(serial, *listed)
    await h.ctx.bind_device(serial)
    h.calls.clear()
    h.events.clear()


# ------------------------------------------------------------------ a disconnect stays a disconnect

async def test_a_disconnect_is_not_undone_by_the_cable_that_is_still_plugged_in(h):
    await _bound(h)

    await h.ctx.unbind_device(pause_bootstrap_s=0)
    await asyncio.sleep(0.05)  # the bootstrap loop runs several rounds (DEVICE_POLL_INTERVAL_S = 0.01)

    ctx = h.ctx
    assert ctx.serial is None and ctx.auto_connect_paused is True
    assert "window_manager" not in h.calls  # nothing was bound again
    assert ("device_lost", {"reason": "user_disconnect"}) in h.events
    assert ctx.startup.current.device == "waiting"


async def test_api_calls_do_not_bind_a_phone_while_the_user_has_disconnected(h):
    await _bound(h)
    await h.ctx.unbind_device(pause_bootstrap_s=60)

    assert await h.ctx.ensure_device() is None
    assert h.ctx.serial is None


async def test_the_device_state_says_automatic_connecting_is_paused(h):
    await _bound(h)
    assert h.ctx.device_state()["auto_connect_paused"] is False

    await h.ctx.unbind_device(pause_bootstrap_s=60)

    state = h.ctx.device_state()
    assert state["auto_connect_paused"] is True and state["session"] is None and state["active_android_id"] is None
    assert [d["serial"] for d in state["devices"]] == [SERIAL]  # still listed: ready to be picked again


async def test_a_usb_disconnect_leaves_adb_alone(h):
    """A bare `adb disconnect` drops every wireless link adb holds — never for a USB session."""
    await _bound(h, SERIAL, WIFI)

    await h.ctx.unbind_device(pause_bootstrap_s=60)

    h.ctx.adb.disconnect.assert_not_awaited()


async def test_a_wifi_disconnect_releases_only_its_own_link(h):
    await _bound(h, WIFI)

    await h.ctx.unbind_device(pause_bootstrap_s=60)

    h.ctx.adb.disconnect.assert_awaited_once_with(WIFI)


async def test_a_disconnect_with_no_session_changes_nothing(h):
    await h.ctx.unbind_device(pause_bootstrap_s=60)

    assert h.ctx.auto_connect_paused is False
    assert h.events == []


# ------------------------------------------------------------------ the user's pick

async def test_picking_a_device_binds_it_and_ends_the_pause(h):
    await _bound(h)
    await h.ctx.unbind_device(pause_bootstrap_s=60)

    await h.ctx.connect_device(SERIAL)

    assert h.ctx.serial == SERIAL and h.ctx.auto_connect_paused is False
    assert "device_connected" in h.event_types()


async def test_a_pick_that_fails_keeps_the_pause(h):
    """The user wanted THAT phone: a failure must not hand the session to whatever else the bootstrap finds."""
    await _bound(h, SERIAL, OTHER_PHONE)
    await h.ctx.unbind_device(pause_bootstrap_s=60)
    h.fail["window_manager"] = RuntimeError("profile probe failed")

    with pytest.raises(RuntimeError):
        await h.ctx.connect_device(SERIAL)
    await asyncio.sleep(0.05)

    assert h.ctx.serial is None and h.ctx.auto_connect_paused is True


async def test_connecting_by_address_ends_the_pause(h):
    await _bound(h)
    await h.ctx.unbind_device(pause_bootstrap_s=60)
    h.ctx.pairing.connect_manual = AsyncMock(return_value=DeviceInfo(serial=WIFI, state=DeviceState.DEVICE, transport="wireless"))

    await h.ctx.connect_and_activate("192.168.1.50", 5555)

    assert h.ctx.serial == WIFI and h.ctx.auto_connect_paused is False


async def test_the_bind_endpoint_reports_a_failure_instead_of_a_500(h):
    h.listed(SERIAL)
    h.fail["window_manager"] = RuntimeError("profile probe failed")

    with pytest.raises(HTTPException) as err:
        await ep.bind_specific_device(ep.BindDeviceRequest(serial=SERIAL), h.ctx)

    assert err.value.status_code == 502 and "profile probe failed" in err.value.detail


# ------------------------------------------------------------------ another phone is a clean change of session

async def test_picking_another_phone_closes_this_ones_windows_instead_of_moving_them(h):
    await _bound(h, SERIAL, OTHER_PHONE)

    async def android_id(serial, *_a, **_k):
        h.calls.append("android_id")
        return "aid-2" if serial == OTHER_PHONE else "aid-1"

    h.ctx.device_manager.get_android_id = android_id

    await h.ctx.connect_device(OTHER_PHONE)

    ctx = h.ctx
    assert ctx.serial == OTHER_PHONE and ctx.android_id == "aid-2"
    assert "migrate" not in h.calls and "close_all" in h.calls
    assert ("device_lost", {"reason": "device_switch"}) in h.events
    assert ("device_connected", {"android_id": "aid-2", "transport": "usb"}) in h.events
    assert ctx.bootstrap_task is None or ctx.bootstrap_task.done()  # no automatic bind races the pick


async def test_another_link_of_the_same_phone_still_moves_the_windows(h):
    await _bound(h, SERIAL, WIFI)

    await h.ctx.connect_device(WIFI)

    assert h.ctx.serial == WIFI and "migrate" in h.calls and "close_all" not in h.calls


# ------------------------------------------------------------------ which phone a link belongs to

class _Adb:
    def __init__(self, ids, fail=()):
        self.ids, self.fail, self.asked = ids, set(fail), []

    async def shell(self, cmd, serial=None, **_):
        self.asked.append(serial)
        if serial in self.fail:
            raise RuntimeError("error: closed")
        return self.ids[serial] + "\n"


def _info(serial, state=DeviceState.DEVICE, tid=1):
    return DeviceInfo(serial=serial, state=state, transport="wireless" if ":" in serial else "usb", transport_id=tid)


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)


async def test_each_usable_link_is_identified_once_and_the_list_republished():
    adb = _Adb({SERIAL: "aid-1", WIFI: "aid-1"})
    manager = DeviceManager(adb)
    heard = []
    manager.on_change(lambda: heard.append([d.android_id for d in manager.current()]))
    manager.enable_identity_resolution()

    manager._observe([_info(SERIAL), _info(WIFI, tid=2), _info("UNAUTH", DeviceState.UNAUTHORIZED, 3)])
    await _settle()

    assert sorted(adb.asked) == sorted([SERIAL, WIFI])  # never an unauthorized link (it cannot answer)
    assert [d.android_id for d in manager.current()] == ["aid-1", "aid-1", None]
    assert heard[-1] == ["aid-1", "aid-1", None]

    manager._observe([_info(SERIAL), _info(WIFI, tid=2)])
    await _settle()
    assert len(adb.asked) == 2  # cached


async def test_a_reestablished_wifi_address_is_asked_again_but_a_usb_serial_is_not():
    adb = _Adb({SERIAL: "aid-1", WIFI: "aid-1"})
    manager = DeviceManager(adb)
    manager.enable_identity_resolution()
    manager._observe([_info(SERIAL, tid=1), _info(WIFI, tid=2)])
    await _settle()

    adb.ids[WIFI] = "aid-9"  # another phone took the address
    manager._observe([_info(SERIAL, tid=5), _info(WIFI, tid=6)])
    await _settle()

    assert adb.asked.count(SERIAL) == 1 and adb.asked.count(WIFI) == 2
    assert manager.android_id_of(WIFI) == "aid-9" and manager.android_id_of(SERIAL) == "aid-1"


async def test_a_failed_read_is_not_retried_on_every_list():
    adb = _Adb({SERIAL: "aid-1"}, fail={SERIAL})
    manager = DeviceManager(adb)
    manager.enable_identity_resolution()
    for _ in range(3):
        manager._observe([_info(SERIAL)])
        await _settle()

    assert adb.asked == [SERIAL] and manager.android_id_of(SERIAL) is None


async def test_nothing_is_read_unless_the_app_turned_it_on():
    adb = _Adb({SERIAL: "aid-1"})
    manager = DeviceManager(adb)
    manager._observe([_info(SERIAL)])
    await _settle()

    assert adb.asked == []
    manager.remember_identity(SERIAL, "aid-1")  # the bind read it anyway
    assert manager.current()[0].android_id == "aid-1"


async def test_binding_records_the_identity_it_read(h):
    await _bound(h)
    assert h.ctx.device_manager.android_id_of(SERIAL) == "aid-1"
    assert h.ctx.device_state()["devices"][0]["android_id"] == "aid-1"


# ------------------------------------------------------------------ saved devices: a name of the user's own

@pytest.fixture
async def db(tmp_path):
    await settings_db.init(tmp_path / "settings.db")


async def test_a_saved_device_can_be_renamed_and_reset(db):
    await settings_db.upsert_known_device(KnownDevice(android_id="abc", model="Redmi Note 13", last_seen_at=1.0))

    renamed = await ep.update_known_device("abc", ep.KnownDeviceUpdate(alias="  İş telefonu "))
    assert renamed.alias == "İş telefonu"
    assert (await settings_db.get_known_device("abc")).alias == "İş telefonu"

    reset = await ep.update_known_device("abc", ep.KnownDeviceUpdate(alias="   "))
    assert reset.alias is None


async def test_renaming_an_unknown_device_is_a_404(db):
    with pytest.raises(HTTPException) as err:
        await ep.update_known_device("missing", ep.KnownDeviceUpdate(alias="x"))
    assert err.value.status_code == 404


async def test_reconnecting_keeps_the_users_name(db, monkeypatch):
    harness = Harness(monkeypatch)
    ctx = harness.ctx
    await settings_db.upsert_known_device(KnownDevice(android_id="aid-1", model="Pixel", alias="Mutfak", last_seen_at=1.0))
    ctx.android_id = "aid-1"
    ctx.device_manager.get_device_model = AsyncMock(return_value="Pixel 8")
    await AppContext._remember_device(ctx, SERIAL)  # the class's own: Harness put a recorder on the instance

    saved = await settings_db.get_known_device("aid-1")
    assert saved.alias == "Mutfak" and saved.model == "Pixel 8"
