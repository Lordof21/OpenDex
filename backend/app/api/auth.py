"""Bearer-token authentication for the local API (HTTP and WebSocket).

The Origin/Host guard (origin_guard.py) keeps web pages out; this layer is the second, independent lock, and the
only one that holds once the API is reachable from anywhere but this machine:

  * One secret per user: OPENDEX_API_TOKEN, or the file ~/.opendex/api-token (0600), created on first start. The
    Tauri shell hands it to the webview through an IPC command, the Vite dev server reads the same file, and local
    tools read the file too — the token never has to travel over HTTP.
  * Every /api/* request and every /ws/* handshake must present it: `Authorization: Bearer <token>`, or — for
    WebSockets and GET requests only, because browsers cannot set headers on those — a `token` query parameter.
    Comparison is constant-time; a failure is 401 (HTTP) or close code 4401 (WebSocket) before any route runs.
  * Exempt: GET /api/health (liveness for the boot splash and Docker) and, ONLY when OPENDEX_TOKEN_BOOTSTRAP is
    enabled, GET /api/auth/bootstrap, which hands the token to a browser page from one of the app's own origins
    (Origin header required — non-browser clients read the file instead). It exists for the nginx/Docker deployment
    where nothing else can give the page the token; the desktop build never turns it on.
  * Bind policy: listening on anything but loopback requires OPENDEX_ALLOW_REMOTE=true AND an explicitly configured
    token — an auto-generated one was never handed to anybody else, so remote clients could only be attackers.
"""
from __future__ import annotations

import hmac
import ipaddress
import logging
import secrets
import time
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs

from fastapi import APIRouter, HTTPException, Request
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from ..config import Settings
from ..storage.private_file import write_private
from .origin_guard import origin_allowed

log = logging.getLogger(__name__)

TOKEN_BYTES = 32
MIN_TOKEN_LEN = 32
WS_UNAUTHORIZED = 4401
TokenSource = Literal["env", "file", "generated"]

# Paths served without a token (both router prefixes).
EXEMPT_PATHS = frozenset({"/api/health", "/api/v1/health", "/api/auth/bootstrap", "/api/v1/auth/bootstrap"})


class RemoteBindRefused(RuntimeError):
    """Refusing to listen beyond loopback without an explicit token and an explicit opt-in."""


# ---------------------------------------------------------------------------------------------------- token store


def load_or_create_token(settings: Settings) -> tuple[str, TokenSource]:
    """The API token and where it came from. A configured token wins; otherwise the per-user file is reused, or
    created (0600) with 256 bits of randomness."""
    configured = (settings.API_TOKEN or "").strip()
    if configured:
        if len(configured) < MIN_TOKEN_LEN:
            raise ValueError(f"OPENDEX_API_TOKEN en az {MIN_TOKEN_LEN} karakter olmalı.")
        return configured, "env"
    path = Path(settings.API_TOKEN_FILE).expanduser()
    try:
        existing = path.read_text(encoding="utf-8").strip()
        if len(existing) >= MIN_TOKEN_LEN:
            return existing, "file"
    except OSError:
        pass
    token = secrets.token_urlsafe(TOKEN_BYTES)
    write_private(path, token)
    log.info("🔐 [Auth] Yeni API anahtarı üretildi → %s", path)
    return token, "generated"


def is_loopback_host(host: str) -> bool:
    host = (host or "").strip().lower()
    if host in ("localhost", ""):
        return host == "localhost"
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def check_bind_policy(settings: Settings, source: TokenSource) -> None:
    """Loopback: always. Anything else: only with OPENDEX_ALLOW_REMOTE=true and a token set explicitly."""
    if is_loopback_host(settings.HTTP_HOST):
        return
    if not settings.ALLOW_REMOTE:
        raise RemoteBindRefused(
            f"OPENDEX_HTTP_HOST={settings.HTTP_HOST!r} loopback dışı bir adres. Bu API kimlik doğrulamasını yalnız "
            "API anahtarıyla yapar; uzak erişim için OPENDEX_ALLOW_REMOTE=true VE OPENDEX_API_TOKEN ayarlanmalı."
        )
    if source != "env":
        raise RemoteBindRefused(
            "OPENDEX_ALLOW_REMOTE=true ama OPENDEX_API_TOKEN ayarlı değil: kendiliğinden üretilen bir anahtar hiç "
            "kimseye verilmedi, uzak istemciler ancak saldırgan olabilir. Anahtarı açıkça ayarlayın."
        )


