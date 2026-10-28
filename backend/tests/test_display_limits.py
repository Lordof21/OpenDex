"""display_limits: no display past a 2.5K screen's pixels — or the phone's own screen when that is bigger — and never past 4K;
enforced where the size leaves for the phone."""
from __future__ import annotations

import struct

import pytest

from app.windows import display_limits
from app.windows.display_limits import PIXELS_2_5K, PIXELS_4K, cap_display_size, cap_display_spec, note_phone_screen
from app.windows.scrcpy_launcher import serialize_opendex_resize, serialize_resize_display


@pytest.fixture(autouse=True)
def no_phone():
    note_phone_screen(0, 0)
    yield
    note_phone_screen(0, 0)


def test_a_size_within_2_5k_is_untouched():
    assert cap_display_size(2560, 1600) == (2560, 1600)
    assert cap_display_size(1220, 2712) == (1220, 2712)  # 2712 long, yet fewer pixels than 2.5K: the phone's own size passes
    assert cap_display_size(0, 0) == (0, 0)              # "keep the size"


def test_a_4k_request_is_brought_down_to_2_5k_pixels_keeping_its_shape():
    w, h = cap_display_size(3840, 2160)
    assert w * h <= PIXELS_2_5K
    assert w % 8 == 0 and h % 8 == 0
    assert abs(w / h - 3840 / 2160) < 0.01


def test_a_phone_whose_own_screen_is_bigger_than_2_5k_gets_its_size():
    note_phone_screen(1440, 3200)                        # 4.6 M px
    assert display_limits.max_display_pixels() == 1440 * 3200
    assert cap_display_size(1440, 3200) == (1440, 3200)
    w, h = cap_display_size(3840, 2160)
    assert w * h <= 1440 * 3200


def test_nothing_ever_passes_4k_whatever_the_phone():
    note_phone_screen(2160, 5000)                        # 10.8 M px panel
    assert display_limits.max_display_pixels() == PIXELS_4K
    w, h = cap_display_size(7680, 4320)
    assert w * h <= PIXELS_4K


def test_the_server_command_and_every_resize_message_are_capped():
    assert cap_display_spec("3840x2160") != "3840x2160"
    assert cap_display_spec("1280x800") == "1280x800"
    assert cap_display_spec("not-a-size") == "not-a-size"
    _, w, h, _, _ = struct.unpack("!BHHHI", serialize_opendex_resize(3840, 2160, 320, 0))
    assert w * h <= PIXELS_2_5K
    _, w, h = struct.unpack("!BHH", serialize_resize_display(3840, 2160))
    assert w * h <= PIXELS_2_5K
