import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import Settings
from app.events import EventBus
from app.schemas.windows import WindowState
from app.windows.handoff_manager import HandoffManager


@pytest.fixture
def settings():
    return Settings()


@pytest.fixture
def events():
    return EventBus()


@pytest.fixture
def mock_adb():
    adb = MagicMock()
    adb.shell = AsyncMock(return_value="")
    return adb


@pytest.mark.asyncio
async def test_on_device_task_focused_hands_the_app_to_the_phone(mock_adb, events, settings):
    """When a window is open in DeX and the app is requested on Display 0, the task is moved to the phone. The window's
    virtual display is NOT pulled to the phone's density first (the old reverse stealth): the move carries the whole
    density change in one step."""
    session = MagicMock()
    session.state = WindowState(window_id="win-1", package="com.android.chrome", width=1280, height=720)
    session.state.handoff_to_phone = False
    session.state.minimized = False
    session.dpi = 180
    session.server = MagicMock()
    session.server.display_id = "10"

    sessions = {"win-1": session}
    unfreeze = AsyncMock()

    handoff = HandoffManager(
        mock_adb,
        settings,
        events,
        sessions,
        serial_getter=lambda: "serial123",
        unfreeze_locked=unfreeze,
    )

    mock_adb.shell.side_effect = lambda cmd, **kwargs: (
        "Physical density: 520" if "wm density" in cmd and "-d" not in cmd else ""
    )

    event_received = []
    events.on("app_handoff_to_phone", lambda **data: event_received.append(data))

    with patch("app.device.deep_navigator.find_task_id_for_package", AsyncMock(return_value="999")):
        await handoff._on_device_task_focused(display_id=0, package="com.android.chrome", task_id="999")
        # Allow the background (lock-guarded) _execute_to_phone to proceed
        await asyncio.sleep(0.4)

    assert session.state.handoff_to_phone is True
    assert len(event_received) == 1
    assert event_received[0]["package"] == "com.android.chrome"
    assert event_received[0]["display_id"] == "0"

    calls = [call[0][0] for call in mock_adb.shell.call_args_list]
    # The window's display keeps the window's density
    assert not any(c.startswith("wm density") and "-d 10" in c for c in calls)
    # Task 999 moved to display 0
    assert any("am display move-stack 999 0" in c for c in calls)
    # Normalized on Display 0 in fullscreen launcher mode
    assert any("am start --display 0" in c and "com.android.chrome" in c for c in calls)


@pytest.mark.asyncio
async def test_pc_handoff_to_phone(mock_adb, events, settings):
    """User clicking 'Telefona Aktar' on PC moves the task; the window's display density is left alone."""
    session = MagicMock()
    session.state = WindowState(window_id="win-2", package="com.whatsapp", width=1280, height=720)
    session.state.handoff_to_phone = False
    session.state.minimized = False
    session.dpi = 180
    session.server = MagicMock()
    session.server.display_id = "11"

    sessions = {"win-2": session}
    unfreeze = AsyncMock()

    handoff = HandoffManager(
        mock_adb,
        settings,
        events,
        sessions,
        serial_getter=lambda: "serial123",
        unfreeze_locked=unfreeze,
    )

    mock_adb.shell.side_effect = lambda cmd, **kwargs: (
        "Physical density: 520" if "wm density" in cmd and "-d" not in cmd else ""
    )

    with patch("app.device.deep_navigator.find_task_id_for_package", AsyncMock(return_value="888")):
        ok = await handoff.handoff_to_phone("win-2")

    assert ok is True
    assert session.state.handoff_to_phone is True

    calls = [call[0][0] for call in mock_adb.shell.call_args_list]
    assert not any(c.startswith("wm density") and "-d 11" in c for c in calls)
    assert any("am display move-stack 888 0" in c for c in calls)


def _watched(package="com.android.chrome", display_id="10", workspace_id=None, handoff_to_phone=False):
    session = MagicMock()
    session.state = WindowState(window_id="win-1", package=package, width=1280, height=720)
    session.state.handoff_to_phone = handoff_to_phone
    session.state.workspace_id = workspace_id
    session.server = MagicMock()
    session.server.display_id = display_id
    return session


