"""Hybrid keyboard injection.

Two paths, chosen per character by :func:`classify_char`:

  * ASCII / plain keycode-representable input  → INJECT_KEYCODE (clipboard never
    touched);
  * characters with no simple keycode (ç ğ ı ö ş ü …) → SET_CLIPBOARD of that ONE
    character with paste=true. **NO clipboard backup** — Android 10+ only lets the
    focused app or the IME *read* the clipboard; a shell-context reader silently
    gets an empty string, so a "backup" would overwrite the user's clipboard with
    nothing (worse than doing nothing). Writing still works; only reading is
    restricted. Faz 2 removes clipboard use entirely via the helper
    IME's commitText().

Shortcut layering: window-manager shortcuts (Alt+Tab, Ctrl+W) NEVER
reach this module — the frontend's windowStore consumes them. Only in-app
shortcuts (Ctrl+C/V/A/Z…) arrive here.
"""
from __future__ import annotations

import asyncio
import logging
import struct
from enum import IntEnum
from typing import Literal, Protocol

log = logging.getLogger(__name__)

_TYPE_INJECT_KEYCODE = 0
_TYPE_INJECT_TEXT = 1
_TYPE_SET_CLIPBOARD = 9

_CLIPBOARD_SEQUENCE_NONE = 0  # no ack requested


class KeyAction(IntEnum):
    DOWN = 0
    UP = 1


class MetaState(IntEnum):
    NONE = 0
    SHIFT_ON = 0x1
    ALT_ON = 0x02
    CTRL_ON = 0x1000


# Android AKEYCODE values for directly injectable input.
_ANDROID_KEYCODES: dict[str, int] = {
    **{chr(ord("a") + i): 29 + i for i in range(26)},   # KEYCODE_A..Z
    **{chr(ord("0") + i): 7 + i for i in range(10)},    # KEYCODE_0..9
    " ": 62, "\n": 66, "\t": 61,
    ",": 55, ".": 56, "-": 69, "=": 70, "/": 76, ";": 74, "'": 75,
    "[": 71, "]": 72, "\\": 73, "`": 68,
}

_NAMED_KEYCODES: dict[str, int] = {
    "enter": 66, "backspace": 67, "delete": 112, "escape": 111, "back": 4, "app_switch": 187, "android_home": 3,
    "arrowup": 19, "arrowdown": 20, "arrowleft": 21, "arrowright": 22,
    "home": 3, "end": 123, "pageup": 92, "pagedown": 93, "tab": 61,
}

_MODIFIER_META: dict[str, MetaState] = {
    "ctrl": MetaState.CTRL_ON,
    "shift": MetaState.SHIFT_ON,
    "alt": MetaState.ALT_ON,
}


class ControlWriter(Protocol):
    async def send(self, payload: bytes) -> None: ...


def classify_char(char: str) -> Literal["ascii", "special"]:
    """Decides the injection path. Characters that can be expressed as a basic unshifted keycode go ascii."""
    if len(char) != 1:
        raise ValueError("classify_char expects a single character")
    lowered = char.lower()
    if lowered in _ANDROID_KEYCODES:
        return "ascii"
    return "special"


def keycode_for(char_or_name: str) -> int | None:
    lowered = char_or_name.lower()
    if lowered in _NAMED_KEYCODES:
        return _NAMED_KEYCODES[lowered]
    return _ANDROID_KEYCODES.get(lowered)


def serialize_keycode(
    keycode: int, action: KeyAction, meta_state: int = MetaState.NONE, repeat: int = 0
) -> bytes:
    return struct.pack(
        "!BBiii", _TYPE_INJECT_KEYCODE, action, keycode, repeat, meta_state
    )


def serialize_set_clipboard(text: str, *, paste: bool) -> bytes:
    raw = text.encode("utf-8")
    return (
        struct.pack(
            "!BQB", _TYPE_SET_CLIPBOARD, _CLIPBOARD_SEQUENCE_NONE, 1 if paste else 0
        )
        + struct.pack("!I", len(raw))
        + raw
    )


async def inject_keycode(
    control: ControlWriter,
    keycode: int,
    action: KeyAction,
    meta_state: int = MetaState.NONE,
) -> None:
    await control.send(serialize_keycode(keycode, action, meta_state))


async def inject_key_press(
    control: ControlWriter, keycode: int, meta_state: int = MetaState.NONE
) -> None:
    log.info("🔌 [Keyboard:WIRE] Injecting keycode=%d meta=0x%x to scrcpy control", keycode, meta_state)
    await inject_keycode(control, keycode, KeyAction.DOWN, meta_state)
    await asyncio.sleep(0.005)
    await inject_keycode(control, keycode, KeyAction.UP, meta_state)


async def inject_special_char(control: ControlWriter, char: str) -> None:
    """Clipboard path — writes ONE character and triggers paste.
    Supports all Unicode characters including Extended-A Turkish characters (ğ, ş, ı, Ğ, Ş, İ)."""
    if classify_char(char) != "special":
        raise ValueError(f"{char!r} has a keycode; use inject_key_press instead")
    # Never the character itself: this path carries typed text (passwords with ş/ğ/ı included) into a persistent log.
    log.debug("📋 [Keyboard:CLIPBOARD] Injecting one Unicode character via clipboard paste")
    await control.send(serialize_set_clipboard(char, paste=True))


async def inject_text(control: ControlWriter, text: str) -> None:
    """Real-time typing: characters are injected as they arrive — never batched
."""
    for char in text:
        if classify_char(char) == "ascii":
            keycode = keycode_for(char)
            assert keycode is not None
            meta = MetaState.SHIFT_ON if char.isalpha() and char.isupper() else MetaState.NONE
            await inject_key_press(control, keycode, meta)
        else:
            await inject_special_char(control, char)


async def inject_shortcut(
    control: ControlWriter, modifiers: list[str], key: str
) -> None:
    """In-app shortcuts (Ctrl+C/V/A/Z): supported framework-wide by Android's own
    EditText; app-specific shortcuts work exactly as they would with a physical
    Bluetooth keyboard — no more, no less."""
    meta = MetaState.NONE
    for mod in modifiers:
        meta |= _MODIFIER_META.get(mod.lower(), MetaState.NONE)
    keycode = keycode_for(key)
    if keycode is None:
        raise ValueError(f"no Android keycode for {key!r}")
    await inject_key_press(control, keycode, meta)
