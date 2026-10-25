import asyncio
from app.windows.playback_continuity import PlaybackSnapshot
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

    mock_daemon = AsyncMock()
    mock_daemon.is_connected = True
    mock_daemon.move_task_wct.return_value = True

    handoff = HandoffManager(
        mock_adb,
        settings,
        events,
        sessions,
        serial_getter=lambda: "serial123",
        daemon_client_getter=lambda: mock_daemon,
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

    mock_daemon.move_task_wct.assert_awaited_once_with("999", "0", mode=1, clear_bounds=True, bounds=None)
    calls = [call[0][0] for call in mock_adb.shell.call_args_list]
    # The window's display keeps the window's density
    assert not any(c.startswith("wm density") and "-d 10" in c for c in calls)
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
    mock_daemon = AsyncMock()
    mock_daemon.is_connected = True
    mock_daemon.move_task_wct.return_value = True

    handoff = HandoffManager(
        mock_adb,
        settings,
        events,
        sessions,
        serial_getter=lambda: "serial123",
        daemon_client_getter=lambda: mock_daemon,
        unfreeze_locked=unfreeze,
    )

    mock_adb.shell.side_effect = lambda cmd, **kwargs: (
        "Physical density: 520" if "wm density" in cmd and "-d" not in cmd else ""
    )

    with patch("app.device.deep_navigator.find_task_id_for_package", AsyncMock(return_value="888")):
        ok = await handoff.handoff_to_phone("win-2")

    assert ok is True
    assert session.state.handoff_to_phone is True
    mock_daemon.move_task_wct.assert_awaited_once_with("888", "0", mode=1, clear_bounds=True, bounds=None)

    calls = [call[0][0] for call in mock_adb.shell.call_args_list]
    assert not any(c.startswith("wm density") and "-d 11" in c for c in calls)


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

    time.sleep(0.08)
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
    density.holds_media = AsyncMock(return_value=False)
    density.settle = AsyncMock(return_value=RefreshOutcome(ADAPTED if outcome_ok else UNCONFIRMED, session.state.package))
    mock_daemon = AsyncMock()
    mock_daemon.is_connected = True
    mock_daemon.restart_task_activity = AsyncMock(return_value=False)
    mock_daemon.move_task_wct = AsyncMock(side_effect=lambda *a, **kw: log.append("MOVE_WCT") or True)
    handoff = HandoffManager(
        mock_adb, settings, events, {"win-3": session}, serial_getter=lambda: "S",
        daemon_client_getter=lambda: mock_daemon,
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
    assert log.index("DENSITY") < log.index("MOVE_WCT")                   # önce yoğunluk, sonra taşıma
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


@pytest.mark.asyncio
async def test_reinflate_on_display_0_triggers_view_reinflation_without_redundant_settle(mock_adb, events, settings):
    """PC'den telefona aktarımda reinflate (restart_task_activity) Display 0 üzerinde tetiklenir ve başarılı olduğunda
    ikinci bir gereksiz reconcile çağrısını önler."""
    handoff, _session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    daemon_client = handoff._daemon_client_getter()
    daemon_client.restart_task_activity = AsyncMock(return_value=True)

    with patches[0], patches[1], patches[2]:
        assert await handoff.handoff_to_phone("win-3") is True

    daemon_client.restart_task_activity.assert_awaited_once_with("888")
    density.schedule_settle.assert_not_called()


@pytest.mark.asyncio
async def test_an_app_with_a_media_session_is_never_process_restarted(mock_adb, events, settings):
    """Medya oturumu olan (oynayan ya da duraklatılmış) uygulamanın reinflate'i süreci öldürmez (müzik/video giderdi)."""
    handoff, _session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    density.holds_media = AsyncMock(return_value=True)
    daemon_client = handoff._daemon_client_getter()
    daemon_client.restart_task_activity = AsyncMock(return_value=True)

    with patches[0], patches[1], patches[2]:
        assert await handoff.handoff_to_phone("win-3") is True

    daemon_client.restart_task_activity.assert_not_called()
    density.holds_media.assert_awaited()


@pytest.mark.asyncio
async def test_native_app_with_prelanding_skips_restart_task_activity_to_preserve_state(mock_adb, events, settings):
    """Play Store veya yerel uygulamalar ön-inişte adapte olduğunda süreç yeniden başlatılmaz — scroll ve state korunur."""
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=True)
    session.state.package = "com.android.vending"
    daemon_client = handoff._daemon_client_getter()
    daemon_client.restart_task_activity = AsyncMock(return_value=True)

    with patches[0], patches[1], patches[2]:
        assert await handoff.handoff_to_phone("win-3") is True

    daemon_client.restart_task_activity.assert_not_called()
    density.schedule_settle.assert_not_called()


@pytest.mark.asyncio
async def test_web_rendered_app_with_prelanding_still_triggers_reinflate(mock_adb, events, settings):
    """Chrome gibi web tabanlı uygulamalar web sitelerinin render/font önbelleğini tazelemek için reinflate tetikler."""
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=True)
    session.state.package = "com.android.chrome"
    daemon_client = handoff._daemon_client_getter()
    daemon_client.restart_task_activity = AsyncMock(return_value=True)

    with patches[0], patches[1], patches[2]:
        assert await handoff.handoff_to_phone("win-3") is True

    daemon_client.restart_task_activity.assert_awaited_once_with("888")
    density.schedule_settle.assert_not_called()


