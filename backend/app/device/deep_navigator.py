"""EVRENSEL BİLDİRİM DERİN NAVİGASYON MOTORU (Universal Notification Deep
Navigation Engine).

Split out of api/v1/endpoints/notifications.py — every helper the
``/notifications/*`` routes lean on to turn a tapped notification into the
phone actually landing on the right screen inside the right virtual display:

  1. The notification's real launch Intent: read by the daemon's notification
     listener; without it, ``cmd notification get`` + ``dumpsys activity
     intents`` recover it from system_server.
  2. Tier 1: direct launch on the target virtual display
     (``am start --display {disp_id} {intent_args}``) — ~97% of apps.
  3. Tier 2 (Method A): Freeform launch + task migration for components that
     refuse a direct cross-display start (``exported=false`` trampolines).
  4. Tier 3: single-activity search fallback (Gmail etc.).
  5. Synchronization: clears the notification from the phone's own shade to
     match the desktop's read/dismissed state.

An OEM AppLock (Xiaomi HyperOS, Samsung Knox, ...) met on the way is handed to the SAME waiter a window uses
(window_lifecycle_coordinator.wait_for_app_lock_unlock) — a locked launch looks identical whether it was triggered by
opening a window or by tapping a notification.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import shlex
from dataclasses import dataclass
from typing import Any

from ..logging_config import window_logger
from ..windows.display_ids import known_display_id
from ..windows.task_movement import move_task_to_display
from . import android_shell, daemon_registry, device_queries, notification_invoker
from .intent_utils import find_request_intent, option_value, parse_intent_args

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


async def _resolve_sms_thread_id(adb, serial: str, title: str | None = None, text: str | None = None) -> str | None:
    """Queries Android SMS content provider to resolve the exact conversation thread ID for an incoming SMS."""
    try:
        cmd = "content query --uri content://sms --projection thread_id:address:body --sort 'date DESC'"
        res = await adb.shell(cmd, serial=serial, timeout_s=2.5)
        if not res:
            return None

        lines = res.splitlines()
        first_thread_id = None
        for line in lines:
            m = re.search(r"Row:\s*\d+\s+thread_id=(\d+)(?:,\s*address=([^,]+))?(?:,\s*body=([^,]+))?", line)
            if m:
                tid = m.group(1)
                addr = (m.group(2) or "").strip().lower()
                body = (m.group(3) or "").strip().lower()

                if not first_thread_id:
                    first_thread_id = tid

                t_clean = (title or "").strip().lower()
                if t_clean and (t_clean in addr or addr in t_clean):
                    return tid
                txt_clean = (text or "").strip().lower()
                if txt_clean and body and (body in txt_clean or txt_clean in body):
                    return tid
        return first_thread_id
    except Exception as exc:
        log.warning("Failed to resolve SMS thread_id: %s", exc)
        return None


async def _resolve_intent_from_system(ctx: Any, key: str, pkg: str) -> str | None:
    """
    AOSP SystemServer CLI (cmd notification get + dumpsys activity intents)
    kullanarak bildirimin gerçek PendingIntent rotasını (act, dat, cmp, flg) çözer.
    """
    if not ctx.serial or not key:
        return None
    # 0. Daemon'un bildirim dinleyicisi hedef Intent'i zaten okudu: kabuk komutu yok.
    notifications = getattr(ctx, "notifications", None)
    item = notifications.find_by_android_key(key) if notifications is not None else None
    content_intent = getattr(item, "content_intent", None)
    if isinstance(content_intent, str) and content_intent:
        am_args = parse_intent_args(content_intent, quote="'")
        if am_args:
            resolved = " ".join(am_args)
            log.info("🎯 [DAEMON INTENT RESOLVED] %s -> %s", key, resolved)
            return resolved
    try:
        # 1. Bildirim kaydını system_server üzerinden çek
        clean_key = key.replace("'", "")
        raw_rec = await ctx.adb.shell(f"cmd notification get '{clean_key}'", serial=ctx.serial, timeout_s=1.5)
        if not raw_rec or "contentIntent=" not in raw_rec:
            return None

        # 2. PendingIntentRecord kimliğini yakala
        m_pi = (
            re.search(r"contentIntent=PendingIntent\{[0-9a-fA-F]+:\s*PendingIntentRecord\{([0-9a-fA-F]+)\s+([a-zA-Z0-9._]+)", raw_rec)
            or re.search(r"contentIntent=PendingIntent\{PendingIntentRecord\{([0-9a-fA-F]+)\s+([a-zA-Z0-9._]+)", raw_rec)
        )
        if not m_pi:
            return None
        rec_id, target_pkg = m_pi.group(1), m_pi.group(2)

        # 3. dumpsys activity intents üzerinden gerçek Intent'i bul
        raw_intents = await ctx.adb.shell(f"dumpsys activity intents {target_pkg}", serial=ctx.serial, timeout_s=1.5)
        req_line = find_request_intent(raw_intents, rec_id)
        if not req_line:
            return None

        # 4. AOSP argümanlarını am start formatına dönüştür
        am_args = parse_intent_args(req_line, quote="'")

        if am_args:
            resolved = " ".join(am_args)
            log.info("🎯 [AOSP SYSTEM INTENT RESOLVED] %s -> %s", key, resolved)
            return resolved
    except Exception as exc:
        log.debug("Intent resolution via system_server skipped for %s: %s", key, exc)
    return None


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


def _is_app_lock_response(res: str) -> bool:
    """Checks whether an am start output or exception indicates Android OEM AppLock intercept (Xiaomi HyperOS, Samsung Knox, etc.)."""
    return android_shell.is_app_lock(res)


# `am start` output of a component that refuses a start from the shell (exported=false trampolines etc.).
_START_DENIED_MARKERS = ("SecurityException", "Permission Denial", "not exported")


def _start_denied(output: str | None) -> bool:
    return bool(output) and any(marker in output for marker in _START_DENIED_MARKERS)


def _force_clear_top(pkg: str, args: str) -> str:
    """WhatsApp's HomeActivity swallows the target conversation unless NEW_TASK|CLEAR_TOP (0x14000000) is set."""
    if pkg != "com.whatsapp":
        return args
    if "-f " not in args:
        return f"{args} -f 0x14000000"
    return args.replace("-f 0x10000000", "-f 0x14000000")


