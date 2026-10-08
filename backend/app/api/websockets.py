"""WebSocket surface: per-window video, per-window audio (Android 13+) or the single legacy session audio, and the
event channel (wire contract with frontend eventStream.js)."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..device import android_shell
from ..events import cancel_and_wait
from ..device.media_control import send_media_action, send_media_seek
from ..schemas.identifiers import MEDIA_ACTIONS, is_package_name
from ..input import keyboard_control, touch_control
from ..input.touch_control import TouchAction
from ..logging_config import BackoffLogLimiter
from ..streams.broadcaster import CLOSE_SENTINEL, FrameBroadcaster

log = logging.getLogger(__name__)
ws_router = APIRouter()

_TOUCH_ACTION_TYPES = {"down", "move", "up"}
# Every message type /ws/input understands. Pinned in frontend/tests/fixtures/backend-input-contract.json so the UI
# cannot send a type this list does not have (the way the D-pad's `kind: "dpad"` was silently refused for months).
INPUT_MESSAGE_TYPES = frozenset({*_TOUCH_ACTION_TYPES, "scroll", "clipboard", "release_all"})
ws_log_limiter = BackoffLogLimiter(intervals=(1.0, 2.0, 4.0, 8.0), max_interval=8.0)


async def _pump_broadcaster(ws: WebSocket, broadcaster: FrameBroadcaster) -> None:
    client_id, queue = broadcaster.register()
    try:
        while True:
            chunk = await queue.get()
            if chunk == CLOSE_SENTINEL:
                break  # window closed — signal precedes resource teardown
            await ws.send_bytes(chunk)
    except (WebSocketDisconnect, asyncio.CancelledError, ConnectionResetError, OSError):
        pass
    finally:
        broadcaster.unregister(client_id)


# Text message a video client sends when its decoder cannot continue without a keyframe (decode error, backlog resync):
# the encoder's own keyframe is up to 60 s away (10 s upstream); this brings one within a frame or two.
KEYFRAME_REQUEST = "keyframe"


async def _read_client_requests(ws: WebSocket, broadcaster: FrameBroadcaster) -> None:
    """Reads what a video client sends. Returns when the client is gone — which also tells the caller to stop pumping
    (a pump blocked on an idle stream would otherwise notice the disconnect only at the next frame)."""
    try:
        while True:
            message = await ws.receive_text()
            if message == KEYFRAME_REQUEST:
                broadcaster.request_keyframe("client decoder resync")
    except (WebSocketDisconnect, RuntimeError, asyncio.CancelledError):
        return


async def _serve_video_client(ws: WebSocket, broadcaster: FrameBroadcaster) -> None:
    pump = asyncio.create_task(_pump_broadcaster(ws, broadcaster), name="video-ws-pump")
    requests = asyncio.create_task(_read_client_requests(ws, broadcaster), name="video-ws-requests")
    try:
        await asyncio.wait({pump, requests}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        await cancel_and_wait(pump)
        await cancel_and_wait(requests)


@ws_router.websocket("/ws/video/{window_id}")
async def ws_video(ws: WebSocket, window_id: str):
    """One window's H.264 video: scrcpy's 12-byte packet headers followed by NAL units, forwarded as the encoder wrote them
    (the frontend parses the same layout). The client may send the text `keyframe` when its decoder needs a key frame."""
    await ws.accept()
    broadcaster = ws.app.state.ctx.broadcasters.get(window_id)
    if broadcaster is None:
        key = f"video_unknown_{window_id}"
        if ws_log_limiter.should_log(key):
            log.warning("📺 [VideoWS:UNKNOWN] Window broadcaster bulunamadı: %s (tekrarlayan istekler loglanmayacak)", window_id)
        await ws.close(code=4404, reason="unknown window")
        return

    log.info("📺 [VideoWS:CONNECT] Frontend bağlandı -> /ws/video/%s", window_id)
    try:
        await _serve_video_client(ws, broadcaster)
    finally:
        log.info("📺 [VideoWS:DISCONNECT] Frontend ayrıldı -> /ws/video/%s", window_id)
    try:
        await ws.close()
    except RuntimeError:
        pass


@ws_router.websocket("/ws/audio")
async def ws_audio(ws: WebSocket):
    """The phone's session-wide audio: raw PCM (s16le, stereo, 48 kHz), each chunk behind a 12-byte header. Exactly ONE
    consumer at a time — a new connection replaces the older one, so a second tab or a hot-reloaded page never plays twice."""
    await ws.accept()
    broadcaster = ws.app.state.ctx.broadcasters.get_audio_broadcaster()
    if broadcaster.client_count > 0:
        log.info("🔊 [AudioWS:EVICT] Evicting %d older audio subscriber(s) to guarantee single playback", broadcaster.client_count)
        broadcaster.close()
    if ws_log_limiter.should_log("audio_ws_session"):
        log.info("🔊 [AudioWS:SESSION] Client connected to master session audio /ws/audio (captures all device sounds)")
    await _pump_broadcaster(ws, broadcaster)
    try:
        await ws.close()
    except RuntimeError:
        pass



@ws_router.websocket("/ws/audio/{window_id}")
async def ws_window_audio(ws: WebSocket, window_id: str):
    """One window's own audio (per-app capture, Android 13+): the same PCM framing as /ws/audio. One consumer per window —
    the newest connection wins, same rule as /ws/audio."""
    await ws.accept()
    broadcaster = ws.app.state.ctx.broadcasters.get(f"audio:{window_id}")
    if broadcaster is None:
        await ws.close(code=4404, reason="no audio for window")
        return
    if broadcaster.client_count > 0:
        broadcaster.close()
    await _pump_broadcaster(ws, broadcaster)
    try:
        await ws.close()
    except RuntimeError:
        pass


@ws_router.websocket("/ws/input/{window_id}")
async def ws_input(ws: WebSocket, window_id: str) -> None:
    """Touch, scroll and clipboard injection for one window — one persistent connection per window, JSON messages."""
    await ws.accept()
    window_manager = ws.app.state.ctx.window_manager
    session = window_manager.get_session(window_id)
    if session is None:
        key = f"input_unknown_{window_id}"
        if ws_log_limiter.should_log(key):
            log.warning("🖱️ [InputWS:UNKNOWN] Window session bulunamadı: %s", window_id)
        await ws.close(code=4404, reason="unknown window")
        return

    log.info("🖱️ [InputWS:CONNECT] Frontend dokunma/fare soketi bağlandı -> /ws/input/%s", window_id)
    window_manager = ws.app.state.ctx.window_manager
    finger = touch_control.TouchTracker()
    try:
        while True:
            msg = await ws.receive_json()
            session = window_manager.get_session(window_id)
            if session is None or session.control is None:
                # window closed/frozen mid-gesture — drop, don't crash the socket. The control that held the finger is
                # gone with it, so the record goes too (a later release must not hit a rebuilt control).
                finger.forget()
                continue
            kind = msg.get("type")
            try:
                w, h = session.display_w, session.display_h
                if kind == "release_all":
                    # The page lost focus / was hidden / is closing: lift whatever this connection still holds down.
                    await finger.release(session.control, w, h)
                elif kind in _TOUCH_ACTION_TYPES or kind == "scroll":
                    x = int(msg["x"])
                    y = int(msg["y"])
                    if kind in _TOUCH_ACTION_TYPES:
                        # Touch down/up logging disabled to prevent terminal log spamming
                        action = TouchAction[kind.upper()]
                        await touch_control.inject_touch(session.control, x, y, action, w, h)
                        finger.note(session.control, action, x, y)   # only what was really delivered counts as pressed
                    else:
                        # Touch scroll logging disabled to prevent terminal log spamming
                        await touch_control.inject_scroll(
                            session.control, x, y, w, h,
                            msg.get("hscroll", 0.0), msg.get("vscroll", 0.0),
                        )
                elif kind == "clipboard":
                    text = msg.get("text", "")
                    paste = msg.get("paste", True)
                    if text:
                        log.debug("[Input:CLIPBOARD 📋] win=%s text_len=%d paste=%s", window_id, len(text), paste)
                        await session.control.send(keyboard_control.serialize_set_clipboard(text, paste=paste))
            except (ValueError, KeyError) as exc:
                log.warning("[Touch:DROP ⚠️] dropping input for %s (%s): %s", window_id, kind, exc)
            except (ConnectionResetError, BrokenPipeError, OSError) as exc:
                log.debug("[Touch:SOCKET_CLOSED 🔌] control socket closed for %s (%s): %s", window_id, kind, exc)
                break
    except (WebSocketDisconnect, asyncio.CancelledError, ConnectionResetError, OSError):
        pass
    finally:
        # The socket ended (tab closed, network dropped, backend restarting) with a finger possibly still down:
        # nobody will ever send its UP, so do it here.
        session = window_manager.get_session(window_id)
        if finger.pressed and session is not None and session.control is not None:
            lifted = await finger.release(session.control, session.display_w, session.display_h)
            if lifted:
                log.info("🖱️ [InputWS:RELEASE] Soket kapanırken basılı kalan parmak bırakıldı -> /ws/input/%s", window_id)
        log.info("🖱️ [InputWS:DISCONNECT] Frontend dokunma/fare soketi ayrıldı -> /ws/input/%s", window_id)


@ws_router.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    """Backend → client state events (events.py), JSON text frames `{type, payload}`. Also a duplex command channel for the
    hot paths (media, volume, quick toggles, ping) so a UI needs no HTTP round trip for them."""
    await ws.accept()
    ctx = ws.app.state.ctx
    bus = ctx.event_bus
    queue = await bus.subscribe()

    async def _pump_out() -> None:
        try:
            while True:
                event = await queue.get()
                await ws.send_text(event.model_dump_json())
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass

    async def _pump_in() -> None:
        try:
            while True:
                msg = await ws.receive_json()
                if not isinstance(msg, dict):
                    continue
                try:
                    msg_type = msg.get("type") or msg.get("action")
                    if msg_type == "ping":
                        # Gerçek RTT ölçümü (frontend rttProbe.js): istemcinin `t` damgası aynen
                        # geri yansıtılır; süreyi istemci KENDİ saatiyle ölçer.
                        await ws.send_text(json.dumps({"type": "pong", "id": msg.get("id"), "t": msg.get("t")}))
                        continue
                    # The frontend (notificationStore/systemStore) sends ONE shape per type; a "payload" dict, when
                    # present, carries the same fields.
                    payload = msg.get("payload") if isinstance(msg.get("payload"), dict) else msg
                    if msg_type == "media_action":
                        act = payload.get("action", "toggle")
                        pkg = payload.get("package")
                        if act not in MEDIA_ACTIONS or (pkg and not is_package_name(pkg)):
                            # Same gate as the REST models: these two strings go onto the daemon's LINE protocol.
                            with contextlib.suppress(Exception):
                                await ws.send_text(json.dumps({"type": "media_action_ack", "action": act, "package": pkg,
                                                               "result": {"ok": False, "error": "bad_request"}}))
                            continue
                        log.info("🎵 [WS_EVENT:IN /ws/events ⚡] Received media_action: action='%s', package='%s'", act, pkg)
                        res = await send_media_action(ctx, act, pkg, log_context="WS_EVENT_DISPATCH")
                        log.info("🎵 [WS_EVENT:OUT /ws/events ⚡] media_action '%s' (pkg=%s) completed with result: %s", act, pkg, res)
                        with contextlib.suppress(Exception):
                            await ws.send_text(json.dumps({"type": "media_action_ack", "action": act, "package": pkg, "result": res}))
                    elif msg_type == "media_seek":
                        pos_ms = payload.get("position", payload.get("position_ms", 0))
                        pkg = payload.get("package")
                        if pkg and not is_package_name(pkg):
                            with contextlib.suppress(Exception):
                                await ws.send_text(json.dumps({"type": "media_seek_ack", "package": pkg, "ok": False, "error": "bad_request"}))
                            continue
                        log.info("⏩ [WS_EVENT:IN /ws/events ⚡] Received media_seek: pos_ms=%s, package='%s'", pos_ms, pkg)
                        try:
                            clean_pos_ms = int(float(pos_ms or 0))
                        except (ValueError, TypeError):
                            clean_pos_ms = 0

                        # send_media_seek covers both the daemon-socket fast path and the
                        # CLI MediaBridge fallback, JSON-validating the fallback's reply so
                        # `ok` is never optimistically set on a bare successful process exit.
                        seek_ok = False
                        seek_error = None
                        with contextlib.suppress(Exception):
                            seek_result = await send_media_seek(ctx, clean_pos_ms, pkg)
                            seek_ok = bool(seek_result.get("ok"))
                            seek_error = None if seek_ok else seek_result.get("error")
                            log.info("⏩ [WS_EVENT:IN /ws/events ⚡] Seek result: %s", seek_result)

                        ack = {"type": "media_seek_ack", "position_ms": clean_pos_ms, "package": pkg, "ok": seek_ok}
                        if seek_error:
                            ack["error"] = str(seek_error)   # "session_gone": the named app has no media session
                        with contextlib.suppress(Exception):
                            await ws.send_text(json.dumps(ack))
                    elif msg_type == "set_volume" and ctx.serial:
                        await android_shell.set_stream_volume(
                            ctx.adb, ctx.serial, ctx.daemon_client,
                            int(payload.get("stream_id", 3)), int(payload.get("value", payload.get("volume", 0))),
                        )
                    elif msg_type == "set_hardware_state" and ctx.serial:
                        await android_shell.set_hardware_state(
                            ctx.adb, ctx.serial, ctx.daemon_client,
                            str(payload.get("key", "")).lower(), bool(payload.get("value", payload.get("enabled", False))),
                        )
                    elif msg_type == "set_display_power" and ctx.serial:
                        await ctx.display_power.set(bool(payload.get("on", True)), source="ws")
                except Exception as msg_err:
                    log.warning("[ws_events:IN] Error processing %s: %s", msg.get("action") or msg.get("type"), msg_err)
        except (WebSocketDisconnect, asyncio.CancelledError):
            pass
        except Exception as exc:
            log.debug("[ws_events:IN] Error processing message: %s", exc)

    sender_task = asyncio.create_task(_pump_out())
    receiver_task = asyncio.create_task(_pump_in())

    try:
        done, pending = await asyncio.wait(
            [sender_task, receiver_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
    finally:
        await bus.unsubscribe(queue)
