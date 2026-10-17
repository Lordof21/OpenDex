"""Touch injection over the scrcpy control socket.

Chosen over `adb shell input` (100-300ms per tap: a fresh shell each time) and raw
`sendevent` (device-specific, brittle): the control socket is a persistent
connection with millisecond timing on the infrastructure we already run.

Wire format (scrcpy v3.x INJECT_TOUCH_EVENT, 32 bytes):
    u8  type(=2)  u8 action  u64 pointerId
    i32 x  i32 y  u16 screenW  u16 screenH
    u16 pressure  i32 actionButton  i32 buttons

Hover (the pointer over the screen with no finger down) is the same message with action HOVER_MOVE and the mouse pointer id:
the scrcpy server (v3.3.1 and v4.x alike) turns exactly that pair into a SOURCE_MOUSE / TOOL_TYPE_MOUSE hover event.
"""
from __future__ import annotations

import asyncio
import struct
import time
from collections.abc import Callable
from enum import IntEnum
from typing import Protocol

_TYPE_INJECT_TOUCH_EVENT = 2
_TYPE_INJECT_SCROLL_EVENT = 3
_POINTER_ID_MOUSE = 0xFFFFFFFFFFFFFFFF
_POINTER_ID_VIRTUAL_FINGER = 0xFFFFFFFFFFFFFFFE
_POINTER_ID_SECONDARY_FINGER = 0xFFFFFFFFFFFFFFFD
_PRESSURE_FULL = 0xFFFF

# The most hover positions one connection may deliver per second. The UI already sends at the window's own frame rate
# (60 at most today); this is the ceiling that holds whatever a client does.
HOVER_MAX_HZ = 120
# A few positions may arrive back to back (timer jitter on the client, a packet that was held up): a bucket this deep absorbs
# that without ever letting the average pass HOVER_MAX_HZ.
HOVER_BURST = 4

# Android's own gesture detector recognizes long-press by DURATION — there is no
# special "long press" message type.
DEFAULT_LONG_PRESS_MS = 500
DEFAULT_DRAG_STEP_MS = 16  # ~60Hz move cadence


def resolve_pointer_id(raw_id: int | None = None) -> int:
    """Map a pointer index (0, 1) or raw 64-bit ID to scrcpy's pointerId.

    scrcpy v3 protocol uses a u64 pointerId. We reserve:
      0 / None -> _POINTER_ID_VIRTUAL_FINGER (0xFFFFFFFFFFFFFFFE)
      1        -> _POINTER_ID_SECONDARY_FINGER (0xFFFFFFFFFFFFFFFD)
      n (<100) -> (_POINTER_ID_VIRTUAL_FINGER - n) & 0xFFFFFFFFFFFFFFFF
      direct   -> raw_id & 0xFFFFFFFFFFFFFFFF
    """
    if raw_id is None or raw_id == 0:
        return _POINTER_ID_VIRTUAL_FINGER
    if raw_id == 1:
        return _POINTER_ID_SECONDARY_FINGER
    if 0 <= raw_id < 100:
        return (_POINTER_ID_VIRTUAL_FINGER - raw_id) & 0xFFFFFFFFFFFFFFFF
    return raw_id & 0xFFFFFFFFFFFFFFFF


class TouchAction(IntEnum):
    DOWN = 0  # AMOTION_EVENT_ACTION_DOWN
    UP = 1    # AMOTION_EVENT_ACTION_UP
    MOVE = 2  # AMOTION_EVENT_ACTION_MOVE
    HOVER_MOVE = 7  # AMOTION_EVENT_ACTION_HOVER_MOVE — only meaningful for the mouse pointer (see serialize_hover)


class ControlWriter(Protocol):
    async def send(self, payload: bytes) -> None: ...


def _pack_touch(action: int, pointer_id: int, x: int, y: int, screen_w: int, screen_h: int, pressure: int) -> bytes:
    # action_button/buttons are for MOUSE click semantics (ACTION_BUTTON_PRESS/
    # RELEASE) and MUST stay 0 for a touchscreen finger (POINTER_ID_GENERIC_
    # FINGER): scrcpy's own client always zeroes them for simulated touch.
    # Sending BUTTON_PRIMARY here builds a MotionEvent whose button state is
    # inconsistent with SOURCE_TOUCHSCREEN — some views/gesture detectors then
    # silently swallow the event (matches the "screen renders, zero input
    # reacts" symptom exactly). A hover has no button either.
    return struct.pack("!BBQiiHHHii", _TYPE_INJECT_TOUCH_EVENT, action, pointer_id, x, y, screen_w, screen_h, pressure, 0, 0)


def serialize_touch(
    action: TouchAction,
    x: int,
    y: int,
    screen_w: int,
    screen_h: int,
    *,
    pressure: int = _PRESSURE_FULL,
    pointer_id: int | None = None,
) -> bytes:
    if not (0 <= x <= screen_w and 0 <= y <= screen_h):
        raise ValueError(f"({x},{y}) outside screen {screen_w}x{screen_h}")
    return _pack_touch(
        action, resolve_pointer_id(pointer_id), x, y, screen_w, screen_h, pressure if action != TouchAction.UP else 0,
    )


