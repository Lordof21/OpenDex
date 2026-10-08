"""Virtual-display density policy — ONE rule for opening and resizing a window.

The same "explicit > custom DPI > target-dp derived > fallback" chain lived in window_manager (open) and
session_reconfigure (resize) with different lower clamps (120 vs 90): a small window opened at 120 DPI could drop to
~90 on its next resize and re-layout visibly.
"""
from __future__ import annotations

from typing import Any

# target-dp derived density is clamped so tiny/huge windows still get a usable layout.
MIN_DERIVED_DPI = 120
MAX_DERIVED_DPI = 480


def negotiate_dpi(width: int, height: int, requested: int | None, project: Any, fallback: int) -> int:
    """Explicit request > user's custom DPI > density that makes the short side `target_dp` dp wide > `fallback`."""
    if requested is not None and requested > 0:
        return requested
    if project.custom_dpi and project.custom_dpi > 0:
        return project.custom_dpi
    if project.target_dp and project.target_dp > 0:
        derived = round(min(width, height) * 160 / project.target_dp)
        return max(MIN_DERIVED_DPI, min(MAX_DERIVED_DPI, derived))
    return fallback
