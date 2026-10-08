"""Encoder capacity stress test (capability_probe.py tier-2 follow-up).

Empirically measures how many concurrent virtual-display/encoder sessions a
device actually supports — the "real open-until-failure verification"
CapabilityProbe's own docstring calls out as an unimplemented follow-up (the
media_codecs.xml value it starts with is only an OEM-published upper-bound
estimate, never independently verified).

Opens throwaway, app-less, minimal-quality virtual displays one at a time (no
START_APP, no control socket — a bare ``new_display=`` is already enough to
allocate a real hardware encoder) until one fails or a safety cap is hit,
then tears every one of them down. These probe sessions are intentionally
NEVER registered into WindowManager._sessions — they must stay invisible to
list_windows(), _active_encoder_count(), and budget reallocation.

Opt-in and manually triggered only (never automatic, never called from
anywhere but the dedicated endpoint): requires zero real windows open, so a
probe can never contend with — or get miscounted against — the live encoder
budget a real session assumes it owns.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging

from ..config import Settings
from ..device.adb import Adb
from ..schemas import DeviceProfile, EncoderStressTestResult
from ..storage import settings_db
from .scrcpy_launcher import ScrcpyServer

log = logging.getLogger(__name__)


class StressTestBusyError(RuntimeError):
    """Encoder stress test refused: at least one real window is already open."""


async def _open_stress_probe(
    server: ScrcpyServer,
    width: int,
    height: int,
    max_fps: int,
    video_bit_rate: int,
) -> None:
    """Real-world stress probe: tests full operational quality (720p/1080p,
    60 FPS, 8-12 Mbps) to measure the device's true hardware VPU / bandwidth
    ceiling under real-life multi-window usage conditions."""
    await server.push_server()
    await server.start_forward()
    await server.spawn(
        control=False,
        video=True,
        audio=False,
        new_display=f"{width}x{height}",
        max_fps=max_fps,
        video_bit_rate=video_bit_rate,
    )
    await server.connect_sockets(video=True, audio=False, control=False)


async def run_encoder_stress_test(
    adb: Adb,
    settings: Settings,
    serial: str,
    android_id: str,
    profile: DeviceProfile,
    *,
    has_open_sessions: bool,
) -> EncoderStressTestResult:
    """Runs the probe device-side and persists a verified ``encoder_limit`` on
    *profile* (mutated in place — the same object the caller already holds)
    whenever at least one concurrent session succeeds.

    Caller (WindowManager.run_encoder_stress_test) is responsible for holding
    the device-wide lifecycle lock for the duration of this call — this
    function itself has no opinion on that, it only refuses to run at all
    while real windows are open (``has_open_sessions``).
    """
    if has_open_sessions:
        raise StressTestBusyError("Test için önce tüm açık pencereler kapatılmalıdır.")

    project = await settings_db.get_project_settings()
    opened: list[ScrcpyServer] = []
    failure_reason: str | None = None

    probe_w = settings.STRESS_TEST_PROBE_DISPLAY_W
    probe_h = settings.STRESS_TEST_PROBE_DISPLAY_H
    if project.max_size and project.max_size > 0:
        probe_w = project.max_size
        probe_h = round(probe_w * 9 / 16)
    probe_fps = project.max_fps or settings.STRESS_TEST_PROBE_MAX_FPS
    probe_bitrate = project.video_bit_rate or settings.STRESS_TEST_PROBE_VIDEO_BIT_RATE

    try:
        for attempt in range(1, settings.STRESS_TEST_MAX_ATTEMPTS + 1):
            server = ScrcpyServer(adb, settings, serial)
            try:
                await asyncio.wait_for(
                    _open_stress_probe(server, probe_w, probe_h, probe_fps, probe_bitrate),
                    timeout=settings.STRESS_TEST_ATTEMPT_TIMEOUT_S,
                )
            except Exception as exc:
                failure_reason = str(exc)
                log.info(
                    "encoder stress test: attempt %d failed (%s) — %d concurrent session(s) confirmed",
                    attempt, exc, len(opened),
                )
                # This attempt's server may have partially spawned a real
                # on-device process even though the overall attempt failed
                # (e.g. spawn() succeeded but connect_sockets() timed out)
                # — always try to tear it down too, not just the ones that
                # fully succeeded (those are handled in `finally` below).
                with contextlib.suppress(Exception):
                    await server.stop()
                break
            opened.append(server)
    finally:
        for server in opened:
            with contextlib.suppress(Exception):
                await server.stop()

    succeeded = len(opened)
    capped_by_safety_limit = succeeded == settings.STRESS_TEST_MAX_ATTEMPTS
    previous_limit = profile.encoder_limit

    if succeeded > 0:
        # Ranked above the XML/fallback estimate per CapabilityProbe's own
        # documented trust order — persisted even if LOWER than the
        # previously-cached value, since this is a real measurement.
        profile.encoder_limit = succeeded
        profile.encoder_limit_verified = True
        await settings_db.save_device_profile(android_id, profile)
    # A degenerate zero-success run (e.g. a transient ADB hiccup on the
    # very first attempt) must not regress a previously-good cached value
    # — leave the existing profile untouched.

    return EncoderStressTestResult(
        measured_encoder_limit=succeeded,
        previous_encoder_limit=previous_limit,
        capped_by_safety_limit=capped_by_safety_limit,
        failure_reason=failure_reason if succeeded == 0 else None,
        profile=profile,
    )
