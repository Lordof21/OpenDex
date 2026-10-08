"""Keyframe on demand: the encoder's own keyframe is up to 10 s away (scrcpy's I-frame interval), and every desync of a
client's decoder — a stalled link that overflowed its queue, a decode error, a backlog resync — used to show a frozen
picture for all of it. A client that cannot continue now asks for a keyframe (RESET_VIDEO) and has one in a few hundred
milliseconds."""
import asyncio

from fastapi import FastAPI
from starlette.testclient import TestClient

from app.api.websockets import KEYFRAME_REQUEST, ws_router
from app.config import Settings
from app.events import EventBus
from app.streams.broadcaster import BroadcasterRegistry, FrameBroadcaster
from app.windows.scrcpy_launcher import serialize_opendex_request_keyframe, serialize_reset_video
from app.windows.session_reconfigure import SessionReconfigurer, _PendingAck

# ------------------------------------------------------------------ wire format


def test_reset_video_is_the_one_byte_upstream_message():
    assert serialize_reset_video() == bytes([17])      # scrcpy ControlMessage.TYPE_RESET_VIDEO, no payload


# ------------------------------------------------------------------ the broadcaster asks when a client is stuck


def _video(requests: list[str]) -> FrameBroadcaster:
    broadcaster = FrameBroadcaster("video")
    broadcaster.remember_config(b"CFG")
    broadcaster.keyframe_requester = requests.append
    return broadcaster


async def test_a_client_that_overflowed_its_queue_gets_a_keyframe_requested():
    requests: list[str] = []
    b = _video(requests)
    b.HARD_QUEUE_CAP = 10
    b.register()                                   # never reads
    await b.broadcast(b"K0", is_key_frame=True)
    for n in range(1, 30):
        await b.broadcast(b"D%d" % n)

    assert b.resync_count >= 1
    assert requests == ["client queue overflow"]   # once: the chain stays broken until the keyframe, no repeats


async def test_a_late_client_with_nothing_to_replay_on_a_live_stream_asks_for_one():
    requests: list[str] = []
    b = _video(requests)
    b.GOP_CACHE_LIMIT = 4
    await b.broadcast(b"K0", is_key_frame=True)
    for n in range(1, 12):
        await b.broadcast(b"D%d" % n)              # the cache overflows and is dropped: nothing replayable
    b.register()

    assert requests == ["late client, no keyframe cached"]


async def test_a_client_of_a_stream_that_has_not_produced_anything_yet_does_not_ask():
    """Right after a window opens the first keyframe is already on its way — a reset would only delay it."""
    requests: list[str] = []
    b = _video(requests)
    b.register()
    assert requests == []


async def test_a_client_that_can_be_given_a_replay_does_not_ask():
    requests: list[str] = []
    b = _video(requests)
    await b.broadcast(b"K0", is_key_frame=True)
    await b.broadcast(b"D1")
    b.register()
    assert requests == []


async def test_audio_never_asks_for_keyframes():
    requests: list[str] = []
    b = FrameBroadcaster("audio", gop_aware=False)
    b.keyframe_requester = requests.append
    await b.broadcast(b"PCM")
    b.register()
    assert requests == []


async def test_a_failing_requester_never_breaks_frame_delivery():
    b = FrameBroadcaster("video")
    b.remember_config(b"CFG")

    def broken(reason):
        raise RuntimeError("boom")

    b.keyframe_requester = broken
    b.HARD_QUEUE_CAP = 3
    _, queue = b.register()
    await b.broadcast(b"K0", is_key_frame=True)
    for n in range(1, 10):
        await b.broadcast(b"D%d" % n)             # must not raise
    await b.broadcast(b"K20", is_key_frame=True)
    assert b"K20" in [queue.get_nowait() for _ in range(queue.qsize())]


# ------------------------------------------------------------------ the session sends it, rate-limited and guarded


class _Control:
    def __init__(self):
        self.sent: list[bytes] = []

    async def send(self, payload: bytes) -> None:
        self.sent.append(payload)


class _State:
    frozen = False


class _Server:
    def __init__(self, features=()):
        self.features = frozenset(features)

    def supports(self, feature):
        return feature in self.features


class _Session:
    def __init__(self, control, features=()):
        self.control = control
        self.server = _Server(features)
        self.state = _State()
        self.keyframe_requested_at = float("-inf")


class _Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def _reconfigurer(session, window_id="w1", **settings):
    sessions = {window_id: session} if session is not None else {}
    reconfigurer = SessionReconfigurer(
        None, Settings(**settings), EventBus(), BroadcasterRegistry(), sessions,
        serial_getter=lambda: "SER", profile_getter=lambda: None, android_id_getter=lambda: None,
    )
    reconfigurer._clock = _Clock()
    return reconfigurer


async def _settle():
    await asyncio.sleep(0)
    await asyncio.sleep(0)


async def test_a_request_sends_reset_video_on_the_windows_control_socket():
    control = _Control()
    reconfigurer = _reconfigurer(_Session(control))

    assert reconfigurer.request_keyframe("w1", "test") is True
    await _settle()

    assert control.sent == [serialize_reset_video()]


