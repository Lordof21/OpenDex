"""Görev pencereleme kipi (windowing mode): Workspace/VD'den ÇIKIŞTA temiz geçiş + doğrulama.

Sorun: Workspace görevleri freeform (5) + launch-bounds + `resizeable 2` ile yaşar. Telefona ya da yeni bir VD'ye
taşınırken bunlar geri alınmazsa görev ekranın yalnız bir bölümünü kaplar, gerisi siyah kalır. Kök nedeni (kalan
freeform kipi mi, eski override bounds mu, üretici freeform ölçeği mi) cihazda kesinleştirmek için her geçişte TEK
satırlık "geçiş raporu" loglanır (`[TRANSFER]`); düzeltme nedenden bağımsızdır:

    taşıdıktan SONRA hedef kipi uygula → doğrula → (gerekirse) yeniden yerleşim → yine olmazsa çağıran son çare
    olarak uygulamayı sıfırdan başlatır.

Doğrulama KORUYUCUDUR: yalnız durum OKUNABİLİYORSA ve hedefle uyuşmuyorsa "bad" denir; okunamıyorsa "unknown"
(tekrar/yıkıcı adım yok). Böylece bir OEM'in dumpsys biçimi farklı olsa bile geçiş bozulmaz, yalnızca doğrulanamaz.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ..device import android_shell, daemon_registry
from ..device.android_shell import parse_display_size, read_display_size  # noqa: F401 (moved; kept importable here)
from . import surfaceflinger_probe

log = logging.getLogger(__name__)

Rect = tuple[int, int, int, int]

FULLSCREEN = 1
FREEFORM = 5
TARGET_MODES: dict[str, int] = {"fullscreen": FULLSCREEN, "freeform": FREEFORM}

# Android WindowConfiguration: WINDOWING_MODE_* adları (dumpsys `mWindowingMode=` / `mode=`)
_MODE_BY_NAME: dict[str, int] = {
    "undefined": 0, "fullscreen": 1, "pinned": 2, "split-screen-primary": 3,
    "split-screen-secondary": 4, "freeform": 5, "multi-window": 6,
}

_RECT_RE = re.compile(r"mBounds=Rect\((-?\d+),\s*(-?\d+)\s*-\s*(-?\d+),\s*(-?\d+)\)")
_HEADER_MODE_RE = re.compile(r"\bmode=([A-Za-z][A-Za-z-]*)")  # `* Task{… mode=fullscreen …}` başlık satırı
_CONFIG_MODE_RE = re.compile(r"mWindowingMode=([A-Za-z][A-Za-z-]*)")  # `winConfig={… mWindowingMode=fullscreen …}`
_DISPLAY_RES = (re.compile(r"\bmDisplayId=(\d+)"), re.compile(r"\bdisplayId=(\d+)"))

_COVER_TOLERANCE = 0.02  # tam ekran görevi ekranı ±%2 doldurmalı (sistem insets için pay)
_MIN_SIDE_PX = 100  # < 100 px kutular gerçek pencere değil (insets/artık)


@dataclass(frozen=True)
class TaskWindowingState:
    task_id: str
    found: bool
    windowing_mode: int | None = None
    bounds: Rect | None = None
    display_id: str | None = None
    visible: bool | None = None  # the daemon's TaskInfo.isVisible; None when the source cannot tell (dumpsys)

    @property
    def mode_name(self) -> str:
        for name, value in _MODE_BY_NAME.items():
            if value == self.windowing_mode:
                return name
        return "?"


@dataclass(frozen=True)
class WindowingReport:
    task_id: str
    target: str            # "fullscreen" | "freeform"
    verdict: str           # "ok" | "bad" | "unknown"
    attempts: int
    method: str            # "daemon" | "shell" | "none"
    relayout: bool
    before: TaskWindowingState | None
    after: TaskWindowingState | None


# ---------------------------------------------------------------- saf ayrıştırıcılar

def _task_block(raw: str, task_id: str) -> str | None:
    match = re.search(
        rf"\* Task\{{[^\n]*#{re.escape(str(task_id))}\b.*?(?=\n  \* Task\{{|\n\s*Display #|\Z)", raw, re.DOTALL,
    )
    return match.group(0) if match else None


def _read_mode(block: str) -> int | None:
    """Etkin kip: önce görev başlık satırındaki `mode=`, yoksa yapılandırmadaki ilk `mWindowingMode=`. `undefined`
    (0) ATLANIR: override yapılandırması çoğu zaman `undefined` yazar; bu gerçek kip değildir."""
    header = block.split("\n", 1)[0]
    candidates = [m.group(1) for m in _HEADER_MODE_RE.finditer(header)]
    candidates += [m.group(1) for m in _CONFIG_MODE_RE.finditer(block)]
    for name in candidates:
        value = _MODE_BY_NAME.get(name.lower())
        if value:  # None ve 0 (undefined) elenir
            return value
    return None


def parse_task_windowing(raw: str, task_id: str) -> TaskWindowingState:
    """`dumpsys activity activities <task>` çıktısından görevin kipini/kutusunu okur. Bulunamazsa found=False."""
    block = _task_block(raw or "", task_id)
    if block is None:
        return TaskWindowingState(task_id=str(task_id), found=False)

    mode = _read_mode(block)

    bounds: Rect | None = None
    for m in _RECT_RE.finditer(block):
        cand = tuple(int(g) for g in m.groups())
        if cand[2] - cand[0] >= _MIN_SIDE_PX and cand[3] - cand[1] >= _MIN_SIDE_PX:
            bounds = cand  # type: ignore[assignment]
            break

    display_id: str | None = None
    for pattern in _DISPLAY_RES:
        m = pattern.search(block)
        if m:
            display_id = m.group(1)
            break

    return TaskWindowingState(task_id=str(task_id), found=True, windowing_mode=mode, bounds=bounds, display_id=display_id)


def _covers_display(bounds: Rect, size: tuple[int, int]) -> bool:
    """Kutu ekranı doldurur mu? Yön (dikey/yatay) fark etmez: boyutlar sıralı karşılaştırılır."""
    bw, bh = sorted((bounds[2] - bounds[0], bounds[3] - bounds[1]))
    dw, dh = sorted(size)
    return bw >= dw * (1 - _COVER_TOLERANCE) and bh >= dh * (1 - _COVER_TOLERANCE)


def verify_windowing(state: TaskWindowingState | None, target: str, display_size: tuple[int, int] | None) -> str:
    """"ok" | "bad" | "unknown". Yalnız POZİTİF okunan uyumsuzluk "bad"dir."""
    if state is None or not state.found or state.windowing_mode is None:
        return "unknown"
    want = TARGET_MODES[target]
    if state.windowing_mode != want:
        return "bad"
    if target == "fullscreen" and state.bounds and display_size and not _covers_display(state.bounds, display_size):
        return "bad"  # kip doğru ama görev ekranı doldurmuyor (kalıntı bounds / letterbox)
    return "ok"


def freeform_box_for(display_size: tuple[int, int] | None, margin: float = 0.1) -> Rect | None:
    """Telefonda serbest pencere için ekranın ~%80'i, ortalı (deneysel)."""
    if not display_size:
        return None
    w, h = display_size
    return (round(w * margin), round(h * margin), round(w * (1 - margin)), round(h * (1 - margin)))


