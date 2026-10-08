"""Android shell primitives — the ONE place the backend asks the phone basic questions over `adb shell`.

Every window/handoff/workspace module used to re-implement these (physical DPI, "bring the app to the front on
display X", display density, app-lock detection, `dumpsys activity` display sections…), and the copies drifted apart.
Callers use them as `android_shell.<fn>(…)` (module attribute, not `from … import fn`) so a test can monkeypatch one
function for every caller at once.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

# ---------------------------------------------------------------- the phone's own screen (display 0)

# A density Override inside this range is a real phone scale choice (the user's "Display size" / developer "Smallest
# width"); below it is a leaked PC virtual-display value, above it a bogus reading — neither describes the phone screen.
_PHONE_OVERRIDE_RANGE = (320, 700)


@dataclass(frozen=True, slots=True)
class PhoneDisplay:
    """The phone's own panel as its apps see it.

    ``density`` is what Android lays the phone's apps out with: the user's display size / smallest-width choice when
    one is set, else the panel's own ``physical_density``. A window handed back to the phone must land on exactly this
    value — e.g. a 1220 px wide 520 dpi panel set to 380 dp smallest width runs its apps at 513 dpi, and an app landed
    at 520 looks like the factory 375 dp. Sizes are the natural-orientation base size (the resolution choice included).
    """

    density: int
    physical_density: int
    width: int
    height: int
    source: str  # "daemon" (Binder, PhoneDisplay.java) | "shell" (`wm density` / `wm size`)

    @property
    def smallest_width_dp(self) -> int:
        """As Android computes Configuration.smallestScreenWidthDp: truncated, not rounded."""
        return int(min(self.width, self.height) * 160 / self.density)


def effective_density(physical: int | None, override: int | None) -> int | None:
    """The density the phone's apps use: a plausible override wins (see _PHONE_OVERRIDE_RANGE), else the physical one;
    a lone implausible override only when nothing else is known. The ONE rule for both sources (daemon and shell)."""
    if override and _PHONE_OVERRIDE_RANGE[0] <= override <= _PHONE_OVERRIDE_RANGE[1]:
        return override
    return physical or override or None


def parse_phone_density(raw: str) -> int | None:
    """`wm density` of Display 0 → effective_density of its Physical / Override lines; None if absent."""
    override = re.search(r"Override density:\s*(\d+)", raw or "")
    physical = re.search(r"Physical density:\s*(\d+)", raw or "")
    return effective_density(int(physical.group(1)) if physical else None, int(override.group(1)) if override else None)


def phone_display_from_snapshot(snapshot: dict[str, Any] | None) -> PhoneDisplay | None:
    """The daemon's ``display_update`` object (PhoneDisplay.java) → PhoneDisplay; None for an unusable one."""
    if not isinstance(snapshot, dict) or not snapshot.get("ok"):
        return None
    try:
        physical = int(snapshot["physical_density"])
        base = int(snapshot["density"])
        width, height = int(snapshot["w"]), int(snapshot["h"])
    except (KeyError, TypeError, ValueError):
        return None
    density = effective_density(physical, base if base != physical else None)
    if not density or density <= 0 or width <= 0 or height <= 0:
        return None
    return PhoneDisplay(density=density, physical_density=physical, width=width, height=height, source="daemon")


async def _daemon_phone_display() -> PhoneDisplay | None:
    """The daemon's Binder read of display 0 (no fork, no text parsing); None when it cannot answer."""
    from . import daemon_registry  # late: daemon_registry is filled in by main.py

    daemon = daemon_registry.live("display_get")
    if daemon is None:
        return None
    try:
        return phone_display_from_snapshot(await daemon.phone_display())
    except Exception as exc:  # noqa: BLE001 — the shell is the fallback
        log.debug("[android_shell] daemon display_get başarısız: %s", exc)
        return None


