"""Multi-window management, virtual displays, layout, and resizing."""
from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import AppContextDep
from app.schemas import PackageName, VisibilityState, WindowHandle, WindowState
from app.device.device_manager import DeviceNotBoundError
from app.storage import settings_db
from app.windows.window_manager import EncoderLimitError, UnsupportedDeviceError

log = logging.getLogger(__name__)
router = APIRouter()


class OpenWindowRequest(BaseModel):
    package: PackageName
    display_w: int = 1280
    display_h: int = 720
    dpi: int | None = Field(default=None, gt=0)
    display_mode: Literal["maximized", "windowed"] = "windowed"
    auto_start_app: bool = True


class ModeRequest(BaseModel):
    window_id: str
    mode: Literal["maximized", "windowed"]


class CloseWindowRequest(BaseModel):
    window_id: str


class ReclaimWindowRequest(BaseModel):
    window_id: str
    # Yalnızca telefona park edilmiş Workspace üyesi için: kullanıcı ghost kartı sürüklediyse
    # yeni slot [l, t, r, b] (VD koordinatı). Verilmezse park anındaki yer kullanılır.
    bounds: list[int] | None = Field(default=None, min_length=4, max_length=4)


class HandoffWindowRequest(BaseModel):
    window_id: str


class RefreshDensityRequest(BaseModel):
    window_id: str


class RestartAppRequest(BaseModel):
    window_id: str


class RetryAppLockRequest(BaseModel):
    window_id: str


class AdoptPhoneAppRequest(BaseModel):
    package: PackageName


class VisibilityRequest(BaseModel):
    window_id: str
    state: VisibilityState


class ResizeRequest(BaseModel):
    window_id: str
    w: int = Field(gt=0)
    h: int = Field(gt=0)
    dpi: int | None = Field(default=None, gt=0)


class FocusRequest(BaseModel):
    window_id: str


class OpenWorkspaceWindowRequest(BaseModel):
    package: PackageName


class PopoutWindowRequest(BaseModel):
    window_id: str


class DockWindowRequest(BaseModel):
    window_id: str
    bounds: list[int] | None = None


class ResizeWorkspaceTaskRequest(BaseModel):
    window_id: str
    bounds: list[int] = Field(min_length=4, max_length=4)
    density: int | None = Field(default=None, gt=50, lt=1000)
    # Yoğunluğun kaynağı: "auto" = OpenDeX boyuta göre hesapladı, "manual" = kullanıcı sabitledi
    density_mode: Literal["auto", "manual"] | None = None


class CloseWorkspaceTaskRequest(BaseModel):
    window_id: str


class VerifyWorkspaceTaskRequest(BaseModel):
    window_id: str


class SetWorkspaceTaskDensityRequest(BaseModel):
    window_id: str
    density: int = Field(gt=50, lt=1000)
    mode: Literal["auto", "manual"] = "manual"


@router.get("/windows", response_model=list[WindowState])
async def get_windows(ctx: AppContextDep):
    """Lists all active window sessions."""
    return ctx.window_manager.list_windows()


_background_tasks: set[asyncio.Task] = set()


async def apply_screen_off_setting(ctx, *, first_window: bool) -> bool:
    """`screen_off_while_mirroring`: ayar açıksa yansıtma BAŞLADIĞINDA (ilk pencere) telefon ekranı kapatılır.
    Ayar eskiden yalnızca saklanıyordu (anlık düğme dışında hiçbir şey yapmıyordu). Kapatma tek sahibi olan
    `DisplayPowerController` üzerinden yapılır: idempotent, gerçek durumu okur, güç tuşu (toggle) KULLANMAZ. Yalnızca
    İLK pencerede: kullanıcı ekranı sonradan elle açtıysa her yeni pencere onu tekrar kapatmaz. True = kapatma istendi."""
    try:
        project = await settings_db.get_project_settings()
        if not (first_window and project.screen_off_while_mirroring):
            return False
        await ctx.display_power.set(False, source="mirror_setting")
        return True
    except Exception as exc:  # noqa: BLE001 — bu bir konfor ayarı; pencere açılışını asla bozmamalı
        log.warning("[Window:SCREEN_OFF] ayar uygulanamadı: %s", exc)
        return False


def _schedule_screen_off(ctx, first_window: bool) -> None:
    """Yanıtı geciktirmeden (doğrulama ~1 sn sürer) arka planda uygular; görev tutamağı GC'ye karşı saklanır."""
    task = asyncio.create_task(apply_screen_off_setting(ctx, first_window=first_window), name="screen-off-setting")
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