@dataclass
class _Nav:
    """State of one notification navigation, threaded through the app routes and the launch tiers."""

    ctx: Any
    pkg: str
    disp_id: str | None
    target_key: str | None
    title: str | None
    text: str | None
    final_args: str | None
    launched: bool = False
    # The component is known to refuse shell starts (Gmail's SAPI provider): Tier 1 must not even try.
    tier1_blocked: bool = False

    @property
    def disp_prefix(self) -> str:
        return f"--display {self.disp_id} " if self.disp_id else ""

    @property
    def text_lower(self) -> str:
        return f"{(self.title or '').lower()} {(self.text or '').lower()}"


async def _move_task(ctx: Any, task_id: str, disp_id: str, tag: str) -> bool:
    """Moves a task onto the window's display through the shared primitive (daemon fast path, adb fallback)."""
    try:
        await move_task_to_display(ctx.adb, task_id, disp_id, serial=ctx.serial, daemon=getattr(ctx, "daemon_client", None))
        log.info("🚚 [%s] Görev %s -> Display %s", tag, task_id, disp_id)
        return True
    except Exception as exc:  # noqa: BLE001 — one failed move must not abort the navigation ladder
        log.warning("⚠️ [%s] Görev %s Display %s'ye taşınamadı: %s", tag, task_id, disp_id, exc)
        return False


