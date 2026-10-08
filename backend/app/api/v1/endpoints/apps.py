"""App registry, launcher apps, and icon extraction endpoints."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Path, Response

from app.api.deps import AppContextDep
from app.apps import icon_service
from app.schemas import PACKAGE_PATTERN, AppInfo, RegistryDiff

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/apps", response_model=list[AppInfo])
async def get_apps(ctx: AppContextDep):
    """Lists launcher apps installed on the attached Android device."""
    serial = await ctx.ensure_device()
    if serial is None:
        raise HTTPException(status_code=409, detail="Cihaz bağlı değil.")
    return await ctx.app_registry.list_launcher_apps(serial)


@router.get("/apps/icon-v2/{package}")
async def get_app_icon(ctx: AppContextDep, package: str = Path(pattern=PACKAGE_PATTERN, max_length=255), force: bool = False):
    """Retrieves high-resolution app icon bytes from the on-disk cache or extracts via ADB."""
    serial = await ctx.ensure_device()
    if serial is None:
        raise HTTPException(status_code=409, detail="Cihaz bağlı değil.")
    icon_bytes = await icon_service.get_app_icon_bytes(ctx.adb, serial, package, force=force)
    if not icon_bytes:
        raise HTTPException(status_code=404, detail="Icon bulunamadı.")
    return Response(
        content=icon_bytes,
        media_type="image/png",
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/apps/icon-v2/{package}/refresh")
async def force_refresh_app_icon(ctx: AppContextDep, package: str = Path(pattern=PACKAGE_PATTERN, max_length=255)):
    """Forces re-extraction and cache update of an app icon."""
    serial = await ctx.ensure_device()
    if serial is None:
        raise HTTPException(status_code=409, detail="Cihaz bağlı değil.")
    result = await icon_service.force_reextract_icon(ctx.adb, serial, package)
    return result


@router.post("/apps/refresh", response_model=RegistryDiff)
async def refresh_apps(ctx: AppContextDep):
    """Refreshes installed app registry against device state."""
    serial = await ctx.ensure_device()
    if serial is None or ctx.android_id is None:
        raise HTTPException(status_code=409, detail="Cihaz bağlı değil.")
    return await ctx.app_registry.refresh_registry(serial, ctx.android_id)
