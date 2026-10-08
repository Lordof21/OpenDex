"""Android Notification Service.

Two sources, one pipeline (``_apply``: new / updated / cleared events, dismissed-content memory, intent cache):

  * PUSH (normal): the on-device daemon is a system notification listener and pushes every post/removal
    (``notification_posted`` / ``notification_removed`` / ``notifications_update``). Nothing is polled and no `adb
    logcat` runs on the phone while it is live.
  * FALLBACK (no v1.2 daemon, or its listener was refused): `adb logcat` notification events trigger a debounced
    ``dumpsys notification --noredact`` refresh, plus a slow safety heartbeat.

The supervisor switches between them by itself whenever the daemon (dis)connects.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import re
from typing import Any, Awaitable, Callable

from ..device.adb import Adb
from ..events import EventBus, cancel_and_wait, spawn_background
from ..schemas.notifications import NotificationCategory, RichNotificationItem
from . import notification_invoker
from .intent_utils import find_request_intent, parse_intent_args
from .notification_parser import notifications_from_daemon, parse_dumpsys_notifications, post_time_label

log = logging.getLogger(__name__)


def _content_shape(item: Any) -> str:
    """What a log line may say about a notification: its SHAPE, never its words. Titles and texts carry message
    bodies and one-time codes, and the log files persist on disk (10 MB × 5)."""
    return f"başlık={len(item.title or '')} metin={len(item.text or '')} karakter"

# `adb logcat` filters: notification lifecycle events (trigger a debounced dumpsys refresh) and activity starts / shade
# taps (log what a notification click actually opened).
_NOTIFICATION_EVENTS_LOGCAT = (
    "-T", "1", "-b", "events", "-v", "tag",
    "notification_enqueue:I", "notification_canceled:I", "notification_cancel_all:I", "*:S",
)
_ACTIVITY_LOGCAT = ("-T", "1", "-s", "ActivityTaskManager:I", "StatusBar:I")


async def _kill(proc: asyncio.subprocess.Process | None) -> None:
    if proc is not None:
        with contextlib.suppress(Exception):
            proc.kill()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(proc.wait(), timeout=0.8)


class NotificationSupervisor:
    """Notification mirror: daemon push when live, debounced logcat + dumpsys otherwise (see module docstring)."""

    DEBOUNCE_INTERVAL_S = 0.180  # 180ms sliding window prevents dumpsys storms
    # Fallback only. logcat events already trigger a refresh within ~0.2 s; this merely catches a dropped stream.
    HEARTBEAT_S = 10.0
    PUSH_RECHECK_S = 2.0  # how often an idle fallback loop re-checks whether the daemon's push became live

    def __init__(self, adb: Adb, event_bus: EventBus, poll_interval_s: float = 10.0) -> None:
        self._adb = adb
        self._events = event_bus
        self._poll_interval_s = poll_interval_s
        self._daemon: Any = None
        self._raw: dict[str, dict[str, Any]] = {}  # push mode: the listener's items by Android key
        self._apply_lock = asyncio.Lock()
        self._mode_logged: str | None = None  # "push" / "fallback": each switch is logged once
        self._notifications: dict[str, RichNotificationItem] = {}
        self._serial: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._poll_task: asyncio.Task[None] | None = None
        self._logcat_proc: asyncio.subprocess.Process | None = None
        self._activity_task: asyncio.Task[None] | None = None
        self._activity_logcat_proc: asyncio.subprocess.Process | None = None
        self._window_manager = None
        self._helper_available: bool = False
        self._dismissed_signatures: dict[str, str] = {}  # notification_id -> content_signature hash
        self._intent_cache: dict[str, str] = {}  # id / android_key / package -> resolved intent args
        self._initial_sync_done = False  # the first refresh doesn't log every existing notification as "new"

        # Debounce control
        self._refresh_task: asyncio.Task[None] | None = None
        self._has_pending_refresh: bool = False

        # Package the user most recently navigated to via a notification
        # click — lets the activity logcat stream promote its log lines
        # about it from DEBUG to INFO.
        self._last_nav_target_pkg: str | None = None

    def set_window_manager(self, window_manager: Any) -> None:
        """Injects WindowManager reference for active window correlation."""
        self._window_manager = window_manager

    def attach_daemon(self, daemon: Any) -> None:
        """Subscribes to the daemon's notification pushes (see DeviceDaemonClient.subscribe)."""
        self._daemon = daemon
        daemon.subscribe("notifications_update", self._on_daemon_snapshot)
        daemon.subscribe("notification_posted", self._on_daemon_posted)
        daemon.subscribe("notification_removed", self._on_daemon_removed)

    @property
    def push_live(self) -> bool:
        """The daemon's listener is delivering notifications: no logcat stream, no heartbeat, no dumpsys."""
        return self._daemon is not None and bool(getattr(self._daemon, "notification_push", False))

    @property
    def source(self) -> str:
        return "daemon" if self.push_live else "dumpsys"

    def start(self, serial: str) -> None:
        self._serial = serial
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._logcat_stream_loop())
        if self._poll_task is None or self._poll_task.done():
            self._poll_task = asyncio.create_task(self._poll_heartbeat_loop())
        if self._activity_task is None or self._activity_task.done():
            self._activity_task = asyncio.create_task(self._activity_logcat_stream_loop())
        # Check helper companion APK asynchronously
        spawn_background(self.check_companion_helper())

    async def stop(self, clear_cache: bool = True) -> None:
        """Bildirim dinleme süreçlerini durdurur.

        Args:
            clear_cache: True ise tüm hafızayı temizler (cihaz tamamen koptuğunda).
                         False ise bildirim önbelleğini korur (Wi-Fi <-> USB handover).
        """
        for task in (self._task, self._poll_task, self._activity_task):
            await cancel_and_wait(task)
        self._task = self._poll_task = self._activity_task = None
        await self._stop_logcat_streams()

        if clear_cache:
            self._notifications.clear()
            self._dismissed_signatures.clear()
            self._raw.clear()
            log.debug("[NotificationService] Bildirim onbellegi temizlendi.")
        else:
            log.info("[NotificationService] Handover: Bildirim onbellegi korundu (Duplicate Toast onlendi).")

    async def check_companion_helper(self) -> bool:
        """Checks if Engine B companion helper is installed on Android device."""
        if not self._serial:
            self._helper_available = False
            return False
        try:
            out = await self._adb.shell("pm path com.opendex.helper", serial=self._serial)
            self._helper_available = bool(out and "package:" in out)
        except Exception:
            self._helper_available = False
        return self._helper_available

    @staticmethod
    def _content_signature(item: RichNotificationItem) -> str:
        """What the user dismissed: the notification's CONTENT. Deliberately no time field — `post_time` is a relative
        label re-computed on every parse ("şimdi" → "1 dk önce"), so a dismissed ongoing notification (or one whose
        phone-side clear failed) came back as "new message" a minute later. A genuinely new message under the same
        key changes the text and is still delivered."""
        return hashlib.md5(f"{item.title}\x1f{item.text}\x1f{item.big_text or ''}".encode("utf-8")).hexdigest()[:12]

    def _open_window_ids(self) -> dict[str, str]:
        """package -> window_id of every open DeX window."""
        if not self._window_manager:
            return {}
        return {win.package: win.window_id for win in self._window_manager.list_windows()}

    def get_notification(self, nid: str) -> RichNotificationItem | None:
        return self._notifications.get(nid)

    def find_by_android_key(self, android_key: str) -> RichNotificationItem | None:
        """Looks up a live notification by its Android system key rather
        than our own id — used when a click only carries the OS-level key."""
        for item in self._notifications.values():
            if item.android_key == android_key:
                return item
        return None

    def find_by_package(self, package: str) -> RichNotificationItem | None:
        """First live notification for a package — a last-resort match when
        neither an id nor an android_key is available."""
        for item in self._notifications.values():
            if item.package == package:
                return item
        return None

    def set_nav_target_package(self, package: str) -> None:
        """Records the package the user just navigated to via a notification
        click (see ``_last_nav_target_pkg``'s use in the activity logcat stream)."""
        self._last_nav_target_pkg = package

    def get_notifications(self) -> list[dict[str, Any]]:
        """Returns all active notifications, annotating them with open window IDs."""
        open_windows = self._open_window_ids()
        result = []
        for n in self._notifications.values():
            if n.timestamp:
                n.post_time = post_time_label(n.timestamp)
            item_dict = n.to_dict()
            item_dict["active_window_id"] = open_windows.get(n.package)
            result.append(item_dict)
        return result

    async def mark_read(self, notification_id: str) -> bool:
        """Marks an individual notification as read in OpenDeX without removing it from history."""
        item = self._notifications.get(notification_id)
        if item:
            item.read = True
            log.info("📖 [BİLDİRİM OKUNDU İŞARETLENDİ ✅] [%s] id=%s", item.app_name, notification_id)
            await self._events.emit("notification_updated", **item.to_dict())
            return True
        return False

    async def dismiss_notification(self, notification_id: str) -> bool:
        """Dismisses an individual notification on OpenDeX UI and native Android status bar."""
        item = self._notifications.pop(notification_id, None)
        if not item:
            for k, it in list(self._notifications.items()):
                if it.android_key == notification_id:
                    item = self._notifications.pop(k)
                    notification_id = k
                    break

        if item:
            # Store exact content signature so this specific message stays dismissed,
            # but any new incoming message or text update under the same key will be delivered!
            self._dismissed_signatures[notification_id] = self._content_signature(item)
            log.info("🗑️ [BİLDİRİM KAPATILDI ❌] [%s] id=%s key=%s", item.app_name, notification_id, item.android_key)

            # Dismiss natively on Android phone via IStatusBarService & INotificationManager
            if self._serial and item.android_key:
                try:
                    out = await notification_invoker.clear(self._adb, self._serial, item.android_key, item.package)
                    log.info("📱 [TELEFONDA SİLİNDİ 🗑️] [%s] key=%s result=%s", item.app_name, item.android_key, out)
                except Exception as exc:
                    log.warning("📱 [TELEFONDA SİLME BAŞARISIZ ⚠️] [%s] id=%s hata: %s", item.app_name, notification_id, exc)

            await self._events.emit("notification_cleared", id=notification_id)
            return True
        return False

    async def clear_all(self) -> None:
        """Clears all clearable notifications on OpenDeX UI and native Android status bar."""
        items = list(self._notifications.values())
        keys = list(self._notifications.keys())
        for it in items:
            self._dismissed_signatures[it.id] = self._content_signature(it)
        self._notifications.clear()

        # Clear natively on Android phone via IStatusBarService & INotificationManager
        if self._serial:
            try:
                out = await notification_invoker.clear_all(self._adb, self._serial, (it.package for it in items))
                log.info("📱 [TÜMÜ TELEFONDA TEMİZLENDİ 🧹] result=%s", out)
            except Exception as exc:
                log.warning("📱 [TÜMÜ TELEFONDA TEMİZLEME BAŞARISIZ ⚠️] hata: %s", exc)

        for nid in keys:
            await self._events.emit("notification_cleared", id=nid)
        log.info("🧹 [TÜM BİLDİRİMLER TEMİZLENDİ] Toplam %d bildirim kaldırıldı.", len(keys))

    # ------------------------------------------------------------------ live streams

    def _trigger_debounced_refresh(self) -> None:
        """Trailing-edge debouncer: aggregates bursts into clean dumpsys calls."""
        if self._refresh_task and not self._refresh_task.done():
            self._has_pending_refresh = True
            return
        self._has_pending_refresh = False
        self._refresh_task = asyncio.create_task(self._do_debounced_refresh())

    async def _do_debounced_refresh(self) -> None:
        while True:
            self._has_pending_refresh = False
            await asyncio.sleep(self.DEBOUNCE_INTERVAL_S)
            await self._refresh_notifications()
            if not self._has_pending_refresh:
                break

    async def _follow_logcat(
        self, proc_attr: str, logcat_args: tuple[str, ...], on_line: Callable[[str], Awaitable[None] | None],
    ) -> None:
        """Runs `adb logcat <logcat_args>` for the bound device and hands every line to `on_line`; restarts the stream
        whenever it ends or breaks (device replug, adb restart) until the task is cancelled. The process is kept on
        `self.<proc_attr>` so stop() can kill it."""
        while True:
            try:
                if not self._serial or self.push_live:
                    # No device, or the daemon pushes: no `logcat` process on the phone at all.
                    await asyncio.sleep(self.PUSH_RECHECK_S)
                    continue
                if self._mode_logged != "fallback":
                    self._mode_logged = "fallback"
                    log.info("[NotificationService] daemon bildirim dinleyicisi yok — logcat + dumpsys yedek yolu")
                proc = await self._adb.spawn_logcat(*logcat_args, serial=self._serial)
                setattr(self, proc_attr, proc)
                log.debug("logcat stream %s started for %s", proc_attr, self._serial)
                assert proc.stdout is not None
                while True:
                    try:
                        line_bytes = await proc.stdout.readline()
                    except Exception:
                        break
                    if not line_bytes:
                        break
                    result = on_line(line_bytes.decode("utf-8", errors="replace").strip())
                    if result is not None:
                        await result
                # The stream ended: don't respawn `adb logcat` in a tight loop while the device is gone.
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                break
            except Exception as err:
                log.debug("logcat stream %s error: %s", proc_attr, err)
                await asyncio.sleep(3)

    def _on_notification_event(self, line: str) -> None:
        if line and not line.startswith("---"):
            self._trigger_debounced_refresh()

    def _on_activity_event(self, line: str) -> None:
        if "START u0 {" in line:
            content = line[line.index("START u0 {"):]
            # Only OpenDeX windows and the last notification target at INFO; unrelated background starts at DEBUG.
            open_pkgs = set(self._open_window_ids())
            recent_target = self._last_nav_target_pkg
            if any(p in content for p in open_pkgs) or (recent_target and recent_target in content):
                log.info("📱 [TELEFONDA ETKİNLİK BAŞLATILDI 🚀] %s", content)
            else:
                log.debug("📱 [TELEFONDA ETKİNLİK BAŞLATILDI] %s", content)
        elif "onNotificationClick" in line:
            log.info("📱 [TELEFONDA BİLDİRİME DOKUNULDU 👆] %s", line)

    async def _stop_logcat_streams(self) -> None:
        for proc in (self._logcat_proc, self._activity_logcat_proc):
            await _kill(proc)
        self._logcat_proc = self._activity_logcat_proc = None

    async def _daemon_settled(self) -> None:
        """The daemon's push replaces dumpsys and logcat, so those start only after the daemon had its chance (the startup
        window of DeviceDaemonClient). Polling first made the phone work twice, and the second source's rendering of the
        same notification differs a little from the first's, which the UI showed as new messages."""
        if self._daemon is not None and self._serial:
            await self._daemon.wait_ready(self._serial)

    async def _logcat_stream_loop(self) -> None:
        """Fallback notification events: every enqueue/cancel triggers a debounced dumpsys refresh."""
        await self._daemon_settled()
        try:
            if self._serial:
                await self._refresh_notifications()
        except Exception as err:
            log.debug("initial notification refresh error: %s", err)
        await self._follow_logcat("_logcat_proc", _NOTIFICATION_EVENTS_LOGCAT, self._on_notification_event)

    async def _activity_logcat_stream_loop(self) -> None:
        """Tracks what opens when notifications are tapped (ActivityTaskManager & StatusBar) — a diagnostic of the
        fallback mode only; with the daemon live, task focus changes arrive as its events instead."""
        await self._daemon_settled()
        await self._follow_logcat("_activity_logcat_proc", _ACTIVITY_LOGCAT, self._on_activity_event)

    async def _poll_heartbeat_loop(self) -> None:
        """Safety net: a full `dumpsys notification` every ``poll_interval_s`` catches whatever the logcat stream
        dropped. Idle while the daemon's push listener is live."""
        await self._daemon_settled()
        while True:
            try:
                await asyncio.sleep(self._poll_interval_s)
                if self._serial and not self.push_live:
                    await self._refresh_notifications()
            except asyncio.CancelledError:
                break
            except Exception as err:
                log.debug("notification poll heartbeat error: %s", err)
                await asyncio.sleep(3)

    # ------------------------------------------------------------------ daemon push

    async def _on_daemon_snapshot(self, data: dict[str, Any]) -> None:
        """notifications_update: the listener's whole list (on connect, and on request)."""
        if not self._serial or not data.get("ok"):
            if not data.get("ok"):
                log.warning("[NotificationService] daemon bildirim dinleyicisi yok (%s) — dumpsys yoluna geçildi",
                            data.get("error"))
            return
        items = [it for it in data.get("items") or [] if isinstance(it, dict) and it.get("key")]
        self._raw = {it["key"]: it for it in items}
        # Push is live from now on: the fallback's `logcat` processes on the phone are no longer needed.
        await self._stop_logcat_streams()
        if self._mode_logged != "push":
            self._mode_logged = "push"
            log.info("[NotificationService] bildirimler daemon'dan anlık alınıyor (%d aktif) — dumpsys/logcat yoklaması "
                     "kapalı", len(items))
        await self._apply(notifications_from_daemon(self._raw.values()))

    async def _on_daemon_posted(self, data: dict[str, Any]) -> None:
        item = data.get("item")
        if not self._serial or not isinstance(item, dict) or not item.get("key"):
            return
        self._raw[item["key"]] = item
        await self._apply(notifications_from_daemon(self._raw.values()))

    async def _on_daemon_removed(self, data: dict[str, Any]) -> None:
        key = data.get("key")
        if not self._serial or not key or self._raw.pop(key, None) is None:
            return
        await self._apply(notifications_from_daemon(self._raw.values()))

    # ------------------------------------------------------------------ one pipeline for both sources

    async def _refresh_notifications(self) -> None:
        """A full re-sync: the daemon's list when its listener is live, `dumpsys notification` otherwise."""
        if not self._serial:
            return
        if self.push_live:
            resp = await self._daemon.notifications_list()
            if resp is not None:
                items = [it for it in resp.get("items") or [] if isinstance(it, dict) and it.get("key")]
                self._raw = {it["key"]: it for it in items}
                await self._apply(notifications_from_daemon(self._raw.values()))
                return
        out = await self._adb.shell("dumpsys notification --noredact", serial=self._serial)
        await self._apply(parse_dumpsys_notifications(out))

    async def _apply(self, parsed: dict[str, RichNotificationItem]) -> None:
        async with self._apply_lock:
            await self._apply_locked(parsed)

    async def _apply_locked(self, parsed: dict[str, RichNotificationItem]) -> None:
        open_windows = self._open_window_ids()
        existing_keys = set(self._notifications.keys())

        # New or updated notifications (Strict LIFO ordering: emitted as they arrive/update)
        for key, new_item in parsed.items():
            # Check if user dismissed this exact notification content
            if key in self._dismissed_signatures:
                if self._dismissed_signatures[key] == self._content_signature(new_item):
                    continue  # same content the user already dismissed
                # New message arrived under the same notification key! Unmask it!
                self._dismissed_signatures.pop(key, None)
                log.info("📩 [YENİ MESAJ GELDİ 🌟] [%s] Yeni içerik algılandı (%d karakter)", new_item.app_name, len(new_item.text or ""))

            new_item.active_window_id = open_windows.get(new_item.package)
            existing = self._notifications.get(key)
            self._notifications[key] = new_item  # also refreshes the age label of an unchanged item
            if existing is None:
                if self._initial_sync_done:
                    log.info("✨ [BİLDİRİM 🔔] [%s] %s", new_item.app_name, _content_shape(new_item))
                await self._events.emit("notification_received", **new_item.to_dict())
            elif existing.text != new_item.text or existing.title != new_item.title:
                if new_item.category == NotificationCategory.MEDIA:
                    log.info("🎵 [MEDYA DURUMU GÜNCELLENDİ] [%s] %s", new_item.app_name, _content_shape(new_item))
                else:
                    log.info(
                        "🔄 [BİLDİRİM GÜNCELLENDİ 💬] [%s] %s (Zaman: %s)",
                        new_item.app_name, _content_shape(new_item), new_item.post_time,
                    )
                await self._events.emit("notification_updated", **new_item.to_dict())

            # Warm intent cache in background for fast instant notification click. From the daemon this is free (the
            # intent came with the item); an item without one is resolved on click, not with a dumpsys per notification.
            if new_item.id not in self._intent_cache and new_item.package and (
                new_item.content_intent or not self.push_live
            ):
                spawn_background(self.resolve_notification_intent(new_item))

        self._initial_sync_done = True

        # Removed notifications (Bidirectional sync: dismissed on phone -> cleared on PC)
        for key in existing_keys - set(parsed.keys()):
            self._dismissed_signatures.pop(key, None)
            old_item = self._notifications.pop(key, None)
            log.info("🗑️ [BİLDİRİM TELEFONDA SİLİNDİ] [%s] id=%s", old_item.app_name if old_item else key, key)
            await self._events.emit("notification_cleared", id=key)

    # ------------------------------------------------------------------ intent resolution

    @staticmethod
    def _intent_str_to_am_args(intent_str: str) -> str:
        """Converts an Android dumpsys requestIntent string into am start command arguments."""
        return " ".join(parse_intent_args(intent_str, quote='"'))

    @staticmethod
    def _field(item: RichNotificationItem | dict, name: str) -> Any:
        return item.get(name) if isinstance(item, dict) else getattr(item, name, None)

    def _remember_intent(self, args: str, *keys: str | None) -> str:
        for key in keys:
            if key:
                self._intent_cache[key] = args
        return args

    async def resolve_notification_intent(self, item: RichNotificationItem | dict) -> str | None:
        """
        Resolves the exact Android intent arguments (-a ... -d ... -n ...) for a notification
        from dumpsys activity intents {pkg} so it can be launched directly into the target conversation
        or activity on a specific Virtual Display.
        """
        if not self._serial or not self._adb:
            return None

        nid = self._field(item, "id")
        ci_id = self._field(item, "content_intent_id")
        pkg = self._field(item, "package")
        android_key = self._field(item, "android_key")

        # 0. In-memory cache: instant return
        for key in (nid, android_key):
            if key and key in self._intent_cache:
                log.debug("⚡ [BİLDİRİM INTENT ÖNBELLEKTEN ALINDI (%s)] args: %s", key, self._intent_cache[key])
                return self._intent_cache[key]

        # 1. The daemon's listener read the launch Intent itself: no `dumpsys activity intents` at all.
        content_intent = self._field(item, "content_intent")
        if isinstance(content_intent, str) and content_intent:
            args = self._intent_str_to_am_args(content_intent)
            if args:
                log.debug("🎯 [BİLDİRİM INTENT DAEMON'DAN] pkg=%s -> am_args=%s", pkg, args)
                return self._remember_intent(args, nid, android_key, pkg)

        log.debug("🔍 [INTENT ÇÖZÜMLEME BAŞLADI] pkg=%s ci_id=%s nid=%s key=%s", pkg, ci_id, nid, android_key)

        try:
            # 1. Fast package-specific dump (~60ms instead of 2.5s global dumpsys)
            out = ""
            if pkg:
                with contextlib.suppress(Exception):
                    out = await self._adb.shell(f"dumpsys activity intents {pkg}", serial=self._serial, timeout_s=2.5)

            # Fallback to global dump only if package-specific was empty or failed
            if not out or (pkg and f"packageName={pkg}" not in out and pkg not in out):
                with contextlib.suppress(Exception):
                    out = await self._adb.shell("dumpsys activity intents", serial=self._serial, timeout_s=2.5)

            if not out:
                cached = self._intent_cache.get(pkg) if pkg else None
                log.debug("ℹ️ [INTENT DUMPSYS BOŞ] pkg=%s fallback_cache=%s", pkg, cached)
                return cached

            # 2. The notification's own PendingIntentRecord
            if ci_id:
                raw_intent = find_request_intent(out, ci_id)
                if raw_intent:
                    args = self._intent_str_to_am_args(raw_intent)
                    log.debug("🎯 [BİLDİRİM INTENT ÇÖZÜLDÜ (CI_ID: %s)] raw=%s -> am_args=%s", ci_id, raw_intent, args)
                    return self._remember_intent(args, nid, android_key, pkg)

            # 3. Fallback: the package's latest startActivity PendingIntentRecord (a non-launcher one preferred)
            if pkg:
                pattern = (
                    r"PendingIntentRecord\{[a-fA-F0-9]+\s+" + re.escape(pkg) + r"\s+startActivity[^\r\n]*\r?\n"
                    r"(?:(?!\bPendingIntentRecord\{)[^\r\n]*\r?\n)*?\s*requestIntent=([^\r\n]+)"
                )
                intents = [m.group(1).strip() for m in re.finditer(pattern, out)]
                if intents:
                    chosen = next((i for i in reversed(intents) if "category.LAUNCHER" not in i), intents[-1])
                    args = self._intent_str_to_am_args(chosen)
                    log.debug("🎯 [BİLDİRİM INTENT ÇÖZÜLDÜ (PKG: %s)] raw=%s -> am_args=%s", pkg, chosen, args)
                    return self._remember_intent(args, nid, android_key, pkg)
            log.debug("ℹ️ [BİLDİRİM INTENT EŞLEŞMEDİ] pkg=%s ci_id=%s (dumpsys boyutu: %d byte)", pkg, ci_id, len(out))
        except Exception as exc:
            log.warning("resolve_notification_intent failed for %s: %s", pkg, exc)

        return self._intent_cache.get(pkg) if pkg else None
