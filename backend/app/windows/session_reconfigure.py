"""Encoder session reconfiguration: freeze/unfreeze, resize (flex in-place +
legacy freeze/rebuild), the per-window video pump, and the FORCE_RESIZE_APP
compat override.

Split out of window_manager.py — this is the "stop, restart, or live-adjust
the on-device encoder" engine. Every operation here works on a SINGLE
session already present in the (shared, by-reference) sessions dict; opening
or closing a session at all is window_manager.py's own job, not this
module's.

Callers (WindowManager's freeze_window/unfreeze_window/resize_window, and
budget_reallocator.py's freeze/unfreeze callbacks) are responsible for
holding the device-wide lifecycle lock for the duration of these calls, same
as every other window-lifecycle operation.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..config import Settings
from ..device import android_shell
from ..device.adb import Adb
from ..device.device_manager import DeviceNotBoundError
from ..events import EventBus, cancel_and_wait, spawn_background
from ..logging_config import window_logger
from ..schemas import DeviceProfile, ProjectSettings, WindowHandle
from ..storage import settings_db
from ..streams.broadcaster import BroadcasterRegistry
from ..telemetry import markers as load_markers
from ..streams.video_stream import (
    HEADER_SIZE,
    FrameMeta,
    SessionMeta,
    find_sps_profile,
    read_video_socket,
)
from .display_ids import known_display_id
from .dpi_policy import negotiate_dpi
from .eco_workspace import ANCHOR_MARKER
from .mirror_packages import is_mirror_package
from .scrcpy_launcher import (
    ScrcpyServer,
    flex_constrained_size,
    serialize_opendex_resize,
    serialize_opendex_request_keyframe,
    serialize_reset_video,
    serialize_resize_display,
)
from .spawn_profile import bring_up_server, flex_display_enabled, spawn_window_server

if TYPE_CHECKING:
    from .window_manager import WindowSession

log = logging.getLogger(__name__)


class FlexResizeUnsupportedError(RuntimeError):
    """A RESIZE_DISPLAY control message produced no confirming session packet
    in time, or flex resize is disabled/already known unsupported for this
    device. Callers must fall back to freeze/unfreeze."""


class FlexResizeAborted(RuntimeError):
    """The window's video pump ended while a flex resize was waiting for its confirmation (the server stopped or died).
    NOT evidence that flex resize is unsupported, and no reason to rebuild the display from here: whatever ended the
    pump owns what happens next. The requested size and density are kept as the session's target for its next encoder
    start."""


@dataclass
class _PendingAck:
    """A flex resize waiting for scrcpy's session packet. ``expected``: the size scrcpy will produce, when the encoder
    alignment is known (flex_constrained_size); None otherwise."""

    future: "asyncio.Future[SessionMeta]"
    expected: tuple[int, int] | None


def resolution_aware_bitrate(width: int, height: int, fps: int, configured_bitrate: int, settings: Settings) -> int:
    """A FLOOR, not the actual value: ``max(configured_bitrate, w*h*fps*bpp)``.

    ``video_bit_rate`` used to be a single, resolution-agnostic project
    setting — opening a small windowed panel and later growing it (dynamic
    bucket growth, or dynamic_fit continuously enlarging the request) never
    re-examined it, so the SAME bitrate budget that looked fine small kept
    getting reused at a much larger target — visible blocking/softness
    ("kalite düşüyor"), worst on screen content (sharp text/UI edges compress
    far worse than camera video). Never LOWERS what the user explicitly
    configured for a small target — only raises an under-provisioned one for
    a large target. See Settings.MIN_BITS_PER_PIXEL_PER_FRAME's docstring for
    how the floor constant itself was chosen.
    """
    floor = int(width * height * max(fps, 1) * settings.MIN_BITS_PER_PIXEL_PER_FRAME)
    return max(configured_bitrate, floor)


# UPSTREAM SERVER ONLY (a patched one carries the new bitrate in the resize
# message itself — OPENDEX_RESIZE + bitrate_on_reset, §4.4).
# RESIZE_DISPLAY (flex resize) carries no bitrate field — see
# scrcpy_launcher.serialize_resize_display's docstring — so an in-place flex
# resize structurally cannot push a live bitrate bump to the encoder the way
# freeze/unfreeze does. Below this ratio we accept the existing bitrate
# staying under the new floor (a drag-resize nudge, self-corrects on the next
# freeze/unfreeze or window reopen); at or above it we route through
# resize()'s legacy freeze/unfreeze path instead, which already reapplies
# resolution_aware_bitrate() on respawn (see below). Trades one non-"zero-
# blink" resize for correct quality only on jumps big enough to matter.
FLEX_RESIZE_BITRATE_FLOOR_SLACK = 1.5


class SessionReconfigurer:
    def __init__(
        self,
        adb: Adb,
        settings: Settings,
        events: EventBus,
        broadcasters: BroadcasterRegistry,
        sessions: dict[str, "WindowSession"],
        *,
        serial_getter,
        profile_getter,
        android_id_getter,
        daemon_client_getter=None,
        on_anchor_pump_terminated=None,
        on_window_pump_ended=None,
        link_dropped=None,
        density=None,
    ) -> None:
        self._adb = adb
        self._settings = settings
        self._events = events
        # density_reconciler.DensityReconciler (None in tests that don't care): a live DPI change reaches the app's
        # process like any other density change, and the process must be reborn if it cannot adapt to it.
        self._density = density
        self._broadcasters = broadcasters
        # SAME dict WindowManager owns — never copied.
        self._sessions = sessions
        self._serial_getter = serial_getter
        self._profile_getter = profile_getter
        self._android_id_getter = android_id_getter
        self._daemon_client_getter = daemon_client_getter or (lambda: None)
        # EcoWorkspaceManager.notify_anchor_pump_terminated, injected lazily
        # (WindowManager constructs EcoWorkspaceManager AFTER this class,
        # since EcoWorkspaceManager itself needs THIS class's
        # start_video_pump — see window_manager.py's __init__ ordering) —
        # called with (window_id: str), sync, whenever ANY session's video
        # pump ends; a no-op for every window_id that isn't the eco-anchor.
        self._on_anchor_pump_terminated = on_anchor_pump_terminated
        # HandoffManager.on_pump_ended (async, takes the session): any OTHER window's pump ended — whether that means
        # "the app left for the phone" is the handoff layer's decision, not this encoder engine's.
        self._on_window_pump_ended = on_window_pump_ended
        # async () -> bool (ConnectionSupervisor.link_dropped): did the adb link drop? Set lazily like the callbacks above.
        self._link_dropped = link_dropped
        # scrcpy v4.x flex resize: window_id -> the in-flight resize's confirmation, resolved by the video pump's
        # on_session callback (_resolve_resize_ack) or aborted when the pump ends (_abort_pending_ack). Never outlives
        # a single in-flight resize call.
        self._pending_resize_acks: dict[str, _PendingAck] = {}
        self._clock = time.monotonic

    # ------------------------------------------------------------------ video pump

    def start_video_pump(self, session: "WindowSession") -> None:
        assert session.server.sockets and session.server.sockets.video
        reader = session.server.sockets.video[0]
        window_id = session.state.window_id
        wlog = window_logger(__name__, window_id)
        broadcaster = self._broadcasters.get_or_create(window_id)
        # A client that cannot continue without a keyframe (broken chain, nothing cached) gets one now instead of at
        # the encoder's next, up to 10 s away. Re-bound on every pump: the control socket belongs to the current server.
        broadcaster.keyframe_requester = lambda reason: self.request_keyframe(window_id, reason)
        pump_chunk_count = 0

        async def _on_chunk(meta: FrameMeta, chunk: bytes) -> None:
            nonlocal pump_chunk_count
            pump_chunk_count += 1
            if meta.is_config:
                broadcaster.remember_config(chunk)
                sps = find_sps_profile(chunk[HEADER_SIZE:])
                if sps is not None:
                    wlog.info(
                        "[VideoPump ⚙️] Window=%s Config (SPS/PPS) received: profile=0x%02x level=0x%02x size=%d",
                        window_id[:8],
                        sps.profile_idc,
                        sps.level_idc,
                        meta.size,
                    )
            elif meta.is_key_frame:
                wlog.info(
                    "[VideoPump 🔑] Window=%s KEYFRAME #%d received from phone encoder: size=%d pts=%.1fms",
                    window_id[:8],
                    pump_chunk_count,
                    meta.size,
                    meta.pts_us / 1000.0,
                )
            elif pump_chunk_count <= 5 or pump_chunk_count % 120 == 0:
                wlog.info(
                    "[VideoPump 📤] Window=%s Chunk #%d pumped to broadcaster: size=%d is_key=%s pts=%.1fms",
                    window_id[:8],
                    pump_chunk_count,
                    meta.size,
                    meta.is_key_frame,
                    meta.pts_us / 1000.0,
                )

            await broadcaster.broadcast(
                chunk, is_key_frame=meta.is_key_frame, is_config=meta.is_config
            )

        async def _on_session(meta: SessionMeta) -> None:
            # Only MID-STREAM session packets ever reach here — the
            # handshake's own (first) session packet is consumed inside
            # ScrcpyServer.connect_sockets() before this pump task is even
            # created (see ScrcpySockets.video_meta). So a call here always
            # means the encoder's actual output size just changed — a
            # flex-resize confirmation, or a server-initiated change we did not
            # request (_resolve_resize_ack tells them apart).
            self._resolve_resize_ack(window_id, meta)

        async def _pump_wrapper() -> None:
            try:
                await read_video_socket(reader, _on_chunk, _on_session)
            except Exception as exc:  # EOF is a normal end (read_video_socket); anything else is a real failure
                wlog.warning("[Pump] video pump failed: %s: %s", type(exc).__name__, exc)
            finally:
                # No session packet can arrive any more: a resize waiting for one learns it now, not after its timeout.
                self._abort_pending_ack(window_id, "video pump ended")
                s = self._sessions.get(window_id)
                if s is not None and not await self._died_with_link(s):
                    if s.state.workspace_id == ANCHOR_MARKER:
                        # Pompa (okuma döngüsü) normal koşullarda da sık sık
                        # biter — resize/reconfigure her seferinde YENİ bir
                        # pompa görevi kurar (break-before-make), o yüzden
                        # "pompa bitti" tek başına "VD öldü" anlamına gelmez.
                        # Asıl sinyal: bu session'ın scrcpy SUNUCU SÜRECİ
                        # gerçekten ölmüş mü (server.is_alive) — öyleyse
                        # dışarıdan/Android tarafında VD çökmüş demektir ve
                        # EcoWorkspaceManager'a haber verilmezse bu hayalet
                        # oturum encoder bütçesinde bir slot işgal
                        # eder. server.is_alive hâlâ True ise (örn. bu
                        # sadece resize'ın eski pompasının doğal sonu) hiçbir
                        # şey yapılmaz.
                        if self._on_anchor_pump_terminated is not None and not s.server.is_alive:
                            with contextlib.suppress(Exception):
                                self._on_anchor_pump_terminated(window_id)
                    elif self._on_window_pump_ended is not None:
                        try:
                            await self._on_window_pump_ended(s)
                        except Exception as p_err:
                            wlog.warning("[Pump] pump-end check failed: %s: %s", type(p_err).__name__, p_err)

        session.pump_task = asyncio.create_task(
            _pump_wrapper(),
            name=f"video-pump-{window_id}",
        )

    async def _died_with_link(self, session: "WindowSession") -> bool:
        """Its server is gone because the adb link dropped (not because the app wandered to the phone or the display
        crashed). Such a window is neither a handoff nor a ghost to discard — the Workspace keeps its members, the
        standalone window its place: ConnectionSupervisor heals them in place (WindowManager.heal_links)."""
        if session.server.is_alive or self._link_dropped is None:
            return False
        try:
            dropped = await self._link_dropped()
        except Exception:  # noqa: BLE001 — an unanswerable probe must leave the old handling in charge, never break the pump's end
            return False
        if dropped:
            window_logger(__name__, session.state.window_id).info(
                "[LINK] video pompası bağlantı kopmasıyla bitti — pencere yerinde yeniden kurulacak"
            )
        return dropped

    def request_keyframe(self, window_id: str, reason: str = "") -> bool:
        """Asks the window's scrcpy server for a fresh keyframe. A server announcing "keyframe_request" makes the running
        encoder's next frame a keyframe (no restart, the decoder carries on); any other gets RESET_VIDEO (the encoder
        restarts and emits a new SPS/PPS + keyframe within a few hundred ms) — and so does the first one when no keyframe
        arrived within KEYFRAME_REQUEST_FALLBACK_S. Fire-and-forget; returns whether a request was sent.

        Not sent when: the window has no live control socket (frozen, closing); a resize is waiting for its session
        packet (the resize's own encoder reset yields the keyframe, and a second reset would be mistaken for its
        confirmation); or the last request was less than KEYFRAME_REQUEST_MIN_INTERVAL_S ago (a stalled link must not
        turn the request into a reset storm — the keyframe is already on its way)."""
        session = self._sessions.get(window_id)
        if session is None or session.state.frozen or session.control is None:
            return False
        if window_id in self._pending_resize_acks:
            return False
        now = self._clock()
        if now - session.keyframe_requested_at < self._settings.KEYFRAME_REQUEST_MIN_INTERVAL_S:
            return False
        session.keyframe_requested_at = now
        cheap = session.server.supports("keyframe_request")
        window_logger(__name__, window_id).info(
            "[Keyframe:REQ 🔑] %s — %s", reason or "?",
            "kodlayıcı durmadan keyframe isteniyor" if cheap else "RESET_VIDEO gönderiliyor (kodlayıcı yeniden başlar)",
        )
        spawn_background(self._send_keyframe_request(session, window_id, cheap), name=f"keyframe-request-{window_id}")
        return True

    async def _send_keyframe_request(self, session: "WindowSession", window_id: str, cheap: bool) -> None:
        control = session.control
        if control is None:
            return
        broadcaster = self._broadcasters.get(window_id)
        seen = broadcaster.key_frames_total if broadcaster is not None else 0
        try:
            await control.send(serialize_opendex_request_keyframe() if cheap else serialize_reset_video())
            if not cheap or broadcaster is None:
                return
            # The encoder honours it on its next frame (scrcpy repeats the last frame every 100 ms, so even a static
            # screen produces one). Nothing yet: a codec that ignored it — restart the encoder after all.
            await asyncio.sleep(self._settings.KEYFRAME_REQUEST_FALLBACK_S)
            if (broadcaster.key_frames_total == seen and session.control is control
                    and window_id not in self._pending_resize_acks):
                window_logger(__name__, window_id).warning(
                    "[Keyframe:FALLBACK] %.1f sn içinde keyframe gelmedi — RESET_VIDEO", self._settings.KEYFRAME_REQUEST_FALLBACK_S,
                )
                await control.send(serialize_reset_video())
        except Exception as exc:  # noqa: BLE001 — the socket is going away; whatever ends it owns what happens next
            window_logger(__name__, window_id).debug("[Keyframe:REQ] gönderilemedi: %s", exc)

    def _resolve_resize_ack(self, window_id: str, meta: SessionMeta) -> None:
        """Completes the in-flight flex resize of ``window_id`` with ``meta`` — but only when the packet really is
        ours: scrcpy flags a reset caused by OUR resize request (``client_resized``; scrcpy 4.1
        ``SurfaceEncoder.java:144-146``). If the same reset also carried a display-properties change (rotation, …)
        scrcpy clears that flag, yet the packet still reports our size — so a packet with exactly the expected size is
        accepted too. Anything else is a server-initiated change and must not be mistaken for the confirmation."""
        pending = self._pending_resize_acks.get(window_id)
        if pending is None or pending.future.done():
            return
        if meta.client_resized or (pending.expected is not None and (meta.width, meta.height) == pending.expected):
            pending.future.set_result(meta)
            return
        window_logger(__name__, window_id).info(
            "[Resize:ACK_IGNORED] sunucu kaynaklı session paketi %dx%d (beklenen %s) — resize onayı sayılmadı",
            meta.width, meta.height, pending.expected,
        )

    def _abort_pending_ack(self, window_id: str, reason: str) -> None:
        pending = self._pending_resize_acks.get(window_id)
        if pending is not None and not pending.future.done():
            pending.future.set_exception(FlexResizeAborted(reason))

    # ------------------------------------------------------------------ freeze

    async def freeze(self, window_id: str, reason: str = "minimized") -> None:
        """Minimize OR full occlusion: stop ONLY the video encoder —
        session audio is untouched (device-global). The frontend keeps
        the last frame frozen; the encoder session is released for other windows.
        """
        session = self._sessions.get(window_id)
        if session is None or session.state.frozen:
            return
        window_logger(__name__, window_id).info("[WindowManager:FREEZE ❄️] Window %s (%s) FROZEN (reason=%s)", window_id, session.state.package, reason)
        await cancel_and_wait(session.pump_task)
        session.pump_task = None
        await session.server.stop()
        session.state.frozen = True
        session.state.fps = 0
        await self._events.emit("window_frozen", window_id=window_id, reason=reason)

    async def unfreeze(self, window_id: str, *, project: ProjectSettings | None = None) -> None:
        """Restart the encoder from scratch — new SPS/PPS/IDR is unavoidable
        (an accepted cost).

        The stopped server's display took its apps' tasks with it (scrcpy's default
        vd_destroy_content; nothing here evacuates them), so the relaunched server's
        fresh display gets the app started again (start_app) — an app that
        restores its own state shows it, the process may even be cached.

        Reuses ``session.dpi`` (NOT the global default): this runs on every
        minimize/restore and budget reallocation, not just explicit resizes —
        if it fell back to the phone-default density, a window the user had
        resized into tablet territory would silently lose that density (and
        with it, tablet-mode dp) the next time it got minimized and restored.
        """
        serial = self._serial_getter()
        if serial is None:
            raise DeviceNotBoundError()
        session = self._sessions.get(window_id)
        if session is None or not session.state.frozen:
            return
        window_logger(__name__, window_id).info("[WindowManager:UNFREEZE 🔥] Window %s (%s) UNFREEZING...", window_id, session.state.package)
        server = ScrcpyServer(self._adb, self._settings, serial, daemon=self._daemon_client_getter())
        try:
            # A short grace period after the OLD server's stop(): on real
            # devices, releasing the previous virtual display/encoder appears
            # to not be instantaneous even after our own sockets-closed-first
            # stop() returns. Racing a brand new app_process spawn in right
            # away was observed to abort the on-device JVM outright (a bare
            # "Aborted", not a Java exception) on a Xiaomi/HyperOS device —
            # this pause consistently avoided it in testing.
            await asyncio.sleep(self._settings.UNFREEZE_GRACE_DELAY_S)
            # bring_up_server's push_server() is not redundant here: dropping it (same file) brought these crashes
            # back — its ADB round-trip gives the device extra release time. Keep it until verified on more devices.
            project = project or await settings_db.get_project_settings()
            sockets = await bring_up_server(
                server, lambda: self._respawn(server, session, project), start_app=self._start_app_for(session),
            )
        except Exception:
            # session.server/state.frozen are only updated AFTER this whole sequence succeeds (bring_up_server has
            # already stopped the failed `server`): the session stays "frozen" for the caller to decide how to recover.
            window_logger(__name__, window_id).exception(
                "[WindowManager:UNFREEZE] failed to bring package=%s back up on a new "
                "virtual display; cleaning up the failed attempt",
                session.state.package,
            )
            raise
        if sockets.video_meta:
            # Same rule as open_window: injection coordinates must match the
            # NEW encoder's actual output size.
            session.stream_w = sockets.video_meta.width
            session.stream_h = sockets.video_meta.height
        session.server = server
        session.state.frozen = False
        session.state.fps = session.max_fps
        self.start_video_pump(session)
        window_logger(__name__, window_id).info(
            "window unfrozen: target_display=%dx%d, max_size=%d, stream_output=%dx%d",
            session.target_display_w, session.target_display_h, session.max_size, session.stream_w, session.stream_h
        )
        await self._events.emit(
            "window_unfrozen",
            window_id=window_id,
            display_w=session.stream_w,
            display_h=session.stream_h,
        )

    # ------------------------------------------------------------------ resize

    async def _respawn(self, server: ScrcpyServer, session: WindowSession, project: ProjectSettings | None) -> None:
        """Unfreeze and transport migration re-create an EXISTING window: same display size/dpi/bitrate/fps as the
        session had; only max_size follows the (possibly changed) project setting."""
        await spawn_window_server(
            server,
            package=session.state.package,
            project=project,
            settings=self._settings,
            display_w=session.target_display_w,
            display_h=session.target_display_h,
            dpi=session.dpi,
            max_size=project.max_size if project is not None else session.max_size,
            video_bit_rate=session.video_bit_rate,
            max_fps=session.max_fps,
        )

    @staticmethod
    def _start_app_for(session: WindowSession) -> str | None:
        """A re-created window relaunches its app on the new display; the phone mirror has none to start."""
        return None if is_mirror_package(session.state.package) else session.state.package

    def flex_display_ok(self, profile: DeviceProfile, project: ProjectSettings | None = None) -> bool:
        if not flex_display_enabled(project, self._settings):
            return False
        if profile.android_api < self._settings.MIN_API_FOR_FLEX_DISPLAY:
            return False
        return profile.flex_display_supported is not False  # True or None (untried)

    async def _flex_resize(self, window_id: str, width: int, height: int, *, dpi: int = 0, bit_rate: int = 0) -> bool:
        """v4.x in-place resize: VirtualDisplay.resize() via RESIZE_DISPLAY,
        confirmed by a session packet on the VIDEO socket — no freeze, no new
        virtual display, no app restart.

        Upstream server: SIZE ONLY — RESIZE_DISPLAY has no density field; a
        density change is the caller's second step (a live
        ``set_display_density``, i.e. a second display configuration change).
        Patched server (``supports("opendex_resize")``): OPENDEX_RESIZE, and a
        non-zero ``dpi`` travels in the same message — size and density in ONE
        VirtualDisplay.resize call —
        as does a non-zero ``bit_rate``, applied by the encoder reset that
        resize causes (§4.4). Both count as applied once the confirmation
        arrives; on a predicted no-op nothing is sent (the caller applies the
        density on its own; the bitrate waits for a real resize).

        Returns True when the server confirmed a resize, False when it was
        predicted to be a no-op (the encoder alignment rounds the request to
        the current size) and nothing was sent. Raises
        FlexResizeUnsupportedError when no confirmation came, FlexResizeAborted
        when the video pump ended while waiting.
        """
        session = self._sessions.get(window_id)
        if session is None:
            raise KeyError(f"Window session '{window_id}' not found")
        if session.control is None:
            raise FlexResizeUnsupportedError(f"Window '{window_id}' has no active control socket for flex resize")

        # The size scrcpy will really produce, when the encoder alignment is known (patched server). If that is the
        # display's current size, scrcpy resizes nothing and sends no session packet: answer now instead of waiting
        # out FLEX_RESIZE_TIMEOUT_S and then rebuilding the display for nothing (B4).
        expected = None
        alignment = session.server.size_alignment
        if alignment:
            expected = flex_constrained_size(width, height, alignment=alignment, max_size=session.server.max_size)
            if expected == (session.stream_w, session.stream_h):
                session.target_display_w, session.target_display_h = width, height
                window_logger(__name__, window_id).info(
                    "[Resize:FLEX_NOOP] %dx%d -> %dx%d (hizalama=%d): sunucu ekranı değiştirmeyecek, onay beklenmiyor",
                    width, height, expected[0], expected[1], alignment,
                )
                return False

        if session.server.supports("opendex_resize"):
            payload = serialize_opendex_resize(width, height, dpi, bit_rate)
        elif dpi or bit_rate:
            raise ValueError("only a server that announced opendex_resize takes a density or bitrate with a resize")
        else:
            payload = serialize_resize_display(width, height)

        loop = asyncio.get_running_loop()
        future: asyncio.Future[SessionMeta] = loop.create_future()
        self._pending_resize_acks[window_id] = _PendingAck(future, expected)
        try:
            try:
                await self._send_resize(session, payload, dpi)
            except Exception as exc:
                raise FlexResizeUnsupportedError(f"Failed to send the resize control message: {exc}") from exc

            try:
                meta = await asyncio.wait_for(
                    future, timeout=self._settings.FLEX_RESIZE_TIMEOUT_S
                )
            except asyncio.TimeoutError as exc:
                raise FlexResizeUnsupportedError(
                    f"no session packet confirming resize to {width}x{height} "
                    f"within {self._settings.FLEX_RESIZE_TIMEOUT_S}s"
                ) from exc
        finally:
            self._pending_resize_acks.pop(window_id, None)

        session.stream_w, session.stream_h = meta.width, meta.height
        session.target_display_w, session.target_display_h = width, height
        session.state.width, session.state.height = meta.width, meta.height
        wlog = window_logger(__name__, window_id)
        wlog.debug(
            "FLEX_RESIZE_SUCCESS: allocated_display=%dx%d, stream_output=%dx%d for %s",
            width, height, meta.width, meta.height, session.state.package
        )
        return True

    async def _send_resize(self, session: "WindowSession", payload: bytes, dpi: int) -> None:
        """A resize carrying a density goes through the density writer's ledger (android_shell.apply_display_density):
        ordered with every other density write to this display, recorded as its newest target, and never skipped — it
        carries the size too. The density it carries is the display's BASE density: a forced override left by an earlier
        fallback write would mask it, so that is lifted first (android_shell.lift_forced_density)."""
        display_id = known_display_id(session)
        if not (dpi and display_id):
            await session.control.send(payload)
            return

        async def write() -> str:
            serial = self._serial_getter()
            if serial:
                with contextlib.suppress(Exception):
                    await android_shell.lift_forced_density(self._adb, serial, display_id)
            await session.control.send(payload)
            return "opendex_resize"

        await android_shell.apply_display_density(display_id, dpi, write, carries_more=True)

    async def resize(
        self, window_id: str, width: int, height: int, dpi: int | None,
        *, project: ProjectSettings | None = None, settle: bool = True,
    ) -> WindowHandle:
        """Two paths:

          * FLEX (v4.x RESIZE_DISPLAY, in-place, no freeze) — used when the
            device is known/likely to support it and the density change, if
            any, can be applied live: the display id is known (or the change
            is small). Upstream server: the size goes through RESIZE_DISPLAY
            (_flex_resize) and a density change follows as a live
            ``set_display_density`` — two display configuration changes for a
            resize that changes both. Patched server: one OPENDEX_RESIZE
            carries both — one change. Android's VirtualDisplay.resize() drives a real
            AOSP layout pass (ViewRootImpl.performTraversals — measure/layout/
            draw against the NEW bounds) rather than stretching existing
            pixels, so text reflows natively at the new size.
          * LEGACY (freeze -> new virtual display -> unfreeze) — everything
            else, unchanged from the pre-flex implementation: a density change
            on a display whose id is unknown, a size whose bitrate floor has
            outgrown the running encoder, flex disabled/unsupported, and the
            automatic fallback when a flex attempt gets no confirmation.

        A flex resize interrupted by the end of the window's video pump is
        neither: the asked size and density are kept as the target and the
        handle says ``deferred=True`` (FlexResizeAborted).

        ``dpi``, when given, overrides the phone-shaped default for THIS
        session going forward (sticky — see ``unfreeze``). Omitted for a
        plain resize-handle drag, which keeps whatever density the session
        already had.

        ``settle=False``: the caller owns what the density change does to the app's process (the handoff's pre-landing
        settles it itself, right before it moves the task; an EMPTY display has nobody to settle) — no snapshot, no
        scheduled settle here.
        """
        serial = self._serial_getter()
        profile = self._profile_getter()
        android_id = self._android_id_getter()
        session = self._sessions.get(window_id)
        if session is None:
            raise KeyError(window_id)
        wlog = window_logger(__name__, window_id)
        previous_target_w, previous_target_h, previous_dpi = (
            session.target_display_w, session.target_display_h, session.dpi
        )
        previous_video_bit_rate = session.video_bit_rate

        project = project or await settings_db.get_project_settings()
        target_dpi = negotiate_dpi(width, height, dpi, project, session.dpi or self._settings.VIRTUAL_DISPLAY_DPI)

        # Live density needs THIS window's display id, as reported by its own server. The old `dumpsys display | grep
        # scrcpy` fallback took the FIRST scrcpy display — with several windows open, another window's display.
        display_id = known_display_id(session)
        # Patched server (§4.3): a density change rides in the resize message itself — one display change, not two.
        atomic = session.server.supports("opendex_resize") and bool(display_id)

        # Flex display resizes resolution in-place and applies live density injection:
        # If display_id is known, Android's `wm density <dpi> -d <id>` applies ANY DPI delta live
        # with zero restart and zero freeze. The legacy freeze path is only needed if display_id is unknown
        # and DPI changes significantly (> 40 DPI).
        dpi_diff = abs(target_dpi - session.dpi) if session.dpi else 0
        wants_same_dpi = (dpi is None) or (target_dpi == session.dpi) or bool(display_id) or (dpi_diff <= 40)
        flex_ok = wants_same_dpi and profile is not None and self.flex_display_ok(profile, project)

        # The bitrate the target size calls for — what a legacy rebuild applies. A patched server takes it in the
        # resize message itself (§4.4); an upstream flex resize can't carry it (see FLEX_RESIZE_BITRATE_FLOOR_SLACK),
        # so if the target size's floor has outgrown the current bitrate by enough to matter, prefer the legacy path
        # so resolution_aware_bitrate() actually gets reapplied.
        target_bitrate_floor = resolution_aware_bitrate(
            width, height, project.max_fps, project.video_bit_rate, self._settings
        )
        bitrate_in_place = session.server.supports("opendex_resize") and session.server.supports("bitrate_on_reset")
        bitrate_outgrown = target_bitrate_floor > session.video_bit_rate * FLEX_RESIZE_BITRATE_FLOOR_SLACK
        if flex_ok and bitrate_outgrown and not bitrate_in_place:
            wlog.info(
                "📐 [Resize:FLEX_SKIP] win=%s bitrate floor %d exceeds current %d by >%.1fx — routing to legacy for a real bitrate bump",
                window_id, target_bitrate_floor, session.video_bit_rate, FLEX_RESIZE_BITRATE_FLOOR_SLACK,
            )
            flex_ok = False

        wlog.info(
            "📐 [Resize:REQ] win=%s (%s) -> %dx%d (target_dpi=%d, curr_dpi=%d, disp_id=%s, flex_ok=%s)",
            window_id, session.state.package, width, height, target_dpi, session.dpi, display_id, flex_ok
        )

        # Same size, same density, running: nothing to reconfigure — whether or not the caller spelled the density out
        # (target_dpi already resolves an omitted dpi). Without this, an explicit-but-unchanged dpi went on to rebuild
        # the display on a non-flex device, or marked flex "supported" without ever having resized anything.
        if (
            session.target_display_w == width
            and session.target_display_h == height
            and session.dpi == target_dpi
            and not session.state.frozen
        ):
            return session.handle()

        # A DPI change reaches the app's live PROCESS like the phone→window move did: note its identity BEFORE the first
        # density-affecting step, settle after the (debounced) burst — density_reconciler.py.
        density_before = None
        if (
            settle
            and self._density is not None
            and session.dpi
            and target_dpi != session.dpi
            and not is_mirror_package(session.state.package)
        ):
            density_before = await self._density.snapshot(session.state.package)
        density_applied = False
        changed_at: float | None = None  # device clock right before the density change (density_reconciler.mark)

        if flex_ok:
            try:
                # 1. Video stream in-place flex resize (Zero-Blink)
                resized = False
                if session.target_display_w != width or session.target_display_h != height:
                    density_with_size = target_dpi if atomic and target_dpi != session.dpi else 0
                    bitrate_with_size = (
                        target_bitrate_floor
                        if bitrate_in_place and target_bitrate_floor != session.video_bit_rate else 0
                    )
                    wlog.info(
                        "⚡ [Resize:FLEX] In-place %s for %s (%dx%d%s%s)...",
                        "OPENDEX_RESIZE" if session.server.supports("opendex_resize") else "RESIZE_DISPLAY",
                        session.state.package, width, height,
                        f" @ {density_with_size} dpi" if density_with_size else "",
                        f", {bitrate_with_size} bps" if bitrate_with_size else "",
                    )
                    if density_with_size and density_before is not None:
                        # The density rides in THIS message (no `wm density` write below): the moment an app has to adapt
                        # is now. Without the mark the reconciler cannot see that an app rebuilt itself after the change
                        # and refreshes it a second time (a visible reload) — for every package alike.
                        changed_at = await self._density.mark()
                    resized = await self._flex_resize(
                        window_id, width, height, dpi=density_with_size, bit_rate=bitrate_with_size,
                    )
                    if resized and bitrate_with_size:
                        wlog.info(
                            "📶 [Resize:BITRATE] aynı encoder reset'inde: %d -> %d bps",
                            session.video_bit_rate, bitrate_with_size,
                        )
                        session.video_bit_rate = bitrate_with_size
                    if resized and density_with_size:
                        wlog.info(
                            "📐 [Resize:ATOMIC_DPI] boyut + yoğunluk tek VirtualDisplay.resize ile: %d -> %d (display=%s)",
                            session.dpi, target_dpi, display_id,
                        )
                        session.dpi = target_dpi
                        density_applied = True

                # 2. In-place live density injection if DPI changed and did not ride along with the size (upstream
                #    server, or a size the server would not change): through the single writer — the display's own
                #    channel on a patched server.
                if target_dpi != session.dpi:
                    if display_id:
                        wlog.info(
                            "📐 [Resize:LIVE_DPI] Canlı VirtualDisplay DPI güncelleniyor: %d -> %d (display=%s, sıfır restart)",
                            session.dpi, target_dpi, display_id
                        )
                        if density_before is not None:
                            changed_at = await self._density.mark()
                        path = await android_shell.set_display_density(
                            self._adb, serial, display_id, target_dpi, daemon=self._daemon_client_getter(),
                        )
                        wlog.debug("⚡ [Resize:LIVE_DPI] density %d uygulandı (%s)", target_dpi, path)
                        session.dpi = target_dpi
                        density_applied = True
                    else:
                        wlog.warning("[Resize:LIVE_DPI ⚠️] display_id bilinmiyor; session.dpi=%d korunuyor", session.dpi)

                # Only a resize the server actually CONFIRMED proves the device can do it; a density-only change or a
                # predicted no-op proves nothing.
                if resized and profile and profile.flex_display_supported is not True:
                    profile.flex_display_supported = True
                    if android_id:
                        await settings_db.save_device_profile(android_id, profile)

                wlog.info("✅ [Resize:FLEX_OK] %s artık %dx%d @ %d DPI (sıfır donma, oturum korundu)", session.state.package, width, height, session.dpi)
                if density_applied:
                    self._schedule_density_settle(window_id, session, density_before, changed_at)
                return session.handle()
            except FlexResizeAborted as exc:
                # The pump ended under us (server stopped/died): not a flex failure, and not ours to rebuild — whatever
                # ended the pump decides what happens to the window. Keep the asked size and density for its next
                # encoder start.
                session.target_display_w, session.target_display_h = width, height
                session.dpi = target_dpi
                wlog.info(
                    "[Resize:DEFERRED] %dx%d @ %d dpi — %s; bir sonraki encoder başlangıcı bunları kullanır",
                    width, height, target_dpi, exc,
                )
                return session.handle(deferred=True)
            except FlexResizeUnsupportedError as exc:
                wlog.warning(
                    "[Resize:FLEX_FAIL ⚠️] flex resize to %dx%d failed (%s); falling back to freeze/unfreeze",
                    width, height, exc,
                )
                if profile and profile.flex_display_supported is None:
                    profile.flex_display_supported = False
                    if android_id:
                        await settings_db.save_device_profile(android_id, profile)
        else:
            wlog.debug(
                "[Resize:LEGACY 🔄] Rebuilding virtual display (flex_ok=False)",
            )

        # --- legacy freeze/unfreeze path — byte-for-byte the pre-flex behavior ---
        session.target_display_w, session.target_display_h = width, height
        session.dpi = target_dpi
        session.state.width, session.state.height = width, height
        session.video_bit_rate = resolution_aware_bitrate(
            width, height, project.max_fps, project.video_bit_rate, self._settings
        )
        if density_before is not None and target_dpi != previous_dpi:
            # The rebuilt display comes up at the new density and START_APP moves the task onto it: that move is the
            # density change the app has to adapt to.
            changed_at = await self._density.mark()
        await self.freeze(window_id, reason="budget")
        try:
            await self.unfreeze(window_id, project=project)
        except Exception as unfreeze_err:
            wlog.error(
                "resize to %dx%d/%s failed for window %s (%s): %s",
                width, height, dpi, window_id, type(unfreeze_err).__name__, unfreeze_err,
                exc_info=True
            )
            session.target_display_w, session.target_display_h, session.dpi = (
                previous_target_w, previous_target_h, previous_dpi
            )
            session.state.width, session.state.height = previous_target_w, previous_target_h
            session.video_bit_rate = previous_video_bit_rate
            raise
        # unfreeze updated stream_w/h to the new encoder's ACTUAL output
        # (max_size may have scaled the request down) — report that, not the ask.
        if target_dpi != previous_dpi:
            # The app's process survives the virtual-display rebuild (its task is moved onto the new display), so a DPI
            # change here is the same density change for it as the live one.
            self._schedule_density_settle(window_id, session, density_before, changed_at)
        return session.handle()

    def _schedule_density_settle(
        self, window_id: str, session: "WindowSession", before, changed_at: float | None = None,
    ) -> None:
        """Debounced, non-blocking (the caller holds the global window lock and an HTTP reply is waiting): a burst of
        DPI changes — dragging the DP slider — becomes ONE settle after the last one; an app that rebuilt itself after
        that last change (Chrome) is left alone."""
        load_markers.record("dpi_change", package=session.state.package, detail=f"{session.dpi} DPI")
        if self._density is None or before is None:
            return
        self._density.schedule_settle(
            window_id, session.state.package, before,
            display=lambda: known_display_id(session) or session.state.display_id or None,
            reason="resize", changed_at=changed_at,
        )

    # ------------------------------------------------------------------ transport migration
    async def migrate_session_transport(self, window_id: str, new_serial: str) -> bool:
        """Açık pencereyi ve FrameBroadcaster akışını kapatmadan, arka plandaki
        ScrcpyServer ve video pump soketini yeni ADB serisine taşır.

        Prensip (Break-Before-Make with Frame Holding):
        Eski sunucu durdurulup MediaCodec donanım bütçesi serbest bırakıldıktan
        sonra yeni sunucu açılır. Frontend canvas bu sırada son kareyi dondurur,
        böylece çift encoder çakışması ve CodecException engellenir.
        """
        session = self._sessions.get(window_id)
        if session is None or session.state.frozen:
            return False

        wlog = window_logger(__name__, window_id)
        wlog.info("🚀 [SEAMLESS MIGRATION] Pencere %s için taşıyıcı aktarımı başlatıldı -> %s", window_id, new_serial)

        old_server = session.server
        old_pump_task = session.pump_task
        new_server = ScrcpyServer(self._adb, self._settings, new_serial, daemon=self._daemon_client_getter())

        # 1. Eski video pompasını durdur ve eski sunucuyu kapat (Donanım encoder'ı serbest bırakılır)
        await cancel_and_wait(old_pump_task)
        session.pump_task = None

        try:
            await asyncio.wait_for(old_server.stop(), timeout=1.5)
        except Exception as stop_err:
            wlog.warning("Eski server durdurulurken gecikme/hata: %s", stop_err)

        # 2. Android mediaserver / SurfaceFlinger codec temizliği için bekleme süresi
        await asyncio.sleep(self._settings.UNFREEZE_GRACE_DELAY_S)

        try:
            # 3-5. Yeni seri üzerinde sunucuyu kur, soketleri bağla, uygulamayı yeni ekrana odakla
            try:
                project = await settings_db.get_project_settings()
            except Exception:
                project = None
            sockets = await bring_up_server(
                new_server, lambda: self._respawn(new_server, session, project), start_app=self._start_app_for(session),
            )

            if sockets.video_meta:
                session.stream_w = sockets.video_meta.width
                session.stream_h = sockets.video_meta.height

            # 6. Oturumu yeni sunucuya bağla ve video pompasını mevcut Broadcaster ile başlat
            session.server = new_server
            self.start_video_pump(session)

            wlog.info("✅ [SEAMLESS MIGRATION TAMAMLANDI] %s penceresi %s taşıyıcısına aktarıldı!", window_id, new_serial)
            return True

        except Exception as exc:
            wlog.exception("❌ [SEAMLESS MIGRATION BAŞARISIZ] Hata: %s; oturum frozen moduna alınıyor", exc)
            # (Yarım kalan yeni sunucuyu bring_up_server zaten durdurdu.)
            # Başarısızlık durumunda oturumu frozen olarak işaretle; kullanıcı tekrar tıklayınca unfreeze açılabilsin
            session.state.frozen = True
            session.state.fps = 0
            await self._events.emit("window_frozen", window_id=window_id, reason="migration_fallback")
            return False
