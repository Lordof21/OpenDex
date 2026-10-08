"""Pencereler açıkken telefon uyutulmaz; kapanınca kullanıcının KENDİ değeri geri gelir (device/phone_awake.py)."""
import re

import pytest

from app.device.phone_awake import ORIGINAL_KEY, SETTING, PhoneAwakeLease


class _Phone:
    """`settings get/put/delete global` yapan sahte cihaz."""

    def __init__(self, **globals_):
        self.g = dict(globals_)

    async def shell(self, cmd, serial=None, timeout_s=None):
        m = re.fullmatch(r"settings (get|put|delete) global (\w+)(?: (\S+))?", cmd)
        verb, key, value = m.groups()
        if verb == "put":
            self.g[key] = value
        elif verb == "delete":
            self.g.pop(key, None)
        return self.g.get(key, "null") if verb == "get" else ""


def _lease(phone, live):
    return PhoneAwakeLease(phone, lambda: "SER", lambda: live[0])


@pytest.mark.asyncio
async def test_held_while_windows_exist_and_the_users_own_value_comes_back():
    phone, live = _Phone(**{SETTING: "3"}), [False]
    lease = _lease(phone, live)

    live[0] = True
    await lease.sync()
    assert phone.g[SETTING] == "7" and phone.g[ORIGINAL_KEY] == "3"

    live[0] = False
    await lease.sync()
    assert phone.g[SETTING] == "3" and ORIGINAL_KEY not in phone.g


@pytest.mark.asyncio
async def test_a_crashed_session_is_undone_on_the_next_bind_and_never_overwrites_the_original():
    phone, live = _Phone(**{SETTING: "7", ORIGINAL_KEY: "0"}), [False]   # arka uç 7'yi yazıp çöktü
    await _lease(phone, live).sync()                                      # yeni oturum, pencere yok
    assert phone.g[SETTING] == "0" and ORIGINAL_KEY not in phone.g

    phone, live = _Phone(**{SETTING: "7", ORIGINAL_KEY: "0"}), [True]    # çökme sonrası pencere açık geldi
    await _lease(phone, live).sync()
    assert phone.g[ORIGINAL_KEY] == "0"                                   # 7, "özgün" diye yedeklenmedi
