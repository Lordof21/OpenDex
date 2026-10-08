"""Identifiers that end up in a shell command line or on the daemon's line protocol — validated at the API boundary.

A package name, a media verb or a host name typed by a client used to travel unchanged into `adb shell "am … {pkg}"`,
`app_process … MediaBridge {action} {pkg}` and `#<id> media_action {action} {pkg}\\n`. A `;`, a newline or a quote in
any of them was a second command on the phone (shell uid) or a second daemon command (`exec`). Every request model
and route with such a field uses the types below, and the device layer re-checks with the same regexes.
"""
from __future__ import annotations

import ipaddress
import re
from typing import Annotated, Literal

from pydantic import AfterValidator

# Android package name: dot-separated Java identifiers (PackageParser.validateName), ≤ 255 characters.
PACKAGE_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$"
PACKAGE_RE = re.compile(PACKAGE_PATTERN)
PACKAGE_MAX_LEN = 255

MEDIA_ACTIONS = ("play", "pause", "toggle", "play_pause", "next", "prev", "previous")
MediaAction = Literal["play", "pause", "toggle", "play_pause", "next", "prev", "previous"]

_HOST_LABEL = r"[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_HOSTNAME_RE = re.compile(rf"^{_HOST_LABEL}(\.{_HOST_LABEL})*\.?$")


def is_package_name(value: object) -> bool:
    return isinstance(value, str) and len(value) <= PACKAGE_MAX_LEN and PACKAGE_RE.fullmatch(value) is not None


def require_package(value: str) -> str:
    if not is_package_name(value):
        raise ValueError("Geçersiz paket adı.")
    return value


def is_host(value: object) -> bool:
    """An IPv4/IPv6 literal or a DNS host name — what `adb connect <host>:<port>` accepts."""
    if not isinstance(value, str) or not value or len(value) > 253:
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return _HOSTNAME_RE.fullmatch(value) is not None


def require_host(value: str) -> str:
    value = value.strip()
    if not is_host(value):
        raise ValueError("Geçersiz IP adresi veya ana bilgisayar adı.")
    return value


PackageName = Annotated[str, AfterValidator(require_package)]
HostName = Annotated[str, AfterValidator(require_host)]