async def _shell_phone_density(adb: Any, serial: str) -> tuple[int, int] | None:
    """(effective density, physical density) from `wm density`; None when unreadable."""
    try:
        raw = await adb.shell("wm density", serial=serial, timeout_s=1.5)
    except Exception as exc:  # noqa: BLE001
        log.warning("[android_shell] telefonun yoğunluğu okunamadı (wm density): %s", exc)
        return None
    density = parse_phone_density(raw)
    if not density:
        log.warning("[android_shell] telefonun yoğunluğu okunamadı (wm density çıktısı: %r)", (raw or "")[:80])
        return None
    physical = re.search(r"Physical density:\s*(\d+)", raw or "")
    return density, int(physical.group(1)) if physical else density


async def read_phone_display(adb: Any, serial: str) -> PhoneDisplay | None:
    """The phone panel (density AND size), read LIVE: the daemon first, `wm density` + `wm size` through the shell only
    when the daemon cannot answer (not connected, an older jar). None when it could not be read — never a guessed
    value: a guess becomes the density an app is laid out with on the phone."""
    display = await _daemon_phone_display()
    if display is not None:
        return display
    densities = await _shell_phone_density(adb, serial)
    size = await read_display_size(adb, serial, 0)
    if densities is None or not size:
        return None
    return PhoneDisplay(density=densities[0], physical_density=densities[1], width=size[0], height=size[1], source="shell")


async def phone_density(adb: Any, serial: str) -> int | None:
    """The density the phone's own apps use right now (see PhoneDisplay): the daemon's Binder read, `wm density` only
    when the daemon cannot answer. None when unreadable — callers that would WRITE a density from it must skip the write
    instead of inventing one."""
    display = await _daemon_phone_display()
    if display is not None:
        return display.density
    densities = await _shell_phone_density(adb, serial)
    return densities[0] if densities else None


async def phone_size(adb: Any, serial: str) -> tuple[int, int] | None:
    """(width, height) in px of the phone's own panel as its apps see it (natural orientation, the resolution choice
    included): the daemon's Binder read, `wm size` only when the daemon cannot answer. None when unreadable — a caller that
    would resize a display to it must skip that instead of inventing a size."""
    display = await _daemon_phone_display()
    if display is not None:
        return display.width, display.height
    return await read_display_size(adb, serial, 0)


async def read_phone_metrics(adb: Any, serial: str) -> tuple[int, int, int] | None:
    """(short side, long side, density) of the phone's own panel as apps see it. None when it cannot be read."""
    display = await read_phone_display(adb, serial)
    if display is None:
        return None
    short, long_ = sorted((display.width, display.height))
    return short, long_, display.density


_SIZE_RE = re.compile(r"(\d+)\s*x\s*(\d+)")


def parse_display_size(raw: str) -> tuple[int, int] | None:
    """`wm size` output: 'Physical size: 1080x2400' (+ 'Override size:' when set — that one wins)."""
    if not raw:
        return None
    override = re.search(r"Override size:\s*(\d+)\s*x\s*(\d+)", raw)
    if override:
        return int(override.group(1)), int(override.group(2))
    m = _SIZE_RE.search(raw)
    return (int(m.group(1)), int(m.group(2))) if m else None


async def read_display_size(adb: Any, serial: str, display_id: str | int) -> tuple[int, int] | None:
    """(width, height) of a display; None when it can't be read."""
    cmd = "wm size" if str(display_id) in ("0", "") else f"wm size -d {display_id}"
    try:
        return parse_display_size(await adb.shell(cmd, serial=serial, timeout_s=1.5))
    except Exception as exc:  # noqa: BLE001
        log.debug("[android_shell] display=%s boyutu okunamadı: %s", display_id, exc)
        return None


# ---------------------------------------------------------------- display density

_desired_density: dict[str, int] = {}
_density_locks: dict[str, asyncio.Lock] = {}
# Virtual display id -> the density channel of the scrcpy server that owns it (patched server, flex display:
# OPENDEX_RESIZE with the size kept, i.e. VirtualDisplay.resize(w, h, dpi)).
DensitySender = Callable[[int], Awaitable[None]]
_vd_density_channels: dict[str, DensitySender] = {}