# ---------------------------------------------------------------------------------------------------- middleware


def _presented_token(scope: Scope, headers: Headers) -> str | None:
    auth = headers.get("authorization")
    if auth and auth[:7].lower() == "bearer ":
        return auth[7:].strip() or None
    # Browsers cannot set headers on <img> loads or WebSocket handshakes: the token may ride in the query string,
    # but only where it cannot change state (GET) or where nothing else works (WebSocket).
    if scope["type"] == "websocket" or scope.get("method") == "GET":
        values = parse_qs(scope.get("query_string", b"").decode("latin-1")).get("token")
        if values:
            return values[0]
    return None


class ApiAuthMiddleware:
    def __init__(self, app: ASGIApp, *, token: str) -> None:
        if len(token) < MIN_TOKEN_LEN:
            raise ValueError("API token too short")
        self.app = app
        self._token = token.encode("utf-8")
        self._last_failure_log = 0.0
        self._failures_since_log = 0

    def protects(self, path: str) -> bool:
        return (path.startswith("/api/") or path == "/api" or path.startswith("/ws/")) and path not in EXEMPT_PATHS

    def authorized(self, scope: Scope) -> bool:
        presented = _presented_token(scope, Headers(scope=scope))
        return presented is not None and hmac.compare_digest(presented.encode("utf-8"), self._token)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket") or not self.protects(scope["path"]):
            await self.app(scope, receive, send)
            return
        if self.authorized(scope):
            await self.app(scope, receive, send)
            return

        self._log_failure(scope)
        if scope["type"] == "http":
            response = JSONResponse(
                {"detail": "API anahtarı gerekli."}, status_code=401, headers={"WWW-Authenticate": "Bearer"}
            )
            await response(scope, receive, send)
        else:
            await receive()                                    # websocket.connect
            await send({"type": "websocket.close", "code": WS_UNAUTHORIZED})

    def _log_failure(self, scope: Scope) -> None:
        """One warning per 10 s at most: a stuck client must not fill the log, an attacker must not either."""
        self._failures_since_log += 1
        now = time.monotonic()
        if now - self._last_failure_log < 10.0:
            return
        log.warning(
            "🔐 [Auth] %s %s anahtarsız/yanlış anahtarla reddedildi (%d istek)",
            scope["type"], scope["path"], self._failures_since_log,
        )
        self._last_failure_log = now
        self._failures_since_log = 0


# ---------------------------------------------------------------------------------------------------- routes

router = APIRouter()


@router.get("/health")
async def health(request: Request):
    """Liveness only — no device state, no configuration, nothing an unauthenticated caller could use."""
    return {"ok": True, "version": request.app.version, "auth": "bearer"}


@router.get("/auth/bootstrap")
async def bootstrap(request: Request):
    """The token, for a browser page served from one of the app's own origins (OPENDEX_TOKEN_BOOTSTRAP only)."""
    settings: Settings = request.app.state.ctx.settings
    if not settings.TOKEN_BOOTSTRAP:
        raise HTTPException(status_code=404)
    origin = request.headers.get("origin")
    if not origin or not origin_allowed(origin, settings.CORS_ORIGINS):
        # No Origin: not a browser page — a local program reads the token file instead.
        raise HTTPException(status_code=403, detail="Bu uç yalnız uygulamanın kendi arayüzüne açıktır.")
    return JSONResponse({"token": request.app.state.api_token}, headers={"Cache-Control": "no-store"})