async def _one_watchdog_pass(handoff, mock_adb, dumpsys):
    """run_monitor_loop: one real iteration, then the loop's next sleep cancels it."""
    mock_adb.shell = AsyncMock(return_value=dumpsys)
    sleeps = iter([None])

    async def fake_sleep(_s):
        if next(sleeps, "stop") == "stop":
            raise asyncio.CancelledError

    with patch.object(HandoffManager, "_execute_to_phone", AsyncMock()) as to_phone:
        with patch("app.windows.handoff_manager.asyncio.sleep", fake_sleep):
            await handoff.run_monitor_loop()
        await asyncio.sleep(0)  # let the spawned (lock-guarded) to-phone task run while still patched
    return to_phone


@pytest.mark.asyncio
async def test_watchdog_hands_off_an_app_that_showed_up_on_the_phone(mock_adb, events, settings):
    session = _watched()
    handoff = HandoffManager(mock_adb, settings, events, {"win-1": session}, serial_getter=lambda: "S", unfreeze_locked=AsyncMock())
    emitted = []
    events.on("app_handoff_to_phone", lambda **d: emitted.append(d))

    stealth = await _one_watchdog_pass(
        handoff, mock_adb, "Display: mDisplayId=0\n  mCurrentFocus=Window{1 u0 com.android.chrome/.Main}\nDisplay: mDisplayId=10\n",
    )

    assert session.state.handoff_to_phone is True
    assert [d["package"] for d in emitted] == ["com.android.chrome"]
    args, kwargs = stealth.await_args
    assert args[1:4] == ("com.android.chrome", "10", "S") and kwargs["source"] == "watchdog"


@pytest.mark.asyncio
async def test_watchdog_resolves_a_handoff_when_the_app_is_back_on_its_display(mock_adb, events, settings):
    session = _watched(handoff_to_phone=True)
    handoff = HandoffManager(mock_adb, settings, events, {"win-1": session}, serial_getter=lambda: "S", unfreeze_locked=AsyncMock())
    resolved = []
    events.on("app_handoff_resolved", lambda **d: resolved.append(d))

    stealth = await _one_watchdog_pass(
        handoff, mock_adb, "Display: mDisplayId=10\n  mFocusedApp=ActivityRecord{2 u0 com.android.chrome/.Main t5}\n",
    )

    assert session.state.handoff_to_phone is False
    assert resolved == [{"window_id": "win-1", "package": "com.android.chrome"}]
    stealth.assert_not_awaited()


@pytest.mark.asyncio
async def test_focus_event_routes_an_eco_member_to_its_callback_only(mock_adb, events, settings):
    session = _watched(workspace_id="eco")
    on_phone = MagicMock()
    handoff = HandoffManager(
        mock_adb, settings, events, {"win-1": session}, serial_getter=lambda: "S",
        unfreeze_locked=AsyncMock(), on_eco_member_on_phone=on_phone,
    )
    await handoff._on_device_task_focused(display_id=0, package="com.android.chrome")
    on_phone.assert_called_once_with("win-1")
    assert session.state.handoff_to_phone is False


@pytest.mark.asyncio
@pytest.mark.parametrize("package", ["com.miui.home", "com.opendex.eco_workspace"])
async def test_launchers_and_internal_windows_are_never_handed_off(mock_adb, events, settings, package):
    session = _watched(package=package)
    handoff = HandoffManager(mock_adb, settings, events, {"win-1": session}, serial_getter=lambda: "S", unfreeze_locked=AsyncMock())
    await handoff._on_device_task_focused(display_id=0, package=package)
    assert session.state.handoff_to_phone is False


@pytest.mark.asyncio
@pytest.mark.parametrize("task_on_phone, expected", [("301", True), (None, False)])
async def test_pump_end_is_a_handoff_only_when_the_task_stands_on_the_phone(mock_adb, events, settings, task_on_phone, expected):
    """B12: a pump also ends on every resize — only a task of the app on display 0 makes it a handoff."""
    session = _watched()
    session.state.frozen = False
    session.server.is_alive = False  # the server died with its display: Android evacuated the task
    handoff = HandoffManager(mock_adb, settings, events, {"win-1": session}, serial_getter=lambda: "S", unfreeze_locked=AsyncMock())
    emitted = []
    events.on("app_handoff_to_phone", lambda **d: emitted.append(d))
    lookup = AsyncMock(return_value=task_on_phone)
    with patch("app.device.deep_navigator.find_task_id_for_package", lookup):
        await handoff.on_pump_ended(session)
    assert session.state.handoff_to_phone is expected
    assert len(emitted) == int(expected)
    assert lookup.await_args.kwargs["display_id"] == "0"