# ---------------------------------------------------------------- cihaz okuma / uygulama

def state_from_daemon(task_id: str, info: dict[str, Any]) -> TaskWindowingState:
    """The daemon's get_task_geometry reply (bounds + mode + display) as a TaskWindowingState — the same fields
    `parse_task_windowing` reads out of the dump (mode 0 = undefined is not a real mode, a sliver is not a window)."""
    mode = info.get("mode")
    raw_bounds = info.get("bounds")
    bounds: Rect | None = None
    if isinstance(raw_bounds, list) and len(raw_bounds) == 4 and all(isinstance(v, int) for v in raw_bounds):
        cand = tuple(raw_bounds)
        if cand[2] - cand[0] >= _MIN_SIDE_PX and cand[3] - cand[1] >= _MIN_SIDE_PX:
            bounds = cand  # type: ignore[assignment]
    display = info.get("display")
    return TaskWindowingState(
        task_id=str(task_id), found=True,
        windowing_mode=mode if isinstance(mode, int) and mode > 0 else None,
        bounds=bounds,
        display_id=str(display) if isinstance(display, int) and display >= 0 else None,
        visible=info["visible"] if isinstance(info.get("visible"), bool) else None,
    )


async def read_task_windowing(adb: Any, serial: str, task_id: str) -> TaskWindowingState:
    """The task's mode / bounds / display: from the daemon (ActivityTaskManager, ~2 ms), else from
    `dumpsys activity activities <task>`."""
    daemon = daemon_registry.live("get_task_geometry")
    if daemon is not None and str(task_id).isdigit():
        info = await daemon.get_task_geometry(task_id)
        if info is not None and "mode" in info:  # a pre-1.2 daemon has no mode: the dump still has to answer
            return state_from_daemon(task_id, info)
    try:
        raw = await adb.shell(f"dumpsys activity activities {task_id}", serial=serial, timeout_s=2.5)
    except Exception as exc:  # noqa: BLE001 — okunamayan durum "unknown"dur, geçişi bozmaz
        log.debug("[TRANSFER] task=%s durum okunamadı: %s", task_id, exc)
        return TaskWindowingState(task_id=str(task_id), found=False)
    return parse_task_windowing(raw, task_id)


