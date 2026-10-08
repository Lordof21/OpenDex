"""The process-wide handle on the on-device daemon client, for the modules that read the phone "daemon first, shell as
fallback" but are not handed the client (task lookups in deep_navigator are called from half a dozen places with only
an Adb). main.py registers the one DeviceDaemonClient; nothing registered (tests, before startup) = shell path.

`live(capability)` is the only question callers ask: a connected daemon that advertises `capability`, or None.
"""
from __future__ import annotations

from typing import Any

_client: Any = None


def register(client: Any) -> None:
    global _client
    _client = client


def live(capability: str | None = None) -> Any:
    """The connected daemon client (advertising `capability` when given), else None."""
    client = _client
    if client is None or not getattr(client, "is_connected", False):
        return None
    if capability is not None and capability not in getattr(client, "daemon_capabilities", ()):
        return None
    return client