@router.post("/windows/open", response_model=WindowHandle)
async def open_window(body: OpenWindowRequest, ctx: AppContextDep):
    """Spawns an isolated scrcpy session on a virtual display for an app."""
    if not ctx.serial:
        await ctx.ensure_device()
    first_window = not ctx.window_manager.list_windows()
    try:
        handle = await ctx.window_manager.open_window(
            body.package,
            display_w=body.display_w,
            display_h=body.display_h,
            dpi=body.dpi,
            display_mode=body.display_mode,
            auto_start_app=body.auto_start_app,
        )
        _schedule_screen_off(ctx, first_window)
        return handle
    except EncoderLimitError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except UnsupportedDeviceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except DeviceNotBoundError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        log.warning("open_window failed for %s: %s", body.package, exc)
        raise HTTPException(status_code=500, detail=f"Pencere açılamadı: {exc}") from exc


@router.post("/windows/mode")
async def set_display_mode(body: ModeRequest, ctx: AppContextDep):
    """Updates display mode (maximized or windowed)."""
    log.debug("[Window:MODE 🪟] win=%s -> mode=%s", body.window_id, body.mode)
    await ctx.window_manager.set_display_mode(body.window_id, body.mode)
    return {"ok": True}


@router.post("/windows/close")
async def close_window(body: CloseWindowRequest, ctx: AppContextDep):
    """Closes an active window session and frees on-device encoder resources."""
    log.debug("[Window:CLOSE ❌] win=%s", body.window_id)
    await ctx.window_manager.close_window(body.window_id)
    return {"ok": True}