# Displays that carry a FORCED density (written through the daemon's Binder call or `wm density`). A forced override pins
# the density: the base density a channel write changes (VirtualDisplay.resize(w, h, dpi)) is MASKED by it — Android keeps
# the forced value (DisplayContent: a forced density survives a change of the display's initial density) while the ledger
# believes the new one is in effect, and the app never sees the DPI it was promised ("the DPI does not settle"). A display
# gets both kinds of writes when its channel was unavailable once (control socket not up yet, a failed send): the override is
# lifted before the next channel write so the two writers cannot disagree.
_forced_density_displays: set[str] = set()
# Displays whose channel failed RIGHT AFTER the override was lifted for it: the write fell back to a forced one again, and
# trying the channel on every later write would lift and re-force each time (two density changes per write). Cleared when a
# channel is (re-)registered or the display is forgotten.
_channel_suspect_displays: set[str] = set()


async def lift_forced_density(adb: Any, serial: str, display_id: str | int, *, timeout_s: float = 2.0) -> bool:
    """Clears a forced density this process wrote on `display_id` (no-op when there is none). True when one was lifted.
    Raises when the clearing itself failed — the display stays marked, so the next write tries again."""
    key = str(display_id)
    if key not in _forced_density_displays:
        return False
    await clear_forced_display_density(adb, serial, display_id, timeout_s=timeout_s)
    _forced_density_displays.discard(key)
    log.info("[android_shell] display=%s: zorlanmış yoğunluk kaldırıldı (taban yoğunluk yazımı artık görünür)", key)
    return True


def register_vd_density_channel(display_id: str | int, sender: DensitySender) -> None:
    """From now on this virtual display's density is written by its own server: the display's base density changes
    (no forced override — on Android <= 14 a forced one is persisted and inherited by the next virtual display), and
    it travels on the same control socket as the display's resizes, so the two can never overtake each other."""
    _vd_density_channels[str(display_id)] = sender
    _channel_suspect_displays.discard(str(display_id))


def unregister_vd_density_channel(display_id: str | int, sender: DensitySender) -> None:
    """Drops the channel only if it is still ``sender``'s (a newer server may own a reused id)."""
    key = str(display_id)
    if _vd_density_channels.get(key) is sender:
        del _vd_density_channels[key]


async def apply_display_density(
    display_id: str | int,
    dpi: int,
    write: Callable[[], Awaitable[str]],
    *,
    initial: bool = False,
    carries_more: bool = False,
) -> str:
    """The single writer's ledger: per-display newest-target tracking and lock around ``write`` (which performs the
    write and returns the path it took). A write whose target was overtaken while it waited is skipped — unless it
    ``carries_more`` than the density (a resize message): then it goes anyway and the newer density, queued behind it
    on the same lock, is written after it. An ``initial`` write never overrides an existing target.
    Returns ``write()``'s path, or "skipped:superseded"."""
    key = str(display_id)
    target_dpi = int(dpi)

    if initial and key in _desired_density:
        log.debug(
            "[android_shell] display=%s için daha yeni bir DPI hedefi (%d) mevcut; initial=%d atlandı",
            key, _desired_density[key], target_dpi,
        )
        return "skipped:superseded"

    _desired_density[key] = target_dpi
    lock = _density_locks.setdefault(key, asyncio.Lock())

    async with lock:
        if _desired_density.get(key) != target_dpi and not carries_more:
            log.debug(
                "[android_shell] display=%s için işlem sırasında hedef %d -> %s olarak güncellendi; atlanıyor",
                key, target_dpi, _desired_density.get(key),
            )
            return "skipped:superseded"
        return await write()