async def _apply_mode(task_id: str, mode: int, daemon: Any, box: Rect | None) -> tuple[str, bool]:
    """The task's REQUESTED windowing mode through the daemon's WindowContainerTransaction — the only primitive there is:
    `am task` knows lock / resizeable / resize / focus, nothing else (`cmd activity task windowing-mode` is "unknown
    command" on AOSP, which the old shell fallback sent and reported as applied). Without the daemon the mode is not
    set here; from the 2nd attempt the activity is re-laid out with `am start --windowingMode` (_relayout).
    Returns (method, placed): 'daemon' | 'none', and whether ``box`` was applied in the same transaction."""
    if daemon is None or not getattr(daemon, "is_connected", False) or not hasattr(daemon, "set_task_windowing"):
        return "none", False
    placed = box is not None and bool(getattr(daemon, "supports", lambda _c: False)("set_task_windowing_bounds"))
    try:
        ok = await daemon.set_task_windowing(task_id, mode, clear_bounds=(mode == FULLSCREEN), bounds=box if placed else None)
    except Exception as exc:  # noqa: BLE001
        log.debug("[TRANSFER] daemon pencereleme kipi uygulanamadı task=%s: %s", task_id, exc)
        return "none", False
    return ("daemon", placed) if ok else ("none", False)


async def _relayout(adb: Any, serial: str, package: str, display_id: str | int, mode: int) -> None:
    """Görevi hedef kipte yeniden yerleştirir (aktiviteyi hedef display'de öne alır)."""
    with contextlib.suppress(Exception):
        await android_shell.bring_to_front(adb, serial, package, display_id, windowing_mode=mode)


async def _sf_summary(adb: Any, serial: str, task_id: str) -> str:
    with contextlib.suppress(Exception):
        geom = await surfaceflinger_probe.probe_omni_geometry(adb, serial, task_id)
        if geom:
            # `decor`: window chrome the system drew for this task — a phone-side freeform window with none has nothing to be
            # moved/resized by (the handle is the phone's SystemUI, not ours); `oem`: the vendor's own freeform layer.
            decor = f" decor={list(geom.decor_layers) or 'yok'} oem={list(geom.oem_marks) or 'yok'}"
            return f"render={geom.render_bounds} scale=({geom.scale_x:.2f},{geom.scale_y:.2f}){decor}"
    return "render=? scale=?"


