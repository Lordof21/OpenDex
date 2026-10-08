"""Notification events and system notification routing endpoints.

The deep-navigation engine itself (AOSP intent resolution, Tier 1/2/3
launch strategies, AppLock coordination) lives in
``app/device/deep_navigator.py`` — this module is route definitions only.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import AppContextDep, RequireDevice
from app.device.deep_navigator import (
    _execute_deep_navigation,
    _get_display_id,
    invoke_notification_click,
)
from app.device.media_control import get_media_status as _get_media_status
from app.device.media_control import send_media_action
from app.device.media_control import send_media_seek as _send_media_seek
from app.schemas import MediaAction, PackageName

log = logging.getLogger(__name__)
router = APIRouter()


class DismissNotificationRequest(BaseModel):
    id: str


class OpenNotificationRequest(BaseModel):
    package: PackageName
    id: str | None = None
    android_key: str | None = None
    title: str | None = None
    text: str | None = None


class InvokeActionRequest(BaseModel):
    id: str
    action_id: int


class MediaSeekRequest(BaseModel):
    position: int = Field(ge=0, le=24 * 60 * 60 * 1000)  # milliseconds
    package: PackageName | None = None


class MediaActionRequest(BaseModel):
    action: MediaAction
    package: PackageName | None = None


@router.get("/notifications")
async def list_notifications(ctx: AppContextDep):
    """Lists current active Android notifications with rich metadata."""
    return ctx.notifications.get_notifications()


@router.post("/notifications/dismiss")
async def dismiss_notification(body: DismissNotificationRequest, ctx: AppContextDep):
    """Dismisses an individual notification by ID on both PC and Android phone."""
    if not body.id:
        raise HTTPException(status_code=400, detail="Missing notification id")
    success = await ctx.notifications.dismiss_notification(body.id)
    return {"ok": success}


@router.post("/notifications/clear_all")
async def clear_all_notifications(ctx: AppContextDep):
    """Clears all notifications."""
    await ctx.notifications.clear_all()
    return {"ok": True}


@router.post("/notifications/open")
async def open_notification_target(body: OpenNotificationRequest, ctx: AppContextDep):
    """
    Handles notification click:
    - Deep Conversation Navigation: triggers native contentIntent via NotificationInvoker
      so Android navigates directly into the specific chat, email, or screen!
    - Smart Window Routing: If app is already open, focuses existing window to avoid duplicate sessions.
    - Otherwise launches new app window on desktop and navigates into it.
    """
    pkg = body.package
    title = (body.title or "").lower()
    text = (body.text or "").lower()

    if not pkg:
        raise HTTPException(status_code=400, detail="Missing package")

    target_key = body.android_key
    if not target_key and body.id:
        item = ctx.notifications.get_notification(body.id)
        if item:
            target_key = item.android_key
    if not target_key:
        match = ctx.notifications.find_by_package(pkg)
        if match:
            target_key = match.android_key

    if ctx.notifications:
        ctx.notifications.set_nav_target_package(pkg)

    # Title/text are message content (one-time codes…) — never written to the persistent log.
    log.info("🔔 [BİLDİRİM TIKLANDI (OPENDEX UI) 🎯] pkg=%s id=%s", pkg, body.id)

    # 1. System settings deep-intent mapping
    if ctx.serial:
        if pkg in ("android", "com.android.systemui"):
            if any(k in title or k in text for k in ("debug", "hata ayıklama")):
                with contextlib.suppress(Exception):
                    await ctx.adb.shell(
                        "am start -a android.settings.APPLICATION_DEVELOPMENT_SETTINGS",
                        serial=ctx.serial,
                    )
                    return {"ok": True, "action": "dev_settings"}
            elif any(k in title or k in text for k in ("usb", "mtp", "ptp", "file", "dosya")):
                with contextlib.suppress(Exception):
                    await ctx.adb.shell(
                        "am start -a android.settings.USB_SETTINGS",
                        serial=ctx.serial,
                    )
                    return {"ok": True, "action": "usb_settings"}
            elif any(k in title or k in text for k in ("hotspot", "tethering", "bağlantı noktası", "erişim noktası")):
                with contextlib.suppress(Exception):
                    await ctx.adb.shell(
                        "am start -a android.settings.TETHER_SETTINGS",
                        serial=ctx.serial,
                    )
                    return {"ok": True, "action": "tether_settings"}
            elif any(k in title or k in text for k in ("wifi", "kablosuz")):
                with contextlib.suppress(Exception):
                    await ctx.adb.shell(
                        "am start -a android.settings.WIFI_SETTINGS",
                        serial=ctx.serial,
                    )
                    return {"ok": True, "action": "wifi_settings"}

    # Resolve notification item and deep navigation intent
    item = ctx.notifications.get_notification(body.id) if body.id else None
    if not item and target_key:
        item = ctx.notifications.find_by_android_key(target_key)
    if not item:
        item = ctx.notifications.find_by_package(pkg)

    intent_args = None
    if ctx.notifications:
        intent_args = await ctx.notifications.resolve_notification_intent(
            item or {"id": body.id, "package": pkg, "android_key": target_key}
        )

    # 2. Check if the window is ALREADY running on a virtual display
    if ctx.window_manager:
        for win in ctx.window_manager.list_windows():
            if win.package == pkg:
                log.info("🎯 Smart Routing: %s is already open as window %s, navigating into message", pkg, win.window_id)
                await ctx.window_manager.focus_window(win.window_id)
                disp_id = await _get_display_id(ctx, pkg)
                await _execute_deep_navigation(ctx, pkg, disp_id, intent_args, target_key, title=title, text=text)
                return {
                    "ok": True,
                    "action": "focus_existing",
                    "window_id": win.window_id,
                    "package": pkg,
                }

    # 3. App is not open: launch virtual display window and navigate directly into message
    try:
        session = ctx.window_manager.get_session_by_package(pkg) if ctx.window_manager else None
        if not session:
            await ctx.window_manager.open_window(pkg, auto_start_app=False)

        # Wait dynamically for session and display_id (up to 2.5s)
        disp_id = None
        for _ in range(25):
            disp_id = await _get_display_id(ctx, pkg)
            if disp_id:
                break
            await asyncio.sleep(0.1)

        await asyncio.sleep(0.15)
        await _execute_deep_navigation(ctx, pkg, disp_id, intent_args, target_key, title=title, text=text)

        return {"ok": True, "action": "open_window", "package": pkg}
    except Exception as exc:
        log.warning("Handled error opening notification target %s: %s", pkg, exc)
        return {"ok": False, "error": str(exc), "package": pkg}


class ReplyRequest(BaseModel):
    id: str = Field(min_length=1, max_length=256)
    message: str = Field(min_length=1, max_length=4000)


@router.post("/notifications/reply", status_code=501)
async def reply_to_notification(body: ReplyRequest, ctx: AppContextDep):
    """Direct reply (RemoteInput) is not possible from the shell: a RemoteInput result must be delivered through the
    posting app's own PendingIntent, which no shell-level API exposes. The UI offers a reply box only for items the
    backend marks `can_reply`; none are today. This route exists so the contract is explicit (501, not a 404)."""
    raise HTTPException(status_code=501, detail="Bildirime buradan yanıt verilemiyor; telefondan yanıtlayın.")


@router.post("/notifications/refresh", dependencies=[RequireDevice])
async def force_refresh_notifications(ctx: AppContextDep):
    """Forces an immediate full re-sync: the daemon listener's list, or `dumpsys notification` without it."""
    await ctx.notifications._refresh_notifications()
    items = ctx.notifications.get_notifications()
    log.info("🔄 [BİLDİRİM MERKEZİ YENİLENDİ] Toplam %d bildirim listelendi.", len(items))
    return {"ok": True, "count": len(items)}


