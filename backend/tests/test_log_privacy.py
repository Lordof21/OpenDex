"""Message contents and typed characters never reach the persistent log (backend/logs/opendex-*.log, 10 MB × 5):
notification titles/texts carry message bodies and one-time codes; the clipboard typing path carries passwords."""
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

from app.device.notification_service import _content_shape
from app.input import keyboard_control


def test_a_notification_is_logged_by_shape_only():
    item = SimpleNamespace(title="Banka", text="Doğrulama kodunuz: 482913")
    shape = _content_shape(item)
    assert "482913" not in shape and "Banka" not in shape
    assert shape == "başlık=5 metin=25 karakter"


async def test_typed_unicode_characters_are_not_logged(caplog):
    caplog.set_level(logging.DEBUG)
    await keyboard_control.inject_special_char(AsyncMock(), "ş")
    assert "ş" not in caplog.text