def _fmt_state(state: TaskWindowingState | None) -> str:
    if state is None or not state.found:
        return "mode=? bounds=? display=?"
    return f"mode={state.windowing_mode}({state.mode_name}) bounds={state.bounds} display={state.display_id}"


def report_line(
    wlog: logging.Logger, package: str, task_id: str, phase: str, state: TaskWindowingState | None, extra: str = "",
) -> None:
    """Geçiş raporu (TEK satır): cihazda kesin nedeni buradan okuyabilmek için."""
    wlog.info("[TRANSFER] %s task=%s phase=%s %s %s", package, task_id, phase, _fmt_state(state), extra)


async def settle_task_windowing(
    adb: Any,
    serial: str,
    task_id: str,
    package: str,
    *,
    target: str = "fullscreen",
    display_id: str | int = "0",
    daemon: Any = None,
    wlog: logging.Logger | None = None,
    settle_s: float = 0.25,
    attempts: int = 3,
    skip_if_ok: bool = False,
    freeform_bounds: Rect | None = None,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
) -> WindowingReport:
    """Görevi TAŞIDIKTAN SONRA hedef kipe oturtur ve doğrular (en çok `attempts` deneme). 2. denemeden itibaren
    aktivite hedef display'de yeniden yerleştirilir. Durum okunamıyorsa tek deneme yapılır (yıkıcı adım yok).
    `skip_if_ok`: görev ZATEN hedefteyse (pozitif okundu) hiçbir komut gönderilmez — Workspace'e hiç girmemiş normal
    pencerelerin aktarımı gereksiz komut/gecikme almasın.
    `freeform_bounds`: serbest kipte görevin yeri (Android px; Workspace'e dönüşte pencerenin kutusu). Verilmezse
    ekranın ~%80'i (telefonda serbest pencere)."""
    if target not in TARGET_MODES:
        raise ValueError(f"bilinmeyen hedef pencereleme kipi: {target!r}")
    wlog = wlog or log
    mode = TARGET_MODES[target]

    display_size = await read_display_size(adb, serial, display_id)
    before = await read_task_windowing(adb, serial, task_id)
    report_line(wlog, package, task_id, "before", before, f"target={target} display_size={display_size}")

    if skip_if_ok and verify_windowing(before, target, display_size) == "ok":
        report_line(wlog, package, task_id, "after", before, f"target={target} verdict=ok attempts=0 method=none (zaten hedefte)")
        return WindowingReport(
            task_id=str(task_id), target=target, verdict="ok", attempts=0, method="none", relayout=False,
            before=before, after=before,
        )

    box = (freeform_bounds or freeform_box_for(display_size)) if target == "freeform" else None
    method, relayout, verdict, after = "none", False, "unknown", before
    used = 0
    for attempt in range(1, max(1, attempts) + 1):
        used = attempt
        method, placed = await _apply_mode(task_id, mode, daemon, box)
        if box is not None and not placed:
            with contextlib.suppress(Exception):
                await adb.shell(
                    f"cmd activity task resize {task_id} {box[0]} {box[1]} {box[2]} {box[3]}", serial=serial, timeout_s=2.0,
                )
        if attempt >= 2:
            relayout = True
            await _relayout(adb, serial, package, display_id, mode)
        await sleep(settle_s)
        after = await read_task_windowing(adb, serial, task_id)
        verdict = verify_windowing(after, target, display_size)
        if verdict != "bad":
            break  # ok ya da okunamıyor — tekrarın anlamı yok

    sf = await _sf_summary(adb, serial, task_id)
    report_line(wlog, package, task_id, "after", after, f"target={target} verdict={verdict} attempts={used} method={method} relayout={relayout} {sf}")
    return WindowingReport(
        task_id=str(task_id), target=target, verdict=verdict, attempts=used, method=method, relayout=relayout,
        before=before, after=after,
    )