@pytest.mark.asyncio
async def test_pump_end_while_the_server_is_alive_is_our_own_reconfigure_not_a_handoff(mock_adb, events, settings):
    """A reclaim / resize closes the old pump while the server (and its display) lives on: the app cannot have been pushed
    to the phone. Looking at display 0 then re-flagged a just-reclaimed window as 'on the phone'."""
    session = _watched()
    session.state.frozen = False
    session.server.is_alive = True
    handoff = HandoffManager(mock_adb, settings, events, {"win-1": session}, serial_getter=lambda: "S", unfreeze_locked=AsyncMock())
    lookup = AsyncMock(return_value="301")  # a stale phone task would still be found
    with patch("app.device.deep_navigator.find_task_id_for_package", lookup):
        await handoff.on_pump_ended(session)
    lookup.assert_not_awaited()
    assert session.state.handoff_to_phone is False


@pytest.mark.asyncio
async def test_pump_end_of_a_frozen_window_is_not_looked_at(mock_adb, events, settings):
    session = _watched()
    session.state.frozen = True
    handoff = HandoffManager(mock_adb, settings, events, {"win-1": session}, serial_getter=lambda: "S", unfreeze_locked=AsyncMock())
    lookup = AsyncMock(return_value="301")
    with patch("app.device.deep_navigator.find_task_id_for_package", lookup):
        await handoff.on_pump_ended(session)
    lookup.assert_not_awaited()
    assert session.state.handoff_to_phone is False


def test_handoff_holds_are_per_owner_and_a_leased_hold_lapses_by_itself():
    """Bir sahibin bırakması başkasının tutuşunu kaldırmaz; bağlantı kopması gibi başkasının bırakmasına bağlı tutuş
    (lease) hiç bırakılmasa bile kendiliğinden düşer — devir algılaması sonsuza dek kapalı kalmaz."""
    handoff = HandoffManager(MagicMock(), MagicMock(), MagicMock(), {}, serial_getter=lambda: "S", unfreeze_locked=AsyncMock())
    assert handoff.paused is False

    handoff.hold("transport")
    handoff.hold("link_drop", lease_s=0.05)
    handoff.release("transport")
    assert handoff.paused is True  # link_drop hâlâ tutuyor

    time.sleep(0.06)
    assert handoff.paused is False  # lease doldu; kimse bırakmasa da


# ---------------------------------------------------------------- ön-iniş (PC'den aktarımda yoğunluk perdenin arkasında)
def _prelanding_rig(mock_adb, events, settings, *, outcome_ok=True, density_write_ok=True, prelanding_setting=True):
    from app.schemas.settings import ProjectSettings
    from app.windows.density_reconciler import ADAPTED, UNCONFIRMED, RefreshOutcome

    session = MagicMock()
    session.state = WindowState(window_id="win-3", package="com.google.android.youtube", width=1280, height=720)
    session.state.workspace_id = None
    session.state.frozen = False
    session.dpi = 200
    session.server = MagicMock(is_alive=True, display_id="12")
    density = MagicMock()
    density.snapshot = AsyncMock(return_value="BEFORE")
    density.mark = AsyncMock(return_value=123.0)
    density.settle = AsyncMock(return_value=RefreshOutcome(ADAPTED if outcome_ok else UNCONFIRMED, session.state.package))
    handoff = HandoffManager(
        mock_adb, settings, events, {"win-3": session}, serial_getter=lambda: "S",
        unfreeze_locked=AsyncMock(), density=density,
    )
    log = []

    def shell(cmd, **_):
        log.append(cmd)
        if cmd.startswith("wm density") and "-d" not in cmd:
            return "Physical density: 520"
        return ""

    mock_adb.shell = AsyncMock(side_effect=shell)
    phases = []
    events.on("vd_phase", lambda **p: phases.append(p["phase"]))
    patches = [
        patch("app.device.deep_navigator.find_task_id_for_package", AsyncMock(return_value="888")),
        patch("app.windows.handoff_manager.HandoffManager._set_density",
              AsyncMock(side_effect=lambda *a: log.append("DENSITY") or density_write_ok)),
        patch("app.storage.settings_db.get_project_settings", AsyncMock(return_value=ProjectSettings(handoff_prelanding=prelanding_setting))),
    ]
    return handoff, session, density, log, phases, patches


