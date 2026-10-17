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


def verify_windowing(
    state: TaskWindowingState | None, target: str, display_size: tuple[int, int] | None,
    freeform_size: tuple[int, int] | None = None,
) -> str:
    """"ok" | "bad" | "unknown". Yalnız POZİTİF okunan uyumsuzluk "bad"dir.
    `freeform_size`: serbest kipte görevin MANTIKSAL boyutu (en, boy). Verilirse kip doğru olsa da boyut tutmuyorsa "bad":
    HyperOS'ta kabuktan serbest kipe alınan görev AOSP'nin küçük varsayılan kutusunu alır (~%48 genişlik → ~183 dp) ve
    uygulama telefonun düzeniyle çizilmez."""
    if state is None or not state.found or state.windowing_mode is None:
        return "unknown"
    want = TARGET_MODES[target]
    if state.windowing_mode != want:
        return "bad"
    if target == "fullscreen" and state.bounds and display_size and not _covers_display(state.bounds, display_size):
        return "bad"  # kip doğru ama görev ekranı doldurmuyor (kalıntı bounds / letterbox)
    if target == "freeform" and freeform_size and state.bounds:
        bw, bh = state.bounds[2] - state.bounds[0], state.bounds[3] - state.bounds[1]
        if (
            abs(bw - freeform_size[0]) > freeform_size[0] * _FREEFORM_SIZE_TOLERANCE
            or abs(bh - freeform_size[1]) > freeform_size[1] * _FREEFORM_SIZE_TOLERANCE
        ):
            return "bad"
    return "ok"


# Yalnız HyperOS'un KENDİ serbest penceresi için (settle_task_windowing `native_freeform`; diğer üreticilerde bu sayılar
# varsayılmaz). Cihazda ölçüldü, POCO 2412DPC0AG / HyperOS Android 16: görevin mantıksal kutusu
# ekran genişliğinde ve onun 1,6 katı yüksekliktedir (1220×1952 → sw381dp: uygulama telefonun tam düzenini çizer); sistem
# onu 0,7 ölçekle, kutunun sol üst köşesinden küçülterek gösterir. Kabuktan (`am start --windowingMode 5`) gelen görev bu
# boyutu ALMAZ, AOSP'nin küçük varsayılan kutusunu (588×1220 → sw183dp) alır; 0,7 ölçek yine uygulandığından pencere hem
# küçük hem sıkışık (düşük dp) görünür.
HYPEROS_FREEFORM_SCALE = 0.7
HYPEROS_FREEFORM_ASPECT = 1.6
_FREEFORM_SIZE_TOLERANCE = 0.03
_FREEFORM_CONFIRM_S = 0.7  # kutu verildikten sonra sistemin geri yazıp yazmadığını görmek için bekleme


def freeform_size_for(display_size: tuple[int, int] | None) -> tuple[int, int] | None:
    """Telefonda serbest pencerenin mantıksal boyutu (HyperOS'un yerel serbest penceresiyle aynı): kısa kenar ekran kadar,
    uzun kenar onun 1,6 katı (ekranı aşmaz). Yatay ekranda yön çevrilir."""
    if not display_size:
        return None
    w, h = display_size
    if w <= h:
        return (w, min(round(w * HYPEROS_FREEFORM_ASPECT), h))
    return (min(round(h * HYPEROS_FREEFORM_ASPECT), w), h)


def freeform_box_for(display_size: tuple[int, int] | None) -> Rect | None:
    """Telefonda serbest pencerenin kutusu: `freeform_size_for` boyutunda; sistemin 0,7 ölçekle gösterdiği görünür pencere
    ekranda ortalanacak biçimde yerleşir."""
    size = freeform_size_for(display_size)
    if size is None or not display_size:
        return None
    w, h = size
    left = round((display_size[0] - w * HYPEROS_FREEFORM_SCALE) / 2)
    top = round((display_size[1] - h * HYPEROS_FREEFORM_SCALE) / 2)
    return (left, top, left + w, top + h)


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


async def _relayout(
    adb: Any, serial: str, package: str, display_id: str | int, mode: int, *, component: str | None = None,
) -> None:
    """Görevi hedef kipte yeniden yerleştirir (aktiviteyi hedef display'de öne alır)."""
    with contextlib.suppress(Exception):
        await android_shell.bring_to_front(
            adb, serial, package, display_id, windowing_mode=mode, reorder_only=True, component=component,
        )


