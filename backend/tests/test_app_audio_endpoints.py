"""Per-app audio HTTP/WS surface: GET/PUT /api/audio/apps, WS /ws/audio/{window_id}."""
from __future__ import annotations

import struct
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import create_app
from app.streams.app_audio import AUDIO_QUEUE_CHUNKS, audio_key


def _client() -> TestClient:
    # No `with`: the lifespan (device discovery, mDNS…) is not started.
    return TestClient(create_app())


def test_without_a_device_per_app_audio_is_off_and_lists_nothing():
    res = _client().get("/api/audio/apps")
    assert res.status_code == 200
    body = res.json()
    assert (body["supported"], body["mode"], body["apps"]) == (False, "off", [])
    # the "İkisi" alignment card: nothing can align without a device, the defaults are what a new user gets
    assert body["sync"] == {
        "supported": False, "offset_ms": 0, "pc_output_ms": 30, "link_ms": None, "target_ms": None, "late_extra_ms": 0,
    }


def test_a_bad_route_or_volume_is_rejected_by_validation():
    client = _client()
    assert client.put("/api/audio/apps/com.a", json={"route": "speaker"}).status_code == 422
    assert client.put("/api/audio/apps/com.a", json={"volume": 1.5}).status_code == 422
    assert client.put("/api/audio/apps/com.a%0Aexec", json={"muted": True}).status_code == 422


def test_a_media_center_transfer_without_per_app_audio_is_a_409_with_its_reason():
    client = _client()           # no device bound: per-app audio is "off"
    res = client.put("/api/audio/apps/com.spotify.music", json={"route": "pc", "standalone": True})
    assert (res.status_code, res.json()["detail"]) == (409, "not_supported")
    assert client.put("/api/audio/apps/com.spotify.music", json={"standalone": "yes please"}).status_code == 422


def test_the_page_reports_what_it_measures_and_a_nonsense_report_is_refused():
    client = _client()
    res = client.put("/api/audio/sync", json={"pc_output_ms": 240, "late_chunks": 2})
    assert res.status_code == 200 and res.json()["pc_output_ms"] == 240      # no device yet: remembered for the first capture
    assert client.put("/api/audio/sync", json={"late_chunks": 1}).status_code == 200   # either field alone is a report
    for bad in ({"pc_output_ms": -1}, {"pc_output_ms": 99999}, {"pc_output_ms": "fast"}, {"late_chunks": -1}):
        assert client.put("/api/audio/sync", json=bad).status_code == 422


def test_the_device_clock_is_served_for_the_pages_offset_probes_and_503_when_the_daemon_cannot_say():
    from unittest.mock import AsyncMock

    client = _client()
    ctx = client.app.state.ctx
    ctx.daemon_client.clock_us = AsyncMock(return_value=987_654_321)
    assert client.post("/api/audio/clock").json() == {"device_us": 987_654_321}
    ctx.daemon_client.clock_us = AsyncMock(return_value=None)
    res = client.post("/api/audio/clock")
    assert (res.status_code, res.json()["detail"]) == (503, "clock_unavailable")


def test_a_window_without_audio_is_refused_with_4404():
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with _client().websocket_connect("/ws/audio/nope") as ws:
            ws.receive_bytes()
    assert exc_info.value.code == 4404


def test_the_window_socket_streams_that_windows_chunks():
    client = _client()
    broadcaster = client.app.state.ctx.broadcasters.get_or_create(
        audio_key("w1"), queue_size=AUDIO_QUEUE_CHUNKS, gop_aware=False
    )
    chunk = struct.pack(">QI", 1000, 4) + b"\x01\x02\x03\x04"
    with client.websocket_connect("/ws/audio/w1") as ws:
        deadline = time.monotonic() + 2.0
        while broadcaster.client_count == 0 and time.monotonic() < deadline:   # accept() precedes register()
            time.sleep(0.01)
        ws.portal.call(broadcaster.broadcast, chunk)
        assert ws.receive_bytes() == chunk


def test_the_calibration_probe_is_a_409_with_its_reason_when_the_device_cannot_align():
    res = _client().post("/api/audio/probe")                     # no device bound: per-app audio is "off"
    assert (res.status_code, res.json()["detail"]) == (409, "not_supported")


def test_the_calibration_probe_hands_the_page_the_phones_instants():
    from unittest.mock import AsyncMock

    client = _client()
    ctx = client.app.state.ctx
    answer = {"ok": True, "pts_us": [1, 2], "spacing_ms": 500, "common_target_ms": 96, "phone_target_ms": 96, "offset_ms": 0}
    ctx.app_audio.probe = AsyncMock(return_value=answer)
    res = client.post("/api/audio/probe")
    assert (res.status_code, res.json()) == (200, answer)