@pytest.mark.asyncio
async def test_browser_with_cdp_triggers_live_nudge_without_restarting_process(mock_adb, events, settings):
    """CDP soketi bulunan tarayıcıda süreç ASLA öldürülmez (sıfır state kaybı): önce sekme izleyicisi (tüm sekmeler telefonun
    yerel ölçeğine, anahtar = paket, ölçek = telefonun KENDİ yoğunluğu), sonra canlı layout dürtmesi."""
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=True)
    session.state.package = "com.android.chrome"
    daemon_client = handoff._daemon_client_getter()
    daemon_client.restart_task_activity = AsyncMock(return_value=True)
    order: list[str] = []

    def start_watcher(adb, serial, socket, key, phone_dpr=None, resume=None):
        order.append("watcher")
        start_watcher.args = (socket, key, phone_dpr)
        return MagicMock(wait_ready=AsyncMock(return_value=True))

    async def nudge(*args, **kwargs):
        order.append("nudge")
        return True

    with (
        patches[0], patches[1], patches[2],
        patch("app.windows.handoff_manager.inspect_app_runtime", AsyncMock(
            return_value=MagicMock(is_browser_cdp=True, cdp_socket="chrome_devtools_remote", is_pure_native=False, has_web_engine=True)
        )),
        patch("app.windows.handoff_manager.start_browser_auto_attach_watcher", start_watcher),
        patch("app.windows.handoff_manager.refresh_browser_layout_inplace", nudge),
    ):
        assert await handoff.handoff_to_phone("win-3") is True

    assert order == ["watcher", "nudge"]        # the scale is in place when the nudge anchors the scroll
    socket, key, phone_dpr = start_watcher.args
    assert (socket, key) == ("chrome_devtools_remote", "com.android.chrome")
    assert phone_dpr == pytest.approx(520 / 160)  # the phone's own density, not a constant
    daemon_client.restart_task_activity.assert_not_called()
    density.schedule_settle.assert_not_called()


def _snapshot(pid):
    from types import SimpleNamespace
    return SimpleNamespace(identity=None if pid is None else (pid, 1))


