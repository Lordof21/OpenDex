"""Runtime Web Engine & UI Architecture Inspector (Zero-Hardcode).

Instead of maintaining a static allowlist of package names, this module inspects
the running application's live OS artifacts on the Android device via Linux abstract
domain sockets (/proc/net/unix) for live Chrome DevTools Protocol endpoints
(Chrome, Chromium, Brave, Edge, Opera, Samsung Internet, etc.) and dynamically
verifies socket ownership via `/json/version`.

Zero hardcoded packages. 100% resilient across any browser or hybrid app.
"""
from __future__ import annotations

import asyncio
import json
import logging
import urllib.request
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .cdp_refresher import open_cdp_session

if TYPE_CHECKING:
    from ..device.adb import Adb

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class AppRuntimeProfile:
    package: str
    is_browser_cdp: bool
    cdp_socket: str | None
    webview_count: int = 0

    @property
    def has_web_engine(self) -> bool:
        return self.is_browser_cdp or self.webview_count > 0

    @property
    def is_pure_native(self) -> bool:
        return not self.has_web_engine


async def inspect_app_runtime(
    adb: "Adb",
    serial: str | None,
    package: str,
    *,
    timeout_s: float = 2.0,
) -> AppRuntimeProfile:
    """Inspects a package's live runtime architecture on the Android device.

    Enforces strict process & session isolation:
    - Never attributes foreign CDP sockets (e.g. background Chrome) to native apps or other browsers.
    - Dynamically verifies socket ownership via ephemeral CDP inspection.
    - Zero hardcoded package requirements.
    - Never raises; returns a default pure-native profile on any communication failure.
    """
    if not serial or not package:
        return AppRuntimeProfile(package=package, is_browser_cdp=False, cdp_socket=None)

    cdp_socket: str | None = None
    is_browser_cdp = False

    # Check /proc/net/unix for live CDP abstract sockets (< 5ms)
    try:
        raw_unix = await adb.shell("cat /proc/net/unix 2>/dev/null", serial=serial, timeout_s=timeout_s)
        if isinstance(raw_unix, str) and "devtools_remote" in raw_unix:
            clean_pkg = package.strip().lower()
            for candidate_socket, inode in _candidate_cdp_sockets(raw_unix, package):
                # Fast-path: Sockets explicitly namespaced with the package name are guaranteed
                if clean_pkg in candidate_socket.lower():
                    cdp_socket, is_browser_cdp = candidate_socket, True
                    break
                # Dynamic verification: the socket's own /json/version says whose it is (Android-Package) — Chrome's is
                # `chrome_devtools_remote`, Samsung Internet's `Terrace_devtools_remote`, Brave's carries its package name.
                owner = await _socket_owner(adb, serial, candidate_socket, inode, timeout_s=0.5)
                if owner == clean_pkg or (
                    owner is None and candidate_socket == "chrome_devtools_remote" and clean_pkg in _KNOWN_CHROMIUM_FALLBACK_PACKAGES
                ):
                    cdp_socket, is_browser_cdp = candidate_socket, True
                    break
                log.debug(
                    "[WEB_INSPECTOR] Soket %s, hedef %s tarafından SAHİPLENİLMİYOR (sahibi: %s). Yabancı soket izole edildi.",
                    candidate_socket, package, owner,
                )
    except Exception as exc:
        log.debug("[WEB_INSPECTOR] /proc/net/unix okunamadı (%s): %s", package, exc)

    profile = AppRuntimeProfile(
        package=package,
        is_browser_cdp=is_browser_cdp,
        cdp_socket=cdp_socket,
    )

    log.debug(
        "[WEB_INSPECTOR] %s profili: cdp=%s (socket=%s), pure_native=%s",
        package, profile.is_browser_cdp, profile.cdp_socket, profile.is_pure_native,
    )
    return profile


