"""The API token lock (app/api/auth.py) and transport hardening (app/api/hardening.py)."""
import os
import stat

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api import auth
from app.config import Settings
from app.main import create_app

TOKEN = os.environ["OPENDEX_API_TOKEN"]


@pytest.fixture
def client():
    c = TestClient(create_app())              # no `with`: the lifespan is not started
    c.app.state.ctx.serial = "R5C"
    return c


@pytest.fixture
def anon(client):
    client.headers.pop("Authorization", None)
    return client


# ---------------------------------------------------------------------------------------------------- the lock


def test_health_is_open_and_says_nothing_about_the_device(anon):
    res = anon.get("/api/health")
    assert res.status_code == 200 and res.json()["ok"] is True
    assert "R5C" not in res.text


@pytest.mark.parametrize("method, path", [
    ("get", "/api/settings"), ("get", "/api/devices"), ("post", "/api/device/unlock"),
    ("get", "/api/apps/icon-v2/com.a"), ("get", "/api/v1/devices"), ("get", "/api/diagnostics/log-tail"),
])
def test_every_route_needs_the_token(anon, method, path):
    res = getattr(anon, method)(path)
    assert res.status_code == 401
    assert res.headers["www-authenticate"] == "Bearer"


def test_a_wrong_token_is_refused(anon):
    assert anon.get("/api/devices", headers={"Authorization": f"Bearer {TOKEN[:-1]}x"}).status_code == 401
    assert anon.get("/api/devices", headers={"Authorization": f"Basic {TOKEN}"}).status_code == 401


def test_the_token_opens_the_api(client):
    assert client.get("/api/devices").status_code == 200


def test_get_may_carry_the_token_in_the_query_but_a_post_may_not(anon):
    assert anon.get(f"/api/devices?token={TOKEN}").status_code == 200          # <img src> loads
    assert anon.post(f"/api/device/unlock?token={TOKEN}").status_code == 401


def test_websockets_need_the_token(anon):
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with anon.websocket_connect("/ws/events") as ws:
            ws.receive_text()
    assert exc_info.value.code == auth.WS_UNAUTHORIZED
    with anon.websocket_connect(f"/ws/events?token={TOKEN}") as ws:
        ws.send_json({"type": "ping", "id": 1, "t": 5})
        assert ws.receive_json()["type"] == "pong"


def test_a_foreign_page_is_refused_even_with_the_token(client):
    assert client.get("/api/devices", headers={"Origin": "https://evil.example"}).status_code == 403


def test_docs_are_off_in_the_product(anon):
    assert anon.get("/docs").status_code == 404
    assert anon.get("/openapi.json").status_code == 404


# ---------------------------------------------------------------------------------------------------- bootstrap


def test_bootstrap_is_off_by_default(anon):
    assert anon.get("/api/auth/bootstrap", headers={"Origin": "http://localhost:5173"}).status_code == 404


def test_bootstrap_hands_the_token_only_to_the_apps_own_pages():
    c = TestClient(create_app(Settings(TOKEN_BOOTSTRAP=True)))
    c.headers.pop("Authorization", None)
    assert c.get("/api/auth/bootstrap").status_code == 403                      # no Origin: not a browser page
    assert c.get("/api/auth/bootstrap", headers={"Origin": "https://evil.example"}).status_code == 403
    res = c.get("/api/auth/bootstrap", headers={"Origin": "http://localhost"})
    assert res.status_code == 200 and res.json() == {"token": TOKEN}
    assert res.headers["cache-control"] == "no-store"


# ---------------------------------------------------------------------------------------------------- transport


def test_oversized_bodies_are_refused_before_a_route_sees_them(client):
    big = b'{"pad": "' + b"x" * 2_100_000 + b'"}'
    res = client.put("/api/settings", content=big, headers={"Content-Type": "application/json"})
    assert res.status_code == 413


def test_a_chunked_body_without_a_length_is_refused(client):
    res = client.post("/api/device/unlock", content=iter([b"{}"]), headers={"Transfer-Encoding": "chunked"})
    assert res.status_code == 411


def test_security_headers_on_every_response(anon):
    res = anon.get("/api/health")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["referrer-policy"] == "no-referrer"
    assert res.headers["x-frame-options"] == "DENY"
    assert res.headers["cache-control"] == "no-store"


