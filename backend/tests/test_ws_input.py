"""Real-time input WebSocket (/ws/input/{window_id}).

Regression this replaces: the frontend used to buffer an entire drag/scroll
gesture and POST it once on pointer-up, replayed with artificial delays
server-side — the phone showed nothing until after release. This channel
streams each down/move/up/scroll the instant it arrives, over one persistent
connection per window, exactly like scrcpy's own client does over its
control socket.
"""
import struct

from fastapi import FastAPI
from starlette.testclient import TestClient

from app.api.websockets import ws_router

POINTER_ID_GENERIC_FINGER = 0xFFFFFFFFFFFFFFFE


def _unpack_touch(data: bytes):
    return struct.unpack("!BBQiiHHHii", data)


def _actions(control):
    return [_unpack_touch(p)[1] for p in control.sent if p[0] == 2]


class _CaptureControl:
    def __init__(self):
        self.sent: list[bytes] = []

    async def send(self, payload: bytes) -> None:
        self.sent.append(payload)


class _FakeSession:
    def __init__(self, control, display_w=1280, display_h=720):
        self.control = control
        self.display_w = display_w
        self.display_h = display_h


class _FakeWindowManager:
    def __init__(self, sessions: dict):
        self._sessions = sessions

    def get_session(self, window_id):
        return self._sessions.get(window_id)


class _FakeCtx:
    def __init__(self, window_manager):
        self.window_manager = window_manager


def _make_app(sessions: dict) -> FastAPI:
    app = FastAPI()
    app.include_router(ws_router)
    app.state.ctx = _FakeCtx(_FakeWindowManager(sessions))
    return app


def test_streams_down_move_up_in_real_time_order():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "down", "x": 10, "y": 20})
        ws.send_json({"type": "move", "x": 15, "y": 25})
        ws.send_json({"type": "up", "x": 15, "y": 25})
        ws.close()

    actions = [_unpack_touch(p)[1] for p in control.sent]
    assert actions == [0, 2, 1]  # DOWN, MOVE, UP


def test_scroll_message_dispatches_scroll_injection():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "scroll", "x": 5, "y": 5, "hscroll": 0.0, "vscroll": 0.5})
        ws.close()

    assert len(control.sent) == 1
    msg_type = struct.unpack("!B", control.sent[0][:1])[0]
    assert msg_type == 3  # SC_CONTROL_MSG_TYPE_INJECT_SCROLL_EVENT


def test_unknown_window_id_drops_messages_without_closing_socket():
    app = _make_app({})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/does-not-exist") as ws:
        ws.send_json({"type": "down", "x": 1, "y": 1})
        # Socket must still be alive/usable — send one more and close cleanly.
        ws.send_json({"type": "up", "x": 1, "y": 1})
        ws.close()


def test_malformed_message_is_dropped_not_fatal():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "down"})  # missing x/y — KeyError, must not kill the socket
        ws.send_json({"type": "down", "x": 1, "y": 1})
        ws.close()

    # the malformed message was dropped, the valid DOWN went through — and closing lifted that finger (DOWN, UP)
    assert _actions(control) == [0, 1]


def test_out_of_range_coordinates_dropped_not_fatal():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control, display_w=100, display_h=100)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "down", "x": 9999, "y": 9999})  # ValueError from serialize_touch
        ws.send_json({"type": "down", "x": 1, "y": 1})
        ws.close()

    # only the in-range DOWN was delivered (plus the UP that closing the socket adds for it)
    assert _actions(control) == [0, 1]


# --- a finger left down must never outlive its connection ---------------------------------------------------------

def test_closing_the_socket_mid_gesture_lifts_the_finger():
    """The tab was closed / the network dropped between a DOWN and its UP: Android would keep the finger on the glass."""
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "down", "x": 10, "y": 20})
        ws.send_json({"type": "move", "x": 40, "y": 50})
        ws.close()

    assert _actions(control) == [0, 2, 1]  # DOWN, MOVE, then the UP the page never sent
    _, _, _, x, y, *_ = _unpack_touch(control.sent[-1])
    assert (x, y) == (40, 50)


def test_a_finished_gesture_leaves_nothing_to_lift_on_close():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "down", "x": 1, "y": 1})
        ws.send_json({"type": "up", "x": 1, "y": 1})
        ws.close()

    assert _actions(control) == [0, 1]  # no second UP


