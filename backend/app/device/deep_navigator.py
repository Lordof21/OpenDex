"""NOTIFICATION → TARGET: what a tap on a notification does, and the task/display helpers the window code shares.

A tapped notification is opened by sending ITS OWN PendingIntent onto the window's virtual display, from the phone daemon
(`notification_invoker.launch` → `NotificationInvoker.launchToDisplay`): the notification's app starts the exact screen it
meant — the DM thread, the tweet, the conversation — with its own identity (so components that are not exported work) and its
own extras. On Android 16 the daemon, a bare shell process, has to send it with the ALLOW_ALWAYS background-start mode; with
the plain ALLOWED mode the platform logs "Background activity launch blocked" and the PendingIntent starts nothing.
This module used to rebuild an `am start` from the intent's text (action/data/component/flags, no extras) and climb a ladder
of guesses per app when that was refused; the ladder was removed so that a failure of the real path is SEEN (logged with the
reason, returned as `False`) instead of being hidden by a fallback that lands on the app's home feed.

An OEM AppLock (Xiaomi HyperOS, Samsung Knox, ...) met on the way is handed to the SAME waiter a window uses
(window_lifecycle_coordinator.wait_for_app_lock_unlock) — a locked launch looks identical whether it was triggered by
opening a window or by tapping a notification — and the PendingIntent is fired once more after the unlock.

The rest of the module (`find_task_id_for_package`, `_is_package_on_display`, ...) is shared by handoff, teleport, density and
workspace code.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import shlex
from typing import Any

from ..logging_config import window_logger
from ..windows.display_ids import known_display_id
from . import android_shell, daemon_registry, device_queries, notification_invoker

log = logging.getLogger(__name__)

async def invoke_notification_click(adb, serial: str, android_key: str, action_index: int | None = None) -> bool:
    """Invokes native Android IStatusBarService.onNotificationClick or onNotificationActionClick."""
    try:
        out = await notification_invoker.click(adb, serial, android_key, action_index)
        log.info("🎯 [BİLDİRİM HEDEFİNE GİDİLDİ 🚀] key=%s action_index=%s out=%s", android_key, action_index, out)
        return True
    except Exception as exc:
        log.warning("Notification click invocation failed: %s", exc)
        return False

async def _get_display_id(ctx: Any, pkg_name: str) -> str | None:
    """The package's window display as reported by its own scrcpy server — never guessed from `dumpsys display`
    (a guess could name another window's display; see windows/display_ids.py)."""
    session = ctx.window_manager.get_session_by_package(pkg_name) if ctx.window_manager else None
    return known_display_id(session) if session else None

async def find_task_id_for_package(
    ctx_or_adb: Any,
    pkg_name: str,
    display_id: str | None = None,
    serial: str | None = None,
) -> str | None:
    """Most recent Task ID of `pkg_name` — on EXACTLY `display_id` when given (no fallback), else anywhere.

    Strict on purpose: the display-specific search used to fall through to a device-wide search, so "is this task on
    the phone (display 0)?" answered yes for a task living on a DeX virtual display (re-clicking an open app ran a
    needless reclaim; a finished video pump reported a false handoff). Callers that want "prefer this display, else
    anywhere" make the second, global call explicitly.

    Public (previously ``_find_task_id_for_package``): six modules under
    ``windows/`` call this. Each does so via a function-scoped
    ``from ..device.deep_navigator import find_task_id_for_package`` — keep
    that import local rather than hoisting it to module level. It's not (only)
    about avoiding a circular import (there isn't one); several tests
    (``test_eco_workspace.py``, ``test_eco_workspace_bounds.py``,
    ``test_task_teleporter.py``, ``test_window_manager_eco_workspace.py``)
    do ``monkeypatch.setattr(deep_navigator_module, "find_task_id_for_package",
    fake)``, which only reaches call sites that re-resolve the name from the
    module at call time. A module-level import would capture the real
    function at import time and silently stop honoring that monkeypatch.
    """
    adb = getattr(ctx_or_adb, "adb", ctx_or_adb)
    dev_serial = getattr(ctx_or_adb, "serial", serial)
    if not dev_serial or not hasattr(adb, "shell"):
        return None
    # The daemon answers from ActivityTaskManager in a few ms; the full `dumpsys activity activities` it replaces is
    # one of the heaviest things a shell can ask system_server for (and this runs on every open / move / handoff).
    daemon = daemon_registry.live("find_task")
    if daemon is not None:
        disp = str(display_id).strip() if display_id is not None and str(display_id).strip() != "" else None
        resp = await daemon.find_task(pkg_name, disp)
        if resp is not None:
            return str(resp["task_id"]) if resp.get("found") and resp.get("task_id") is not None else None
    try:
        raw = await adb.shell("dumpsys activity activities", serial=dev_serial, timeout_s=3.0)
        if display_id is not None and str(display_id).strip() != "":
            section = android_shell.activities_by_display(raw).get(str(display_id).strip(), "")
            return android_shell.task_id_in(section, pkg_name)
        return android_shell.task_id_in(raw, pkg_name)
    except Exception as exc:
        log.warning("Failed to find task id for %s (display=%s): %s", pkg_name, display_id, exc)
    return None

async def _is_display_has_activity(ctx: Any, display_id: str | None) -> bool:
    """Checks whether the virtual display has at least one active task/activity."""
    if not ctx.serial or not display_id or display_id == "0":
        return True
    daemon = daemon_registry.live("tasks_list")
    if daemon is not None and str(display_id).isdigit():
        tasks = await daemon.tasks()
        if tasks is not None:
            return any(t.get("display") == int(display_id) for t in tasks if isinstance(t, dict))
    try:
        raw = await ctx.adb.shell("dumpsys activity activities", serial=ctx.serial, timeout_s=2.0)
        if not raw:
            return True
        section = android_shell.activities_by_display(raw).get(str(display_id))
        return section is not None and android_shell.has_any_activity(section)
    except Exception:
        return True

async def _is_package_on_display(ctx: Any, pkg_name: str, display_id: str | None) -> bool:
    """Checks whether a specific package has an active task/activity on the given display ID."""
    if not ctx.serial or not display_id or display_id == "0":
        return False
    daemon = daemon_registry.live("find_task")
    if daemon is not None:
        resp = await daemon.find_task(pkg_name, display_id)
        if resp is not None:
            return bool(resp.get("found"))
    try:
        raw = await ctx.adb.shell("dumpsys activity activities", serial=ctx.serial, timeout_s=2.0)
        if not raw:
            return False
        section = android_shell.activities_by_display(raw).get(str(display_id))
        return section is not None and android_shell.has_package(section, pkg_name)
    except Exception:
        return False

async def _resolve_default_launcher_activity(adb, serial: str, pkg: str) -> str | None:
    """Resolves the exact exported main launcher activity for any package via AOSP package manager."""
    try:
        out = await adb.shell(f"cmd package resolve-activity --brief {shlex.quote(pkg)}", serial=serial, timeout_s=1.5)
        lines = [line.strip() for line in out.splitlines() if line.strip() and not line.startswith("priority=")]
        if lines:
            cmp_line = lines[-1]
            if "/" in cmp_line and not cmp_line.startswith("Error"):
                return cmp_line
    except Exception:
        pass
    return None


# `launch` answers that mean "there is no notification to open" (as opposed to a launch that was refused).
_TARGET_GONE = ("notification_not_found", "no_content_intent")


async def _wait_for_app_lock(ctx: Any, pkg: str, disp_id: str) -> bool:
    """An OEM AppLock blocked the start on the virtual display: waits with the SAME state machine a window uses
    (window_lifecycle_coordinator.wait_for_app_lock_unlock: wake, prompt, cancel/timeout detection, move onto the window's
    display, app_lock_* events carrying window_id). True when the app was unlocked."""
    from ..windows.window_lifecycle_coordinator import wait_for_app_lock_unlock  # windows → device dependency direction

    session = ctx.window_manager.get_session_by_package(pkg) if ctx.window_manager else None
    if not ctx.serial or session is None:
        return False
    win_id = session.state.window_id
    return await wait_for_app_lock_unlock(
        adb=ctx.adb,
        events=ctx.event_bus,
        serial=ctx.serial,
        sockets=session.server.sockets if session.server else None,
        wlog=window_logger(__name__, win_id),
        pkg_name=pkg,
        win_id=win_id,
        disp_id=str(disp_id),
        p1_dpi=session.dpi,
        daemon=getattr(ctx, "daemon_client", None),
        is_alive=lambda: ctx.window_manager.get_session(win_id) is session,
    )


async def _landed_on_display(ctx: Any, pkg: str, disp_id: str, *, attempts: int = 12) -> bool:
    """Polls (100 ms steps, ~1.2 s) until the package has a task on the window's display."""
    for _ in range(attempts):
        if await _is_package_on_display(ctx, pkg, disp_id):
            return True
        await asyncio.sleep(0.1)
    return False


async def _move_task(ctx: Any, task_id: str, disp_id: str, tag: str) -> bool:
    """Moves a task onto the window's display through the shared primitive (daemon fast path, adb fallback)."""
    try:
        from ..windows.task_movement import move_task_to_display
        await move_task_to_display(
            ctx.adb,
            task_id,
            disp_id,
            serial=ctx.serial,
            daemon=getattr(ctx, "daemon_client", None),
        )
        log.info("🚚 [%s] Görev %s -> Display %s", tag, task_id, disp_id)
        return True
    except Exception as exc:
        log.warning("Task move failed (%s): %s", tag, exc)
        return False


async def _wait_for_phone_task(ctx: Any, pkg: str, max_wait: float = 1.2) -> str | None:
    """Waits for an app's task to appear on display 0 (the phone)."""
    steps = max(1, int(max_wait / 0.1))
    for _ in range(steps):
        task_id = await find_task_id_for_package(ctx, pkg, display_id="0")
        if task_id:
            return task_id
        await asyncio.sleep(0.1)
    return None


async def _safe_launch(ctx: Any, pkg: str, disp_id: str) -> bool:
    """Guaranteed launch of the app onto disp_id: never leaves the virtual display empty/black."""
    log.info("🚀 [GÜVENLİ BAŞLATMA] pkg=%s disp_id=%s", pkg, disp_id)
    # 1. Try window_manager.start_app_in_window (scrcpy START_APP control message)
    if getattr(ctx, "window_manager", None):
        with contextlib.suppress(Exception):
            started = await ctx.window_manager.start_app_in_window(pkg)
            if started and await _landed_on_display(ctx, pkg, disp_id, attempts=10):
                log.info("🚀 [GÜVENLİ BAŞLATMA: SCRCPY START_APP BAŞARILI] %s -> Display %s", pkg, disp_id)
                return True

    # 2. Try am start --display
    launcher_cmp = await _resolve_default_launcher_activity(ctx.adb, ctx.serial, pkg)
    cmd = (
        f"am start --display {disp_id} -n {shlex.quote(launcher_cmp)} -f 0x10000000"
        if launcher_cmp
        else f"monkey --display {disp_id} -p {shlex.quote(pkg)} -c android.intent.category.LAUNCHER 1"
    )
    with contextlib.suppress(Exception):
        await ctx.adb.shell(cmd, serial=ctx.serial, timeout_s=3.0)

    if await _landed_on_display(ctx, pkg, disp_id, attempts=10):
        log.info("🚀 [GÜVENLİ BAŞLATMA: AM START BAŞARILI] %s -> Display %s", pkg, disp_id)
        return True

    # 3. Check if task appeared on Display 0 and move it
    task_on_d0 = await find_task_id_for_package(ctx, pkg, display_id="0")
    if task_on_d0 and await _move_task(ctx, task_on_d0, disp_id, "GÜVENLİ BAŞLATMA TAŞIMA"):
        if await _landed_on_display(ctx, pkg, disp_id, attempts=8):
            return True

    return await _is_package_on_display(ctx, pkg, disp_id)


async def _execute_deep_navigation(ctx: Any, pkg: str, disp_id: str | None, target_key: str | None) -> bool:
    """Opens the tapped notification's target on `disp_id`.
    1. Tier 0: Direct notification_invoker.launch to disp_id.
    2. Display 0 Task Teleport: If the notification started on Display 0, move it to disp_id.
    3. Tier 1: SystemUI status bar click (invoke_notification_click) + Teleport to disp_id.
    4. Tier 2: Safe launch fallback (guarantees the virtual display never stays blank).
    """
    if not ctx.serial:
        return True
    if not target_key or not disp_id:
        log.error("❌ [BİLDİRİM HEDEFİ] açılamadı: %s yok (pkg=%s display=%s)",
                  "bildirim anahtarı" if not target_key else "sanal ekran", pkg, disp_id)
        return False

    log.info("🎯 [BİLDİRİM HEDEFİ] PendingIntent → display %s (pkg=%s)", disp_id, pkg)
    res = await notification_invoker.launch(ctx.adb, ctx.serial, target_key, disp_id)
    if not res.get("ok") and res.get("error") in _TARGET_GONE:
        log.warning("⚠️ [BİLDİRİM HEDEFİ] bildirim telefonda artık yok (%s): hedef açılamaz, uygulama normal açılıyor (pkg=%s)",
                    res.get("error"), pkg)
        started = bool(ctx.window_manager) and await ctx.window_manager.start_app_in_window(pkg)
        return started and await _landed_on_display(ctx, pkg, disp_id)

    landed = False
    kind = res.get("kind")

    if res.get("ok"):
        landed = await _landed_on_display(ctx, pkg, disp_id, attempts=8)
        if not landed and await device_queries.app_lock_visible(ctx.adb, ctx.serial, timeout_s=1.5):
            log.info("🔒 [BİLDİRİM HEDEFİ] %s telefonda kilitli; AppLock bekleyicisi devreye giriyor", pkg)
            if await _wait_for_app_lock(ctx, pkg, disp_id):
                res = await notification_invoker.launch(ctx.adb, ctx.serial, target_key, disp_id)
                landed = bool(res.get("ok")) and await _landed_on_display(ctx, pkg, disp_id, attempts=8)

        if kind != "activity" and await find_task_id_for_package(ctx, pkg, display_id="0") is not None:
            log.warning("⚠️ [BİLDİRİM HEDEFİ] pending_intent=%s: hedef telefonun kendi ekranında açılmış olabilir (pkg=%s)", kind, pkg)

        # Check if an existing task was on Display 0 or appeared on Display 0, and move it to disp_id
        task_on_d0 = await find_task_id_for_package(ctx, pkg, display_id="0")
        if task_on_d0:
            log.info("🚚 [BİLDİRİM HEDEFİ] Görev telefon ekranında (Display 0, task=%s) tespit edildi; sanal ekrana taşınıyor", task_on_d0)
            if await _move_task(ctx, task_on_d0, disp_id, "BİLDİRİM GÖREV TAŞIMA"):
                landed = await _landed_on_display(ctx, pkg, disp_id, attempts=8)

    # 2. Tier 1: If launch didn't land or failed (e.g. background activity start blocked / -96), try status bar click
    if not landed and target_key:
        log.info("🔔 [BİLDİRİM HEDEFİ] Tier 1: SystemUI statusbar click deneniyor (key=%s)", target_key)
        clicked = await invoke_notification_click(ctx.adb, ctx.serial, target_key)
        if clicked:
            task_on_d0 = await _wait_for_phone_task(ctx, pkg, max_wait=1.2)
            if task_on_d0:
                log.info("🚚 [BİLDİRİM HEDEFİ: TIER 1] Görev bulundu (task=%s), sanal ekrana ışınlanıyor", task_on_d0)
                if await _move_task(ctx, task_on_d0, disp_id, "TIER 1 IŞINLAMA"):
                    landed = await _landed_on_display(ctx, pkg, disp_id, attempts=8)

    # 3. Tier 2: Safe launch fallback — NEVER leave the virtual display empty
    if not landed:
        log.warning("⚠️ [BİLDİRİM HEDEFİ] Derin navigasyon hedefe ulaşamadı (pkg=%s); güvenli başlatma devreye giriyor", pkg)
        landed = await _safe_launch(ctx, pkg, disp_id)

    # 4. Clean up notification from phone shade if launched
    if landed and target_key:
        with contextlib.suppress(Exception):
            await notification_invoker.clear(ctx.adb, ctx.serial, target_key, pkg, timeout_s=2.5)

    if landed:
        log.info("🚀 [BİLDİRİM HEDEFİ BAŞARILI] %s display %s üzerinde başarıyla açıldı", pkg, disp_id)
        if getattr(ctx, "window_manager", None):
            session = ctx.window_manager.get_session_by_package(pkg)
            if session:
                session.state.handoff_to_phone = False
                if getattr(ctx, "event_bus", None):
                    with contextlib.suppress(Exception):
                        await ctx.event_bus.emit("app_handoff_resolved", window_id=session.state.window_id, package=pkg)
    else:
        on_phone = await find_task_id_for_package(ctx, pkg, display_id="0") is not None
        log.error("❌ [BİLDİRİM HEDEFİ] %s display %s üzerinde görünmedi (pending_intent=%s, %s)", pkg, disp_id, kind,
                  "telefonun kendi ekranında açıldı" if on_phone else "hiçbir ekranda görev yok")

    return landed
