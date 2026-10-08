import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import Settings
from app.device.notification_service import NotificationSupervisor
from app.events import EventBus
from app.schemas.notifications import RichNotificationItem
from app.streams.audio_stream import SessionAudio
from app.windows.session_reconfigure import SessionReconfigurer
from app.windows.window_manager import WindowManager, WindowSession
from app.schemas import WindowState


@pytest.mark.asyncio
async def test_notification_service_stop_clear_cache_flag():
    adb = MagicMock()
    events = EventBus()
    svc = NotificationSupervisor(adb, events)

    # Insert a dummy notification
    item = RichNotificationItem(
        id="test-notif-1",
        android_key="0|com.whatsapp|1|null|1000",
        package="com.whatsapp",
        app_name="WhatsApp",
        title="Test Message",
        text="Hello world",
    )
    svc._notifications[item.id] = item
    svc._dismissed_signatures[item.id] = "some-sig"

    # Handover stop: clear_cache=False
    await svc.stop(clear_cache=False)
    assert "test-notif-1" in svc._notifications
    assert "test-notif-1" in svc._dismissed_signatures

    # Complete disconnect stop: clear_cache=True
    await svc.stop(clear_cache=True)
    assert len(svc._notifications) == 0
    assert len(svc._dismissed_signatures) == 0


@pytest.mark.asyncio
async def test_session_audio_migrate_transport():
    adb = MagicMock()
    settings = Settings()
    broadcasters = MagicMock()
    audio = SessionAudio(adb, settings, broadcasters)

    # If audio is not running, it just updates serial
    await audio.migrate_transport("NEW_SERIAL_1")
    assert audio._serial == "NEW_SERIAL_1"

    # Mock running state
    audio._server = MagicMock()
    audio._server._serial = "OLD_SERIAL"
    audio._output_mode = "pc"

    audio.stop_session_audio = AsyncMock()
    audio.start_session_audio = AsyncMock()

    await audio.migrate_transport("NEW_SERIAL_2")
    audio.stop_session_audio.assert_awaited_once()
    audio.start_session_audio.assert_awaited_once_with("NEW_SERIAL_2", output_mode="pc")


@pytest.mark.asyncio
async def test_window_manager_migrate_transport_serializes_and_queues():
    adb = MagicMock()
    settings = Settings()
    events = EventBus()
    broadcasters = MagicMock()
    session_audio = MagicMock()
    session_audio.migrate_transport = AsyncMock()
    probe = MagicMock()
    device_manager = MagicMock()

    wm = WindowManager(
        adb, settings, events, broadcasters, session_audio, probe, device_manager
    )

    # Setup dummy window session
    state = WindowState(window_id="win-1", package="com.test.app", title="Test", width=1280, height=720)
    mock_server = MagicMock()
    mock_server.is_alive = True
    session = WindowSession(state=state, server=mock_server)
    wm._sessions["win-1"] = session

    # Track emitted events
    queue = await events.subscribe()

    wm._reconfigure.migrate_session_transport = AsyncMock(return_value=True)

    await wm.migrate_transport("OLD_SERIAL", "NEW_SERIAL")

    session_audio.migrate_transport.assert_awaited_once_with("NEW_SERIAL")
    wm._reconfigure.migrate_session_transport.assert_awaited_once_with("win-1", "NEW_SERIAL")

    emitted_events = []
    while not queue.empty():
        emitted_events.append(queue.get_nowait())

    event_types = [e.type for e in emitted_events]
    assert "migration_queued" in event_types
    assert "migration_started" in event_types
    assert "migration_completed" in event_types