async def set_display_density(
    adb: Any,
    serial: str,
    display_id: str | int,
    dpi: int,
    *,
    daemon: Any = None,
    timeout_s: float = 2.0,
    initial: bool = False,
) -> str:
    """Sets a display's density — the ONE writer every caller goes through. In order: the display's own scrcpy
    server (registered channel: base density, no forced override), the daemon's Binder call (sub-ms), `wm density`;
    a failing path falls through to the next. The ledger (apply_display_density) keeps an older 'initial' or
    superseded write from overriding a newer target.
    Returns the path used ("channel" | "daemon" | "adb" | "skipped:superseded"); raises when the adb fallback fails."""
    target_dpi = int(dpi)

    async def write() -> str:
        key = str(display_id)
        channel = None if key in _channel_suspect_displays else _vd_density_channels.get(key)
        if channel is not None:
            lifted = False
            try:
                lifted = await lift_forced_density(adb, serial, display_id, timeout_s=timeout_s)
                await channel(target_dpi)
                return "channel"
            except Exception as exc:  # noqa: BLE001 — fall back to the daemon / shell
                log.debug("[android_shell] yoğunluk kanalı hatası (display=%s): %s", display_id, exc)
                if lifted:
                    _channel_suspect_displays.add(key)

        if daemon is not None and getattr(daemon, "is_connected", False):
            try:
                if await daemon.set_display_density(display_id, target_dpi):
                    _forced_density_displays.add(str(display_id))
                    return "daemon"
            except Exception as exc:  # noqa: BLE001 — fall back to the shell
                log.debug("[android_shell] daemon set_display_density hatası (display=%s): %s", display_id, exc)

        await adb.shell(f"wm density {target_dpi} -d {display_id}", serial=serial, timeout_s=timeout_s)
        _forced_density_displays.add(str(display_id))
        return "adb"

    return await apply_display_density(display_id, target_dpi, write, initial=initial)


async def clear_forced_display_density(adb: Any, serial: str, display_id: str | int, *, timeout_s: float = 2.0) -> None:
    """Removes a forced density override from a display (`wm density reset -d`): the display shows its own base
    density again. A new virtual display on Android <= 14 can carry one inherited from an earlier display (persisted
    in display_settings.xml) that would mask the density it was created with."""
    await adb.shell(f"wm density reset -d {display_id}", serial=serial, timeout_s=timeout_s)


def forget_display_density(display_id: str | int) -> None:
    """Ekran kapandığında hafızadaki hedefi, kilidi ve yoğunluk kanalını temizler; ID tekrar kullanıldığında eski değer
    taşınmaz."""
    key = str(display_id)
    _desired_density.pop(key, None)
    _density_locks.pop(key, None)
    _vd_density_channels.pop(key, None)
    _forced_density_displays.discard(key)
    _channel_suspect_displays.discard(key)


# ---------------------------------------------------------------- launching


def bring_to_front_command(package: str, display_id: str | int, windowing_mode: int | None = None) -> str:
    mode = f" --windowingMode {windowing_mode}" if windowing_mode is not None else ""
    return (
        f"am start --display {display_id}{mode} -a android.intent.action.MAIN "
        f"-c android.intent.category.LAUNCHER -p {package} -f 0x10000000"
    )


async def bring_to_front(
    adb: Any, serial: str, package: str, display_id: str | int, *,
    windowing_mode: int | None = None, timeout_s: float = 2.0,
) -> str:
    """Starts the app's launcher activity on `display_id` — an existing task is brought to the front (NEW_TASK), so
    this also 'resumes' a task that was just moved there. Returns `am start` output; raises on adb failure."""
    return await adb.shell(bring_to_front_command(package, display_id, windowing_mode), serial=serial, timeout_s=timeout_s)


async def wake_and_unlock(adb: Any, serial: str) -> None:
    """Wakes the phone screen and dismisses a non-secure keyguard (best effort, never raises)."""
    with contextlib.suppress(Exception):
        await adb.shell("input keyevent KEYCODE_WAKEUP", serial=serial, timeout_s=1.0)
        await adb.shell("wm dismiss-keyguard", serial=serial, timeout_s=1.0)


# ---------------------------------------------------------------- app lock

