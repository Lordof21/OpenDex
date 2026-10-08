"""Touch/scroll wire format.

Regression: action_button/buttons MUST be 0 for a touchscreen finger pointer.
scrcpy's own client always zeroes them for POINTER_ID_GENERIC_FINGER; sending
BUTTON_PRIMARY builds a MotionEvent whose button state is inconsistent with
SOURCE_TOUCHSCREEN, which some views/gesture detectors silently swallow —
exactly the "screen renders, nothing reacts to clicks" field symptom.
"""
import struct

import pytest

from app.input.touch_control import (
    TouchAction,
    TouchTracker,
    inject_drag,
    inject_long_press,
    inject_touch,
    serialize_touch,
)

POINTER_ID_GENERIC_FINGER = 0xFFFFFFFFFFFFFFFE


class _Capture:
    def __init__(self):
        self.sent: list[bytes] = []

    async def send(self, payload: bytes) -> None:
        self.sent.append(payload)


def _unpack(data: bytes):
    return struct.unpack("!BBQiiHHHii", data)


class TestSerializeTouch:
    def test_wire_format_size_and_type(self):
        data = serialize_touch(TouchAction.DOWN, 100, 200, 1280, 720)
        assert len(data) == 32
        msg_type, action, *_ = _unpack(data)
        assert msg_type == 2  # SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT
        assert action == TouchAction.DOWN

    def test_uses_generic_finger_pointer_id_not_mouse(self):
        _, _, pointer_id, *_ = _unpack(serialize_touch(TouchAction.DOWN, 0, 0, 100, 100))
        assert pointer_id == POINTER_ID_GENERIC_FINGER

    @pytest.mark.parametrize("action", [TouchAction.DOWN, TouchAction.MOVE, TouchAction.UP])
    def test_action_button_and_buttons_are_always_zero(self, action):
        """The actual regression: these fields are mouse-click semantics and
        must never be set for a simulated touchscreen finger."""
        data = serialize_touch(action, 10, 10, 1280, 720)
        *_, action_button, buttons = _unpack(data)
        assert action_button == 0
        assert buttons == 0

    def test_up_action_carries_zero_pressure(self):
        data = serialize_touch(TouchAction.UP, 5, 5, 1280, 720)
        *_, pressure, _, _ = _unpack(data)
        assert pressure == 0

    def test_down_action_carries_full_pressure(self):
        data = serialize_touch(TouchAction.DOWN, 5, 5, 1280, 720)
        *_, pressure, _, _ = _unpack(data)
        assert pressure == 0xFFFF

    def test_coordinates_and_screen_size_roundtrip(self):
        data = serialize_touch(TouchAction.DOWN, 321, 654, 1280, 720)
        _, _, _, x, y, w, h, *_ = _unpack(data)
        assert (x, y, w, h) == (321, 654, 1280, 720)

    def test_rejects_coordinates_outside_screen(self):
        with pytest.raises(ValueError):
            serialize_touch(TouchAction.DOWN, 1281, 10, 1280, 720)
        with pytest.raises(ValueError):
            serialize_touch(TouchAction.DOWN, 10, -1, 1280, 720)


class TestInjectionSequences:
    async def test_tap_like_down_up_pair_has_no_button_bits(self):
        control = _Capture()
        await inject_touch(control, 50, 50, TouchAction.DOWN, 1280, 720)
        await inject_touch(control, 50, 50, TouchAction.UP, 1280, 720)
        for payload in control.sent:
            *_, action_button, buttons = _unpack(payload)
            assert (action_button, buttons) == (0, 0)

    async def test_long_press_sends_down_then_up_after_threshold(self):
        control = _Capture()
        await inject_long_press(control, 1, 1, 1280, 720, hold_ms=1)
        actions = [_unpack(p)[1] for p in control.sent]
        assert actions == [TouchAction.DOWN, TouchAction.UP]

    async def test_drag_sends_down_moves_then_up_in_order(self):
        control = _Capture()
        path = [(0, 0), (10, 10), (20, 20)]
        await inject_drag(control, path, 1280, 720, step_ms=1)
        actions = [_unpack(p)[1] for p in control.sent]
        assert actions == [
            TouchAction.DOWN, TouchAction.MOVE, TouchAction.MOVE, TouchAction.UP
        ]

    async def test_drag_requires_at_least_two_points(self):
        with pytest.raises(ValueError):
            await inject_drag(_Capture(), [(0, 0)], 1280, 720)


