"""Transport hardening for the local API: request body limit and security response headers."""
from __future__ import annotations

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})


class BodyLimitMiddleware:
    """Every JSON body this API takes is small (settings, layout, a batch of client log lines). A body-bearing
    request must declare its length (browsers always do) and stay under the limit; otherwise it is refused before
    a byte reaches a route — no unbounded buffering, no half-parsed uploads."""

    def __init__(self, app: ASGIApp, *, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") not in _BODY_METHODS:
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        length = headers.get("content-length")
        if length is None:
            if headers.get("transfer-encoding", "").lower() == "chunked":
                await JSONResponse({"detail": "Content-Length gerekli."}, status_code=411)(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return
        try:
            declared = int(length)
        except ValueError:
            await JSONResponse({"detail": "Geçersiz Content-Length."}, status_code=400)(scope, receive, send)
            return
        if declared > self.max_bytes:
            await JSONResponse(
                {"detail": f"İstek gövdesi çok büyük (en fazla {self.max_bytes} bayt)."}, status_code=413
            )(scope, receive, send)
            return
        await self.app(scope, receive, send)


class SecurityHeadersMiddleware:
    """API responses are data, never documents: no MIME sniffing, no referrer leakage, never framed, never cached
    (notification contents and tokens must not survive in a browser cache)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.setdefault("X-Content-Type-Options", "nosniff")
                headers.setdefault("Referrer-Policy", "no-referrer")
                headers.setdefault("X-Frame-Options", "DENY")
                headers.setdefault("Cache-Control", "no-store")
            await send(message)

        await self.app(scope, receive, send_with_headers)
