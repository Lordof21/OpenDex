"""Touch injection over the scrcpy control socket.

Chosen over `adb shell input` (100-300ms per tap: a fresh shell each time) and raw
`sendevent` (device-specific, brittle): the control socket is a persistent
connection with millisecond timing on the infrastructure we already run.

Wire format (scrcpy v3.x INJECT_TOUCH_EVENT, 32 bytes):
    u8  type(=2)  u8 action  u64 pointerId
    i32 x  i32 y  u16 screenW  u16 screenH
    u16 pressure  i32 actionButton  i32 buttons
"""
from __future__ import annotations

import asyncio
import struct
from enum import IntEnum
from typing import Protocol

_TYPE_INJECT_TOUCH_EVENT = 2
_TYPE_INJECT_SCROLL_EVENT = 3
_POINTER_ID_VIRTUAL_FINGER = 0xFFFFFFFFFFFFFFFE
_PRESSURE_FULL = 0xFFFF

# Android's own gesture detector recognizes long-press by DURATION — there is no
# special "long press" message type.
DEFAULT_LONG_PRESS_MS = 500
DEFAULT_DRAG_STEP_MS = 16  # ~60Hz move cadence


class TouchAction(IntEnum):
    DOWN = 0  # AMOTION_EVENT_ACTION_DOWN
    UP = 1    # AMOTION_EVENT_ACTION_UP
    MOVE = 2  # AMOTION_EVENT_ACTION_MOVE


class ControlWriter(Protocol):
    async def send(self, payload: bytes) -> None: ...


def serialize_touch(
    action: TouchAction,
    x: int,
    y: int,
    screen_w: int,
    screen_h: int,
    *,
    pressure: int = _PRESSURE_FULL,
) -> bytes:
    if not (0 <= x <= screen_w and 0 <= y <= screen_h):
        raise ValueError(f"({x},{y}) outside screen {screen_w}x{screen_h}")
    # action_button/buttons are for MOUSE click semantics (ACTION_BUTTON_PRESS/
    # RELEASE) and MUST stay 0 for a touchscreen finger (POINTER_ID_GENERIC_
    # FINGER): scrcpy's own client always zeroes them for simulated touch.
    # Sending BUTTON_PRIMARY here builds a MotionEvent whose button state is
    # inconsistent with SOURCE_TOUCHSCREEN — some views/gesture detectors then
    # silently swallow the event (matches the "screen renders, zero input
    # reacts" symptom exactly).
    return struct.pack(
        "!BBQiiHHHii",
        _TYPE_INJECT_TOUCH_EVENT,
        action,
        _POINTER_ID_VIRTUAL_FINGER,
        x,
        y,
        screen_w,
        screen_h,
        pressure if action != TouchAction.UP else 0,
        0,
        0,
    )


def _float_to_i16fp(value: float) -> int:
    """scrcpy fixed-point: [-1.0, 1.0] → signed 16-bit (1.0 → 0x7FFF)."""
    clamped = max(-1.0, min(1.0, value))
    return int(clamped * 0x7FFF)


def serialize_scroll(
    x: int,
    y: int,
    screen_w: int,
    screen_h: int,
    hscroll: float,
    vscroll: float,
    buttons: int = 0,
) -> bytes:
    """INJECT_SCROLL_EVENT (21 bytes): position(12) + hscroll/vscroll as i16
    fixed-point + buttons. Positive vscroll = scroll up (Android AXIS_VSCROLL)."""
    if not (0 <= x <= screen_w and 0 <= y <= screen_h):
        raise ValueError(f"({x},{y}) outside screen {screen_w}x{screen_h}")
    return struct.pack(
        "!BiiHHhhi",
        _TYPE_INJECT_SCROLL_EVENT,
        x,
        y,
        screen_w,
        screen_h,
        _float_to_i16fp(hscroll),
        _float_to_i16fp(vscroll),
        buttons,
    )


async def inject_touch(
    control: ControlWriter,
    x: int,
    y: int,
    action: TouchAction,
    screen_w: int,
    screen_h: int,
) -> None:
    await control.send(serialize_touch(action, x, y, screen_w, screen_h))


