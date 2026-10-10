"""Event bus — backend's one-way decisions broadcast to every connected frontend.

Without this channel the live fps readout, freeze visualization and thermal warning
cannot work (audit finding). Event names form the wire contract with
``frontend/src/events/eventStream.js`` — change them in both places or not at all.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Literal

from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

# ── Log payload sanitizer ─────────────────────────────────────────────────────
# Strips large base64/binary fields recursively so the terminal stays readable.
_LARGE_FIELDS = frozenset({
    "album_art", "album_art_uri", "picture", "artwork", "thumbnail",
    "large_icon", "icon", "cover_art", "art", "art_b64", "image"
})
_MAX_FIELD_LEN = 30        # other long strings: a readable head
_IMAGE_PREVIEW_LEN = 10    # pictures (album art, icons, data: URIs): only the first characters are logged

def truncate_payload(obj: Any, _depth: int = 0, *, long_strings: bool = True) -> Any:
    """Recursively shorten picture fields (and, with ``long_strings``, every string over 80 chars) for logging.
    ``long_strings=False`` touches only pictures — for replies, where an error text must stay whole."""
    if _depth > 5:
        return obj
    if isinstance(obj, dict):
        result = {}
        for k, v in obj.items():
            if isinstance(v, str):
                image = k in _LARGE_FIELDS or v.startswith("data:")
                if image or (long_strings and len(v) > 80):
                    keep = _IMAGE_PREVIEW_LEN if image else _MAX_FIELD_LEN
                    result[k] = f"{v[:keep]}…({len(v)}b)"
                    continue
            result[k] = truncate_payload(v, _depth + 1, long_strings=long_strings)
        return result
    if isinstance(obj, list):
        return [truncate_payload(item, _depth + 1, long_strings=long_strings) for item in obj]
    return obj
# ─────────────────────────────────────────────────────────────────────────────


EventType = Literal[
    # --- Windows, device link, notifications, app hand-off ---
    "fps_changed",         # {window_id, fps}
    "window_frozen",       # {window_id, reason: "minimized"|"occluded"|"budget"}
    "window_unfrozen",     # {window_id}
    "thermal_throttle",    # {level}
    "device_load_sample",  # {sample, insights, adb, markers} — the "Phone Load" panel (telemetry/load_monitor.py)
    "device_connected",    # {android_id, transport}
    "device_lost",         # {reason}
    "device_reconnected",  # {android_id}
    "link_quality",        # {weak} — the phone stopped answering while its video is silent (a stalled link); cleared when it answers
    "encoder_limit_hit",   # {max_windows}
    "notification_received", # {id, package, title, text, post_time, app_name}
    "notification_updated",  # {id, package, title, text, post_time, app_name} (silent in-place state update)
    "notification_cleared",  # {id}
    "app_lock_pending",      # {package, display_id, message}
    "app_lock_resolved",     # {package, display_id}
    "app_lock_timeout",      # {package, display_id, message}
    "app_lock_cancelled",    # {package, window_id, display_id, message} — the user cancelled the lock (gesture / home)
    "app_handoff_to_phone",  # {window_id, package, display_id, message}
    "app_handoff_resolved",  # {window_id, package}
    "app_reclaim_result",    # {window_id, package, outcome: "moved"|"relaunched"} — the result of taking an app back from the phone
    "vd_phase",              # {window_id, package, phase: "stealth"|"live", target_dpi?, physical_dpi?, deadline_ms?}
    # --- Workspace (freeform tasks on the phone) ---
    "workspace_task_added",          # {window_id, package, bounds: [l,t,r,b]}
    "workspace_task_removed",        # {window_id}
    "workspace_task_bounds_changed", # {window_id, bounds: [l,t,r,b]}
    "workspace_task_density_changed",# {window_id, density, density_mode}
    "task_popout_result",            # {window_id, package, success, ws_url, display_w, display_h}
    "task_dock_result",              # {window_id, package, success, ws_url, bounds: [l,t,r,b]}
    "workspace_task_returned",       # {window_id, package, ws_url, bounds, render_scale, density, display_w, display_h} — a task came back from the phone
    # --- OpenDeX daemon (pushed by the on-phone process) ---
    "device_task_focused",           # {display_id, package, activity, task_id}
    "device_media_update",           # {active, title, artist, album, duration_ms, position_ms, is_playing, ...}
    "device_volumes_update",         # {streams: [{id, name, label, current, max, min, muted}]}
    "device_states_update",          # {states: {wifi, bluetooth, torch, mute, ...}}
    "device_battery_update",         # {level, is_charging, charging_type, temperature_c, voltage_mv, health, ...}
    "device_daemon_connected",       # {version, capabilities, screen_blanked} — every (re)connect to the daemon
    "device_tasks_update",           # {ok, push, tasks: [{id, display, visible, package?}]} — task snapshot
    "device_task_removed",           # {taskId, package?}
    "device_display_added",          # {id, name?, w?, h?}
    "device_display_removed",        # {id}
    "device_profile_changed",        # {profile} — the phone's own screen changed (display size / smallest width) while bound
    "devices_changed",               # {devices: [DeviceInfo], active_serial} — adb's list / the bound phone changed
    "device_bind_failed",            # {serial, reason, attempt} — bringing a session up failed and was undone; retries follow
    "window_app_closed",             # {window_id, package, action: "close"|"badge"} — app closed ON THE PHONE
    "window_app_restored",           # {window_id, package} — a badged window's app is running again
    # --- Per-app audio ---
    "app_audio_mode",                # {supported, mode: "pending"|"per_app"|"legacy"|"off"}
    "app_audio_state",               # {package, route, live_route, volume, muted, windows, stream_id, error, explicit}
    # --- Transport handover (Wi-Fi <-> USB) ---
    "migration_queued",              # {window_id, old_serial, new_serial}
    "migration_started",             # {window_id, new_serial}
    "migration_completed",           # {window_id, new_serial}
    "migration_failed",              # {window_id, new_serial}
    # --- File manager ---
    "fs_transfer",                   # a transfer job's snapshot — TransferJob.snapshot(): state, progress, conflict, errors…
    "fs_changed",                    # {provider, device, path} — a folder's content changed; open listings refresh
]


class Event(BaseModel):
    type: EventType
    payload: dict[str, Any] = Field(default_factory=dict)


class EventBus:
    """Fan-out of backend state changes to all subscribed WebSocket clients
    and in-process asynchronous/synchronous subscribers.

    Subscribers own a bounded queue; a slow consumer drops its oldest event rather
    than back-pressuring the emitters (same recency-over-completeness policy as the
    media broadcaster).
    """

    QUEUE_SIZE = 256

    def __init__(self) -> None:
        self._queues: set[asyncio.Queue[Event]] = set()
        self._lock = asyncio.Lock()
        # Listener tasks stay referenced until done (asyncio holds tasks only weakly) and report their failures.
        self._listener_tasks: set[asyncio.Task] = set()
        self._listeners: dict[str, list[Any]] = {}
        self._waiters: dict[str, list[tuple[Any, asyncio.Future[dict[str, Any]]]]] = {}

    def on(self, type: EventType | str, callback: Any) -> Any:
        """Registers an in-process listener for a specific event type.

        Callback may be a coroutine function or a standard callable.
        Returns a parameterless unsubscribe function.
        """
        if type not in self._listeners:
            self._listeners[type] = []
        self._listeners[type].append(callback)

        def unsubscribe() -> None:
            callbacks = self._listeners.get(type, [])
            if callback in callbacks:
                callbacks.remove(callback)

        return unsubscribe

    async def wait_for(
        self,
        type: EventType | str,
        predicate: Any = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Asynchronously awaits the next emitted event matching type and predicate."""
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        entry = (predicate, fut)
        if type not in self._waiters:
            self._waiters[type] = []
        self._waiters[type].append(entry)

        try:
            if timeout is not None:
                return await asyncio.wait_for(fut, timeout=timeout)
            return await fut
        finally:
            waiters = self._waiters.get(type, [])
            if entry in waiters:
                waiters.remove(entry)

    async def subscribe(self) -> asyncio.Queue[Event]:
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=self.QUEUE_SIZE)
        async with self._lock:
            self._queues.add(queue)
        return queue

    async def unsubscribe(self, queue: asyncio.Queue[Event]) -> None:
        async with self._lock:
            self._queues.discard(queue)

    async def emit(self, type: EventType, **payload: Any) -> None:
        event = Event(type=type, payload=payload)
        if log.isEnabledFor(logging.DEBUG):
            log.debug("event %s %s", event.type, truncate_payload(payload))

        # 1. External WebSocket streaming clients
        async with self._lock:
            queues = list(self._queues)
        for queue in queues:
            if queue.full():
                try:
                    queue.get_nowait()  # drop oldest — recency wins
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(event)

        # 2. In-process listeners
        callbacks = list(self._listeners.get(type, []))
        for cb in callbacks:
            try:
                if asyncio.iscoroutinefunction(cb):
                    self._spawn_listener(cb(**payload), type)
                else:
                    res = cb(**payload)
                    if asyncio.iscoroutine(res):
                        self._spawn_listener(res, type)
            except Exception as exc:
                log.exception("Error in EventBus listener for %s: %s", type, exc)

        # 3. Asynchronous waiters
        waiters = list(self._waiters.get(type, []))
        for pred, fut in waiters:
            if not fut.done():
                try:
                    if pred is None or pred(payload):
                        fut.set_result(payload)
                except Exception as exc:
                    log.exception("Error evaluating predicate in wait_for for %s: %s", type, exc)

    def _spawn_listener(self, coro: Any, type: str) -> None:
        spawn_background(coro, f"event-{type}", self._listener_tasks)

    @property
    def pending_listener_tasks(self) -> int:
        return len(self._listener_tasks)


async def cancel_and_wait(task: asyncio.Task | None) -> None:
    """Cancels `task` (no-op when None/finished/the caller itself) and waits until it has really stopped — its own
    exception, if any, is not re-raised into the caller's teardown."""
    if task is None or task is asyncio.current_task():
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task


_background_tasks: set[asyncio.Task] = set()


def spawn_background(coro: Any, name: str | None = None, owner: set[asyncio.Task] | None = None) -> asyncio.Task:
    """Fire-and-forget that neither vanishes nor fails silently: asyncio holds tasks only weakly (an unreferenced one
    can be garbage-collected mid-flight) and an unretrieved exception surfaced — if at all — only at collection."""
    tasks = _background_tasks if owner is None else owner
    task = asyncio.get_running_loop().create_task(coro, name=name)
    tasks.add(task)

    def _done(t: asyncio.Task) -> None:
        tasks.discard(t)
        if not t.cancelled() and t.exception() is not None:
            log.error("background task %s failed: %r", t.get_name(), t.exception(), exc_info=t.exception())

    task.add_done_callback(_done)
    return task
