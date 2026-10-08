"""Budget-based fps allocation for visible windows.

IMPORTANT — "Açık Teknik Risk": the live cost of changing a running encoder's fps
has NOT been measured yet. Until that MVP measurement lands, allocation is
single-tier (full fps or frozen); the intermediate tiers (30/15/5) exist behind
``ENABLE_FPS_TIERS`` and stay off by default. Do not flip the flag without the
measurement.
"""
from __future__ import annotations

from typing import Iterator

from ..config import Settings
from ..schemas import DeviceProfile, WindowState

FPS_TIERS = (60, 30, 15, 5)
FROZEN = 0


def _priority_order(windows: list[WindowState]) -> list[WindowState]:
    """Focused window first, the rest by MRU (callers keep ``z_index`` as the MRU
    proxy: focusing bumps it, so higher z == more recently used)."""
    return sorted(windows, key=lambda w: (not w.focused, -w.z_index))


def is_fully_occluded(window: WindowState, others: list[WindowState]) -> bool:
    """A window is occluded if a higher Z-index window is maximized or fully covers it."""
    if window.minimized:
        return False
    for other in others:
        if other.window_id == window.window_id or other.minimized:
            continue
        if other.z_index <= window.z_index:
            continue
        if other.display_mode == "maximized":
            return True
        if (
            other.x <= window.x
            and other.y <= window.y
            and other.x + other.width >= window.x + window.width
            and other.y + other.height >= window.y + window.height
        ):
            return True
    return False


def get_effective_encoder_limit(device_profile: DeviceProfile, custom_encoder_limit: int = 0) -> int:
    """Calculates the effective encoder session limit considering probed limits and user overrides."""
    effective_limit = device_profile.encoder_limit
    if custom_encoder_limit and custom_encoder_limit > 0:
        effective_limit = min(device_profile.encoder_limit, custom_encoder_limit)
    return effective_limit


def allocate_fps(
    windows: list[WindowState],
    device_profile: DeviceProfile,
    settings: Settings,
    custom_encoder_limit: int = 0,
) -> dict[str, int]:
    """Returns ``{window_id: fps}``; ``0`` means freeze (encoder session released).

    Session budget = ``device_profile.encoder_limit`` (probed, not assumed).
    Minimized windows or budget-exhausted
    windows release encoder sessions.
    """
    allocation: dict[str, int] = {}

    occlusion_freeze_enabled = settings.ENABLE_OCCLUSION_FREEZE

    visible_candidates: list[WindowState] = []
    minimized_candidates: list[WindowState] = []

    for win in windows:
        if occlusion_freeze_enabled and is_fully_occluded(win, windows):
            allocation[win.window_id] = FROZEN
        elif win.minimized:
            minimized_candidates.append(win)
        else:
            visible_candidates.append(win)

    effective_limit = get_effective_encoder_limit(device_profile, custom_encoder_limit)

    sessions_left = effective_limit
    for win in _priority_order(visible_candidates):
        if sessions_left <= 0:
            allocation[win.window_id] = FROZEN
            continue
        if settings.ENABLE_FPS_TIERS:
            # Post-measurement path: give the best tier the remaining budget allows.
            tier_index = min(len(FPS_TIERS) - 1, effective_limit - sessions_left)
            allocation[win.window_id] = FPS_TIERS[tier_index]
        else:
            allocation[win.window_id] = min(FPS_TIERS[0], settings.DEFAULT_MAX_FPS)
        sessions_left -= 1

    # If we have spare encoder sessions, keep minimized windows running so their
    # virtual displays stay alive on Android and don't dump the app to Display 0.
    for win in _priority_order(minimized_candidates):
        if sessions_left <= 0:
            allocation[win.window_id] = FROZEN
        else:
            allocation[win.window_id] = min(FPS_TIERS[0], settings.DEFAULT_MAX_FPS)
            sessions_left -= 1

    return allocation


def smooth_fps_transition(old_fps: int, new_fps: int, steps: int = 4) -> Iterator[int]:
    """Softens a 60→5 jump over intermediate values (secondary priority,
    unused until fps tiers are enabled)."""
    if old_fps == new_fps or steps < 2:
        yield new_fps
        return
    delta = (new_fps - old_fps) / steps
    for i in range(1, steps + 1):
        yield round(old_fps + delta * i)