@router.post("/notifications/action", dependencies=[RequireDevice])
async def invoke_notification_action(body: InvokeActionRequest, ctx: AppContextDep):
    """Invokes an individual notification action button (Media, Mark as read, etc.)."""
    items = {n["id"]: n for n in ctx.notifications.get_notifications()}
    item = items.get(body.id)
    if not item and ctx.notifications:
        raw = ctx.notifications.get_notification(body.id)
        if not raw:
            raw = ctx.notifications.find_by_android_key(body.id)
        if raw:
            item = raw.to_dict()

    if item:
        actions = item.get("actions", [])
        matching_act = next((a for a in actions if a.get("action_id") == body.action_id), None)
        act_title = (matching_act.get("title", "") if matching_act else "").lower()
        target_key = item.get("android_key")
        pkg = item.get("package", "")

        # 1. Media Control via MediaBridge (Strict Per-Package Media Player Isolation)
        if pkg and any(w in act_title for w in ("previous", "önceki", "geri", "next", "sonraki", "ileri", "pause", "play", "durdur", "oynat", "stop")):
            cmd_action = None
            if any(w in act_title for w in ("previous", "önceki", "geri")):
                cmd_action = "prev"
            elif any(w in act_title for w in ("next", "sonraki", "ileri")):
                cmd_action = "next"
            elif any(w in act_title for w in ("pause", "durdur")) and not any(w in act_title for w in ("play", "oynat")):
                cmd_action = "pause"
            elif any(w in act_title for w in ("play", "oynat")) and not any(w in act_title for w in ("pause", "durdur")):
                cmd_action = "play"
            else:
                cmd_action = "toggle"

            res = await send_media_action(ctx, cmd_action, pkg, log_context="HEDEF MEDYA EYLEMİ")
            if not res.get("ok") and target_key:
                # The app has no reachable media session, but its notification is still there: press the
                # notification's OWN button — its PendingIntent can only reach this app (a media key could not).
                await invoke_notification_click(ctx.adb, ctx.serial, target_key, action_index=body.action_id)
                return {"ok": True, "action": f"media_{cmd_action}_notification", "package": pkg}
            return res

        # 2. Mark as read / Okundu Olarak İşaretle (Frontend Triage)
        elif any(w in act_title for w in ("read", "okundu")):
            log.info("📖 [OKUNDU OLARAK İŞARETLE 📌] [%s] id=%s key=%s", pkg, body.id, target_key)
            await ctx.notifications.mark_read(body.id)
            return {"ok": True, "action": "mark_as_read"}

        # 3. Archive / Arşivle
        elif any(w in act_title for w in ("archive", "arşiv")):
            log.info("📦 [ARŞİVLE] [%s] key=%s action_id=%s", pkg, target_key, body.action_id)
            if target_key:
                await invoke_notification_click(ctx.adb, ctx.serial, target_key, action_index=body.action_id)
            await ctx.notifications.dismiss_notification(body.id)
            return {"ok": True, "action": "archive"}

        # 4. General action invocation (Native Action click via IStatusBarService)
        if target_key:
            await invoke_notification_click(ctx.adb, ctx.serial, target_key, action_index=body.action_id)
            if not item.get("is_ongoing", False):
                await ctx.notifications.dismiss_notification(body.id)
            return {"ok": True, "action_id": body.action_id}

    log.info("⚡ [BİLDİRİM EYLEMİ] id=%s action_id=%s", body.id, body.action_id)
    return {"ok": True, "action_id": body.action_id}


