"""Per-app audio routing: the mixer's read model and its one write."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Path

from app.api.deps import AppContextDep
from app.schemas import PACKAGE_PATTERN, AppAudioPatch, AudioSyncReport
from app.streams.app_audio import TransferRefused

router = APIRouter()


@router.get("/audio/apps")
async def list_app_audio(ctx: AppContextDep) -> dict[str, Any]:
    """{supported, mode, apps, sync}: `supported` is false on Android ≤12 / an old daemon jar (single legacy stream).
    `sync` = {supported, offset_ms, pc_output_ms, link_ms, target_ms, late_extra_ms}: the "İkisi" (DeX + phone) alignment."""
    app_audio = ctx.app_audio
    return {
        "supported": app_audio.supported, "mode": app_audio.mode, "apps": app_audio.list_apps(),
        "sync": await app_audio.sync_info(),
    }


@router.put("/audio/sync")
async def put_audio_sync(body: AudioSyncReport, ctx: AppContextDep) -> dict[str, Any]:
    """The DeX page reports what it measures about its own audio: the output device's latency and how many chunks of the
    last window were too late for the common target. The phone and the page then move to a new common target (see
    streams/app_audio.py). The fine tune is a setting (`audio_sync_offset_ms` in PUT /api/settings)."""
    await ctx.app_audio.report_pc(body.pc_output_ms, body.late_chunks)
    return await ctx.app_audio.sync_info()


@router.post("/audio/clock")
async def audio_clock(ctx: AppContextDep) -> dict[str, Any]:
    """The device's monotonic clock (µs) — the clock of the audio PTS. The page calls this a few times, times each round
    trip with its own clock and keeps the quickest, to know which PTS is "now" on its side. 503 when the daemon cannot say."""
    device_us = await ctx.daemon_client.clock_us()
    if device_us is None:
        raise HTTPException(status_code=503, detail="clock_unavailable")
    return {"device_us": device_us}


@router.post("/audio/probe")
async def audio_probe(ctx: AppContextDep) -> dict[str, Any]:
    """The phone's half of the "İkisi" calibration: test tones on the phone at the instants (device-clock PTS) in the answer.
    The page plays its own tone at the matching instants, listens to both with the laptop's microphone and writes the
    fine tune (`audio_sync_offset_ms`) from the gap it hears. 409 `not_supported` when this device cannot align."""
    res = await ctx.app_audio.probe()
    if not res.get("ok"):
        raise HTTPException(status_code=409, detail=res.get("error") or "probe_failed")
    return res


@router.put("/audio/apps/{package}")
async def put_app_audio(
    body: AppAudioPatch, ctx: AppContextDep, package: str = Path(pattern=PACKAGE_PATTERN, max_length=255),
) -> dict[str, Any]:
    """Saves the package's preference (device-independent) and applies it to its open windows, if any. With
    `standalone: true` (the Media Center's transfer) an app WITHOUT a window is played on the PC too; the answer carries
    `error` when the phone could not carry it out (the transfer is then already taken back). 409 + a code
    (`not_supported`: no per-app audio on this device; `internal_package`) when it cannot start at all."""
    try:
        return await ctx.app_audio.set_prefs(
            package, route=body.route, volume=body.volume, muted=body.muted, standalone=body.standalone,
        )
    except TransferRefused as exc:
        raise HTTPException(status_code=409, detail=exc.code) from exc