# OEM app-lock / credential screens as they appear in focus lines, activity dumps and `am start` output
# (Xiaomi HyperOS `…applicationlock.AppLockActivity` / `APPLOCK_ACCESS_CONTROL`, AOSP/Samsung `ConfirmDeviceCredential…`).
APPLOCK_MARKERS = ("AppLock", "APPLOCK", "applicationlock", "ConfirmDeviceCredential")


# ---------------------------------------------------------------- quick toggles & volume (REST + /ws/events)

# Shell fallback for the toggles that have a command; the daemon flips every one it knows.
_TOGGLE_COMMANDS = {
    "wifi": ("svc wifi enable", "svc wifi disable"),
    "bluetooth": ("svc bluetooth enable", "svc bluetooth disable"),
    "mobile_data": ("svc data enable", "svc data disable"),
    "mute": ("cmd audio set-ringer-mode SILENT", "cmd audio set-ringer-mode NORMAL"),
}


async def set_hardware_state(adb: Any, serial: str, daemon: Any, key: str, on: bool) -> bool:
    """Daemon first, then the shell command; False when neither could apply `key`."""
    if daemon is not None and daemon.is_connected and await daemon.set_hardware_state(key, on):
        return True
    command = _TOGGLE_COMMANDS.get(key)
    if command is None:
        return False
    with contextlib.suppress(Exception):
        await adb.shell(command[0 if on else 1], serial=serial)
        return True
    return False


async def set_stream_volume(adb: Any, serial: str, daemon: Any, stream_id: int, value: int) -> bool:
    """Daemon first, then `cmd audio set-volume`."""
    if daemon is not None and daemon.is_connected and await daemon.set_volume(stream_id, value):
        return True
    with contextlib.suppress(Exception):
        await adb.shell(f"cmd audio set-volume {int(stream_id)} {int(value)}", serial=serial)
        return True
    return False


def is_app_lock(text: str | None) -> bool:
    return bool(text) and any(marker in text for marker in APPLOCK_MARKERS)


# ---------------------------------------------------------------- `dumpsys activity activities`

# Section headers: "Display #5 (activities …)" on most builds, "Display: mDisplayId=5" on some OEM builds.
_DISPLAY_HEADER_RE = re.compile(r"(?:Display\s*#|Display:\s*mDisplayId=)(\d+)")


def activities_by_display(raw: str) -> dict[str, str]:
    """Splits a `dumpsys activity activities` dump into {display_id: section text}."""
    parts = _DISPLAY_HEADER_RE.split(raw or "")
    return {parts[i]: (parts[i + 1] if i + 1 < len(parts) else "") for i in range(1, len(parts), 2)}


_WINDOW_OWNER_RE = re.compile(r"(?:Window|ActivityRecord)\{[0-9a-fA-F]+\s+u\d+\s+([a-zA-Z0-9._]+)/")


def visible_packages_by_display(raw: str) -> dict[str, set[str]]:
    """`dumpsys window | grep -E 'Display: |mCurrentFocus|mFocusedApp'` → {display_id: packages focused on it}."""
    return {disp: set(_WINDOW_OWNER_RE.findall(text)) for disp, text in activities_by_display(raw).items()}


def task_id_in(text: str, package: str) -> str | None:
    """Most recent task id of `package` within `text` (an ActivityRecord's `t<id>` first, then a Task header)."""
    pkg = re.escape(package)
    m = re.search(rf"ActivityRecord\{{[^}}]*?{pkg}[^}}]*?\st(\d+)\}}", text)
    if m:
        return m.group(1)
    m = re.search(rf"Task\{{[a-f0-9]+\s+#(\d+)[^}}]*?{pkg}", text)
    return m.group(1) if m else None


def has_package(text: str, package: str) -> bool:
    pkg = re.escape(package)
    return bool(re.search(rf"ActivityRecord\{{[^}}]*?{pkg}", text) or re.search(rf"Task\{{[^}}]*?{pkg}", text))


def has_any_activity(text: str) -> bool:
    return "Task{" in text or "ActivityRecord{" in text