@pytest.mark.asyncio
async def test_a_killed_app_that_does_not_come_back_is_started_again_on_the_phone(mock_adb, events, settings, monkeypatch):
    """Field report 2026-10-17 (black screen): `restart_task_activity` kills the process but relaunches only a VISIBLE task. Right
    after the Home -> app transition it is not yet, so the task sat on the phone with no process. The rebirth is checked and a
    task that did not come back is launched by hand."""
    handoff, _session, density, _log, _phases, _patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=True)
    daemon = handoff._daemon_client_getter()
    daemon.restart_task_activity = AsyncMock(return_value=True)
    daemon.task_info = AsyncMock(return_value={"top": "com.google.android.youtube/.app.honeycomb.Shell$HomeActivity"})
    density.holds_media = AsyncMock(return_value=False)
    density.snapshot = AsyncMock(side_effect=[_snapshot(100)] + [_snapshot(None)] * 20)   # before: pid 100, then: no process
    monkeypatch.setattr(handoff, "_REBIRTH_WAIT_S", 0.05)
    monkeypatch.setattr(handoff, "_REBIRTH_POLL_S", 0.01)
    launched = AsyncMock()
    monkeypatch.setattr("app.windows.handoff_manager.android_shell.bring_to_front", launched)

    assert await handoff._reinflate("com.google.android.youtube", 467) is True

    launched.assert_awaited_once()
    args, kwargs = launched.await_args
    assert args[2:4] == ("com.google.android.youtube", "0")
    assert kwargs["component"] == "com.google.android.youtube/.app.honeycomb.Shell$HomeActivity"
    assert kwargs["reorder_only"] is False


@pytest.mark.asyncio
async def test_an_app_that_relaunched_itself_is_left_alone(mock_adb, events, settings, monkeypatch):
    handoff, _session, density, _log, _phases, _patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=True)
    daemon = handoff._daemon_client_getter()
    daemon.restart_task_activity = AsyncMock(return_value=True)
    density.holds_media = AsyncMock(return_value=False)
    density.snapshot = AsyncMock(side_effect=[_snapshot(100), _snapshot(None), _snapshot(200)])   # killed, then reborn
    monkeypatch.setattr(handoff, "_REBIRTH_WAIT_S", 1.0)
    monkeypatch.setattr(handoff, "_REBIRTH_POLL_S", 0.01)
    launched = AsyncMock()
    monkeypatch.setattr("app.windows.handoff_manager.android_shell.bring_to_front", launched)

    assert await handoff._reinflate("com.android.chrome", 5) is True
    launched.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_restart_that_never_killed_the_process_launches_nothing(mock_adb, events, settings, monkeypatch):
    handoff, _session, density, _log, _phases, _patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=True)
    daemon = handoff._daemon_client_getter()
    daemon.restart_task_activity = AsyncMock(return_value=True)
    density.holds_media = AsyncMock(return_value=False)
    density.snapshot = AsyncMock(return_value=_snapshot(100))      # same process the whole time
    monkeypatch.setattr(handoff, "_REBIRTH_WAIT_S", 0.05)
    monkeypatch.setattr(handoff, "_REBIRTH_POLL_S", 0.01)
    launched = AsyncMock()
    monkeypatch.setattr("app.windows.handoff_manager.android_shell.bring_to_front", launched)

    assert await handoff._reinflate("com.android.chrome", 5) is True
    launched.assert_not_awaited()


