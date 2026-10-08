"""Telemetry endpoints: live per-app CPU/stream rates (/telemetry) and device-load history (/telemetry/load)."""
from __future__ import annotations

from fastapi import APIRouter, Query

from app.api.deps import AppContextDep

router = APIRouter(tags=["telemetry"])


@router.get("/telemetry")
async def get_telemetry(ctx: AppContextDep):
    """One shared, cached sample (younger than ~1 s is reused): polling it from several panels costs one adb round trip.
    A figure that could not be measured is `null`, never 0."""
    return await ctx.telemetry.snapshot()


@router.get("/telemetry/load")
async def get_device_load(ctx: AppContextDep, minutes: float = Query(default=15.0, ge=1.0, le=120.0)):
    """Samples of the last `minutes`, the markers on the same timeline, current findings and background command
    rates. `active` is False while no phone is bound (the history of the last session is still returned)."""
    return ctx.load_monitor.snapshot(minutes)
