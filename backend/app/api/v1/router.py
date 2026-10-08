"""OpenDeX API v1 Central Router.

Aggregates all sub-routers from endpoints/ into a single cohesive api_router.
"""
from fastapi import APIRouter

from .endpoints import (
    apps,
    audio,
    devices,
    diagnostics,
    fs,
    input,
    notifications,
    pairing,
    settings,
    telemetry,
    windows,
)

api_router = APIRouter()

api_router.include_router(devices.router, tags=["devices"])
api_router.include_router(pairing.router, tags=["pairing"])
api_router.include_router(apps.router, tags=["apps"])
api_router.include_router(windows.router, tags=["windows"])
api_router.include_router(settings.router, tags=["settings"])
api_router.include_router(audio.router, tags=["audio"])
api_router.include_router(input.router, tags=["input"])
api_router.include_router(notifications.router, tags=["notifications"])
api_router.include_router(diagnostics.router, tags=["diagnostics"])
api_router.include_router(telemetry.router, tags=["telemetry"])
api_router.include_router(fs.router, tags=["fs"])