async def test_requests_are_rate_limited_per_window():
    control = _Control()
    session = _Session(control)
    reconfigurer = _reconfigurer(session, KEYFRAME_REQUEST_MIN_INTERVAL_S=1.5)

    assert reconfigurer.request_keyframe("w1") is True
    reconfigurer._clock.now += 1.0
    assert reconfigurer.request_keyframe("w1") is False         # the keyframe is already on its way
    reconfigurer._clock.now += 0.6
    assert reconfigurer.request_keyframe("w1") is True
    await _settle()

    assert len(control.sent) == 2


async def test_nothing_is_sent_for_a_missing_frozen_or_controlless_window():
    assert _reconfigurer(None).request_keyframe("w1") is False
    frozen = _Session(_Control())
    frozen.state.frozen = True
    assert _reconfigurer(frozen).request_keyframe("w1") is False
    assert _reconfigurer(_Session(None)).request_keyframe("w1") is False


async def test_no_request_while_a_resize_waits_for_its_session_packet():
    """The resize's own encoder reset yields the keyframe — and a second reset would be taken for its confirmation."""
    control = _Control()
    reconfigurer = _reconfigurer(_Session(control))
    reconfigurer._pending_resize_acks["w1"] = _PendingAck(asyncio.get_running_loop().create_future(), None)

    assert reconfigurer.request_keyframe("w1") is False
    await _settle()
    assert control.sent == []


async def test_a_dead_control_socket_does_not_raise():
    class Broken:
        async def send(self, payload):
            raise ConnectionError("closed")

    reconfigurer = _reconfigurer(_Session(Broken()))
    assert reconfigurer.request_keyframe("w1") is True
    await _settle()                                              # the failure is swallowed in the background task


# ------------------------------------------------------------------ the video websocket carries the client's request


class _Ctx:
    def __init__(self, broadcasters):
        self.broadcasters = broadcasters


def _app(broadcasters):
    app = FastAPI()
    app.include_router(ws_router)
    app.state.ctx = _Ctx(broadcasters)
    return app


def test_a_client_can_ask_for_a_keyframe_over_its_video_socket():
    registry = BroadcasterRegistry()
    broadcaster = registry.get_or_create("w1")
    requests: list[str] = []
    broadcaster.keyframe_requester = requests.append

    with TestClient(_app(registry)).websocket_connect("/ws/video/w1") as ws:
        ws.send_text(KEYFRAME_REQUEST)
        ws.send_text("something else")                           # unknown messages are ignored, not fatal
        ws.send_text(KEYFRAME_REQUEST)
        ws.close()

    assert requests == ["client decoder resync"] * 2             # rate limiting is the session's job


def test_the_video_socket_still_delivers_frames_and_releases_the_client_on_disconnect():
    registry = BroadcasterRegistry()
    broadcaster = registry.get_or_create("w1")
    broadcaster.remember_config(b"CFG")

    with TestClient(_app(registry)).websocket_connect("/ws/video/w1") as ws:
        assert ws.receive_bytes() == b"CFG"
        assert broadcaster.client_count == 1
        ws.close()

    # the disconnect is seen even though the stream is idle (no frame to fail a send on)
    for _ in range(50):
        if broadcaster.client_count == 0:
            break
        import time
        time.sleep(0.02)
    assert broadcaster.client_count == 0


# ------------------------------------------------------------------ patched server: a keyframe without an encoder restart


def test_the_keyframe_request_is_the_one_byte_opendex_message():
    assert serialize_opendex_request_keyframe() == bytes([201])   # patch 0004: TYPE_OPENDEX_REQUEST_KEYFRAME


async def test_a_server_that_announces_it_is_asked_without_a_restart_and_nothing_else_follows_the_keyframe():
    control = _Control()
    reconfigurer = _reconfigurer(_Session(control, {"keyframe_request"}), KEYFRAME_REQUEST_FALLBACK_S=0.05)
    broadcaster = reconfigurer._broadcasters.get_or_create("w1")

    assert reconfigurer.request_keyframe("w1", "test") is True
    await _settle()
    assert control.sent == [serialize_opendex_request_keyframe()]

    await broadcaster.broadcast(b"K1", is_key_frame=True)        # the encoder honoured it
    await asyncio.sleep(0.1)
    assert control.sent == [serialize_opendex_request_keyframe()]  # no RESET_VIDEO


async def test_when_no_keyframe_follows_the_request_the_encoder_is_restarted_after_all():
    control = _Control()
    reconfigurer = _reconfigurer(_Session(control, {"keyframe_request"}), KEYFRAME_REQUEST_FALLBACK_S=0.05)
    reconfigurer._broadcasters.get_or_create("w1")

    reconfigurer.request_keyframe("w1")
    await asyncio.sleep(0.1)

    assert control.sent == [serialize_opendex_request_keyframe(), serialize_reset_video()]