@pytest.mark.asyncio
async def test_handoff_to_phone_moves_fullscreen_then_settles_freeform(mock_adb, events, settings):
    """WCT ile doğrudan freeform taşımak HyperOS Shell geçişini atladığı için içerik beyaz kalır.
    Bu nedenle görev önce tam ekran taşınır, ardından _settle_phone_windowing içinde HyperOS geçişi tetiklenir."""
    from app.schemas.settings import ProjectSettings

    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    daemon_client = handoff._daemon_client_getter()
    daemon_client.move_task_wct = AsyncMock(return_value=True)

    freeform_settings = ProjectSettings(handoff_prelanding=False, phone_handoff_windowing="freeform")
    patches[2] = patch("app.storage.settings_db.get_project_settings", AsyncMock(return_value=freeform_settings))

    with (
        patches[0], patches[1], patches[2],
        patch("app.device.android_shell.phone_size", AsyncMock(return_value=(1220, 2712))),
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")) as mock_bring_to_front,
        patch.object(handoff, "_await_freeform_entered", AsyncMock(return_value=True)) as mock_entered,
        patch.object(handoff, "_settle_phone_windowing", AsyncMock()) as mock_settle,
    ):
        assert await handoff.handoff_to_phone("win-3") is True

    daemon_client.move_task_wct.assert_awaited_once_with(
        "888", "0", mode=1, clear_bounds=True, bounds=None,
    )
    mock_bring_to_front.assert_awaited_once_with(
        mock_adb, "S", "com.google.android.youtube", "0",
        reorder_only=True, component=None, windowing_mode=5,
    )
    # Doğru kutu serbest kipe girer girmez (CDP yenilemesi / yeniden kurma BEKLENMEDEN) verilir; 4. adımda yeniden doğrulanır.
    mock_entered.assert_awaited_once_with("888", "S")
    assert mock_settle.await_count == 2
    mock_settle.assert_awaited_with("com.google.android.youtube", "888", "S", phone_size=None, windowing=None)


@pytest.mark.asyncio
async def test_enter_freeform_via_shell_triggers_mode_5_transition(mock_adb, events, settings):
    """_enter_freeform_via_shell, tam ekrandaki görevi am start --windowingMode 5 ile HyperOS Shell geçişine sokar."""
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    with (
        patch("app.windows.handoff_manager.read_task_windowing", AsyncMock(return_value=MagicMock(found=True, windowing_mode=1))),
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")) as mock_bring_to_front,
        patch("asyncio.sleep", AsyncMock()),
    ):
        await handoff._enter_freeform_via_shell("com.google.android.youtube", "888", "S")

    mock_bring_to_front.assert_awaited_once_with(
        mock_adb, "S", "com.google.android.youtube", "0",
        reorder_only=True, component=None, windowing_mode=5,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("setting", "choice", "launch_mode", "settled_with"),
    [
        ("fullscreen", "freeform", 5, "freeform"),    # başlık çubuğu menüsünden "Serbest pencere": ayar tam ekran olsa da
        ("freeform", "fullscreen", None, "fullscreen"),  # ... ve tersi
        ("freeform", None, 5, None),                   # seçim yok: kullanıcının ayarı
    ],
)
async def test_handoff_windowing_choice_overrides_the_setting_for_this_handoff_only(
    mock_adb, events, settings, setting, choice, launch_mode, settled_with,
):
    from app.schemas.settings import ProjectSettings

    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    daemon_client = handoff._daemon_client_getter()
    daemon_client.move_task_wct = AsyncMock(return_value=True)
    patches[2] = patch(
        "app.storage.settings_db.get_project_settings",
        AsyncMock(return_value=ProjectSettings(handoff_prelanding=False, phone_handoff_windowing=setting)),
    )

    with (
        patches[0], patches[1], patches[2],
        patch("app.device.android_shell.phone_size", AsyncMock(return_value=(1220, 2712))),
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")) as mock_bring_to_front,
        patch.object(handoff, "_await_freeform_entered", AsyncMock(return_value=True)),
        patch.object(handoff, "_settle_phone_windowing", AsyncMock()) as mock_settle,
    ):
        assert await handoff.handoff_to_phone("win-3", windowing=choice) is True

    assert mock_bring_to_front.await_args.kwargs["windowing_mode"] == launch_mode
    assert mock_settle.await_args.kwargs["windowing"] == settled_with


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["display0", "watchdog"])
async def test_app_opened_on_the_phone_is_always_fullscreen_whatever_the_freeform_setting(mock_adb, events, settings, source):
    """Ayar "serbest pencere" olsa da telefonda kendiliğinden açılan/taşınan uygulama tam ekran kalır (kural yalnız PC düğmesi içindir)."""
    from app.schemas.settings import ProjectSettings

    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    patches[2] = patch(
        "app.storage.settings_db.get_project_settings",
        AsyncMock(return_value=ProjectSettings(handoff_prelanding=False, phone_handoff_windowing="freeform")),
    )
    with (
        patches[0], patches[1], patches[2],
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")) as mock_bring_to_front,
        patch.object(handoff, "_settle_phone_windowing", AsyncMock()) as mock_settle,
    ):
        await handoff._execute_to_phone(session, "com.google.android.youtube", None, "S", task_id="888", source=source)

    assert mock_bring_to_front.await_args.kwargs["windowing_mode"] is None
    assert mock_settle.await_args.kwargs["windowing"] == "fullscreen"


