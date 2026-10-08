"""Encoder capability discovery — query, don't guess.

Order of trust:
  1. ``media_codecs.xml`` ``concurrent-instances`` value — the number OEMs are
     CTS-obliged to publish (AOSP sample for H.264: 13).
  2. Real open-until-failure verification (CTS approach). Opening N MediaCodec
     instances requires an on-device execution context; wired through the scrcpy
     session as a follow-up measurement task (plan: "Açık Teknik Risk" §) —
     until then the XML value is used with the documented caveat that it is an
     upper-bound estimate.
  3. ``FALLBACK_ENCODER_LIMIT`` from config when nothing can be read.

Results are cached per ANDROID_ID in SQLite so the probe runs once per device.
"""
from __future__ import annotations

import logging
import re

from ..config import Settings
from ..schemas import DeviceProfile
from ..storage import settings_db
from . import android_shell
from .adb import Adb, AdbError
from .device_manager import DeviceManager

log = logging.getLogger(__name__)

_MEDIA_CODECS_PATHS = (
    "/vendor/etc/media_codecs_c2.xml",
    "/vendor/etc/media_codecs.xml",
    "/vendor/etc/media_codecs_performance.xml",
    "/vendor/etc/media_codecs_system_default.xml",
    "/odm/etc/media_codecs.xml",
    "/system/etc/media_codecs.xml",
    "/etc/media_codecs.xml",
)


def parse_concurrent_instances(xml_text: str, mime: str = "video/avc") -> int | None:
    """Extracts ``<Limit name="concurrent-instances" max="N"/>`` for the codec
    block whose ``type`` matches *mime* (encoder blocks preferred)."""
    best: int | None = None
    for block in re.finditer(r"<MediaCodec\b[^>]*>(?:(?!</MediaCodec>).)*</MediaCodec>", xml_text, re.S):
        text = block.group(0)
        if f'type="{mime}"' not in text:
            continue
        m = re.search(r'concurrent-instances"\s+max="(\d+)"', text)
        if not m:
            continue
        value = int(m.group(1))
        if best is None or value > best:
            best = value
    return best


class CapabilityProbe:
    def __init__(self, adb: Adb, devices: DeviceManager, settings: Settings) -> None:
        self._adb = adb
        self._devices = devices
        self._settings = settings

    async def probe_encoder_limit(self, serial: str, codec_mime: str = "video/avc") -> int:
        for path in _MEDIA_CODECS_PATHS:
            try:
                xml_text = await self._adb.shell(f"cat {path}", serial=serial)
            except AdbError:
                continue
            limit = parse_concurrent_instances(xml_text, codec_mime)
            if limit:
                log.info("encoder limit from %s: %d", path, limit)
                return limit
            if codec_mime == "video/avc":
                hevc_limit = parse_concurrent_instances(xml_text, "video/hevc")
                if hevc_limit:
                    log.info("encoder limit from %s (hevc fallback): %d", path, hevc_limit)
                    return hevc_limit
        log.warning(
            "concurrent-instances not published by OEM; falling back to %d",
            self._settings.FALLBACK_ENCODER_LIMIT,
        )
        return self._settings.FALLBACK_ENCODER_LIMIT

    async def probe_and_cache(self, serial: str, android_id: str) -> DeviceProfile:
        """Runs once when a device first connects; persists under ANDROID_ID."""
        encoder_limit = await self.probe_encoder_limit(serial)
        api = await self._devices.get_android_version(serial)
        profile = DeviceProfile(
            android_id=android_id, encoder_limit=encoder_limit, android_api=api
        )
        await settings_db.save_device_profile(android_id, profile)
        return profile

    async def refresh_phone_metrics(self, serial: str, profile: DeviceProfile) -> DeviceProfile:
        """Re-reads the phone panel's size/density on every connect (the user may have changed the display size /
        smallest width while OpenDeX was away). While connected the daemon pushes such a change by itself
        (main.py → apply_phone_display). The profile is updated IN PLACE: it is the one WindowManager and
        GET /api/device/profile hand out."""
        display = await android_shell.read_phone_display(self._adb, serial)
        if display is None:
            log.info("phone metrics unreadable on %s; phone_scale stays unavailable", serial)
            return profile
        await self.apply_phone_display(profile, display)
        return profile

    async def apply_phone_display(self, profile: DeviceProfile, display: android_shell.PhoneDisplay) -> bool:
        """Writes the phone panel into ``profile`` (in place) and persists it. True when anything changed."""
        short, long_ = sorted((display.width, display.height))
        metrics = (short, long_, display.density)
        if (profile.phone_width, profile.phone_height, profile.phone_density) == metrics:
            return False
        profile.phone_width, profile.phone_height, profile.phone_density = metrics
        await settings_db.save_device_profile(profile.android_id, profile)
        log.info(
            "phone metrics: %dx%d @ %d dpi (smallest width %d dp, %s)", *metrics, display.smallest_width_dp, display.source,
        )
        return True

    async def get_cached_profile(self, android_id: str) -> DeviceProfile | None:
        return await settings_db.get_device_profile(android_id)

    async def get_or_probe(self, serial: str, android_id: str) -> DeviceProfile:
        cached = await self.get_cached_profile(android_id)
        if cached is not None and cached.encoder_limit >= 8:
            return cached
        return await self.probe_and_cache(serial, android_id)