@pytest.mark.asyncio
async def test_pc_handoff_lands_the_density_on_the_virtual_display_before_the_task_moves(mock_adb, events, settings):
    handoff, session, density, log, phases, patches = _prelanding_rig(mock_adb, events, settings)
    with patches[0], patches[1] as set_density, patches[2]:
        assert await handoff.handoff_to_phone("win-3") is True

    set_density.assert_awaited_once_with("12", 520, "S")                  # sanal ekran telefonun yoğunluğunda
    assert density.settle.await_args.kwargs["reason"] == "pre_landing"
    assert density.settle.await_args.kwargs["display"] == "12"            # uzlaştırma SANAL ekranda, taşıma öncesi
    density.schedule_settle.assert_not_called()                           # taşıma yoğunluk-nötr: telefonda iş kalmadı
    assert log.index("DENSITY") < next(i for i, c in enumerate(log) if "move-stack 888 0" in c)   # önce yoğunluk, sonra taşıma
    assert phases == ["stealth", "live"]                                  # PC perdesi açıldı ve kalktı


@pytest.mark.asyncio
@pytest.mark.parametrize("kw", [{"outcome_ok": False}, {"density_write_ok": False}, {"prelanding_setting": False}])
async def test_without_a_proven_prelanding_the_move_still_gets_its_post_settle(mock_adb, events, settings, kw):
    handoff, _session, density, _log, phases, patches = _prelanding_rig(mock_adb, events, settings, **kw)
    with patches[0], patches[1], patches[2]:
        await handoff.handoff_to_phone("win-3")

    density.schedule_settle.assert_called_once()                          # eski yol: taşıma sonrası doğrulanmış yenileme
    assert (phases == ["stealth", "live"]) == ("prelanding_setting" not in kw)   # ayar kapalıyken perde hiç açılmaz


# ---------------------------------------------------------------- ön-iniş: telefonun CANLI yoğunluğu
@pytest.mark.asyncio
async def test_prelanding_uses_the_phones_live_density_including_the_users_smallest_width(mock_adb, events, settings):
    """A 1220 px 520 dpi panel set to 380 dp smallest width runs its apps at 513 dpi. The app must be pre-landed at 513 —
    landing it at the panel's 520 is the factory 375 dp the user moved away from ("DPI bozuk çıkıyor")."""
    handoff, _session, _density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings)
    mock_adb.shell.side_effect = lambda cmd, **_: "Physical density: 520\nOverride density: 513" if cmd == "wm density" else ""
    with patches[0], patches[1] as set_density, patches[2]:
        await handoff.handoff_to_phone("win-3")
    set_density.assert_awaited_once_with("12", 513, "S")


@pytest.mark.asyncio
async def test_the_daemons_binder_read_wins_over_the_shell(mock_adb, events, settings, monkeypatch):
    from app.device import daemon_registry

    class Daemon:
        is_connected = True
        daemon_capabilities = {"display_get"}

        async def phone_display(self):
            return {"ok": True, "id": 0, "density": 513, "physical_density": 520, "w": 1220, "h": 2712}

    monkeypatch.setattr(daemon_registry, "_client", Daemon())
    handoff, _session, _density, log, _phases, patches = _prelanding_rig(mock_adb, events, settings)
    with patches[0], patches[1] as set_density, patches[2]:
        await handoff.handoff_to_phone("win-3")
    set_density.assert_awaited_once_with("12", 513, "S")
    assert "wm density" not in log  # no shell fork for it


@pytest.mark.asyncio
async def test_an_unreadable_phone_density_means_no_prelanding_and_a_verified_settle_after_the_move(mock_adb, events, settings):
    """It used to fall back to a made-up 520 and pre-land the app on it — the wrong density on any phone not at 520 dpi
    (and on a 520 dpi phone whose user picked another smallest width). Unknown now means: nothing is written, the move
    happens, and the reconciler verifies the app afterwards."""
    handoff, _session, density, _log, phases, patches = _prelanding_rig(mock_adb, events, settings)
    mock_adb.shell.side_effect = lambda cmd, **_: "error: timed out" if cmd == "wm density" else ""
    with patches[0], patches[1] as set_density, patches[2]:
        assert await handoff.handoff_to_phone("win-3") is True
    set_density.assert_not_awaited()
    density.schedule_settle.assert_called_once()
    assert phases == []  # no veil: there was no pre-landing to hide