@pytest.mark.asyncio
async def test_window_manager_migration_holds_lock():
    adb = MagicMock()
    settings = Settings()
    events = EventBus()
    broadcasters = MagicMock()
    session_audio = MagicMock()
    session_audio.migrate_transport = AsyncMock()
    probe = MagicMock()
    device_manager = MagicMock()

    wm = WindowManager(
        adb, settings, events, broadcasters, session_audio, probe, device_manager
    )

    state = WindowState(window_id="win-lock", package="com.test.lock", title="LockTest", width=1280, height=720)
    mock_server = MagicMock()
    mock_server.is_alive = True
    session = WindowSession(state=state, server=mock_server)
    wm._sessions["win-lock"] = session

    order_of_execution = []

    async def slow_migrate(window_id, serial):
        order_of_execution.append("migrate_started")
        # Verify self._lock is acquired and locked during migration
        assert wm._lock.locked()
        await asyncio.sleep(0.05)
        order_of_execution.append("migrate_done")
        return True

    wm._reconfigure.migrate_session_transport = slow_migrate

    async def competing_resize():
        # Wait a tiny bit so migrate_transport definitely starts first
        await asyncio.sleep(0.01)
        # resize_window must wait for self._lock to be released
        async with wm._lock:
            order_of_execution.append("competing_lock_acquired")

    await asyncio.gather(
        wm.migrate_transport("OLD", "NEW"),
        competing_resize(),
    )

    # competing_resize could only acquire the lock AFTER migration finished
    assert order_of_execution == ["migrate_started", "migrate_done", "competing_lock_acquired"]


@pytest.mark.asyncio
async def test_session_reconfigure_break_before_make():
    adb = MagicMock()
    settings = Settings()
    settings.UNFREEZE_GRACE_DELAY_S = 0.001
    events = EventBus()
    broadcasters = MagicMock()
    sessions = {}

    reconfig = SessionReconfigurer(
        adb, settings, events, broadcasters, sessions,
        serial_getter=lambda: "OLD_SERIAL",
        profile_getter=lambda: MagicMock(android_api=34),
        android_id_getter=lambda: "test_android_id",
    )

    state = WindowState(window_id="win-abc", package="com.example.app", title="Example", width=1280, height=720)
    old_server = MagicMock()
    old_server.stop = AsyncMock()
    old_server.is_alive = True

    old_pump = asyncio.create_task(asyncio.sleep(10))
    session = WindowSession(
        state=state,
        server=old_server,
        pump_task=old_pump,
        target_display_w=1280,
        target_display_h=720,
        dpi=160,
    )
    sessions["win-abc"] = session

    with patch("app.windows.session_reconfigure.ScrcpyServer") as mock_scrcpy_cls:
        new_server_inst = MagicMock()
        new_server_inst.push_server = AsyncMock()
        new_server_inst.start_forward = AsyncMock()
        new_server_inst.spawn = AsyncMock()
        mock_sockets = MagicMock()
        mock_sockets.video_meta = MagicMock(width=1280, height=720)
        mock_sockets.control = AsyncMock()
        new_server_inst.connect_sockets = AsyncMock(return_value=mock_sockets)
        mock_scrcpy_cls.return_value = new_server_inst

        with patch.object(reconfig, "start_video_pump") as mock_start_pump:
            ok = await reconfig.migrate_session_transport("win-abc", "NEW_SERIAL")

            assert ok is True
            # Verified Break-Before-Make: old_server.stop was called and old pump cancelled
            old_server.stop.assert_awaited_once()
            assert old_pump.cancelled() or old_pump.done()

            # Verified new server was spawned on new serial and new pump started
            new_server_inst.spawn.assert_awaited_once()
            assert session.server == new_server_inst
            mock_start_pump.assert_called_once_with(session)


@pytest.mark.asyncio
async def test_a_dedicated_windows_pump_end_is_reported_to_the_handoff_layer():
    """B12: SessionReconfigurer only REPORTS the pump end; the anchor keeps its own callback."""
    ended = AsyncMock()
    anchor_ended = MagicMock()
    sessions = {}
    reconfig = SessionReconfigurer(
        MagicMock(), Settings(), EventBus(), MagicMock(), sessions,
        serial_getter=lambda: "S", profile_getter=lambda: None, android_id_getter=lambda: None,
        on_anchor_pump_terminated=anchor_ended, on_window_pump_ended=ended,
    )
    server = MagicMock()
    server.sockets.video = (MagicMock(), MagicMock())
    session = WindowSession(state=WindowState(window_id="win-p", package="com.x", width=100, height=100), server=server)
    sessions["win-p"] = session
    with patch("app.windows.session_reconfigure.read_video_socket", AsyncMock()):
        reconfig.start_video_pump(session)
        await session.pump_task
    ended.assert_awaited_once_with(session)
    anchor_ended.assert_not_called()
