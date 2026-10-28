"""The absolute ceiling on the pixels of any display OpenDex creates or resizes on the phone (a window's virtual display, the
Workspace, a pre-landing to the phone's size) — enforced where the size leaves for the phone (scrcpy_launcher: the server's
`new_display=` and every resize message) and where a window takes a size (session_reconfigure), so no path gets past it.

Most phones cannot encode 4K: the normal ceiling is a 2.5K screen's pixel count (2560×1600). The phone's OWN screen may be
bigger (a 1440×3200 panel: 4.6 M px) — a display of the phone's size (the handoff lands the app on exactly that) is always
allowed. Nothing ever passes 4K (3840×2160). Counted in pixels, not sides: a 1220×2712 phone screen is 2712 long, yet fewer
pixels than 2.5K. Hard-coded on purpose (user decision 2026-10-28); change the constants here, nowhere else.
"""
from __future__ import annotations

import logging
import math

log = logging.getLogger(__name__)

PIXELS_2_5K = 2560 * 1600   # 4 096 000 — the normal ceiling
PIXELS_4K = 3840 * 2160     # 8 294 400 — never passed, whatever the phone's own screen
SIZE_ALIGN = 8              # what scrcpy aligns a display size to

_phone_pixels = 0


def note_phone_screen(width: int | None, height: int | None) -> None:
    """The bound phone's own panel (capability_probe.apply_phone_display): a display of its size is always allowed."""
    global _phone_pixels
    _phone_pixels = int(width or 0) * int(height or 0)


def max_display_pixels() -> int:
    return min(PIXELS_4K, max(PIXELS_2_5K, _phone_pixels))


def cap_display_size(width: int, height: int) -> tuple[int, int]:
    """(width, height) scaled down — aspect kept, aligned to SIZE_ALIGN — until it has no more pixels than allowed; a size
    within the ceiling is returned untouched (0 = "keep the size" passes too)."""
    width, height = int(width), int(height)
    limit = max_display_pixels()
    if width <= 0 or height <= 0 or width * height <= limit:
        return width, height
    factor = math.sqrt(limit / (width * height))
    capped_w = max(SIZE_ALIGN, int(width * factor) // SIZE_ALIGN * SIZE_ALIGN)
    capped_h = max(SIZE_ALIGN, int(height * factor) // SIZE_ALIGN * SIZE_ALIGN)
    log.warning("[DisplayLimit] %dx%d (%.1f M px) sınırı aşıyor → %dx%d (sınır %.1f M px)",
                width, height, width * height / 1e6, capped_w, capped_h, limit / 1e6)
    return capped_w, capped_h


def cap_display_spec(spec: str) -> str:
    """The same for scrcpy's ``new_display=WxH`` value (anything else is returned as it is)."""
    w, sep, h = spec.partition("x")
    if not sep or not w.isdigit() or not h.isdigit():
        return spec
    capped_w, capped_h = cap_display_size(int(w), int(h))
    return f"{capped_w}x{capped_h}"
