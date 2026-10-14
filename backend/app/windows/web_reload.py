"""The user's explicit "reload the page" for a window whose app is a Chromium-based browser (Hub → "Sayfayı yenile").

Why a button and not a reflex: after a resize a web page can come out wrong (text laid out for the old width, a stale zoom).
Reloading it by itself after every resize would reload a page the user is reading — lost form input, restarted media and one
more full render on the phone's CPU per resize. So the cheap, safe thing is offered when it is needed and costs nothing when
it is not: a NORMAL reload of the foreground tab through the DevTools socket (cdp_refresher.soft_reload_active_tab) — the app,
its other tabs and the process are untouched.

Package-agnostic: whether a window has a page to reload is asked of the phone (a DevTools socket that really belongs to the
window's package, web_inspector.inspect_app_runtime), never answered from a list of browser names. Never raises.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .cdp_refresher import soft_reload_active_tab
from .mirror_packages import is_internal_package
from .web_inspector import inspect_app_runtime

if TYPE_CHECKING:
    from ..device.adb import Adb

log = logging.getLogger(__name__)

RELOADED = "reloaded"                  # the foreground tab was reloaded
NOT_WEB = "not_web"                    # the app exposes no Chromium DevTools socket: nothing to reload
NO_PAGE = "no_page"                    # a browser, but no http(s) tab answered (only a new-tab page, or a frozen renderer)
NOT_RELOADABLE = "not_reloadable"      # OpenDeX's own pseudo-window (phone mirror, Workspace anchor)
NO_DEVICE = "no_device"                # no phone bound


@dataclass(frozen=True)
class WebReloadOutcome:
    action: str
    package: str
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.action == RELOADED


async def _devtools_socket(adb: "Adb", serial: str | None, package: str) -> str | None:
    profile = await inspect_app_runtime(adb, serial, package)
    return profile.cdp_socket if profile.is_browser_cdp else None


async def can_reload(adb: "Adb", serial: str | None, package: str) -> bool:
    """Does this window's app have a web page the user could reload? (Cheap enough to ask when a menu opens.)"""
    if not serial or not package or is_internal_package(package):
        return False
    try:
        return await _devtools_socket(adb, serial, package) is not None
    except Exception as exc:  # noqa: BLE001
        log.debug("[WEB_RELOAD] yetenek okunamadı (%s): %s", package, exc)
        return False


async def reload_page(adb: "Adb", serial: str | None, package: str) -> WebReloadOutcome:
    """Reloads the foreground tab of ``package`` (see module docstring)."""
    if is_internal_package(package):
        return WebReloadOutcome(NOT_RELOADABLE, package)
    if not serial:
        return WebReloadOutcome(NO_DEVICE, package)
    try:
        socket_name = await _devtools_socket(adb, serial, package)
    except Exception as exc:  # noqa: BLE001
        log.debug("[WEB_RELOAD] soket çözümlenemedi (%s): %s", package, exc)
        socket_name = None
    if socket_name is None:
        return WebReloadOutcome(NOT_WEB, package)
    reloaded = await soft_reload_active_tab(adb, serial, socket_name)
    if reloaded is None:
        return WebReloadOutcome(NO_PAGE, package)
    return WebReloadOutcome(RELOADED, package, detail=reloaded.get("url", ""))