async def _wait_for_phone_task(ctx: Any, pkg: str, attempts: int = 15) -> str | None:
    """Polls (100 ms steps) for the app's task to appear on the phone's own display."""
    for _ in range(attempts):
        await asyncio.sleep(0.1)
        task_id = await find_task_id_for_package(ctx, pkg, display_id="0")
        if task_id:
            return task_id
    return None


async def _click_and_teleport(nav: _Nav, tag: str) -> bool:
    """SystemUI-authorised click on the notification (the app's own PendingIntent path, on the phone), then the task
    that appears on display 0 is moved onto the window's display."""
    await invoke_notification_click(nav.ctx.adb, nav.ctx.serial, nav.target_key)
    task_id = await _wait_for_phone_task(nav.ctx, nav.pkg)
    if task_id and nav.disp_id:
        return await _move_task(nav.ctx, task_id, nav.disp_id, tag)
    return False


async def _wait_for_app_lock_then_deep_link(nav: _Nav) -> bool:
    """An OEM AppLock blocked the start on the virtual display. Waits with the SAME state machine a window uses
    (window_lifecycle_coordinator.wait_for_app_lock_unlock: wake, prompt, cancel/timeout detection, move onto the
    window's display, app_lock_* events carrying window_id), then completes the notification's deep intent there.

    A second, older wait loop used to live in this module: no cancel detection, events without window_id, and it
    called a non-existent `session.is_alive()` (AttributeError on the first poll)."""
    from ..windows.window_lifecycle_coordinator import wait_for_app_lock_unlock  # windows → device dependency direction

    ctx = nav.ctx
    session = ctx.window_manager.get_session_by_package(nav.pkg) if ctx.window_manager else None
    if not ctx.serial or not nav.disp_id or session is None:
        return False
    win_id = session.state.window_id
    unlocked = await wait_for_app_lock_unlock(
        adb=ctx.adb,
        events=ctx.event_bus,
        serial=ctx.serial,
        sockets=session.server.sockets if session.server else None,
        wlog=window_logger(__name__, win_id),
        pkg_name=nav.pkg,
        win_id=win_id,
        disp_id=str(nav.disp_id),
        p1_dpi=session.dpi,
        daemon=getattr(ctx, "daemon_client", None),
        is_alive=lambda: ctx.window_manager.get_session(win_id) is session,
    )
    if unlocked and nav.final_args:
        # Let the task settle on the virtual display before the deep intent (otherwise it lands on the phone).
        for _ in range(10):
            await asyncio.sleep(0.15)
            if await _is_package_on_display(ctx, nav.pkg, nav.disp_id):
                break
        else:
            await asyncio.sleep(0.2)
        args = _force_clear_top(nav.pkg, nav.final_args)
        log.info("🎯 [KİLİT SONRASI DERİN İNTENT] pkg=%s disp=%s args=%s", nav.pkg, nav.disp_id, args)
        with contextlib.suppress(Exception):
            await ctx.adb.shell(f"am start --display {nav.disp_id} {args}", serial=ctx.serial, timeout_s=3.0)
    return unlocked


# ---------------------------------------------------------------------------------------------------------------------
# App routes — each rewrites `nav.final_args` / sets `nav.launched` for the apps whose notification intents can't be
# started from the shell as-is. Order matters (it is the historical order); a route that doesn't apply returns at once.
# ---------------------------------------------------------------------------------------------------------------------

async def _route_sms(nav: _Nav) -> None:
    """Xiaomi/MIUI/HyperOS SingleRecipientConversationActivity is exported=false; the public route is
    ComposeMessageRouterActivity / content://mms-sms/conversations/{thread_id}."""
    is_sms_pkg = nav.pkg in ("com.android.mms", "com.google.android.apps.messaging")
    if not (is_sms_pkg or "SingleRecipientConversationActivity" in (nav.final_args or "")):
        return
    thread_id = await _resolve_sms_thread_id(nav.ctx.adb, nav.ctx.serial, nav.title, nav.text)
    if thread_id:
        nav.final_args = (
            f"-a android.intent.action.VIEW -d content://mms-sms/conversations/{thread_id} -f 0x14000000 -n com.android.mms/.ui.ComposeMessageRouterActivity"
            if nav.pkg == "com.android.mms"
            else f"-a android.intent.action.VIEW -d content://mms-sms/conversations/{thread_id} -f 0x14000000 -p {nav.pkg}"
        )


