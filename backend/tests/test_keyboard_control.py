"""ASCII↔special split + clipboard path only for genuinely special chars."""
import struct

import pytest

from app.input.keyboard_control import (
    KeyAction,
    MetaState,
    classify_char,
    inject_special_char,
    inject_shortcut,
    inject_text,
    keycode_for,
    serialize_keycode,
    serialize_set_clipboard,
)


class _Capture:
    def __init__(self):
        self.sent: list[bytes] = []

    async def send(self, payload: bytes) -> None:
        self.sent.append(payload)


class TestClassification:
    @pytest.mark.parametrize("char", list("abcz09 .,-/"))
    def test_ascii_chars_use_keycode_path(self, char):
        assert classify_char(char) == "ascii"

    @pytest.mark.parametrize("char", list("çğıöşüÇĞİÖŞÜ€"))
    def test_turkish_and_symbol_chars_use_clipboard_path(self, char):
        assert classify_char(char) == "special"

    def test_multi_char_rejected(self):
        with pytest.raises(ValueError):
            classify_char("ab")


class TestSerialization:
    def test_keycode_wire_format(self):
        data = serialize_keycode(29, KeyAction.DOWN, MetaState.CTRL_ON)
        msg_type, action, keycode, repeat, meta = struct.unpack("!BBiii", data)
        assert (msg_type, action, keycode, repeat, meta) == (0, 0, 29, 0, 0x1000)

    def test_clipboard_wire_format_carries_paste_flag(self):
        data = serialize_set_clipboard("ç", paste=True)
        assert data[0] == 9  # SET_CLIPBOARD
        sequence = int.from_bytes(data[1:9], "big")
        paste = data[9]
        length = int.from_bytes(data[10:14], "big")
        assert sequence == 0 and paste == 1
        assert data[14:] == "ç".encode("utf-8") and length == len("ç".encode("utf-8"))


class TestInjection:
    async def test_special_char_goes_to_clipboard_no_backup_traffic(self):
        control = _Capture()
        await inject_special_char(control, "ğ")
        assert len(control.sent) == 1           # ONE write: set+paste, no read/backup
        assert control.sent[0][0] == 9          # _TYPE_SET_CLIPBOARD

    async def test_special_char_path_rejects_ascii(self):
        with pytest.raises(ValueError):
            await inject_special_char(_Capture(), "a")

    async def test_mixed_text_routes_each_char_correctly(self):
        control = _Capture()
        await inject_text(control, "aç")
        # 'a' → keycode DOWN + UP (2 packets), 'ç' → clipboard (1 packet)
        assert [p[0] for p in control.sent] == [0, 0, 9]

    async def test_uppercase_ascii_carries_shift_meta(self):
        control = _Capture()
        await inject_text(control, "A")
        _, _, _, _, meta = struct.unpack("!BBiii", control.sent[0])
        assert meta == MetaState.SHIFT_ON

    async def test_shortcut_combines_modifier_meta(self):
        control = _Capture()
        await inject_shortcut(control, ["ctrl"], "c")
        _, _, keycode, _, meta = struct.unpack("!BBiii", control.sent[0])
        assert keycode == keycode_for("c")
        assert meta == MetaState.CTRL_ON
