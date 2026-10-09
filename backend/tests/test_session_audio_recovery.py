"""SessionAudio (the legacy session-wide /ws/audio stream) reopens itself when its audio socket ends unasked.

It used to stay silent until a window happened to open: nothing noticed that the pump had ended.
"""
import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.streams import audio_stream
from app.streams.audio_stream import SessionAudio
from app.streams.broadcaster import BroadcasterRegistry


class _FakeServer:
    """Stands in for ScrcpyServer; ``reader`` is what the audio pump reads — ``feed_eof()`` kills the stream."""

    created: list["_FakeServer"] = []
    unreachable = 0                       # the next N attempts fail (the phone is offline)

    def __init__(self, adb, settings, serial):
        self.reader = asyncio.StreamReader()
        self.stopped = False
        self.audio_dup = None
        _FakeServer.created.append(self)

    async def push_server(self):
        if _FakeServer.unreachable:
            _FakeServer.unreachable -= 1
            raise ConnectionError("device offline")

    async def start_forward(self):
        pass

    async def spawn(self, *, audio_dup, **_):
        self.audio_dup = audio_dup

    async def connect_sockets(self, **_):
        return MagicMock(audio=(self.reader, None), audio_codec="raw")

    async def stop(self):
        self.stopped = True


@pytest.fixture
def audio(monkeypatch):
    _FakeServer.created, _FakeServer.unreachable = [], 0
    monkeypatch.setattr(audio_stream, "ScrcpyServer", _FakeServer)
    monkeypatch.setattr(SessionAudio, "RESTART_BASE_S", 0.01)
    monkeypatch.setattr(SessionAudio, "RESTART_MAX_S", 0.04)
    return SessionAudio(MagicMock(shell=AsyncMock()), MagicMock(), BroadcasterRegistry())


async def _until(predicate, timeout=2.0):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while not predicate():
        assert loop.time() < deadline, "condition never became true"
        await asyncio.sleep(0.005)


async def test_a_stream_that_ends_on_its_own_is_reopened_in_the_same_mode(audio):
    await audio.start_session_audio("SER", output_mode="both")
    first = _FakeServer.created[0]

    first.reader.feed_eof()

    await _until(lambda: len(_FakeServer.created) == 2 and audio.running)
    assert first.stopped, "the dead server is torn down, not orphaned by its replacement"
    assert _FakeServer.created[1].audio_dup is True
    await audio.stop_session_audio()


async def test_reopening_is_retried_until_the_phone_answers(audio):
    await audio.start_session_audio("SER")
    _FakeServer.unreachable = 3
    _FakeServer.created[0].reader.feed_eof()

    await _until(lambda: audio.running and len(_FakeServer.created) == 5)
    assert all(server.stopped for server in _FakeServer.created[:-1]), "no failed attempt leaves a half-built server behind"
    await audio.stop_session_audio()


async def test_a_stop_is_not_a_loss(audio):
    await audio.start_session_audio("SER")
    await audio.stop_session_audio()
    await asyncio.sleep(0.15)
    assert len(_FakeServer.created) == 1 and not audio.running


async def test_a_start_while_waiting_to_reopen_replaces_the_wait(audio, monkeypatch):
    monkeypatch.setattr(SessionAudio, "RESTART_BASE_S", 0.2)
    await audio.start_session_audio("SER", output_mode="pc")
    _FakeServer.created[0].reader.feed_eof()
    await _until(lambda: audio._pump_task.done())

    await audio.start_session_audio("SER", output_mode="both")       # e.g. the output setting changed meanwhile
    await asyncio.sleep(0.4)

    assert len(_FakeServer.created) == 2, "one stream, not the new one plus the old keeper's reopen"
    assert _FakeServer.created[1].audio_dup is True
    await audio.stop_session_audio()


async def test_consecutive_losses_wait_longer_before_reopening(audio, monkeypatch):
    monkeypatch.setattr(SessionAudio, "RESTART_BASE_S", 0.05)
    monkeypatch.setattr(SessionAudio, "RESTART_MAX_S", 1.0)
    await audio.start_session_audio("SER")
    loop = asyncio.get_running_loop()
    waits = []
    for _ in range(3):
        count = len(_FakeServer.created)
        _FakeServer.created[-1].reader.feed_eof()
        t0 = loop.time()
        await _until(lambda: len(_FakeServer.created) == count + 1 and audio.running)
        waits.append(loop.time() - t0)
    assert waits[0] < waits[1] < waits[2], waits
    await audio.stop_session_audio()