async def _sf_summary(adb: Any, serial: str, task_id: str) -> str:
    """One log field group for a task's surface: its drawn box and scale, and — always, even when the box could not be measured
    (a Workspace task: "render=?") — the window chrome the system drew for it. `chrome` is what tells a freeform window that has
    HyperOS' caption/handle from one that has none (field report 2026-10-16: the same Play Store task had a header in one
    Workspace session and none in another, and the log could not say why because it printed nothing for such tasks).
    `decor`/`oem`: the chrome layers and the vendor marks found in the task's own layer block (only with a measured box)."""
    with contextlib.suppress(Exception):
        geom, chrome = await surfaceflinger_probe.probe_task_surface(adb, serial, task_id)
        chrome_field = " " + surfaceflinger_probe.format_task_chrome(chrome)
        if geom:
            decor = f" decor={list(geom.decor_layers) or 'yok'} oem={list(geom.oem_marks) or 'yok'}"
            return f"render={geom.render_bounds} scale=({geom.scale_x:.2f},{geom.scale_y:.2f}){decor}{chrome_field}"
        return f"render=? scale=?{chrome_field}"
    return "render=? scale=?"


_IDENTITY_SCALE_TOLERANCE = 0.02
_IDENTITY_OFFSET_TOLERANCE_PX = 2.0
_TRANSFORM_READS = 3
_TRANSFORM_READ_GAP_S = 0.45


def _is_identity(transform: tuple[float, float, float, float] | None) -> bool:
    if transform is None:
        return True
    sx, sy, tx, ty = transform
    return (
        abs(sx - 1.0) <= _IDENTITY_SCALE_TOLERANCE and abs(sy - 1.0) <= _IDENTITY_SCALE_TOLERANCE
        and abs(tx) <= _IDENTITY_OFFSET_TOLERANCE_PX and abs(ty) <= _IDENTITY_OFFSET_TOLERANCE_PX
    )


async def _render_transform_state(
    adb: Any, serial: str, package: str, sleep: Callable[[float], Awaitable[Any]],
) -> tuple[str, tuple[float, float, float, float] | None]:
    """("clean" | "stale" | "unknown", the transform). A window that is still ENTERING is scaled for a moment, so "stale" needs
    the same non-identity transform on every one of a few reads half a second apart; one identity read ends it as clean."""
    last: tuple[float, float, float, float] | None = None
    for read in range(_TRANSFORM_READS):
        dump = await surfaceflinger_probe.read_sf_dump(adb, serial)
        if dump is None:
            return "unknown", None
        transform = surfaceflinger_probe.activity_layer_transform(dump, package)
        if _is_identity(transform):
            return "clean", None
        last = transform
        if read + 1 < _TRANSFORM_READS:
            await sleep(_TRANSFORM_READ_GAP_S)
    return "stale", last