async def _route_instagram(nav: _Nav) -> None:
    """Instagram notifications resolve to "stale_badge"/MainActivity without a deep link (home feed): route to the
    notifications page or the DM inbox by content, else let SystemUI click it and teleport the task."""
    if nav.pkg not in ("com.instagram.android", "com.instagram.lite"):
        return
    args = nav.final_args or ""
    if not ("stale_badge" in args or "MainActivity" in args or "-d " not in args):
        return
    words = nav.text_lower
    if any(k in words for k in ("notification", "bildirim", "beğen", "like", "comment", "yorum", "follow", "takip")):
        nav.final_args = f"-a android.intent.action.VIEW -d 'https://www.instagram.com/notifications/' -f 0x14000000 -p {nav.pkg}"
    elif any(k in words for k in ("mesaj", "message", "dm", "direct", "gönderdi", "sent")):
        nav.final_args = f"-a android.intent.action.VIEW -d 'instagram://direct-inbox' -f 0x14000000 -p {nav.pkg}"
    elif nav.target_key:
        log.info("📸 [INSTAGRAM YEREL BİLDİRİM TIKLAMASI] target_key=%s", nav.target_key)
        if await _click_and_teleport(nav, "INSTAGRAM GÖREV IŞINLAMA"):
            nav.launched = True


async def _route_google_search(nav: _Nav) -> None:
    """Google app cards use an exported=false entry point: re-issue them as the public WEB_SEARCH intent built from the
    notification's own title/text (the result card instead of an empty search page)."""
    if nav.pkg != "com.google.android.googlequicksearchbox":
        return
    title = (nav.title or "").strip()
    text = (nav.text or "").strip()
    query = (title if title.lower() not in ("google", "google search") else text) or text
    if query:
        clean_q = query.replace('"', "").replace("'", "").strip()
        nav.final_args = f"-a android.intent.action.WEB_SEARCH --es query {shlex.quote(clean_q)} -p {nav.pkg}"
        log.info("🔍 [GOOGLE ARAMA YÖNLENDİRMESİ DEVREDE] query='%s' args=%s", clean_q, nav.final_args)


async def _route_protected_provider(nav: _Nav) -> None:
    """Gmail's SAPI provider refuses shell starts (SecurityException): SystemUI click + teleport; if no task appears,
    Gmail's exported conversation list on the virtual display (never a black screen)."""
    args = nav.final_args or ""
    if not (nav.pkg == "com.google.android.gm" or "com.google.android.gm.sapi" in args or "application/gmail-ls" in args):
        return
    nav.tier1_blocked = True
    if nav.target_key:
        log.info("📧 [GMAIL / ÖZEL SAĞLAYICI DEVREDE] target_key=%s", nav.target_key)
        if await _click_and_teleport(nav, "GMAIL GÖREV IŞINLAMA"):
            nav.launched = True
    if not nav.launched and nav.disp_id:
        log.info("📧 [GMAIL GÜVENLİ DİREKT BAŞLATMA] pkg=%s disp_id=%s", nav.pkg, nav.disp_id)
        with contextlib.suppress(Exception):
            await nav.ctx.adb.shell(
                f"am start {nav.disp_prefix}-n com.google.android.gm/.ConversationListActivityGmail -f 0x10000000",
                serial=nav.ctx.serial, timeout_s=3.0,
            )
            await asyncio.sleep(0.15)
            task_on_d0 = await find_task_id_for_package(nav.ctx, nav.pkg, display_id="0")
            if task_on_d0:
                await _move_task(nav.ctx, task_on_d0, nav.disp_id, "GMAIL GÖREV IŞINLAMA")
            nav.launched = True