_NOT_A_BROWSER_SOCKET = ("webview_devtools_remote", "stetho_")   # a WebView's per-process socket / stetho: an app's, not a browser's
_MAX_SOCKET_CANDIDATES = 6
# (serial, socket, inode) -> the package its /json/version reported (None: it did not answer). The inode changes when the browser
# restarts, so a stale answer is never reused for a new process.
_owner_cache: dict[tuple[str, str, str], str | None] = {}


def _candidate_cdp_sockets(unix_table: str, package: str) -> list[tuple[str, str]]:
    """The (socket name, inode) pairs of /proc/net/unix that may be ``package``'s DevTools socket: its own (package name in the socket
    name) first, then every other browser-style DevTools socket — whatever its name (Chrome's ``chrome_devtools_remote``, Samsung Internet's
    ``Terrace_devtools_remote``, ...): the one that is really the package's is found by asking it (``_socket_owner``), never by a list of names."""
    pkg_clean = package.strip().lower()
    own: list[tuple[str, str]] = []
    others: list[tuple[str, str]] = []
    for line in unix_table.splitlines():
        parts = line.strip().split()
        if not parts or not parts[-1].startswith("@") or not parts[-1].lower().endswith("devtools_remote"):
            continue
        name = parts[-1][1:]
        inode = parts[6] if len(parts) >= 8 else ""
        if pkg_clean and f"{pkg_clean}_devtools_remote" in name.lower():
            own.append((name, inode))
        elif not name.lower().startswith(_NOT_A_BROWSER_SOCKET):
            others.append((name, inode))
    # Chrome's socket is the most common answer: asked first among the others
    others.sort(key=lambda item: item[0] != "chrome_devtools_remote")
    seen: set[str] = set()
    result = []
    for name, inode in own + others:
        if name not in seen:
            seen.add(name)
            result.append((name, inode))
    return result[:_MAX_SOCKET_CANDIDATES]


async def _socket_owner(adb: "Adb", serial: str, socket_name: str, inode: str, *, timeout_s: float = 0.5) -> str | None:
    """The package a DevTools socket reports as its own (``/json/version`` › ``Android-Package``, lower case), None when it does not
    answer. Cached per (phone, socket, inode)."""
    key = (serial, socket_name, inode)
    if inode and key in _owner_cache:
        return _owner_cache[key]
    owner: str | None = None
    try:
        async with open_cdp_session(adb, serial, socket_name, timeout_s=timeout_s) as port:
            loop = asyncio.get_running_loop()
            req = urllib.request.Request(f"http://127.0.0.1:{port}/json/version")
            raw_ver = await loop.run_in_executor(None, lambda: urllib.request.urlopen(req, timeout=0.25).read().decode())
            owner = (json.loads(raw_ver).get("Android-Package") or "").strip().lower() or None
    except Exception as exc:  # noqa: BLE001 — a socket that does not answer is not anybody's
        log.debug("[WEB_INSPECTOR] /json/version doğrulama yapılamadı (%s): %s", socket_name, exc)
        return None            # not cached: it may answer a moment later
    if inode:
        _owner_cache[key] = owner
    return owner


_KNOWN_CHROMIUM_FALLBACK_PACKAGES = {
    "com.android.chrome",
    "org.chromium.chrome",
    "com.chrome.canary",
    "com.chrome.beta",
    "com.chrome.dev",
    "com.google.android.apps.chrome",
}


def _resolve_cdp_socket(unix_table: str, package: str) -> str | None:
    """Synchronous fallback socket resolver (used for offline unit tests)."""
    pkg_clean = package.strip().lower()

    pkg_pattern = f"{pkg_clean}_devtools_remote"
    for line in unix_table.splitlines():
        if pkg_pattern in line.lower():
            parts = line.strip().split()
            if parts and parts[-1].startswith("@"):
                return parts[-1][1:]

    if pkg_clean in _KNOWN_CHROMIUM_FALLBACK_PACKAGES and "chrome_devtools_remote" in unix_table:
        return "chrome_devtools_remote"

    return None
