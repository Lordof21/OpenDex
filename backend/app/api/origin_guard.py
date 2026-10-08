"""Browser-origin guard for the local API (HTTP + WebSocket).

The backend listens on 127.0.0.1, and every /api and /ws call must also present the API token (auth.py) — that is the
second, independent lock. This module is the first: the thing that must never even reach the backend is ANOTHER web
page open in the user's browser (it cannot know the token, but it can still fire requests and open sockets). CORS does
not stop that on its own:

  * CORS only hides the RESPONSE of a cross-origin request — a "simple" request (a POST without a body, a form post)
    still runs its side effect (forget a Wi-Fi network, switch adb to TCP/IP…).
  * WebSockets are not covered by CORS at all: any page could open /ws/events and read every notification (one-time
    codes included), learn window ids from it, then watch /ws/video/{id} and inject touches over /ws/input/{id}.
  * DNS rebinding makes an attacker's host name resolve to 127.0.0.1: the browser then treats the backend as the
    attacker's own origin, so even CORS is bypassed — only the Host header gives it away.

Rules (browsers always send Origin on cross-origin requests and on every WebSocket handshake, and cannot forge it):
  1. A request whose Origin is present and not one of the app's own origins is refused — 403 for HTTP, close code
     4403 for a WebSocket handshake. `Origin: null` (sandboxed iframes, file://) is foreign too.
  2. A request whose Host is not a loopback / *.localhost name is refused (DNS rebinding).
  3. No Origin → a non-browser client (curl, tests, the Tauri shell) or a same-origin navigation: allowed here (it still
     needs the API token). Such a client can already reach adb directly; this guard protects against web pages, not
     local programs.
"""
from __future__ import annotations

import logging
import re
from typing import Iterable

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

log = logging.getLogger(__name__)

# The app's own front-ends: Vite dev/preview (any port), the Docker nginx, and the packaged Tauri webview.
LOCAL_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|opendex\.localhost|tauri\.localhost)(:\d+)?$"

WS_POLICY_VIOLATION = 4403
_LOCAL_ORIGIN_RE = re.compile(LOCAL_ORIGIN_REGEX, re.IGNORECASE)


def origin_allowed(origin: str, allowed_origins: Iterable[str], origin_regex: re.Pattern | None = None) -> bool:
    """One of the app's own front-end origins (the CORS allowlist or a loopback / *.localhost origin)."""
    origin = (origin or "").strip().rstrip("/").lower()
    if not origin:
        return False
    if origin in {o.rstrip("/").lower() for o in allowed_origins}:
        return True
    return bool((origin_regex or _LOCAL_ORIGIN_RE).fullmatch(origin))


def _host_name(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):                                   # [::1]:8710
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


class OriginGuardMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        allowed_origins: Iterable[str],
        allowed_hosts: Iterable[str],
        origin_regex: str = LOCAL_ORIGIN_REGEX,
    ) -> None:
        self.app = app
        self._origins = {o.rstrip("/").lower() for o in allowed_origins}
        self._origin_re = re.compile(origin_regex, re.IGNORECASE)
        self._hosts = {h.lower() for h in allowed_hosts}

    def origin_allowed(self, origin: str) -> bool:
        return origin_allowed(origin, self._origins, self._origin_re)

    def host_allowed(self, host_header: str) -> bool:
        name = _host_name(host_header)
        # RFC 6761: *.localhost always resolves to loopback — no attacker can own such a name.
        return name in self._hosts or name == "localhost" or name.endswith(".localhost")

    def rejection(self, headers: Headers) -> str | None:
        host = headers.get("host")
        if host is not None and not self.host_allowed(host):
            return f"host {host!r}"
        origin = headers.get("origin")
        if origin is not None and not self.origin_allowed(origin):
            return f"origin {origin!r}"
        return None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        reason = self.rejection(Headers(scope=scope))
        if reason is None:
            await self.app(scope, receive, send)
            return

        log.warning("🛡️ [OriginGuard] %s %s reddedildi: %s", scope["type"], scope.get("path"), reason)
        if scope["type"] == "http":
            await JSONResponse({"detail": "Bu istek kaynağına izin verilmiyor."}, status_code=403)(scope, receive, send)
        else:
            await receive()                                    # websocket.connect
            # Closing before accept → the server answers the handshake with 403; the socket never opens.
            await send({"type": "websocket.close", "code": WS_POLICY_VIOLATION})
