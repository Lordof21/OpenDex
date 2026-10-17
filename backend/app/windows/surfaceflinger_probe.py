"""Omni-Adapter: SurfaceFlinger ve WindowManager tabanlı, OEM-bağımsız
gerçek görünür alan (render bounds), donanım ölçeği ve insets okuyucusu.

Neden bu modül var:
WindowManager'ın (dumpsys activity/window) MANTIKSAL bounds'u ile GPU'nun
(SurfaceFlinger) GERÇEKTEN ekrana bastığı piksel alanı (visibleRegion / displayFrame)
üreticilerin özel kompozisyon katmanları (örneğin Xiaomi HyperOS'un 0.70x leashing'i)
nedeniyle farklı olabilmektedir. Bu modül OEM markasını tahmin etmez;
doğrudan GPU kompozitörünün donanım matrisini ve pencerelerini okur.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from ..device import daemon_registry

log = logging.getLogger(__name__)

# Decor / chrome katmanı ipucu kelimeleri (küçük harf)
_DECOR_NAME_HINTS = ("caption", "shadow", "divider", "handle", "resize", "outline", "leash")

# Evrensel Kutu Regex'i:
# Virgüllü, boşluklu, tireli, süslü ({}), köşeli ([]) veya normal parantezli 4'lü koordinatları yakalar.
_UNIVERSAL_BOX_RE = re.compile(
    r"[\{\[\(]\s*(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s\-]+(-?[\d.]+)[,\s]+(-?[\d.]+)\s*[\}\]\)]"
)

# toDisplayTransform={ scale x=0.7000 y=0.7000 tx=80.0000 ty=80.0000 }
_TRANSFORM_SCALE_RE = re.compile(
    r"toDisplayTransform=\{\s*scale\s+x=([\d.]+)\s+y=([\d.]+)\s+tx=([\d.-]+)\s+ty=([\d.-]+)"
)

# sourceCrop=[0.000000 0.000000 1665.000000 864.000000]
_SOURCE_CROP_RE = re.compile(r"sourceCrop=\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]")

# displayFrame=[80 80 1246 685]
_DISPLAY_FRAME_RE = re.compile(r"displayFrame=\[\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*\]")

# `drawMiuiShadows`, `MiuiFreeform…`: the vendor's own freeform layer left a mark in the task's layers.
_OEM_MARK_RE = re.compile(r"\b(\w*[Mm]iui\w*)\b")
_MAX_REPORTED_NAMES = 4

Rect = tuple[int, int, int, int]


@dataclass
class TaskGeometry:
    render_bounds: Rect           # [80, 80, 1246, 685] - Ekrana fiilen basılan fiziksel piksel kutusu
    logical_bounds: Rect          # [80, 80, 1745, 944] - Android WindowManager mantıksal kutusu
    scale_x: float = 1.0          # 0.7000
    scale_y: float = 1.0          # 0.7000
    # The scale was READ from the task's toDisplayTransform. False: no transform line was found and 1.0 is only the default —
    # not evidence that the system draws this task unscaled (never remembered as the device's scale).
    scale_measured: bool = True
    # Window chrome the system itself drew for this task (caption / handle / resize / shadow layers) and the OEM's own marks
    # in its layers (e.g. HyperOS `drawMiuiShadows`): what a phone-side freeform window gets — or does not get — to be moved
    # and resized with. Report-only (see task_windowing._sf_summary); nothing decides on it.
    decor_layers: tuple[str, ...] = ()
    oem_marks: tuple[str, ...] = ()


async def read_sf_dump(adb, serial: str) -> str | None:
    """`dumpsys SurfaceFlinger` metni; döküm daemon içinden okunur (`dumpsys` süreci açılmaz), daemon yoksa kabuk komutu.
    None: okunamadı."""
    daemon = daemon_registry.live("dump")
    sf_dump = await daemon.dump("SurfaceFlinger") if daemon is not None else None
    if sf_dump is None:
        try:
            sf_dump = await adb.shell("dumpsys SurfaceFlinger", serial=serial, timeout_s=2.5)
        except Exception as exc:
            log.warning("[Omni-Adapter] dumpsys SurfaceFlinger başarısız: %s", exc)
            return None
    return sf_dump


async def probe_omni_geometry(adb, serial: str, task_id: str) -> TaskGeometry | None:
    """SurfaceFlinger ve WindowManager'ı sorgulayarak task'ın OEM-bağımsız tam geometri profilini üretir."""
    sf_dump = await read_sf_dump(adb, serial)
    return None if sf_dump is None else parse_task_geometry(sf_dump, task_id)


def parse_task_geometry(sf_dump: str, task_id: str) -> TaskGeometry | None:
    scale_x, scale_y = 1.0, 1.0
    scale_measured = False
    tx, ty = 0.0, 0.0
    render_bounds: Rect | None = None
    logical_w, logical_h = 0, 0

    lines = sf_dump.splitlines()
    in_task_block = False
    is_decor = False

    task_pattern = re.compile(rf"\bTask[ =#]+{task_id}\b", re.IGNORECASE)
    decor_layers: list[str] = []
    oem_marks: list[str] = []

    for i, line in enumerate(lines):
        # ASCII ağaç gösterimi satırlarını (│, ├─, └─) doğrudan atla;
        # bunlar katman detayı değil, hiyerarşi özetidir ve yanlış eşleşmeye yol açabilir.
        if any(c in line for c in ("│", "├─", "└─")):
            continue

        # Yeni bir katman başlığı geldiğinde kontrol et
        if line.startswith("  Layer [") or line.startswith("  - Output Layer"):
            if task_pattern.search(line):
                in_task_block = True
            else:
                m_other = re.search(r"\bTask[ =#]+(\d+)\b", line, re.IGNORECASE)
                if m_other and m_other.group(1) != str(task_id):
                    in_task_block = False

            is_decor = any(h in line.lower() for h in _DECOR_NAME_HINTS)
            if in_task_block and is_decor and line.startswith("  Layer [") and len(decor_layers) < _MAX_REPORTED_NAMES:
                decor_layers.append(line.strip()[:60])

        # Global bölüm başlıklarında (Displays, SurfaceFlinger global state vb.) bloktan çık
        elif not line.startswith(" ") and line.strip():
            in_task_block = False

        if in_task_block:
            for mark in _OEM_MARK_RE.findall(line):
                if mark not in oem_marks and len(oem_marks) < _MAX_REPORTED_NAMES:
                    oem_marks.append(mark)
            # 1. toDisplayTransform matrisini oku
            if tr := _TRANSFORM_SCALE_RE.search(line):
                scale_x = float(tr.group(1))
                scale_y = float(tr.group(2))
                scale_measured = True
                tx = float(tr.group(3))
                ty = float(tr.group(4))

            # 2. sourceCrop (Mantıksal çizim boyutu)
            if sc := _SOURCE_CROP_RE.search(line):
                cw = int(float(sc.group(3)) - float(sc.group(1)))
                ch = int(float(sc.group(4)) - float(sc.group(2)))
                if cw > 50 and ch > 50:
                    logical_w, logical_h = cw, ch

            # 3. geomCrop (AOSP / HyperOS layer crop boyutu)
            if "geomCrop" in line:
                m_gc = re.search(r"geomCrop=\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]", line)
                if m_gc:
                    gw = int(float(m_gc.group(3)) - float(m_gc.group(1)))
                    gh = int(float(m_gc.group(4)) - float(m_gc.group(2)))
                    if gw > 50 and gh > 50:
                        logical_w, logical_h = gw, gh

            # Decor katmanlarının kutularını değil, sadece içerik katmanını hedefle
            if not is_decor:
                # 4. visibleRegion
                if not render_bounds and "visibleRegion" in line and i + 1 < len(lines):
                    if rb := _UNIVERSAL_BOX_RE.search(lines[i + 1]):
                        rl, rt, rr, rb_val = int(float(rb.group(1))), int(float(rb.group(2))), int(float(rb.group(3))), int(float(rb.group(4)))
                        if (rr - rl) > 100 and (rb_val - rt) > 100 and rl >= 0 and rt >= 0:
                            render_bounds = (rl, rt, rr, rb_val)

                # 5. displayFrame (visibleRegion yoksa)
                if not render_bounds:
                    if df := _DISPLAY_FRAME_RE.search(line):
                        dl, dt, dr, db = int(df.group(1)), int(df.group(2)), int(df.group(3)), int(df.group(4))
                        if (dr - dl) > 100 and (db - dt) > 100 and dl >= 0 and dt >= 0:
                            render_bounds = (dl, dt, dr, db)

    # 6. Transform matrisi ve logical boyut ile matematiksel doğrulama fallback'i
    if not render_bounds and logical_w > 0 and logical_h > 0 and (scale_x > 0 and scale_y > 0) and tx >= 0 and ty >= 0:
        render_bounds = (
            round(tx),
            round(ty),
            round(tx + logical_w * scale_x),
            round(ty + logical_h * scale_y),
        )

    if not render_bounds:
        log.debug("[Omni-Adapter] task=%s için SurfaceFlinger render_bounds bulunamadı", task_id)
        return None
    rl, rt, rr, rb = render_bounds
    logical_bounds = (
        rl, rt,
        rl + (logical_w if logical_w > 0 else round((rr - rl) / scale_x)),
        rt + (logical_h if logical_h > 0 else round((rb - rt) / scale_y)),
    )

    return TaskGeometry(
        render_bounds=render_bounds,
        logical_bounds=logical_bounds,
        scale_x=scale_x,
        scale_y=scale_y,
        scale_measured=scale_measured,
        decor_layers=tuple(decor_layers),
        oem_marks=tuple(oem_marks),
    )


@dataclass(frozen=True)
class ChromeLayer:
    """One window-chrome layer the system drew for a task (a HyperOS freeform window's `Miui Caption` handle, its bottom
    resize handle, shadows…) as SurfaceFlinger reports it."""

    name: str                       # "Miui Caption of Task=309"
    visible: bool                   # SurfaceFlinger prints a `visible reason=` line only for a layer that is on screen
    alpha: float | None = None
    size: tuple[int, int] | None = None   # its buffer, px


_LAYER_HEADER_RE = re.compile(r"^  Layer \[(\d+)\] (.+?)(?:#\d+)?\s*$")
_ALPHA_RE = re.compile(r"\balpha=([\d.]+)")
_BUFFER_SIZE_RE = re.compile(r"geomBufferSize=\[\s*\d+\s+\d+\s+(\d+)\s+(\d+)\s*\]")


def parse_task_chrome(sf_dump: str, task_id: str) -> tuple[ChromeLayer, ...]:
    """The window-chrome layers of `task_id` in a SurfaceFlinger dump — independent of whether the task's content layer could
    be measured (probe_omni_geometry gives up without a render box; a Workspace task's chrome is still worth reporting: whether
    HyperOS drew its caption for the task is exactly what differs between a window that has a header and one that has none).
    A layer is listed once (the dump repeats every layer further down, in its input list)."""
    task_pattern = re.compile(rf"\bTask[ =#]+{re.escape(str(task_id))}\b", re.IGNORECASE)
    lines = sf_dump.splitlines()
    seen: set[str] = set()
    found: list[ChromeLayer] = []
    for i, line in enumerate(lines):
        header = _LAYER_HEADER_RE.match(line)
        if header is None or header.group(1) in seen:
            continue
        name = header.group(2)
        lowered = name.lower()
        if not task_pattern.search(name) or not any(h in lowered for h in _DECOR_NAME_HINTS):
            continue
        seen.add(header.group(1))
        visible, alpha, size = False, None, None
        for follow in lines[i + 1:]:
            if follow.startswith("  Layer [") or follow.startswith("  - Output Layer") or (follow.strip() and not follow.startswith(" ")):
                break
            visible = visible or "visible reason=" in follow
            if alpha is None and (m := _ALPHA_RE.search(follow)):
                alpha = float(m.group(1))
            if size is None and (m := _BUFFER_SIZE_RE.search(follow)):
                size = (int(m.group(1)), int(m.group(2)))
        found.append(ChromeLayer(name=name, visible=visible, alpha=alpha, size=size))
        if len(found) >= _MAX_REPORTED_NAMES * 2:
            break
    return tuple(found)


def format_task_chrome(layers: tuple[ChromeLayer, ...]) -> str:
    """One log field: `chrome=yok` or `chrome=[Miui Caption of Task=309 60x12 görünür α1.00; …]`."""
    if not layers:
        return "chrome=yok"
    parts = []
    for layer in layers:
        size = f" {layer.size[0]}x{layer.size[1]}" if layer.size else ""
        alpha = f" α{layer.alpha:.2f}" if layer.alpha is not None else ""
        parts.append(f"{layer.name}{size} {'görünür' if layer.visible else 'gizli'}{alpha}")
    return "chrome=[" + "; ".join(parts) + "]"


async def probe_task_surface(adb, serial: str, task_id: str) -> tuple[TaskGeometry | None, tuple[ChromeLayer, ...]]:
    """Geometry and window chrome of a task from ONE SurfaceFlinger dump: (None, ()) when the dump cannot be read."""
    sf_dump = await read_sf_dump(adb, serial)
    if sf_dump is None:
        return None, ()
    return parse_task_geometry(sf_dump, task_id), parse_task_chrome(sf_dump, task_id)


Transform = tuple[float, float, float, float]  # (scale_x, scale_y, tx, ty)


def activity_layer_transform(sf_dump: str, package: str) -> Transform | None:
    """The transform the compositor applies to the app's WINDOW layer (``<package>/<activity>#id``), or None when it is the
    identity (SurfaceFlinger prints ``toDisplayTransform`` only for a layer that is scaled or moved).

    The task's own layer is not the one that matters here: HyperOS' freeform window decorator scales the app's window layer
    (0.7, offset to the freeform box). Moved out of a freeform window into a fullscreen one, the task's windowing mode and
    bounds are right in WindowManager — the app is drawn at 70 % in a corner all the same, and its touch region is that
    corner. The first detail block of the layer decides (the dump lists a layer again further down, in its input list)."""
    prefix = f"{package}/"
    lines = sf_dump.splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("  Layer [") or prefix not in line or "InputSink" in line:
            continue
        block: list[str] = []
        for follow in lines[i + 1:]:
            if follow.startswith("  Layer [") or follow.startswith("  - Output Layer"):
                break
            block.append(follow)
        text = "\n".join(block)
        if "bounds=" not in text:
            continue  # not a detail block (a bare list entry)
        if tr := _TRANSFORM_SCALE_RE.search(text):
            return (float(tr.group(1)), float(tr.group(2)), float(tr.group(3)), float(tr.group(4)))
        return None
    return None


async def read_sf_dump(adb, serial: str) -> str | None:
    """SurfaceFlinger's dump through the daemon (no `dumpsys` process), the shell as the fallback; None when unreadable."""
    daemon = daemon_registry.live("dump")
    dump = await daemon.dump("SurfaceFlinger") if daemon is not None else None
    if dump is None:
        try:
            dump = await adb.shell("dumpsys SurfaceFlinger", serial=serial, timeout_s=2.5)
        except Exception as exc:  # noqa: BLE001
            log.debug("[Omni-Adapter] SurfaceFlinger dökümü okunamadı: %s", exc)
            return None
    return dump or None
