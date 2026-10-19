"""The backend process itself (app/lifecycle.py)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app import lifecycle

router = APIRouter(prefix="/system", tags=["system"])


@router.post("/shutdown", status_code=202)
async def shutdown():
    """Ends the backend gracefully — the desktop shell's "quit": windows close and the phone's servers stop before the
    process exits. 409 when this process was not started by the backend's own runner (nothing to stop)."""
    if not lifecycle.request_exit("api"):
        raise HTTPException(status_code=409, detail="Bu süreç kapatılamaz (sunucu backend tarafından başlatılmadı).")
    return {"ok": True}