async def _route_twitter(nav: _Nav) -> None:
    """X/Twitter trampolines are exported=false: DMs via the public twitter://messages link, anything else via a
    SystemUI click + teleport (SystemUI's uid may start them)."""
    if nav.pkg != "com.twitter.android" or nav.launched:
        return
    if any(k in nav.text_lower for k in ("mesaj", "message", "dm", "direkt", "gönderdi", "sent")):
        nav.final_args = f"-a android.intent.action.VIEW -d 'twitter://messages' -f 0x14000000 -p {nav.pkg}"
        log.info("🐦 [TWITTER/X DM YÖNLENDİRMESİ] args=%s", nav.final_args)
    elif nav.target_key:
        log.info("🐦 [TWITTER/X YEREL BİLDİRİM TIKLAMASI] target_key=%s", nav.target_key)
        if await _click_and_teleport(nav, "TWITTER GÖREV IŞINLAMA"):
            nav.launched = True


async def _route_whatsapp(nav: _Nav) -> None:
    if nav.pkg == "com.whatsapp" and nav.final_args:
        nav.final_args = _force_clear_top(nav.pkg, nav.final_args)
        log.info("💬 [WHATSAPP DERİN SOHBET ROTASI] args=%s", nav.final_args)


_APP_ROUTES = (_route_sms, _route_instagram, _route_google_search, _route_protected_provider, _route_twitter, _route_whatsapp)


# ---------------------------------------------------------------------------------------------------------------------
# Launch tiers
# ---------------------------------------------------------------------------------------------------------------------

async def _tier1_direct_start(nav: _Nav) -> None:
    """Direct start on the virtual display (~97% of apps). OEM AppLock (reported by `am start` or visible on display 0)
    hands over to the lock waiter; a refused trampoline retries with just the intent's data URI."""
    ctx = nav.ctx
    try:
        cmd = f"am start {nav.disp_prefix}{nav.final_args}".strip()
        log.debug("🚀 [TIER 1 BAŞLATMA] cmd=%s", cmd)
        res = await ctx.adb.shell(cmd, serial=ctx.serial, timeout_s=3.0)
        log.debug("🚀 [TIER 1 ÇIKTI] res=%s", res.strip() if res else "<boş>")

        is_lock = _is_app_lock_response(res)
        if not is_lock and nav.disp_id:
            # Xiaomi HyperOS / Samsung Knox may return no error yet raise the AppLock on display 0.
            await asyncio.sleep(0.12)
            is_lock = await device_queries.app_lock_visible(ctx.adb, ctx.serial, timeout_s=1.5)

        if is_lock:
            log.info("🔒 [UYGULAMA KİLİDİ AKTİF] %s telefonda kilitli; ortak kilit bekleyicisi devreye giriyor...", nav.pkg)
            if nav.disp_id:
                nav.launched = await _wait_for_app_lock_then_deep_link(nav)
        elif not _start_denied(res):
            log.info("🚀 [NAVİGASYON: TIER 1 BAŞARILI] %s (Display %s)", nav.pkg, nav.disp_id)
            nav.launched = True
        else:
            first_line = res.strip().splitlines()[0] if res.strip() else "engellendi"
            log.warning("⚠️ [TIER 1 ENGELLENDİ] pkg=%s hata='%s' args='%s' -> Tier 2 devreye giriyor", nav.pkg, first_line, nav.final_args)
    except Exception as exc:
        first_err = str(exc).strip().splitlines()[0] if str(exc).strip() else "unknown"
        if _is_app_lock_response(first_err):
            log.info("🔒 [UYGULAMA KİLİDİ AKTİF (EXCEPTION)] %s telefonda kilitli; ortak kilit bekleyicisi devreye giriyor...", nav.pkg)
            if nav.disp_id:
                nav.launched = await _wait_for_app_lock_then_deep_link(nav)
        else:
            log.warning("⚠️ [TIER 1 BAŞLATMA HATASI] pkg=%s hata='%s' args='%s'", nav.pkg, first_err, nav.final_args)

    # Refused trampoline but the intent carries a data URI: open the URI itself.
    if not nav.launched and "-d " in (nav.final_args or ""):
        data_uri = option_value(nav.final_args, "-d")
        if data_uri:
            direct_deep_cmd = f"am start {nav.disp_prefix}-a android.intent.action.VIEW -d {shlex.quote(data_uri)} -f 0x14000000 -p {nav.pkg}"
            with contextlib.suppress(Exception):
                res_d = await ctx.adb.shell(direct_deep_cmd, serial=ctx.serial, timeout_s=2.5)
                if not _start_denied(res_d):
                    log.info("🚀 [NAVİGASYON: TIER 1 DEEP LINK BAŞARILI] %s -> %s", nav.pkg, direct_deep_cmd)
                    nav.launched = True


