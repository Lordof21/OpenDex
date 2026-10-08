"""Global application settings and desktop layout endpoints."""
from __future__ import annotations

import contextlib
import logging

from fastapi import APIRouter, HTTPException

from app.api.deps import AppContextDep
from app.schemas import AppLayoutEntry, ProjectSettings
from app.storage import settings_db

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/settings", response_model=ProjectSettings)
async def get_settings_endpoint():
    """Retrieves current global project settings."""
    return await settings_db.get_project_settings()


@router.put("/settings", response_model=ProjectSettings)
async def put_settings(body: ProjectSettings, ctx: AppContextDep):
    """Updates settings and applies live quality/audio reconfigurations."""
    previous = await settings_db.get_project_settings()

    _MODE_TO_MAX_SIZE = {
        "fixed_1080p": 1920,
        "1080p": 1920,
        "fixed_1200p": 1920,
        "tablet": 1920,
        "fixed_1440p": 2560,
        "2k": 2560,
        "fixed_1600p": 2560,
        "2.5k": 2560,
        "dynamic": 0,
        "dynamic_fit": 0,
        "dynamic_fix": 0,
    }
    derived = _MODE_TO_MAX_SIZE.get(body.resolution_mode)
    if derived is not None and body.dynamic_resolution_enabled:
        body = body.model_copy(update={"max_size": derived})

    # Whenever the user selects DeX (pc) or İkisi (both) output, audio must be enabled and raw PCM codec used
    if body.audio_output_mode in ("pc", "both"):
        body = body.model_copy(update={"enable_audio": True, "audio_codec": "raw"})

    await settings_db.save_project_settings(body)

    serial = ctx.serial or (await ctx.ensure_device())
    if body.enable_audio and body.audio_output_mode in ("pc", "both"):
        if serial:
            try:
                await ctx.session_audio.start_session_audio(serial, output_mode=body.audio_output_mode)
            except Exception as exc:
                log.warning("start_session_audio failed on settings update: %s", exc)
    else:
        if serial:
            with contextlib.suppress(Exception):
                await ctx.session_audio.stop_session_audio(serial=serial)

    if (previous.audio_output_mode, previous.enable_audio) != (body.audio_output_mode, body.enable_audio):
        # Per-app audio: windows whose app has no saved preference follow the new default route.
        await ctx.app_audio.on_default_route_changed()

    if previous.audio_sync_offset_ms != body.audio_sync_offset_ms:
        # "İkisi": the fine tune applies at once (the phone's playout is retuned in place).
        await ctx.app_audio.on_sync_changed()

    quality_changed = (
        previous.max_fps != body.max_fps
        or previous.video_bit_rate != body.video_bit_rate
        or getattr(previous, "video_codec", "auto") != getattr(body, "video_codec", "auto")
        or (previous.max_size != body.max_size and not body.dynamic_resolution_enabled)
    )
    if quality_changed:
        await ctx.window_manager.apply_quality_settings()
    return body


@router.get("/layout", response_model=list[AppLayoutEntry])
async def get_layout(ctx: AppContextDep):
    """Retrieves saved desktop icon grid layout for current device."""
    if ctx.android_id is None:
        return []
    return await settings_db.get_app_layout(ctx.android_id)


@router.put("/layout", response_model=list[AppLayoutEntry])
async def put_layout(body: list[AppLayoutEntry], ctx: AppContextDep):
    """Persists desktop icon positions for current device."""
    if ctx.android_id is None:
        raise HTTPException(status_code=409, detail="Cihaz bağlı değil.")
    await settings_db.save_app_layout(ctx.android_id, body)
    return body