class _BrokenControl:
    """A control socket that was reset under us."""

    async def send(self, payload: bytes) -> None:
        raise ConnectionResetError("control socket reset")


class TestTouchTracker:
    """A finger left down on the phone is never lifted by Android itself — the tracker lifts it when the connection ends."""

    async def test_lifts_the_finger_at_its_last_known_point(self):
        control = _Capture()
        tracker = TouchTracker()
        tracker.note(control, TouchAction.DOWN, 10, 20)
        tracker.note(control, TouchAction.MOVE, 30, 40)
        assert tracker.pressed

        assert await tracker.release(control, 1280, 720) is True

        assert not tracker.pressed
        (payload,) = control.sent
        _, action, _, x, y, *_ = _unpack(payload)
        assert (action, x, y) == (TouchAction.UP, 30, 40)

    async def test_nothing_to_lift_after_a_normal_gesture(self):
        control = _Capture()
        tracker = TouchTracker()
        tracker.note(control, TouchAction.DOWN, 5, 5)
        tracker.note(control, TouchAction.UP, 5, 5)
        assert not tracker.pressed
        assert await tracker.release(control, 1280, 720) is False
        assert control.sent == []

    async def test_a_stray_move_does_not_invent_a_finger(self):
        control = _Capture()
        tracker = TouchTracker()
        tracker.note(control, TouchAction.MOVE, 7, 7)
        assert not tracker.pressed
        assert await tracker.release(control, 1280, 720) is False
        assert control.sent == []

    async def test_release_is_idempotent(self):
        control = _Capture()
        tracker = TouchTracker()
        tracker.note(control, TouchAction.DOWN, 1, 1)
        assert await tracker.release(control, 1280, 720) is True
        assert await tracker.release(control, 1280, 720) is False
        assert len(control.sent) == 1

    async def test_a_rebuilt_control_never_receives_a_stray_up(self):
        old, rebuilt = _Capture(), _Capture()
        tracker = TouchTracker()
        tracker.note(old, TouchAction.DOWN, 1, 1)
        # the window was frozen and rebuilt: the press existed on the old control only
        assert await tracker.release(rebuilt, 1280, 720) is False
        assert rebuilt.sent == [] and old.sent == []
        assert not tracker.pressed

    async def test_a_move_on_another_control_does_not_adopt_the_finger(self):
        old, rebuilt = _Capture(), _Capture()
        tracker = TouchTracker()
        tracker.note(old, TouchAction.DOWN, 1, 1)
        tracker.note(rebuilt, TouchAction.MOVE, 9, 9)
        assert await tracker.release(old, 1280, 720) is True
        (payload,) = old.sent
        assert _unpack(payload)[3:5] == (1, 1)

    async def test_the_point_is_clamped_when_the_display_shrank_since_the_press(self):
        control = _Capture()
        tracker = TouchTracker()
        tracker.note(control, TouchAction.DOWN, 1900, 1000)
        assert await tracker.release(control, 1280, 720) is True
        (payload,) = control.sent
        assert _unpack(payload)[3:5] == (1280, 720)

    async def test_a_dead_control_socket_does_not_raise_while_closing(self):
        control = _BrokenControl()
        tracker = TouchTracker()
        tracker.note(control, TouchAction.DOWN, 1, 1)
        assert await tracker.release(control, 1280, 720) is False
        assert not tracker.pressed

    async def test_forget_drops_the_record_without_touching_the_phone(self):
        control = _Capture()
        tracker = TouchTracker()
        tracker.note(control, TouchAction.DOWN, 1, 1)
        tracker.forget()
        assert not tracker.pressed
        assert await tracker.release(control, 1280, 720) is False
        assert control.sent == []