@pytest.mark.asyncio
@pytest.mark.parametrize("source, restarts", [("pc", True), ("display0", False), ("watchdog", False)])
async def test_an_app_android_moved_itself_is_not_process_killed_by_the_handoff(mock_adb, events, settings, source, restarts):
    """The user tapped the app's icon on the phone (display0) or a watchdog saw it there: Android already re-applied the phone
    display's configuration and recreated the activity, and the forced process kill is what left the app without a process and
    a BLACK screen (2026-10-17). Only the evidence-based settle may restart such an app. A PC-initiated handoff keeps the reinflate."""
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    daemon_client = handoff._daemon_client_getter()
    daemon_client.restart_task_activity = AsyncMock(return_value=True)
    density.holds_media = AsyncMock(return_value=False)
    with (
        patches[0], patches[1], patches[2],
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")),
        patch.object(handoff, "_ensure_relaunched", AsyncMock()),
        patch.object(handoff, "_settle_phone_windowing", AsyncMock()),
    ):
        await handoff._execute_to_phone(session, "com.example.notes", None, "S", task_id="888", source=source)

    assert daemon_client.restart_task_activity.await_count == (1 if restarts else 0)


@pytest.mark.asyncio
async def test_hyperos_handoff_gives_home_a_real_foreground_transition(mock_adb, events, settings):
    """Kenar geri jesti: HyperOS'ta taşınan göreve Home → uygulama geçişi verilir (düz reorder-to-front jesti açmaz)."""
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    daemon_client = handoff._daemon_client_getter()
    daemon_client.move_task_wct = AsyncMock(return_value=True)
    with (
        patches[0], patches[1], patches[2],
        patch("app.device.android_shell.phone_size", AsyncMock(return_value=(1220, 2712))),
        patch("app.device.android_shell.is_miui_or_hyperos", AsyncMock(return_value=True)),
        patch("app.device.android_shell.unlock_display0_gesture_navigation", AsyncMock(return_value="Starting: Intent")) as unlock,
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")) as plain,
    ):
        assert await handoff.handoff_to_phone("win-3") is True

    unlock.assert_awaited_once()
    assert unlock.await_args.args[2] == "com.google.android.youtube"
    plain.assert_not_awaited()


@pytest.mark.asyncio
async def test_hyperos_handoff_keeps_the_phones_open_app_behind_the_target(mock_adb, events, settings):
    """Log 2026-10-16: freeform handoff put Home between the phone's open app (YouTube Music) and the target, hiding the app.
    The foreground task read BEFORE the move is handed to the gesture unlock as the intermediate."""
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    daemon_client = handoff._daemon_client_getter()
    daemon_client.move_task_wct = AsyncMock(return_value=True)
    daemon_client.tasks = AsyncMock(return_value=[
        {"id": 371, "display": 0, "visible": True, "package": "com.google.android.apps.youtube.music"},
        {"id": 2, "display": 0, "visible": False, "package": "com.mi.android.globallauncher"},
    ])
    with (
        patches[0], patches[1], patches[2],
        patch("app.device.android_shell.phone_size", AsyncMock(return_value=(1220, 2712))),
        patch("app.device.android_shell.is_miui_or_hyperos", AsyncMock(return_value=True)),
        patch("app.device.android_shell.unlock_display0_gesture_navigation", AsyncMock(return_value="Starting: Intent")) as unlock,
    ):
        assert await handoff.handoff_to_phone("win-3") is True

    assert unlock.await_args.kwargs["behind_task_id"] == 371
    assert unlock.await_args.kwargs["daemon"] is daemon_client


