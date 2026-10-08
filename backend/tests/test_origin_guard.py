"""A web page open in the user's browser must not drive the local API (app/api/origin_guard.py).

Each attack below was reproduced against the unguarded backend before the fix: a cross-site body-less POST ran its
side effect, and a cross-site WebSocket read notification contents."""
import functools
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.api.origin_guard import WS_POLICY_VIOLATION, OriginGuardMiddleware
from app.main import create_app

EVIL = {"Origin": "https://evil.example"}


@pytest.fixture
def client():
    c = TestClient(create_app())            # no `with`: the lifespan (discovery, mDNS…) is not started
    c.app.state.ctx.serial = "R5C"
    c.app.state.ctx.adb.shell = AsyncMock(return_value="Forget successful")
    return c


@pytest.mark.parametrize("path", [
    "/api/device/wifi/saved/3/forget",
    "/api/device/bluetooth/A0:B1:C2:D3:E4:F5/forget",
    "/api/device/tcpip",
    "/api/device/unlock",
])
@pytest.mark.parametrize("origin", ["https://evil.example", "null", "http://localhost.evil.example"])
def test_a_cross_site_post_is_refused_before_any_side_effect(client, path, origin):
    res = client.post(path, headers={"Origin": origin})
    assert res.status_code == 403
    client.app.state.ctx.adb.shell.assert_not_awaited()


@pytest.mark.parametrize("origin", [
    "http://localhost:5173", "http://127.0.0.1:5173", "https://tauri.localhost", "tauri://localhost",
    "http://localhost",
])
def test_the_apps_own_front_ends_are_served(client, origin):
    res = client.post("/api/device/wifi/saved/3/forget", headers={"Origin": origin})
    assert res.status_code == 200 and res.json() == {"ok": True}


def test_clients_without_an_origin_are_served(client):
    assert client.post("/api/device/wifi/saved/3/forget").status_code == 200


@pytest.mark.parametrize("host", ["attacker.example:8710", "192.168.1.20:8710", "evil.example"])
def test_a_dns_rebound_host_name_is_refused(client, host):
    """After DNS rebinding the page IS same-origin with the backend — only the Host header tells it apart."""
    assert client.get("/api/notifications", headers={"Host": host}).status_code == 403
    assert client.post("/api/device/wifi/saved/3/forget", headers={"Host": host}).status_code == 403


@pytest.mark.parametrize("path", ["/ws/events", "/ws/input/w1", "/ws/video/w1", "/ws/audio"])
def test_a_cross_site_websocket_is_never_opened(client, path):
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(path, headers=EVIL) as ws:
            ws.receive_text()
    assert exc_info.value.code == WS_POLICY_VIOLATION


def test_the_event_stream_still_reaches_the_app_itself(client):
    ctx = client.app.state.ctx
    with client.websocket_connect("/ws/events", headers={"Origin": "https://tauri.localhost"}) as ws:
        ws.portal.call(functools.partial(ctx.event_bus.emit, "fps_changed", window_id="w1", fps=30))
        assert '"fps_changed"' in ws.receive_text()


def test_host_parsing():
    guard = OriginGuardMiddleware(None, allowed_origins=[], allowed_hosts=["127.0.0.1", "::1"])
    assert guard.host_allowed("127.0.0.1:8710") and guard.host_allowed("[::1]:8710")
    assert guard.host_allowed("opendex.localhost") and guard.host_allowed("LOCALHOST:8710")
    assert not guard.host_allowed("localhost.evil.example") and not guard.host_allowed("127.0.0.1.nip.io")
    assert not guard.origin_allowed("http://127.0.0.1.evil.example")