async def repair_stale_render_transform(
    adb: Any,
    serial: str,
    package: str,
    display_id: str | int,
    *,
    wlog: logging.Logger | None = None,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    cycles: int = 2,
) -> str:
    """A task moved out of a HyperOS freeform window into a fullscreen one keeps the freeform decorator's transform on the
    app's window layer: the right windowing mode and bounds in WindowManager, the app drawn at 70 % in a corner on the
    screen (and touchable only there). Measured on the phone: re-launching the task with `--windowingMode 5` and then `1`
    clears it (cmd activity task resize, a plain `am start` and a second WCT did not).
    Returns "clean" (nothing to do), "repaired", "stale" (still scaled after `cycles` tries) or "unknown" (dump unreadable).
    Never raises."""
    wlog = wlog or log
    try:
        state, transform = await _render_transform_state(adb, serial, package, sleep)
        if state != "stale":
            return state
        for cycle in range(1, max(1, cycles) + 1):
            wlog.info(
                "🩹 [TRANSFER] %s tam ekranda ama pencere katmanı eski serbest pencere dönüşümünü taşıyor (ölçek=%.2f kayma=(%.0f,%.0f)) "
                "— serbest → tam ekran döngüsüyle temizleniyor (deneme %d)", package, transform[0], transform[2], transform[3], cycle,
            )
            await _relayout(adb, serial, package, display_id, FREEFORM)
            await sleep(1.0)
            await _relayout(adb, serial, package, display_id, FULLSCREEN)
            await sleep(0.8)
            state, transform = await _render_transform_state(adb, serial, package, sleep)
            if state == "clean":
                return "repaired"
            if state == "unknown":
                return "unknown"
        return "stale"
    except Exception as exc:  # noqa: BLE001
        (wlog or log).warning("⚠️ [TRANSFER] %s pencere dönüşümü denetlenemedi: %s", package, exc)
        return "unknown"


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
    native_freeform: bool | None = None,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
) -> WindowingReport:
    """Görevi TAŞIDIKTAN SONRA hedef kipe oturtur ve doğrular (en çok `attempts` deneme). 2. denemeden itibaren
    aktivite hedef display'de yeniden yerleştirilir. Durum okunamıyorsa tek deneme yapılır (yıkıcı adım yok).
    `skip_if_ok`: görev ZATEN hedefteyse (pozitif okundu) hiçbir komut gönderilmez — Workspace'e hiç girmemiş normal
    pencerelerin aktarımı gereksiz komut/gecikme almasın.
    `freeform_bounds`: serbest kipte görevin yeri (Android px; Workspace'e dönüşte pencerenin kutusu). Verilmezse
    HyperOS'un yerel serbest pencere boyutu (`freeform_box_for`: ekran genişliği × 1,6 katı, 0,7 ölçekle ortalı).
    `native_freeform`: bu cihazın serbest penceresi HyperOS'unki mi (None: cihazdan okunur). Değilse (AOSP, Samsung…) o boyut ve
    ölçek varsayılmaz: yalnız KİP uygulanır ve doğrulanır, kutuyu sistem seçer."""
    if target not in TARGET_MODES:
        raise ValueError(f"bilinmeyen hedef pencereleme kipi: {target!r}")
    wlog = wlog or log
    mode = TARGET_MODES[target]

    display_size = await read_display_size(adb, serial, display_id)
    before = await read_task_windowing(adb, serial, task_id)
    report_line(wlog, package, task_id, "before", before, f"target={target} display_size={display_size}")

    # Telefon tarafı varsayılan serbest penceresinde boyut da doğrulanır (kabuktan gelen küçük kutu "ok" sayılmaz);
    # çağıranın verdiği kutuda (Workspace) yalnız kip.
    own_box = target == "freeform" and freeform_bounds is None  # the phone's default freeform window: sized by the vendor's rules
    if own_box and native_freeform is None:
        native_freeform = await android_shell.is_miui_or_hyperos(adb, serial)
    own_box = own_box and bool(native_freeform)
    want_size = freeform_size_for(display_size) if own_box else None

    if skip_if_ok and verify_windowing(before, target, display_size, want_size) == "ok":
        report_line(wlog, package, task_id, "after", before, f"target={target} verdict=ok attempts=0 method=none (zaten hedefte)")
        return WindowingReport(
            task_id=str(task_id), target=target, verdict="ok", attempts=0, method="none", relayout=False,
            before=before, after=before,
        )

    box = (freeform_bounds or (freeform_box_for(display_size) if own_box else None)) if target == "freeform" else None
    method, relayout, verdict, after = "none", False, "unknown", before
    used = 0
    for attempt in range(1, max(1, attempts) + 1):
        used = attempt
        if want_size is not None:
            # Telefondaki varsayılan serbest pencere: kutu `cmd activity task resize` (ATMS.resizeTask) ile verilir, WCT ile
            # DEĞİL. HyperOS kendi serbest pencere kaydını yalnız bu yolla günceller (cihazda ölçüldü): WCT ile verilen kutuyu
            # sistem, görev öne alınınca / Chrome'un CDP adımında eski küçük kutuya geri çekiyor ve içerik eski boyutta kalıyor;
            # kabuk ile verilen kutu kalıyor. Kip zaten hedefteyse WCT'ye de gerek yok.
            current = after if after is not None and after.found else before
            if current is not None and current.found and current.windowing_mode == mode:
                method, placed = "shell", False
            else:
                method, _ = await _apply_mode(task_id, mode, daemon, None)
                placed = False
        else:
            method, placed = await _apply_mode(task_id, mode, daemon, box)
        if box is not None and not placed:
            with contextlib.suppress(Exception):
                await adb.shell(
                    f"cmd activity task resize {task_id} {box[0]} {box[1]} {box[2]} {box[3]}", serial=serial, timeout_s=2.0,
                )
        # Serbest kipte kip tutuyor, yalnız boyut tutmuyorsa (HyperOS giriş animasyonu kutuyu geri yazdı) yeniden yerleşim YAPILMAZ:
        # `am start` animasyonu baştan başlatıp aynı ezmeyi tekrarlar; kutuyu yeniden vermek yeter.
        if attempt >= 2 and not (want_size is not None and after.found and after.windowing_mode == mode):
            relayout = True
            await _relayout(adb, serial, package, display_id, mode)
        await sleep(settle_s)
        after = await read_task_windowing(adb, serial, task_id)
        verdict = verify_windowing(after, target, display_size, want_size)
        if verdict == "ok" and want_size is not None:
            # Sistem kutuyu birkaç yüz ms sonra geri yazabiliyor: ilk okuma değil, durulmuş okuma geçerlidir.
            await sleep(_FREEFORM_CONFIRM_S)
            after = await read_task_windowing(adb, serial, task_id)
            verdict = verify_windowing(after, target, display_size, want_size)
        if verdict != "bad":
            break  # ok ya da okunamıyor — tekrarın anlamı yok

    # Mode and bounds are right in WindowManager; the compositor may still draw the app small (see the function): fullscreen on
    # the phone's own screen only, and only when the task was not already fullscreen there (nothing stale to inherit).
    render = ""
    if target == "fullscreen" and verdict != "bad" and str(display_id) == "0":
        render = " render_fix=" + await repair_stale_render_transform(adb, serial, package, display_id, wlog=wlog, sleep=sleep)
    sf = await _sf_summary(adb, serial, task_id)
    report_line(wlog, package, task_id, "after", after, f"target={target} verdict={verdict} attempts={used} method={method} relayout={relayout} {sf}{render}")
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
