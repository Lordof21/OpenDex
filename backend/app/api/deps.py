"""Shared API dependencies and modern FastAPI Annotated Dependency Injection."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import Depends, HTTPException, Request


def get_ctx(request: Request):
    """Retrieves the singleton AppContext from request/app state."""
    ctx = getattr(request.state, "ctx", None) or getattr(request.app.state, "ctx", None)
    if ctx is None:
        raise HTTPException(status_code=500, detail="AppContext not initialized on app.state.")
    return ctx


def get_active_serial(request: Request) -> str:
    """Returns the currently active device serial or raises 409 if no device is connected."""
    ctx = get_ctx(request)
    if not ctx.serial:
        raise HTTPException(status_code=409, detail="Cihaz bağlı değil.")
    return ctx.serial


AppContextDep = Annotated[Any, Depends(get_ctx)]
# The bound device's serial as a parameter, or 409 — for a route that only needs the guard: dependencies=[RequireDevice].
ActiveSerialDep = Annotated[str, Depends(get_active_serial)]
RequireDevice = Depends(get_active_serial)
