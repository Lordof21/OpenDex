"""Touch and keyboard input injection endpoints."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import AppContextDep
from app.input import keyboard_control, keyboard_setup, touch_control
from app.input.touch_control import TouchAction
from app.windows.mirror_packages import is_mirror_package

log = logging.getLogger(__name__)
router = APIRouter()


class TouchRequest(BaseModel):
    window_id: str
    type: Literal["tap", "down", "move", "up", "long_press", "drag", "scroll"]
    x: int = 0
    y: int = 0
    path: list[tuple[int, int]] | None = None
    long_press_first: bool = False
    hscroll: float = 0.0  # scroll only, [-1.0, 1.0]
    vscroll: float = 0.0  # positive = scroll up (Android AXIS_VSCROLL)


class KeyRequest(BaseModel):
    window_id: str
    kind: Literal["keycode", "char", "text", "shortcut"]
    key: str | None = None        # named key for keycode/shortcut ("enter", "c"…)
    char: str | None = None       # single char for the clipboard path
    text: str | None = None       # real-time text (injected char by char)
    modifiers: list[str] = Field(default_factory=list)


def _get_control_session(ctx, window_id: str):
    session = ctx.window_manager.get_session(window_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Pencere bulunamadı.")
    if session.control is None:
        raise HTTPException(status_code=409, detail="Pencerenin control soketi yok (frozen?).")
    return session


@router.post("/input/touch")
async def input_touch(body: TouchRequest, ctx: AppContextDep):
    """Fallback REST touch injection for non-streaming clients."""
    session = _get_control_session(ctx, body.window_id)
    control = session.control
    w, h = session.display_w, session.display_h
    try:
        if body.type == "tap":
            await touch_control.inject_touch(control, body.x, body.y, TouchAction.DOWN, w, h)
            await touch_control.inject_touch(control, body.x, body.y, TouchAction.UP, w, h)
        elif body.type == "long_press":
            await touch_control.inject_long_press(control, body.x, body.y, w, h)
        elif body.type == "drag":
            if not body.path:
                raise HTTPException(status_code=422, detail="drag için path gerekli.")
            await touch_control.inject_drag(
                control, body.path, w, h, long_press_first=body.long_press_first
            )
        elif body.type == "scroll":
            await touch_control.inject_scroll(
                control, body.x, body.y, w, h, body.hscroll, body.vscroll
            )
        else:
            action = TouchAction[body.type.upper()]
            await touch_control.inject_touch(control, body.x, body.y, action, w, h)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/input/key")
async def input_key(body: KeyRequest, ctx: AppContextDep):
    """Injects key events, typed characters, or desktop shortcuts."""
    session = _get_control_session(ctx, body.window_id)
    control = session.control
    pkg = session.state.package

    # Handle Android Back Key with Root Activity Guard
    is_back = body.kind == "keycode" and (str(body.key).lower() == "back" or str(body.key) == "4")
    if is_back:
        # Protect window from AppPresence auto-close if the app finishes at root
        session.back_protect_until = time.monotonic() + 4.0
        log.info("🔙 [Keyboard:BACK 📥] win=%s (%s) Back key injection initiated", body.window_id, pkg)
        try:
            await keyboard_control.inject_key_press(control, 4)
            log.info("✅ [Keyboard:BACK] Keycode 4 injected into %s", pkg)
        except Exception as exc:
            log.error("❌ [Keyboard:BACK] Failed to inject keycode 4 into %s: %s", pkg, exc)
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        # Verify on virtual display whether the app finished (was at true root)
        display_id = ctx.window_manager.get_display_for_session(session)
        is_mirror = is_mirror_package(pkg) or display_id in (None, "0")
        if not is_mirror and display_id:
            at_root = False
            # Check over ~400ms: in-app navigation stays alive & visible; root exit becomes invisible/removed
            for delay in (0.12, 0.15, 0.15):
                await asyncio.sleep(delay)
                alive, visible = await ctx.window_manager.is_package_visible_on_display(pkg, display_id)
                if not alive or not visible:
                    at_root = True
                    break

            if at_root:
                log.info(
                    "[RootActivityGuard 🛡️] App %s exited on Back at root; reviving on win=%s to prevent blank display",
                    pkg,
                    body.window_id,
                )
                await ctx.window_manager.start_app_in_window(pkg)
                return {
                    "ok": True,
                    "at_root": True,
                    "status": "at_root",
                    "message": "Başlangıç noktasındasınız",
                }
        return {"ok": True, "at_root": False}

    log.info(
        "⌨️ [Keyboard:API 📥] win=%s (%s) kind=%s key=%s char=%s text=%s mod=%s",
        body.window_id,
        session.state.package,
        body.kind,
        body.key,
        body.char,
        body.text,
        body.modifiers,
    )
    try:
        if body.kind == "keycode":
            if not body.key:
                raise HTTPException(status_code=422, detail="key gerekli.")
            keycode = keyboard_control.keycode_for(body.key)
            if keycode is None:
                raise HTTPException(status_code=422, detail=f"Keycode yok: {body.key}")
            await keyboard_control.inject_key_press(control, keycode)
        elif body.kind == "char":
            if not body.char:
                raise HTTPException(status_code=422, detail="char gerekli.")
            if keyboard_control.classify_char(body.char) == "ascii":
                keycode = keyboard_control.keycode_for(body.char)
                assert keycode is not None
                meta = (
                    keyboard_control.MetaState.SHIFT_ON
                    if body.char.isalpha() and body.char.isupper()
                    else keyboard_control.MetaState.NONE
                )
                await keyboard_control.inject_key_press(control, keycode, meta)
            else:
                await keyboard_control.inject_special_char(control, body.char)
        elif body.kind == "text":
            if body.text is None:
                raise HTTPException(status_code=422, detail="text gerekli.")
            await keyboard_control.inject_text(control, body.text)
        elif body.kind == "shortcut":
            if not body.key:
                raise HTTPException(status_code=422, detail="key gerekli.")
            await keyboard_control.inject_shortcut(control, body.modifiers, body.key)
        log.info("✅ [Keyboard:SUCCESS] Key injected successfully into %s", session.state.package)
    except Exception as exc:
        log.error("❌ [Keyboard:FAILED] Injection error for %s: %s", session.state.package, exc)
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"ok": True, "at_root": False}


@router.get("/keyboard/layout-status")
async def keyboard_layout_status(ctx: AppContextDep):
    """Checks whether Turkish/Q layout setup notice has been dismissed."""
    if ctx.android_id is None:
        return {"configured": False}
    return {"configured": await keyboard_setup.is_layout_configured(ctx.android_id)}


@router.post("/keyboard/open-layout-settings")
async def keyboard_open_layout_settings(ctx: AppContextDep):
    """Directs phone to physical keyboard configuration intent."""
    if ctx.serial is None:
        raise HTTPException(status_code=409, detail="Cihaz bağlı değil.")
    await keyboard_setup.open_layout_settings(ctx.adb, ctx.serial)
    return {"ok": True}


@router.post("/keyboard/mark-configured")
async def keyboard_mark_configured(ctx: AppContextDep):
    """Marks keyboard configuration as completed for current device."""
    if ctx.android_id is None:
        raise HTTPException(status_code=409, detail="Cihaz bağlı değil.")
    await keyboard_setup.mark_layout_configured(ctx.android_id)
    return {"ok": True}