class TouchTracker:
    """The finger one input connection currently holds down on the phone.

    Android keeps a pointer pressed until it is told otherwise. When the browser tab loses focus, the page is closed
    or the socket drops between a DOWN and its UP, nothing ever sends that UP — the phone sees a finger resting on the
    glass for ever (a game character keeps walking, a list keeps being dragged). The connection therefore records what
    it pressed and lifts it itself when it ends or is told to (`release_all`).

    A press is only recorded after it was actually delivered, and it is remembered together with the control it went
    to: a window that was frozen and rebuilt has a new control, on which the old press does not exist, so a late
    release must not inject a stray UP into it.
    """

    __slots__ = ("_control", "_pos")

    def __init__(self) -> None:
        self._control: ControlWriter | None = None
        self._pos: tuple[int, int] | None = None

    @property
    def pressed(self) -> bool:
        return self._pos is not None

    def note(self, control: ControlWriter, action: TouchAction, x: int, y: int) -> None:
        """Record a touch event that was delivered to ``control``."""
        if action is TouchAction.DOWN:
            self._control, self._pos = control, (x, y)
        elif action is TouchAction.MOVE:
            # a MOVE only follows a press this connection made; a stray one must not invent a finger to lift later
            if self._pos is not None and self._control is control:
                self._pos = (x, y)
        else:  # UP
            self.forget()

    def forget(self) -> None:
        """Drop the record without touching the phone (the control that held the finger is gone)."""
        self._control, self._pos = None, None

    async def release(self, control: ControlWriter | None, screen_w: int, screen_h: int) -> bool:
        """Lift the held finger. True when an UP was sent. Never raises: this runs while a connection is closing."""
        pos, held_on = self._pos, self._control
        self.forget()
        if pos is None or control is None or held_on is not control:
            return False
        # the display may have been resized since the press: keep the last known point inside the screen
        x = max(0, min(pos[0], screen_w))
        y = max(0, min(pos[1], screen_h))
        try:
            await inject_touch(control, x, y, TouchAction.UP, screen_w, screen_h)
        except (ValueError, OSError):   # OSError covers a reset / broken control socket
            return False
        return True


async def inject_scroll(
    control: ControlWriter,
    x: int,
    y: int,
    screen_w: int,
    screen_h: int,
    hscroll: float = 0.0,
    vscroll: float = 0.0,
) -> None:
    await control.send(serialize_scroll(x, y, screen_w, screen_h, hscroll, vscroll))


async def inject_long_press(
    control: ControlWriter,
    x: int,
    y: int,
    screen_w: int,
    screen_h: int,
    hold_ms: int = DEFAULT_LONG_PRESS_MS,
) -> None:
    """DOWN → sleep(≥ Android long-press threshold) → UP."""
    await inject_touch(control, x, y, TouchAction.DOWN, screen_w, screen_h)
    await asyncio.sleep(hold_ms / 1000)
    await inject_touch(control, x, y, TouchAction.UP, screen_w, screen_h)


async def inject_drag(
    control: ControlWriter,
    path: list[tuple[int, int]],
    screen_w: int,
    screen_h: int,
    step_ms: int = DEFAULT_DRAG_STEP_MS,
    long_press_first: bool = False,
) -> None:
    """DOWN → intermediate MOVEs → UP. With ``long_press_first`` the DOWN is held
    past the long-press threshold before moving ("hold & drag")."""
    if len(path) < 2:
        raise ValueError("drag path needs at least start and end points")
    x0, y0 = path[0]
    await inject_touch(control, x0, y0, TouchAction.DOWN, screen_w, screen_h)
    if long_press_first:
        await asyncio.sleep(DEFAULT_LONG_PRESS_MS / 1000)
    for x, y in path[1:]:
        await asyncio.sleep(step_ms / 1000)
        await inject_touch(control, x, y, TouchAction.MOVE, screen_w, screen_h)
    xn, yn = path[-1]
    await inject_touch(control, xn, yn, TouchAction.UP, screen_w, screen_h)
