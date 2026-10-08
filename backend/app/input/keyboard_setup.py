"""One-time TR hard-keyboard layout onboarding.

We cannot set the layout ourselves (system-app permission); we deep-link the user
to the exact settings screen and remember their confirmation per device — same
"can't automate, but route correctly" principle as the laptop-hotspot decision.
"""
from __future__ import annotations

import logging

from ..device.adb import Adb
from ..storage import settings_db

log = logging.getLogger(__name__)


async def is_layout_configured(android_id: str) -> bool:
    profile = await settings_db.get_device_profile(android_id)
    return bool(profile and profile.keyboard_layout_configured)


async def open_layout_settings(adb: Adb, serial: str) -> None:
    await adb.shell(
        "am start -a android.settings.HARD_KEYBOARD_SETTINGS", serial=serial
    )
    log.info("opened hard-keyboard settings on device")


async def mark_layout_configured(android_id: str) -> None:
    """User confirmed "yaptım" — never ask again for this device."""
    profile = await settings_db.get_device_profile(android_id)
    if profile is None:
        log.warning("no device profile for %s; cannot persist layout flag", android_id)
        return
    profile.keyboard_layout_configured = True
    await settings_db.save_device_profile(android_id, profile)