@router.post("/windows/handoff")
async def handoff_window(body: HandoffWindowRequest, ctx: AppContextDep):
    """Gracefully handoffs an OpenDeX window to the physical phone (Stealth DPI —
    density equalization; see HandoffManager.handoff_to_phone)."""
    log.info("[Window:HANDOFF 📱] win=%s telefona aktarılıyor", body.window_id)
    try:
        ok = await ctx.window_manager.handoff_window_to_phone(body.window_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": ok}


@router.post("/windows/reclaim")
async def reclaim_window(body: ReclaimWindowRequest, ctx: AppContextDep):
    """Brings an app that moved to Display 0 (the phone) back to the PC window
    (Stealth DPI — see handoff_window)."""
    log.info("[Window:RECLAIM 📲] win=%s PC ekranına geri alınıyor", body.window_id)
    bounds = tuple(body.bounds) if body.bounds else None
    try:
        ok = await ctx.window_manager.reclaim_window(body.window_id, bounds)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": ok}


@router.post("/windows/applock/retry")
async def retry_app_lock(body: RetryAppLockRequest, ctx: AppContextDep):
    """Re-runs the AppLock unlock-wait sequence for a window still stuck
    behind an OEM lock screen (AppLockOverlay's "Tekrar Dene" button) —
    avoids forcing the user to close and cold-relaunch the app after a
    failed fingerprint/PIN attempt."""
    log.info("[Window:APPLOCK_RETRY 🔓] win=%s kilit açma tekrar deneniyor", body.window_id)
    ok = await ctx.window_manager.retry_app_lock(body.window_id)
    return {"ok": ok}


@router.post("/windows/visibility")
async def set_visibility(body: VisibilityRequest, ctx: AppContextDep):
    """Sets window visibility state (visible, minimized, occluded)."""
    log.debug("[Window:VISIBILITY 👁️] win=%s -> state=%s", body.window_id, body.state)
    await ctx.window_manager.set_visibility(body.window_id, body.state)
    return {"ok": True}


@router.post("/windows/focus")
async def focus_window(body: FocusRequest, ctx: AppContextDep):
    """Bumps window z-index to top and updates MRU."""
    await ctx.window_manager.focus_window(body.window_id)
    return {"ok": True}


@router.post("/windows/resize", response_model=WindowHandle)
async def resize_window(body: ResizeRequest, ctx: AppContextDep):
    """Dynamically reconfigures resolution and DPI of a running window's virtual display."""
    project = await settings_db.get_project_settings()
    if not project.dynamic_resolution_enabled:
        raise HTTPException(
            status_code=403, detail="Dinamik çözünürlük ayarı kapalı."
        )
    try:
        return await ctx.window_manager.resize_window(
            body.window_id, body.w, body.h, dpi=body.dpi, project=project
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Pencere bulunamadı.") from exc
    except Exception as exc:
        log.error(
            "resize_window failed for %s (%s): %s",
            body.window_id,
            type(exc).__name__,
            exc or "Boş hata mesajı",
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail=f"Yeniden boyutlandırma başarısız ({type(exc).__name__}): {exc}"
        ) from exc


@router.post("/windows/refresh-density")
async def refresh_window_density(body: RefreshDensityRequest, ctx: AppContextDep):
    """The user's explicit "refresh this window": a state-preserving restart of the app's PROCESS under the window's
    CURRENT density (density_reconciler.py, ``force``) — on Android 11, which has no such API for a shell process, the
    in-place activity relaunch. Verified — the reply says whether the app really rebuilt itself."""
    outcome = await ctx.window_manager.refresh_window_density_outcome(body.window_id)
    if outcome is None:
        raise HTTPException(status_code=404, detail="Pencere bulunamadı.")
    if not outcome.refreshed:
        reasons = {
            "no_process": "Uygulama şu an çalışmıyor.",
            "no_daemon": "Cihaz yardımcısı (daemon) bağlı değil.",
            "no_task": "Pencerede uygulamanın görevi bulunamadı.",
            "unconfirmed": "Yenileme istendi ama uygulama süreci değişmedi.",
            "unsupported": "Bu Android sürümünde (11) durum korumalı süreç yeniden başlatma yolu yok.",
        }
        raise HTTPException(status_code=409, detail=reasons.get(outcome.action, "Uygulama yenilenemedi."))
    return {"ok": True, "window_id": body.window_id, "action": outcome.action}


_RESTART_REFUSALS = {
    "not_restartable": (409, "Bu pencerenin yeniden başlatılacak bir Android uygulaması yok."),
    "handed_off": (409, "Uygulama şu an telefonun kendi ekranında; önce pencereye geri al."),
    "unavailable": (409, "Pencere şu an bağlı değil (küçültülmüş ya da bağlantı toparlanıyor); biraz sonra tekrar dene."),
    "failed": (502, "Uygulama yeniden başlatılamadı: süreç yeniden başlatma da, etkinliği yerinde yeniden kurma da "
                    "doğrulanamadı. Pencereyi kapatıp yeniden açmayı dene."),
}


@router.post("/windows/restart-app")
async def restart_window_app(body: RestartAppRequest, ctx: AppContextDep):
    """Hub → "Uygulamayı yeniden başlat": the window's APP is rebuilt inside the same window — a state-preserving process
    restart, else onDestroy→onCreate in place (plan B), else a cold start when nothing was running (app_restart.py).
    The reply is VERIFIED: ``action`` is what really happened (``restarted`` | ``relaunched`` | ``launched``)."""
    outcome = await ctx.window_manager.restart_window_app(body.window_id)
    if outcome is None:
        raise HTTPException(status_code=404, detail="Pencere bulunamadı.")
    if not outcome.ok:
        status, detail = _RESTART_REFUSALS.get(outcome.action, (502, "Uygulama yeniden başlatılamadı."))
        raise HTTPException(status_code=status, detail=detail)
    return {"ok": True, "window_id": body.window_id, "action": outcome.action}


@router.get("/window/{window_id}/xml-elements")
async def get_window_xml_elements(window_id: str, ctx: AppContextDep):
    """Zero-Apps ADB XML Element Inspector (Faz 3+ Deneysel Mod)."""
    project = await settings_db.get_project_settings()
    if not project.enable_hybrid_dom:
        return {"enabled": False, "nodes": []}

    if not ctx.serial:
        raise HTTPException(status_code=409, detail="Cihaz bağlı değil.")

    from app.device import xml_inspector
    nodes = await xml_inspector.dump_ui_elements(ctx.adb, ctx.serial)
    return {"enabled": True, "nodes": nodes}


@router.post("/windows/workspace/open", response_model=WindowHandle)
async def open_workspace_window(body: OpenWorkspaceWindowRequest, ctx: AppContextDep):
    """Eco Workspace'te (paylaşımlı VD, tek encoder) yeni bir freeform pencere açar."""
    if not ctx.serial:
        await ctx.ensure_device()
    first_window = not ctx.window_manager.list_windows()
    try:
        handle = await ctx.window_manager.open_window_in_workspace(body.package)
        _schedule_screen_off(ctx, first_window)
        return handle
    except Exception as exc:
        log.warning("open_workspace_window failed for %s: %s", body.package, exc)
        raise HTTPException(status_code=500, detail=f"Çalışma alanında açılamadı: {exc}") from exc


@router.post("/windows/workspace/adopt-from-phone", response_model=WindowHandle)
async def adopt_phone_app(body: AdoptPhoneAppRequest, ctx: AppContextDep):
    """"Buraya Yolla": telefonda şu an çalışan bir uygulamayı Eco Workspace'e alır."""
    log.info("[Window:ADOPT 🖥️] pkg=%s telefondan Workspace'e alınıyor", body.package)
    try:
        return await ctx.window_manager.adopt_phone_app_into_workspace(body.package)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/windows/popout", response_model=WindowHandle)
async def popout_window(body: PopoutWindowRequest, ctx: AppContextDep):
    """Bir Eco Workspace penceresini bağımsız masaüstü penceresine tomurcuklar."""
    try:
        return await ctx.window_manager.popout_window_to_desktop(body.window_id)
    except Exception as exc:
        log.warning("popout_window failed for %s: %s", body.window_id, exc)
        raise HTTPException(status_code=500, detail=f"Tomurcuklama başarısız: {exc}") from exc


@router.post("/windows/dock")
async def dock_window(body: DockWindowRequest, ctx: AppContextDep):
    """Bağımsız bir pencereyi Eco Workspace'e geri gönderir."""
    bounds = tuple(body.bounds) if body.bounds else None
    try:
        await ctx.window_manager.dock_window_to_workspace(body.window_id, bounds)
        return {"ok": True}
    except Exception as exc:
        log.warning("dock_window failed for %s: %s", body.window_id, exc)
        raise HTTPException(status_code=500, detail=f"Dock başarısız: {exc}") from exc


@router.post("/windows/workspace/resize-task")
async def resize_workspace_task(body: ResizeWorkspaceTaskRequest, ctx: AppContextDep):
    """Bir Eco Workspace görevinin (task) sınırlarını yeniden konumlar/boyutlar ve dinamik DPI uygular."""
    try:
        effective = await ctx.window_manager.resize_workspace_task(
            body.window_id, tuple(body.bounds), density=body.density, density_mode=body.density_mode,
        )
        # bounds: what Android settled on. None = nothing applied (a newer request for the same task overtook this one
        # at the resize gate, or the task is parked) — superseded then tells the caller to wait for the newer answer.
        return {
            "ok": True, "density": body.density, "superseded": effective is None,
            "bounds": list(effective) if effective else None,
        }
    except Exception as exc:
        log.warning("resize_workspace_task failed for %s: %s", body.window_id, exc)
        raise HTTPException(status_code=500, detail=f"Yeniden boyutlandırma başarısız: {exc}") from exc


@router.post("/windows/workspace/close-task")
async def close_workspace_task(body: CloseWorkspaceTaskRequest, ctx: AppContextDep):
    """Bir Eco Workspace görevini kapatır (paylaşımlı VD, başka üye varsa ayakta kalır)."""
    await ctx.window_manager.close_workspace_task(body.window_id)
    return {"ok": True}


@router.post("/windows/workspace/verify-task")
async def verify_workspace_task(body: VerifyWorkspaceTaskRequest, ctx: AppContextDep):
    """Kullanıcı bir Workspace görevine bastı: gerçek görev defterle (serbest kip, görünür, kutusu) karşılaştırılır; telefon
    ya da OEM katmanı onu kendiliğinden küçülttüyse (yukarı kaydırma → yüzen top, boşta kalma) yerine konur.
    status: ok | healed | failed | unknown | absent."""
    check = await ctx.window_manager.verify_workspace_task(body.window_id)
    return {
        "ok": check.status in ("ok", "healed"), "status": check.status, "reason": check.reason,
        "bounds": list(check.bounds) if check.bounds else None,
    }


@router.post("/windows/workspace/task-density")
async def set_workspace_task_density(body: SetWorkspaceTaskDensityRequest, ctx: AppContextDep):
    """Eco Workspace'teki bir görevin DPI yoğunluğunu ayarlar (AOSP WindowContainerTransaction)."""
    try:
        ok = await ctx.window_manager.set_workspace_task_density(body.window_id, body.density, mode=body.mode)
        if not ok:
            raise HTTPException(status_code=400, detail="DPI uygulanamadı (görev bulunamadı veya daemon yanıt vermedi).")
        return {"ok": True, "density": body.density}
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("set_workspace_task_density failed for %s: %s", body.window_id, exc)
        raise HTTPException(status_code=500, detail=f"DPI ayarlama başarısız: {exc}") from exc

