"""adb on this computer: is there one, install Google's platform-tools, or use the one the user picked.

These are the boot screen's calls (frontend/src/startup/AdbSetupPanel.jsx). The boot screen polls `GET /adb` while an install
runs; the rest is one-shot. Nothing here talks to the phone."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import AppContextDep
from app.device.adb_setup import AdbSetupError

router = APIRouter()


class AdbLocateRequest(BaseModel):
    path: str = Field(..., min_length=1, max_length=1024)


@router.get("/adb")
async def get_adb(ctx: AppContextDep) -> dict[str, Any]:
    """{state: checking|ok|missing, path, version, source: env|chosen|path|managed|sdk, install: {phase: idle|manifest|download|
    verify|extract|done|error, received, total, error, version}, can_install, install_dir, download_page}. In memory: it runs
    nothing, so it is cheap to poll while an install runs."""
    return ctx.adb_setup.snapshot()


@router.post("/adb/recheck")
async def recheck_adb(ctx: AppContextDep) -> dict[str, Any]:
    """Looks for adb again ("Tekrar ara": the user installed one in the meantime) and returns the snapshot."""
    return await ctx.adb_setup.inspect()


@router.post("/adb/install")
async def install_adb(ctx: AppContextDep) -> dict[str, Any]:
    """Installs Google's official platform-tools (newest stable, SHA-1 checked against Google's manifest) into the OpenDeX
    folder and uses it. Returns at once with the snapshot; poll `GET /adb` for `install.phase`. Already running: no second one."""
    return await ctx.adb_setup.install()


@router.post("/adb/install/cancel")
async def cancel_adb_install(ctx: AppContextDep) -> dict[str, Any]:
    """Stops a running install and removes what it started. Nothing running: nothing happens."""
    return await ctx.adb_setup.cancel_install()


@router.post("/adb/locate")
async def locate_adb(body: AdbLocateRequest, ctx: AppContextDep) -> dict[str, Any]:
    """Uses the adb the user picked. 422 `detail` = `not_found` (no such file) | `not_adb` (not called adb[.exe]) | `broken`
    (it does not run). On success the choice is remembered for the next start."""
    try:
        return await ctx.adb_setup.locate(body.path)
    except AdbSetupError as exc:
        raise HTTPException(status_code=422, detail=exc.code) from exc