def test_release_all_lifts_the_held_finger_and_keeps_the_socket_open():
    """The page lost focus: it asks for the release, then goes on using the same connection."""
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "down", "x": 10, "y": 20})
        ws.send_json({"type": "release_all"})
        ws.send_json({"type": "down", "x": 3, "y": 4})  # socket is still alive and tracks the new finger
        ws.send_json({"type": "up", "x": 3, "y": 4})
        ws.close()

    assert _actions(control) == [0, 1, 0, 1]


def test_release_all_without_a_finger_sends_nothing():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "release_all"})
        ws.close()

    assert control.sent == []


def test_a_dropped_down_is_not_remembered_as_a_pressed_finger():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control, display_w=100, display_h=100)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "down", "x": 9999, "y": 9999})  # refused: outside the screen
        ws.close()

    assert control.sent == []  # nothing to lift on close either


def test_a_rebuilt_control_is_not_sent_a_stray_up_on_close():
    """The window was frozen and rebuilt mid-gesture: the old control held the finger, the new one never saw it."""
    old, rebuilt = _CaptureControl(), _CaptureControl()
    sessions = {"win-1": _FakeSession(old)}
    app = _make_app(sessions)
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "down", "x": 10, "y": 20})
        import time; time.sleep(0.02)
        sessions["win-1"] = _FakeSession(rebuilt)
        ws.send_json({"type": "scroll", "x": 5, "y": 5, "vscroll": 0.1})  # proves the new control is live
        ws.close()

    assert _actions(rebuilt) == []


def test_every_message_type_the_socket_serves_is_declared():
    """The UI contract (frontend/tests/fixtures/backend-input-contract.json) is generated from this set."""
    from app.api.websockets import INPUT_MESSAGE_TYPES

    assert INPUT_MESSAGE_TYPES == {"down", "move", "up", "scroll", "hover", "clipboard", "release_all"}


def test_single_finger_down_auto_releases_stale_secondary_pointer():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "down", "x": 10, "y": 20, "pointer_id": 0})
        ws.send_json({"type": "down", "x": 50, "y": 60, "pointer_id": 1})
        ws.send_json({"type": "down", "x": 100, "y": 100})
        ws.send_json({"type": "up", "x": 100, "y": 100})
        ws.close()

    actions = [_unpack_touch(p)[1] for p in control.sent]
    assert actions == [0, 0, 1, 0, 1]


# --- hover: the mouse pointer over the screen, no finger down -----------------------------------------------------------

POINTER_ID_MOUSE = 0xFFFFFFFFFFFFFFFF
HOVER_MOVE = 7


def test_hover_is_a_mouse_hover_move_without_buttons():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "hover", "x": 30, "y": 40})
        ws.close()

    assert len(control.sent) == 1
    msg_type, action, pointer, x, y, w, h, pressure, action_button, buttons = _unpack_touch(control.sent[0])
    assert (msg_type, action, pointer, x, y, w, h) == (2, HOVER_MOVE, POINTER_ID_MOUSE, 30, 40, 1280, 720)
    assert (pressure, action_button, buttons) == (0, 0, 0)


def test_hover_is_ignored_while_a_finger_is_down_and_resumes_after_it_lifts():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "down", "x": 10, "y": 10})
        ws.send_json({"type": "hover", "x": 11, "y": 11})     # the gesture owns the glass
        ws.send_json({"type": "up", "x": 10, "y": 10})
        ws.send_json({"type": "hover", "x": 12, "y": 12})
        ws.close()

    assert _actions(control) == [0, 1, HOVER_MOVE]


def test_a_flood_of_hover_messages_is_cut_at_the_gate_not_queued():
    from app.input.touch_control import HOVER_BURST

    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        for i in range(500):
            ws.send_json({"type": "hover", "x": i % 100, "y": 5})
        ws.close()

    delivered = _actions(control).count(HOVER_MOVE)
    # 500 messages arrive within a few milliseconds: the bucket's burst passes, the rest is dropped (plus what refills meanwhile)
    assert HOVER_BURST <= delivered < 100


def test_hover_past_the_edge_is_pulled_onto_it_and_a_malformed_one_is_dropped():
    control = _CaptureControl()
    app = _make_app({"win-1": _FakeSession(control, display_w=100, display_h=100)})
    client = TestClient(app)
    with client.websocket_connect("/ws/input/win-1") as ws:
        ws.send_json({"type": "hover", "x": 9999, "y": -5})
        ws.send_json({"type": "hover"})                          # no coordinates: dropped, the socket lives on
        ws.send_json({"type": "hover", "x": 1, "y": 1})
        ws.close()

    points = [(_unpack_touch(p)[3], _unpack_touch(p)[4]) for p in control.sent]
    assert points == [(100, 0), (1, 1)]