def serialize_hover(x: int, y: int, screen_w: int, screen_h: int) -> bytes:
    """The mouse pointer resting over (x, y) with no button and no finger down. A position past the edge is pulled onto it: a
    pointer at the border of the window is a normal place for it to be, not an error."""
    return _pack_touch(
        TouchAction.HOVER_MOVE, _POINTER_ID_MOUSE, max(0, min(x, screen_w)), max(0, min(y, screen_h)), screen_w, screen_h, 0,
    )


class HoverGate:
    """Lets at most HOVER_MAX_HZ hover positions per second through one connection (a token bucket HOVER_BURST deep); the rest
    are dropped, never queued — a hover that is late is worth nothing, the next position replaces it."""

    __slots__ = ("_clock", "_tokens", "_stamp")

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._tokens = float(HOVER_BURST)
        self._stamp = clock()

    def allow(self) -> bool:
        now = self._clock()
        self._tokens = min(float(HOVER_BURST), self._tokens + (now - self._stamp) * HOVER_MAX_HZ)
        self._stamp = now
        if self._tokens < 1.0:
            return False
        self._tokens -= 1.0
        return True


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
    *,
    pointer_id: int | None = None,
) -> None:
    await control.send(serialize_touch(action, x, y, screen_w, screen_h, pointer_id=pointer_id))


async def inject_hover(control: ControlWriter, x: int, y: int, screen_w: int, screen_h: int) -> None:
    await control.send(serialize_hover(x, y, screen_w, screen_h))


class TouchTracker:
    """The fingers one input connection currently holds down on the phone.

    Android keeps a pointer pressed until it is told otherwise. When the browser tab loses focus, the page is closed
    or the socket drops between a DOWN and its UP, nothing ever sends that UP — the phone sees a finger resting on the
    glass for ever (a game character keeps walking, a list keeps being dragged). The connection therefore records what
    it pressed and lifts it itself when it ends or is told to (`release_all`).

    Supports multi-touch: tracks all active pointer IDs and ensures all of them are cleanly lifted on release.

    A press is only recorded after it was actually delivered, and it is remembered together with the control it went
    to: a window that was frozen and rebuilt has a new control, on which the old press does not exist, so a late
    release must not inject a stray UP into it.
    """

    __slots__ = ("_control", "_pointers")

    def __init__(self) -> None:
        self._control: ControlWriter | None = None
        self._pointers: dict[int, tuple[int, int]] = {}

    @property
    def pressed(self) -> bool:
        return bool(self._pointers)

    def note(
        self,
        control: ControlWriter,
        action: TouchAction,
        x: int,
        y: int,
        pointer_id: int | None = None,
    ) -> None:
        """Record a touch event that was delivered to ``control``."""
        pid = resolve_pointer_id(pointer_id)
        if action is TouchAction.DOWN:
            self._control = control
            self._pointers[pid] = (x, y)
        elif action is TouchAction.MOVE:
            # a MOVE only follows a press this connection made; a stray one must not invent a finger to lift later
            if pid in self._pointers and self._control is control:
                self._pointers[pid] = (x, y)
        else:  # UP
            self._pointers.pop(pid, None)
            if not self._pointers:
                self._control = None

    def forget(self) -> None:
        """Drop the record without touching the phone (the control that held the finger is gone)."""
        self._control = None
        self._pointers.clear()

    async def release(self, control: ControlWriter | None, screen_w: int, screen_h: int) -> bool:
        """Lift all held fingers. True when at least one UP was sent. Never raises: this runs while a connection is closing."""
        held = list(self._pointers.items())
        held_on = self._control
        self.forget()
        if not held or control is None or held_on is not control:
            return False
        sent_any = False
        # Release in reverse order (secondary fingers first, primary last)
        for pid, pos in reversed(held):
            # the display may have been resized since the press: keep the last known point inside the screen
            x = max(0, min(pos[0], screen_w))
            y = max(0, min(pos[1], screen_h))
            try:
                await inject_touch(control, x, y, TouchAction.UP, screen_w, screen_h, pointer_id=pid)
                sent_any = True
            except (ValueError, OSError):   # OSError covers a reset / broken control socket
                pass
        return sent_any

    def has_secondary_pointers(self) -> bool:
        """True if the second finger of a two-finger gesture (pointer 1: pinch / wheel scroll) is still held.

        Only that finger is meant: the keyboard mapper holds its own fingers (joystick, tap keys: pointers 2 and up) for as long
        as a key is down, and a mouse press must not lift them."""
        return _POINTER_ID_SECONDARY_FINGER in self._pointers

    async def release_secondary(self, control: ControlWriter | None, screen_w: int, screen_h: int) -> bool:
        """Lift the second finger if it is still held down."""
        if control is None or self._control is not control:
            return False
        secondary = [(pid, pos) for pid, pos in list(self._pointers.items()) if pid == _POINTER_ID_SECONDARY_FINGER]
        if not secondary:
            return False
        sent_any = False
        for pid, pos in secondary:
            self._pointers.pop(pid, None)
            x = max(0, min(pos[0], screen_w))
            y = max(0, min(pos[1], screen_h))
            try:
                await inject_touch(control, x, y, TouchAction.UP, screen_w, screen_h, pointer_id=pid)
                sent_any = True
            except (ValueError, OSError):
                pass
        return sent_any


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