async def _tier2_freeform_and_migrate(nav: _Nav) -> None:
    """Freeform start on the phone (doesn't take over its full screen) — or a SystemUI click when even that is
    refused — then the task is moved onto the virtual display."""
    ctx = nav.ctx
    log.debug("🛡️ [TIER 2 DEVREDE: FREEFORM & TASK MIGRATION] pkg=%s", nav.pkg)
    component = option_value(nav.final_args, "-n")
    ff_cmd = f"am start --windowingMode 5 -n {shlex.quote(component) if component else nav.pkg}".strip()
    ff_failed = False
    try:
        ff_res = await ctx.adb.shell(ff_cmd, serial=ctx.serial, timeout_s=2.5)
        log.debug("🛡️ [TIER 2 FREEFORM BAŞLATMA] cmd=%s res=%s", ff_cmd, ff_res.strip() if ff_res else "<boş>")
        if _is_app_lock_response(ff_res):
            nav.launched = await _wait_for_app_lock_then_deep_link(nav)
            ff_failed = not nav.launched
        elif _start_denied(ff_res):
            ff_failed = True
    except Exception as ff_exc:
        if _is_app_lock_response(str(ff_exc)):
            nav.launched = await _wait_for_app_lock_then_deep_link(nav)
            ff_failed = not nav.launched
        else:
            log.debug("🛡️ [TIER 2 FREEFORM AM START ENGELLENDİ: %s]", ff_exc)
            ff_failed = True

    if ff_failed and nav.target_key:
        log.debug("🔔 [TIER 2 SYSTEMUI ON_NOTIFICATION_CLICK] key=%s", nav.target_key)
        await invoke_notification_click(ctx.adb, ctx.serial, nav.target_key)

    task_id = await _wait_for_phone_task(ctx, nav.pkg)
    if task_id and await _move_task(ctx, task_id, nav.disp_id, "TIER 2 GÖREV IŞINLAMA"):
        nav.launched = True


async def _ensure_on_display(nav: _Nav) -> None:
    """A task left on the phone's display is moved onto the window — unless the app is ALREADY on the window's display
    (moving an older phone task over it caused a double window / double transition)."""
    ctx = nav.ctx
    if nav.disp_id and not await _is_package_on_display(ctx, nav.pkg, nav.disp_id):
        await asyncio.sleep(0.15)
        task_on_d0 = await find_task_id_for_package(ctx, nav.pkg, display_id="0")
        if task_on_d0 and await _move_task(ctx, task_on_d0, nav.disp_id, "GÖREV TAŞIMA"):
            nav.launched = True

    if nav.disp_id and not await _is_display_has_activity(ctx, nav.disp_id):
        log.warning("⚠️ [SANAL EKRAN BOŞ / SİYAH EKRAN] disp_id=%s pkg=%s args='%s' - güvenli başlatıcı devreye giriyor",
                    nav.disp_id, nav.pkg, nav.final_args)
        nav.launched = False


