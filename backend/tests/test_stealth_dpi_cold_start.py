"""Tests for cold-start target DPI guarantee and Stealth DPI task presence gating.

Verifies:
1. When package has NO task on Display 0 (cold start), sanal display births directly at target chosen_dpi (is_stealth_active=False).
2. When package HAS an active task on Display 0 (warm handoff), stealth 2-phase DPI activates (is_stealth_active=True).
3. Mirror windows and stealth_dpi_enabled=False immediately bypass stealth phases.
4. Error or exception reading tasks safely falls back to cold start (safe default).
"""
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.windows.window_manager import WindowManager


@pytest.fixture
def mock_wm():
    adb = MagicMock()
    settings = MagicMock()
    settings.VIRTUAL_DISPLAY_DPI = 180
    events = MagicMock()
    broadcasters = MagicMock()
    session_audio = MagicMock()
    capability_probe = MagicMock()
    device_manager = MagicMock()

    wm = WindowManager(
        adb=adb,
        settings=settings,
        events=events,
        broadcasters=broadcasters,
        session_audio=session_audio,
        capability_probe=capability_probe,
        device_manager=device_manager,
    )
    wm._serial = "test-device-123"
    wm._profile = MagicMock()
    wm._profile.android_api = 34
    return wm


@pytest.mark.asyncio
async def test_cold_start_births_directly_at_target_dpi(mock_wm):
    """When package has no task on Display 0, stealth DPI must NOT activate."""
    wlog = logging.getLogger("test")

    with patch("app.device.deep_navigator.find_task_id_for_package", new_callable=AsyncMock) as mock_find_task:
        mock_find_task.return_value = None  # No task on Display 0

        p1, p2, active = await mock_wm._compute_stealth_dpi_phases(
            is_mirror=False,
            chosen_dpi=200,
            wlog=wlog,
            package="com.google.android.youtube",
            stealth_enabled=True,
        )

        assert active is False
        assert p1 == 200
        assert p2 == 200
        mock_find_task.assert_awaited_once_with(
            mock_wm._adb, "com.google.android.youtube", display_id="0", serial="test-device-123"
        )


@pytest.mark.asyncio
async def test_warm_handoff_activates_stealth_phases(mock_wm):
    """When package has an active task on Display 0, stealth DPI activates with physical DPI first."""
    wlog = logging.getLogger("test")

    with (
        patch("app.device.deep_navigator.find_task_id_for_package", new_callable=AsyncMock) as mock_find_task,
        patch("app.device.android_shell.phone_density", new_callable=AsyncMock) as mock_phys_density,
    ):
        mock_find_task.return_value = "1042"  # Active task on phone
        mock_phys_density.return_value = 520

        p1, p2, active = await mock_wm._compute_stealth_dpi_phases(
            is_mirror=False,
            chosen_dpi=200,
            wlog=wlog,
            package="com.google.android.youtube",
            stealth_enabled=True,
        )

        assert active is True
        assert p1 == 520
        assert p2 == 200


@pytest.mark.asyncio
async def test_stealth_disabled_setting_bypasses(mock_wm):
    """When stealth_enabled=False in settings, cold or warm both start directly at chosen_dpi."""
    wlog = logging.getLogger("test")

    p1, p2, active = await mock_wm._compute_stealth_dpi_phases(
        is_mirror=False,
        chosen_dpi=200,
        wlog=wlog,
        package="com.google.android.youtube",
        stealth_enabled=False,
    )

    assert active is False
    assert p1 == 200
    assert p2 == 200


@pytest.mark.asyncio
async def test_mirror_window_bypasses_stealth(mock_wm):
    """Mirror windows (Display 0) must never use stealth DPI."""
    wlog = logging.getLogger("test")

    p1, p2, active = await mock_wm._compute_stealth_dpi_phases(
        is_mirror=True,
        chosen_dpi=200,
        wlog=wlog,
        package="_mirror_",
        stealth_enabled=True,
    )

    assert active is False
    assert p1 == 200
    assert p2 == 200


@pytest.mark.asyncio
async def test_find_task_exception_defaults_to_cold_start(mock_wm):
    """If deep navigator task search fails with an exception, safe default is cold start at target DPI."""
    wlog = logging.getLogger("test")

    with patch("app.device.deep_navigator.find_task_id_for_package", new_callable=AsyncMock) as mock_find_task:
        mock_find_task.side_effect = RuntimeError("ADB timeout")

        p1, p2, active = await mock_wm._compute_stealth_dpi_phases(
            is_mirror=False,
            chosen_dpi=200,
            wlog=wlog,
            package="com.google.android.youtube",
            stealth_enabled=True,
        )

        assert active is False
        assert p1 == 200
        assert p2 == 200
