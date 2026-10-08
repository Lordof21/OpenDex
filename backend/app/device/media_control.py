"""Resilient device media control (Karar: media-control consolidation).

Single source of truth for the "daemon socket fast path -> CLI MediaBridge
fallback -> (for actions only) global keyevent last resort" strategy that
used to be reimplemented independently in ``api/v1/endpoints/notifications.py``
(three times), ``api/websockets.py``, and ``api/v1/endpoints/diagnostics.py`` —
each with a different, drifted level of rigor when validating the CLI
fallback's JSON reply.

The CLI tier never treats a bare successful process exit as success — the
MediaBridge reply body is always JSON-inspected for ``active: false``,
``ok: false``, or an ``error`` field before being trusted.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from . import tools_jar

log = logging.getLogger(__name__)

_MEDIA_BRIDGE_JAR = tools_jar.DEVICE_TOOLS_JAR
_MEDIA_BRIDGE_CLASS = "com.opendex.tools.MediaBridge"

# Global Android keyevent fallback (used only for playback actions — there is
# no meaningful keyevent equivalent for an arbitrary-position seek).
_KEYEVENT_FOR_ACTION = {
    # PLAY (126) / PAUSE (127) are absolute; PLAY_PAUSE (85) is a toggle — sending it for "play" paused music that
    # was already playing. Only an explicit toggle may use 85.
    "play": 126, "pause": 127, "toggle": 85, "play_pause": 85,
    "prev": 88, "previous": 88,
}
_DEFAULT_KEYEVENT = 87  # next


def _is_cli_error(parsed: dict) -> bool:
    """True if a MediaBridge JSON reply signals failure."""
    return parsed.get("active") is False or parsed.get("ok") is False or "error" in parsed


async def _run_media_bridge(ctx, *args: Any, timeout_s: float = 3.0) -> tuple[bool, dict | None, str]:
    """Runs `MediaBridge <args...>` via app_process and JSON-inspects the output.

    Returns ``(ok, parsed_json_or_None, raw_stdout)``. ``ok`` is only True when
    the process produced non-empty output AND (if that output parsed as JSON)
    the JSON did not signal an error — a bare successful exit is never enough.
    """
    if not ctx.serial:
        return False, None, ""
    out = await ctx.adb.run_java_tool(
        _MEDIA_BRIDGE_JAR, _MEDIA_BRIDGE_CLASS, *args,
        serial=ctx.serial, timeout_s=timeout_s, capture_bytes=True,
    )
    out_str = out.decode("utf-8", errors="replace").strip() if isinstance(out, (bytes, bytearray)) else str(out).strip()
    try:
        parsed = json.loads(out_str)
    except Exception:
        parsed = None
    ok = bool(out_str) and not (parsed is not None and _is_cli_error(parsed))
    return ok, parsed, out_str


async def send_media_action(ctx, action: str, package: str | None, *, log_context: str) -> dict[str, Any]:
    """3-tier: daemon socket -> CLI MediaBridge (JSON-validated) -> global keyevent.

    Shared by every call site that issues a native media-playback command from
    an HTTP action or a WebSocket event.

    The global keyevent tier is used ONLY when no package was named. A media key reaches whichever app Android routes
    media buttons to, so for a named package it acted on a different app exactly when the named one had gone: play/
    pause on the card of a closed YouTube toggled the still-running YouTube Music. A named package that neither tier
    could reach is reported instead — ``error: "session_gone"`` when the phone said that app has no media session.
    """
    log.info(
        "🎵 [MediaControl] START: action='%s' pkg='%s' context='%s' serial='%s' daemon_connected=%s",
        action, package, log_context, ctx.serial, bool(ctx.daemon_client and ctx.daemon_client.is_connected),
    )

    # 1. Daemon socket fast path
    if ctx.daemon_client and ctx.daemon_client.is_connected:
        try:
            ok = await ctx.daemon_client.send_media_action(action, package)
            if ok:
                log.info("🎵 [%s (DAEMON ⚡)] SUCCESS action=%s pkg=%s", log_context, action, package)
                return {"ok": True, "action": f"media_{action}", "package": package}
            log.warning(
                "🎵 [MediaControl] Daemon socket returned False for action='%s' pkg='%s'. Falling back to CLI...",
                action, package,
            )
        except Exception as d_err:
            log.warning("🎵 [MediaControl] Daemon socket error: %s. Falling back to CLI...", d_err)

    # 2. CLI MediaBridge fallback via ADB (JSON-validated)
    cli_error: str | None = None
    try:
        ok, parsed, raw = await _run_media_bridge(ctx, action, package or "")
        log.info("🎵 [%s (CLI 🎧)] action=%s pkg=%s stdout='%s'", log_context, action, package, raw)
        if ok:
            return {"ok": True, "action": f"media_{action}", "package": package}
        if parsed is not None:
            cli_error = str(parsed.get("error") or "")
            log.warning("🎵 [MediaControl] CLI MediaBridge indicated no active session or error (%s)", raw)
    except Exception as exc:
        log.warning("MediaBridge %s call failed (%s)", log_context, exc)

    if package:
        # The phone answered for this app: it has no media session (closed/stopped). Anything else: unreachable now.
        gone = cli_error in ("session_gone", "no_active_media_session")
        log.warning("🎵 [MediaControl] pkg=%s not reached (%s) — no global keyevent for a named package",
                    package, "session_gone" if gone else "unreachable")
        return {"ok": False, "action": f"media_{action}", "package": package,
                "error": "session_gone" if gone else "media_unreachable"}

    # 3. Last Resort: Global Android Keyevent Injection
    fallback_key = _KEYEVENT_FOR_ACTION.get(action, _DEFAULT_KEYEVENT)
    log.warning("🎵 [MediaControl:LAST_RESORT] Sending global Android input keyevent %d (action=%s)", fallback_key, action)
    try:
        await ctx.adb.shell(f"input keyevent {fallback_key}", serial=ctx.serial)
        log.info("🎵 [MediaControl:LAST_RESORT] Successfully sent keyevent %d", fallback_key)
        return {"ok": True, "action": f"media_{action}_fallback"}
    except Exception as key_err:
        log.error("🎵 [MediaControl:KEYEVENT_FAILED] Keyevent %d injection failed: %s", fallback_key, key_err)
        return {"ok": False, "error": str(key_err)}


async def send_media_seek(ctx, target_ms: int, package: str | None) -> dict[str, Any]:
    """2-tier: daemon socket -> CLI MediaBridge (JSON-validated).

    Always returns a dict with a trustworthy boolean ``ok`` — never
    optimistically set just because the CLI process exited without raising
    (this is the fix for the WebSocket seek path's previous ``seek_ok = True``
    bug).
    """
    if ctx.daemon_client and ctx.daemon_client.is_connected:
        try:
            ok = await ctx.daemon_client.send_media_seek(target_ms, package)
            if ok:
                return {"ok": True, "action": "seek", "position": target_ms, "package": package}
            log.warning("⏩ [MediaControl] Daemon seek returned False for pos=%dms pkg=%s, falling back to CLI...", target_ms, package)
        except Exception as d_err:
            log.warning("⏩ [MediaControl] Daemon seek error: %s. Falling back to CLI...", d_err)

    ok, parsed, raw = await _run_media_bridge(ctx, "seek", target_ms, package or "")
    if parsed is not None:
        parsed.setdefault("ok", ok)
        return parsed
    return {"ok": ok, "action": "seek", "position": target_ms, "package": package, "raw": raw}


async def get_media_status(ctx, package: str | None, *, fresh: bool = False) -> dict[str, Any]:
    """In-memory daemon cache fast path, else CLI `MediaBridge get` (which
    itself proxies ``OpenDexDaemon.getMediaJson`` on-device).

    `fresh=True`: canlı bir anlık görüntü ister (daemon `media_get`, tam kapak) — DeX'te bir eylemden sonraki
    doğrulama çekişi ve kapak bekleme merdiveni bunu kullanır; telefon otoritedir. Yanıt itilen olaylarla AYNI hattan
    geçer (önbellek + tüm istemciler güncellenir). Alınamazsa normal (önbellek/CLI) yola düşülür."""
    if fresh and ctx.daemon_client and ctx.daemon_client.is_connected:
        try:
            live = await ctx.daemon_client.refresh_media(package)
        except Exception as exc:  # noqa: BLE001
            log.warning("📻 [MediaStatus:FRESH] canlı okuma başarısız (%s) — önbelleğe düşülüyor", exc)
            live = None
        if live is not None:
            return {k: v for k, v in live.items() if k not in ("req_id",)}

    if ctx.daemon_client and ctx.daemon_client.is_connected and ctx.daemon_client.last_media_state.get("active", False):
        state = ctx.daemon_client.last_media_state
        if not package or state.get("package") == package:
            log.info(
                "📻 [MediaStatus ⚡] Cache hit (daemon): title='%s' artist='%s' is_playing=%s pos=%s/%s pkg=%s",
                state.get("title"), state.get("artist"), state.get("is_playing"),
                state.get("position"), state.get("duration"), state.get("package"),
            )
            return state

    try:
        _, parsed, raw = await _run_media_bridge(ctx, "get", package or "")
        if parsed is None:
            raise ValueError(f"MediaBridge returned non-JSON output: {raw[:120]!r}")
        log.info(
            "📻 [MediaStatus 🎧] CLI result: active=%s title='%s' is_playing=%s pos=%s/%s pkg=%s",
            parsed.get("active"), parsed.get("title"), parsed.get("is_playing"),
            parsed.get("position"), parsed.get("duration"), parsed.get("package"),
        )
        return parsed
    except Exception as exc:
        log.error("📻 [MediaStatus ❌] Error fetching media status: %s", exc)
        return {"active": False, "error": str(exc)}