@router.get("/media/status")
async def get_media_status(ctx: AppContextDep, package: str | None = None, fresh: bool = False):
    """Fetches real-time MediaSession state (position, duration, is_playing, title, artist, track_id, art_ready).
    `fresh=true`: önbellek yerine telefondan CANLI anlık görüntü (eylem doğrulaması / kapak bekleme merdiveni)."""
    if not ctx.serial:
        log.warning("📻 [HTTP:GET /api/media/status] Cihaz bağlı değil (serial=None)")
        return {"active": False, "error": "device_not_connected"}

    log.info("📻 [HTTP:GET /api/media/status] Fetching media status for package='%s' fresh=%s", package or "all", fresh)
    return await _get_media_status(ctx, package, fresh=fresh)


@router.post("/media/seek", dependencies=[RequireDevice])
async def seek_media(body: MediaSeekRequest, ctx: AppContextDep):
    """Executes native MediaSession seekTo to an arbitrary millisecond position."""
    log.info("⏩ [HTTP:POST /api/media/seek 📥] Target position: %d ms, package='%s'", body.position, body.package or "default")

    try:
        result = await _send_media_seek(ctx, body.position, body.package)
    except Exception as exc:
        log.error("Media seek error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    log.info("⏩ [MEDYA İLERLEME/SEEK] Result: %s", result)
    return result


@router.post("/media/action", dependencies=[RequireDevice])
async def trigger_media_action(body: MediaActionRequest, ctx: AppContextDep):
    """Executes a native playback action (play, pause, toggle, next, prev) via fast daemon socket or CLI fallback."""
    cmd_action = body.action.lower()
    pkg = body.package
    log.info("🎵 [HTTP:POST /api/media/action 📥] action='%s' package='%s'", cmd_action, pkg or "default")
    res = await send_media_action(ctx, cmd_action, pkg, log_context="DOĞRUDAN MEDYA EYLEMİ")
    log.info("🎵 [HTTP:POST /api/media/action 📤] RESULT: %s", res)
    return res

