"""Windows-host network helpers shared by the wireless pairing/tcpip endpoints."""
from __future__ import annotations

import asyncio
import logging

log = logging.getLogger(__name__)


async def get_windows_gateway_ip(timeout_s: float = 3.0) -> str | None:
    """Best-effort default-gateway IP for this Windows host — used as a
    fallback when the phone can't report its own Wi-Fi IP.

    Returns ``None`` on any failure. Callers must not substitute a hardcoded
    placeholder IP for a ``None`` result: one developer's own LAN IP had
    leaked into this fallback path in two endpoints and would silently
    misdirect wireless-pairing attempts on every other machine.
    """
    try:
        proc = await asyncio.create_subprocess_shell(
            "powershell -Command \"(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty NextHop -First 1)\"",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        gw = stdout.decode().strip()
        return gw or None
    except Exception as exc:
        log.debug("[NetworkUtils] gateway lookup failed: %s", exc)
        return None