async def land_fullscreen(
    adb: Any,
    serial: str,
    package: str,
    display_id: str | int,
    *,
    task_id: str | int | None = None,
    daemon: Any = None,
    wlog: logging.Logger | None = None,
    find_attempts: int = 4,
    find_interval_s: float = 0.35,
    settle_s: float = 0.25,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
) -> WindowingReport | None:
    """A task that arrives on an INDEPENDENT virtual display is fullscreen there — whatever mode it requested where it
    came from. The requested mode survives a move between displays (WindowContainerTransaction), so an app that was on
    the phone as a freeform window (Hızlı DeX ayarı: "Telefona aktar: serbest pencere") would otherwise return into its
    VD window as a small freeform frame inside the stream.

    Deliberately minimal — this runs while the app is coming up on the VD, and a heavy hand there costs a black frame:
      * it acts ONLY when the mode is read positively as something other than fullscreen (freeform …). Fullscreen,
        unreadable, task not found: no command at all (the bounds are NOT compared with the display — a fullscreen task's
        bounds legitimately differ from it by insets, and "fixing" that is what blanks the app);
      * ONE daemon transaction (mode + cleared bounds), never `am start --windowingMode` (that re-launches the activity),
        and one read afterwards for the report.
    ``task_id`` unknown (the app was started onto the display, not moved): it is looked up there, a few times — the launch
    is asynchronous. Never raises: a failed check must not undo the move; None when there was nothing to settle."""
    wlog = wlog or log
    try:
        if task_id is None:
            from ..device.deep_navigator import find_task_id_for_package  # call-time: it imports window modules

            for attempt in range(max(1, find_attempts)):
                task_id = await find_task_id_for_package(adb, package, display_id=str(display_id), serial=serial)
                if task_id:
                    break
                if attempt + 1 < find_attempts:
                    await sleep(find_interval_s)
        if not task_id:
            wlog.debug("[TRANSFER] %s için %s ekranında görev bulunamadı — tam ekran oturtması atlandı", package, display_id)
            return None
        before = await read_task_windowing(adb, serial, str(task_id))
        if not before.found or before.windowing_mode in (None, FULLSCREEN):
            return WindowingReport(
                task_id=str(task_id), target="fullscreen", verdict="ok" if before.windowing_mode == FULLSCREEN else "unknown",
                attempts=0, method="none", relayout=False, before=before, after=before,
            )
        method, _ = await _apply_mode(str(task_id), FULLSCREEN, daemon or daemon_registry.live("set_task_windowing"), None)
        await sleep(settle_s)
        after = await read_task_windowing(adb, serial, str(task_id))
        verdict = "ok" if after.windowing_mode == FULLSCREEN else ("unknown" if after.windowing_mode is None else "bad")
        report_line(wlog, package, str(task_id), "landed", after, f"was={before.mode_name} method={method} verdict={verdict}")
        return WindowingReport(
            task_id=str(task_id), target="fullscreen", verdict=verdict, attempts=1, method=method, relayout=False,
            before=before, after=after,
        )
    except Exception as exc:  # noqa: BLE001
        wlog.warning("⚠️ [TRANSFER] %s sanal ekranda tam ekran oturtulamadı: %s", package, exc)
        return None


async def cold_relaunch(adb: Any, serial: str, package: str, display_id: str | int = "0") -> None:
    """SON ÇARE (yalnız doğrulanmış 'bad' + tüm denemeler tükendiğinde): uygulamayı sıfırdan başlatır. Görev
    durumu kaybolur; çağıran kullanıcıya bildirir."""
    with contextlib.suppress(Exception):
        await adb.shell(f"am force-stop {package}", serial=serial, timeout_s=2.0)
    with contextlib.suppress(Exception):
        await android_shell.bring_to_front(adb, serial, package, display_id)