@pytest.mark.asyncio
@pytest.mark.parametrize("visible", [
    [{"id": 2, "display": 0, "visible": True, "package": "com.mi.android.globallauncher"}],          # user is on Home
    [{"id": 9, "display": 0, "visible": True}],                                                      # topmost has no package
    [{"id": 9, "display": 101, "visible": True, "package": "com.android.chrome"}],                  # only virtual-display tasks
    [],
])
async def test_phone_foreground_task_is_none_when_home_is_the_right_intermediate(mock_adb, events, settings, visible):
    handoff, *_ = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    handoff._daemon_client_getter().tasks = AsyncMock(return_value=visible)
    assert await handoff._phone_foreground_task("com.android.vending", 382) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["Error: Activity not started, unable to resolve Intent", ""])
async def test_hyperos_unlock_that_fails_falls_back_to_plain_bring_to_front(mock_adb, events, settings, failure):
    """Home'a gidip uygulamayı başlatamazsa kullanıcı Home'da kalmaz: düz öne getirme çalışır."""
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    daemon_client = handoff._daemon_client_getter()
    daemon_client.move_task_wct = AsyncMock(return_value=True)
    with (
        patches[0], patches[1], patches[2],
        patch("app.device.android_shell.phone_size", AsyncMock(return_value=(1220, 2712))),
        patch("app.device.android_shell.is_miui_or_hyperos", AsyncMock(return_value=True)),
        patch("app.device.android_shell.unlock_display0_gesture_navigation", AsyncMock(return_value=failure)),
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")) as plain,
    ):
        assert await handoff.handoff_to_phone("win-3") is True

    plain.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_task_the_shell_cannot_start_is_raised_by_id_instead_of_staying_behind_home(mock_adb, events, settings):
    """Log 2026-10-16 (Udemy): the course player's top activity is not exported, so Home → LAUNCHER cannot resolve and
    `am start -n` is refused (SecurityException) — the task stayed behind the launcher for ~5 s. The daemon raises it by id."""
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    daemon_client = handoff._daemon_client_getter()
    daemon_client.move_task_wct = AsyncMock(return_value=True)
    daemon_client.reorder_task = AsyncMock(return_value=True)
    refused = RuntimeError("java.lang.SecurityException: Permission Denial: not exported from uid 10322")
    with (
        patches[0], patches[1], patches[2],
        patch("app.device.android_shell.phone_size", AsyncMock(return_value=(1220, 2712))),
        patch("app.device.android_shell.is_miui_or_hyperos", AsyncMock(return_value=True)),
        patch("app.device.android_shell.unlock_display0_gesture_navigation", AsyncMock(return_value="Error: unable to resolve Intent")),
        patch("app.device.android_shell.bring_to_front", AsyncMock(side_effect=refused)),
    ):
        assert await handoff.handoff_to_phone("win-3") is True

    daemon_client.reorder_task.assert_awaited_once()
    assert daemon_client.reorder_task.await_args.kwargs == {"front": True}


@pytest.mark.asyncio
async def test_non_xiaomi_handoff_keeps_the_plain_reorder(mock_adb, events, settings):
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    daemon_client = handoff._daemon_client_getter()
    daemon_client.move_task_wct = AsyncMock(return_value=True)
    with (
        patches[0], patches[1], patches[2],
        patch("app.device.android_shell.phone_size", AsyncMock(return_value=(1220, 2712))),
        patch("app.device.android_shell.is_miui_or_hyperos", AsyncMock(return_value=False)),
        patch("app.device.android_shell.unlock_display0_gesture_navigation", AsyncMock()) as unlock,
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")) as plain,
    ):
        assert await handoff.handoff_to_phone("win-3") is True

    unlock.assert_not_awaited()
    plain.assert_awaited_once()


