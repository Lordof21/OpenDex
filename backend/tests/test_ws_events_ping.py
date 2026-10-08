"""/ws/events ping→pong: arayüz HUD'ındaki RTT'nin GERÇEK ölçümü için (HTTP gidiş-dönüşü
olmadan, açık olay soketi üzerinden). İstemci `t` damgasını yollar, backend AYNEN geri
yansıtır; süreyi istemci kendi saatiyle ölçer — backend saatine güvenilmez."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app


def _client() -> TestClient:
    # `with` YOK: lifespan (cihaz keşfi, mdns…) başlatılmaz.
    return TestClient(create_app())


def test_ping_is_echoed_back_with_id_and_timestamp_untouched():
    with _client().websocket_connect("/ws/events") as ws:
        ws.send_json({"type": "ping", "id": 41, "t": 12345.678})
        reply = ws.receive_json()
    assert reply == {"type": "pong", "id": 41, "t": 12345.678}


def test_pings_are_answered_in_order_and_do_not_disturb_other_messages():
    with _client().websocket_connect("/ws/events") as ws:
        for i in range(3):
            ws.send_json({"type": "ping", "id": i, "t": float(i)})
        ids = [ws.receive_json()["id"] for _ in range(3)]
    assert ids == [0, 1, 2]


def test_a_ping_without_id_still_gets_a_pong():
    with _client().websocket_connect("/ws/events") as ws:
        ws.send_json({"type": "ping"})
        reply = ws.receive_json()
    assert reply["type"] == "pong" and reply["id"] is None