async def _safe_launch(nav: _Nav) -> None:
    """Last resort: the app's launcher activity on the virtual display — never leave it empty/black."""
    ctx = nav.ctx
    log.info("🚀 [SON ÇARE GÜVENLİ BAŞLATMA] pkg=%s disp_id=%s", nav.pkg, nav.disp_id)
    launcher_cmp = await _resolve_default_launcher_activity(ctx.adb, ctx.serial, nav.pkg)
    safe_cmd = (
        f"am start {nav.disp_prefix}-n {shlex.quote(launcher_cmp)} -f 0x10000000"
        if launcher_cmp
        else f"monkey {nav.disp_prefix}-p {nav.pkg} -c android.intent.category.LAUNCHER 1"
    )
    try:
        await ctx.adb.shell(safe_cmd, serial=ctx.serial, timeout_s=3.0)
        log.info("🚀 [NAVİGASYON: GÜVENLİ BAŞLATMA TAMAMLANDI] %s -> Display %s", nav.pkg, nav.disp_id)
        nav.launched = True
        await asyncio.sleep(0.25)
        task_on_d0 = await find_task_id_for_package(ctx, nav.pkg, display_id="0")
        if task_on_d0 and not await _is_display_has_activity(ctx, nav.disp_id):
            await _move_task(ctx, task_on_d0, nav.disp_id, "GÜVENLİ BAŞLATMA TAŞIMA")
    except Exception as safe_exc:
        log.warning("⚠️ [GÜVENLİ BAŞLATMA HATASI] pkg=%s disp=%s hata='%s'", nav.pkg, nav.disp_id, safe_exc)


async def _execute_deep_navigation(
    ctx: Any,
    pkg: str,
    disp_id: str | None,
    intent_args: str | None = None,
    target_key: str | None = None,
    title: str | None = None,
    text: str | None = None,
) -> bool:
    """EVRENSEL BİLDİRİM DERİN NAVİGASYON MOTORU — returns whether the app actually landed on the window's display.

    1. The notification's real PendingIntent (cmd notification get + dumpsys activity intents).
    2. App routes (`_APP_ROUTES`) for intents the shell can't start as-is.
    3. Tier 1 direct start → Tier 2 freeform + migrate → move a leftover phone task → safe launcher start.
    4. The notification is cleared from the phone's shade (desktop and phone stay in sync).
    """
    if not ctx.serial:
        return True

    log.info("🎯 [EVRENSEL NAVİGASYON BAŞLADI] pkg=%s disp_id=%s has_intent_args=%s target_key=%s title='%s'",
             pkg, disp_id, bool(intent_args), target_key, title)

    resolved_args = await _resolve_intent_from_system(ctx, target_key, pkg) if target_key else None
    nav = _Nav(ctx=ctx, pkg=pkg, disp_id=disp_id, target_key=target_key, title=title, text=text,
               final_args=resolved_args or intent_args)

    for route in _APP_ROUTES:
        await route(nav)

    if not nav.launched and nav.final_args and not nav.tier1_blocked:
        await _tier1_direct_start(nav)
    if not nav.launched and nav.disp_id:
        await _tier2_freeform_and_migrate(nav)
    await _ensure_on_display(nav)
    if not nav.launched and nav.disp_id:
        await _safe_launch(nav)

    if not nav.launched:
        log.error("❌ [EVRENSEL NAVİGASYON BAŞARISIZ] Hedef uygulamaya girilemedi! pkg=%s disp=%s args='%s' target_key=%s",
                  pkg, disp_id, nav.final_args, target_key)

    # Sync: clear the notification from the phone's own shade, as if it had been tapped there.
    if target_key:
        with contextlib.suppress(Exception):
            res = await notification_invoker.clear(ctx.adb, ctx.serial, target_key, pkg, timeout_s=2.5)
            log.debug("🎯 [BİLDİRİM TELEFONDAN TEMİZLENDİ 🧹] res=%s", res)

    return nav.launched