@pytest.mark.asyncio
async def test_the_phone_is_woken_while_the_apps_runtime_is_read_not_before_it(mock_adb, events, settings):
    """`dumpsys meminfo` (the runtime probe) alone is ~0.4 s of a handoff; waking the screen first and probing after made them
    add up. Each one must see that the other has already STARTED: run one after the other, the first never does."""
    handoff, _session, _density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    woke, probing = asyncio.Event(), asyncio.Event()
    seen = {}

    async def wake(*_a, **_k):
        woke.set()
        seen["wake_saw_probe"] = await _became_set(probing)

    async def probe(*_a, **_k):
        probing.set()
        seen["probe_saw_wake"] = await _became_set(woke)
        return MagicMock(is_browser_cdp=False, cdp_socket=None)

    async def _became_set(event):
        try:
            await asyncio.wait_for(event.wait(), timeout=0.5)
            return True
        except asyncio.TimeoutError:
            return False

    with (
        patches[0], patches[1], patches[2],
        patch("app.device.android_shell.wake_and_unlock", wake),
        patch("app.windows.handoff_manager.inspect_app_runtime", probe),
    ):
        assert await handoff.handoff_to_phone("win-3") is True

    assert seen == {"wake_saw_probe": True, "probe_saw_wake": True}


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["display0", "watchdog"])
async def test_a_video_playing_when_the_user_launches_the_app_on_the_phone_is_resumed_after_the_handoff(mock_adb, events, settings, source):
    """The user's own tap on the phone (or Android) launches the app there: the rebuild stops the video. It was still playing when
    the handoff started, so it goes on from where it stopped — exactly as for a handoff started from the PC."""
    handoff, session, density, _log, _phases, patches = _prelanding_rig(mock_adb, events, settings, prelanding_setting=False)
    snapshot = PlaybackSnapshot(package=session.state.package, position_ms=5000, taken_at=0.0)
    handoff._playback.capture = AsyncMock(return_value=snapshot)
    handoff._playback.restore = AsyncMock(return_value="resumed")
    session.state.handoff_to_phone = True               # what _observe sets before it spawns the display work
    with patch.object(handoff, "_execute_to_phone", AsyncMock()):
        await handoff._to_phone_locked(session, "S", "888", source)
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    handoff._playback.capture.assert_awaited_once_with(session.state.package)
    handoff._playback.restore.assert_awaited_once_with(snapshot, "0")


def _landed_session(*, size=(1220, 2712), dpi=513):
    from types import SimpleNamespace
    from app.windows.handoff_manager import Geometry, Landing

    session = SimpleNamespace(target_display_w=size[0], target_display_h=size[1], dpi=dpi)
    session.landing = Landing(window=Geometry(1472, 1016, 180), landed=Geometry(1220, 2712, 513))
    return session


def test_a_window_untouched_on_the_phone_gets_its_own_geometry_back():
    from app.windows.handoff_manager import Geometry

    session = _landed_session()
    assert HandoffManager._geometry_to_restore(session, session.landing) == Geometry(1472, 1016, 180)


def test_a_window_resized_on_the_phone_keeps_its_size_but_gets_the_windows_density_back():
    """A plain resize drag carries no density: the empty display still had the phone's 513 — the app would return drawn at the phone's
    scale inside the bigger window."""
    from app.windows.handoff_manager import Geometry

    session = _landed_session(size=(1656, 1016))
    assert HandoffManager._geometry_to_restore(session, session.landing) == Geometry(1656, 1016, 180)


def test_a_density_the_user_chose_on_the_phone_side_is_left_alone():
    session = _landed_session(size=(1656, 1016), dpi=220)
    assert HandoffManager._geometry_to_restore(session, session.landing) is None


def test_adopting_the_window_geometry_of_a_frozen_display_keeps_a_resize_too():
    session = _landed_session(size=(1656, 1016))
    session.state = WindowState(window_id="w", package="p", width=1, height=1)
    HandoffManager._adopt_window_geometry(session)
    assert (session.target_display_w, session.target_display_h, session.dpi) == (1656, 1016, 180)
    assert session.landing is None
