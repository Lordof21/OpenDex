"""Shared identity check for the phone-mirror pseudo-app.

Its package identifier has had two aliases historically, plus one legacy
internal-only name (``phone_screen``, never sent by the frontend). Every
place needing to special-case "this window IS the phone screen, not a real
Android app" had reimplemented this check independently and drifted (exact
membership vs. ``.startswith``).
"""
from __future__ import annotations

_MIRROR_PACKAGE_PREFIXES = ("com.opendex.screen_mirror", "com.opendex.phone", "phone_screen", "com.android.internal.mirror")

# Home-screen apps: one showing on the phone's display is "the user went home", never "this app moved to the phone".
_LAUNCHER_PACKAGE_PREFIXES = (
    "com.miui.home",                          # Xiaomi / HyperOS
    "com.google.android.apps.nexuslauncher",  # Pixel
    "com.sec.android.app.launcher",           # Samsung One UI
    "net.oneplus.launcher",                   # OnePlus
    "com.oppo.launcher",                      # OPPO / realme
    "com.huawei.android.launcher",            # Huawei
    "com.android.launcher",                   # AOSP Launcher3
)


def is_mirror_package(package: str) -> bool:
    return package.startswith(_MIRROR_PACKAGE_PREFIXES)


def is_internal_package(package: str) -> bool:
    """OpenDeX's own pseudo-windows (phone mirror, Workspace anchor): no real Android app task behind them — never send
    them app keys, START_APP, or treat them as a handoff candidate."""
    return package.startswith("com.opendex") or is_mirror_package(package)


def is_launcher_package(package: str) -> bool:
    return package.startswith(_LAUNCHER_PACKAGE_PREFIXES)