def test_refusals_carry_the_security_headers_too(client, anon):
    """The answers the OUTER layers give (401 auth, 403 origin guard, 413 body limit, 411 chunked) are responses like any
    other: a notification or a token must not survive in a cache because the request happened to be refused."""
    refusals = {
        "401": anon.get("/api/devices/state"),
        "403": anon.get("/api/health", headers={"Origin": "https://evil.example"}),
        "413": client.put("/api/settings", content=b"{" + b" " * 2_100_000 + b"}", headers={"Content-Type": "application/json"}),
        "411": client.post("/api/device/unlock", content=iter([b"{}"]), headers={"Transfer-Encoding": "chunked"}),
    }
    for status, res in refusals.items():
        assert res.status_code == int(status), (status, res.status_code)
        assert res.headers["x-content-type-options"] == "nosniff", status
        assert res.headers["cache-control"] == "no-store", status
        assert res.headers["x-frame-options"] == "DENY", status


# ---------------------------------------------------------------------------------------------------- token store


def test_the_token_file_is_created_private_and_reused(tmp_path):
    settings = Settings(API_TOKEN=None, API_TOKEN_FILE=tmp_path / "api-token")
    token, source = auth.load_or_create_token(settings)
    assert source == "generated" and len(token) >= auth.MIN_TOKEN_LEN
    if os.name != "nt":
        assert stat.S_IMODE(os.stat(tmp_path / "api-token").st_mode) == 0o600
    assert auth.load_or_create_token(settings) == (token, "file")


def test_a_configured_token_wins_and_must_be_long_enough(tmp_path):
    assert auth.load_or_create_token(Settings(API_TOKEN="k" * 40, API_TOKEN_FILE=tmp_path / "t")) == ("k" * 40, "env")
    with pytest.raises(ValueError):
        auth.load_or_create_token(Settings(API_TOKEN="short", API_TOKEN_FILE=tmp_path / "t"))


def test_a_short_token_never_becomes_a_lock():
    with pytest.raises(ValueError):
        auth.ApiAuthMiddleware(lambda *a: None, token="short")


# ---------------------------------------------------------------------------------------------------- bind policy


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
def test_loopback_binds_are_always_allowed(host):
    auth.check_bind_policy(Settings(HTTP_HOST=host), "generated")


@pytest.mark.parametrize("settings, source", [
    (Settings(HTTP_HOST="0.0.0.0"), "env"),                                       # no opt-in
    (Settings(HTTP_HOST="192.168.1.5", ALLOW_REMOTE=True), "file"),               # opt-in but no explicit token
    (Settings(HTTP_HOST="0.0.0.0", ALLOW_REMOTE=True), "generated"),
])
def test_remote_binds_need_an_explicit_token_and_an_explicit_opt_in(settings, source):
    with pytest.raises(auth.RemoteBindRefused):
        auth.check_bind_policy(settings, source)
    auth.check_bind_policy(Settings(HTTP_HOST="0.0.0.0", ALLOW_REMOTE=True), "env")


def test_create_app_refuses_a_remote_bind_without_the_opt_in():
    with pytest.raises(auth.RemoteBindRefused):
        create_app(Settings(HTTP_HOST="0.0.0.0"))


# ---------------------------------------------------------------- an adb failure nobody caught is a 503, not a 500 + traceback
@pytest.mark.parametrize("stderr, expected", [
    ("adb.exe: device offline", "çevrimdışı"),
    ("adb.exe: device unauthorized.", "izin vermedi"),
    ("adb.exe: no devices/emulators found", "bulunamadı"),
    ("adb.exe: something odd", "adb komutu başarısız"),
])
def test_an_uncaught_adb_error_is_a_503_with_a_readable_sentence(client, stderr, expected):
    from unittest.mock import AsyncMock
    from app.device.adb import AdbError

    client.app.state.ctx.app_registry.list_launcher_apps = AsyncMock(side_effect=AdbError(["shell", "x"], 1, stderr))
    r = client.get("/api/apps")
    assert r.status_code == 503
    assert r.json()["code"] == "adb_error" and expected in r.json()["detail"]
