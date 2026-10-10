"""Virtual-display density policy — ONE rule for opening and resizing a window.

The same "explicit > custom DPI > target-dp derived > fallback" chain lived in window_manager (open) and
session_reconfigure (resize) with different lower clamps (120 vs 90): a small window opened at 120 DPI could drop to
~90 on its next resize and re-layout visibly.
"""
from __future__ import annotations

from typing import Any

# target-dp derived density is clamped so tiny/huge windows still get a usable layout.
MIN_DERIVED_DPI = 120
MAX_DERIVED_DPI = 540

DEFAULT_PHONE_TARGET_DP = 360  # Standart Android telefon dikey en küçük genişlik (sw360dp)


def derive_phone_target_dp(phone_w: int | None, phone_density: int | None) -> int:
    """Computes the phone's native portrait Smallest Width in DP.
    e.g. 1080px @ 513 DPI -> 336 dp; 1080px @ 480 DPI -> 360 dp; 1080px @ 420 DPI -> 411 dp.
    Clamped to standard phone range [320, 480].
    """
    if phone_w and phone_density and phone_w > 0 and phone_density > 0:
        raw_dp = round(phone_w * 160 / phone_density)
        if 320 <= raw_dp <= 480:
            return raw_dp
    return DEFAULT_PHONE_TARGET_DP


def negotiate_dpi(
    width: int,
    height: int,
    requested: int | None,
    project: Any,
    fallback: int,
    *,
    phone_dp: int | None = None,
    auto_target_dp: bool = True,
) -> int:
    """Explicit request > user's custom DPI > target-dp derived density > fallback.

    Target DP Normalization:
    Derives DPI such that min(width, height) in DP matches the phone's natural portrait DP
    (project.target_dp if set > 0, or phone_dp if available, or DEFAULT_PHONE_TARGET_DP=360 when auto_target_dp is True).
    Ensures the window always renders in true phone layout without tablet/desktop layout distortion
    or SizeCompat shock when transferred between PC and phone.
    """
    if requested is not None and requested > 0:
        return requested
    if project and getattr(project, "custom_dpi", 0) > 0:
        return project.custom_dpi

    target_dp = getattr(project, "target_dp", 0) if project else 0
    if not target_dp or target_dp <= 0:
        if auto_target_dp and width > 0 and height > 0:
            target_dp = phone_dp if (phone_dp and 320 <= phone_dp <= 480) else DEFAULT_PHONE_TARGET_DP

    if target_dp and target_dp > 0 and width > 0 and height > 0:
        derived = round(min(width, height) * 160 / target_dp)
        return max(MIN_DERIVED_DPI, min(MAX_DERIVED_DPI, derived))
    return fallback

