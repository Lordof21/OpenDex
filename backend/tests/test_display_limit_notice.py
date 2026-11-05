"""A resize over the phone's pixel ceiling is scaled down on its way to the phone — and the reply says so, so the interface can tell the user."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.windows import display_limits


@pytest.fixture(autouse=True)
def _phone_screen():
    display_limits.note_phone_screen(1220, 2712)      # 3.3 M px: under the 2.5K ceiling (4.1 M px)
    yield
    display_limits.note_phone_screen(0, 0)


def test_exceeds_limit_is_a_pure_question_about_pixels_not_sides():
    assert display_limits.exceeds_limit(2560, 1600) is False         # exactly the ceiling
    assert display_limits.exceeds_limit(1220, 2712) is False         # a long side, few pixels
    assert display_limits.exceeds_limit(3000, 2000) is True
    assert display_limits.exceeds_limit(10000, 10000) is True
    assert display_limits.exceeds_limit(0, 0) is False               # "keep the size"


def test_a_bigger_phone_screen_raises_the_ceiling_but_never_past_4k():
    display_limits.note_phone_screen(1440, 3200)                     # 4.6 M px
    assert display_limits.max_display_pixels() == 1440 * 3200
    display_limits.note_phone_screen(5000, 5000)
    assert display_limits.max_display_pixels() == 3840 * 2160


@pytest.mark.asyncio
async def test_the_resize_reply_marks_a_capped_size(monkeypatch):
    from app.api.v1.endpoints import windows as endpoint
    from app.schemas import WindowHandle

    handle = WindowHandle(window_id="w1", package="com.app", ws_url="/ws/video/w1", display_w=2560, display_h=1600)
    ctx = MagicMock()
    ctx.window_manager.resize_window = AsyncMock(return_value=handle)
    monkeypatch.setattr(endpoint.settings_db, "get_project_settings", AsyncMock(return_value=MagicMock(dynamic_resolution_enabled=True)))

    big = await endpoint.resize_window(endpoint.ResizeRequest(window_id="w1", w=5000, h=4000), ctx)
    assert big.capped_by_limit is True
    assert big.max_display_pixels == display_limits.max_display_pixels()

    small = await endpoint.resize_window(endpoint.ResizeRequest(window_id="w1", w=1280, h=720), ctx)
    assert small.capped_by_limit is False
