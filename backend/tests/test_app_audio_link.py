"""AppAudioLink framing: daemon frames → legacy 12-byte-header chunks, END flags, desync."""
import asyncio
import struct

import pytest

from app.streams.app_audio_link import (
    FLAG_END,
    HEADER,
    SCRCPY_HEADER,
    AppAudioLink,
    parse_header,
    reframe,
)


def frame(stream_id: int, pts_us: int, payload: bytes, flags: int = 0) -> bytes:
    return HEADER.pack(stream_id, flags, pts_us, len(payload)) + payload


def test_header_round_trip():
    raw = HEADER.pack(7, 0, 123456789, 3840)
    assert parse_header(raw) == (7, 0, 123456789, 3840)


def test_insane_size_is_a_desync_not_a_huge_read():
    with pytest.raises(ValueError):
        parse_header(HEADER.pack(1, 0, 0, 50_000_000))


def test_reframe_speaks_the_legacy_12_byte_header():
    chunk = reframe(123, b"\x01\x02\x03\x04")
    assert len(SCRCPY_HEADER.pack(1, 2)) == 12
    assert struct.unpack(">QI", chunk[:12]) == (123, 4)
    assert chunk[12:] == b"\x01\x02\x03\x04"


def _link(frames: list, ends: list) -> AppAudioLink:
    async def on_frame(stream_id, chunk):
        frames.append((stream_id, chunk))

    async def on_end(stream_id):
        ends.append(stream_id)

    return AppAudioLink(adb=None, on_frame=on_frame, on_end=on_end)


async def test_pump_reframes_pcm_per_stream_and_reports_ends():
    frames, ends = [], []
    reader = asyncio.StreamReader()
    reader.feed_data(frame(1, 1000, b"ab" * 4) + frame(2, 2000, b"cd" * 4) + frame(1, 0, b"", FLAG_END))
    reader.feed_eof()

    got_data = await _link(frames, ends)._pump(reader)

    assert got_data is True
    assert [sid for sid, _ in frames] == [1, 2]
    assert frames[0][1] == reframe(1000, b"ab" * 4)
    assert ends == [1]


async def test_pump_without_any_frame_reports_no_data_so_backoff_keeps_growing():
    reader = asyncio.StreamReader()
    reader.feed_eof()     # adb forward accepted the connect, nothing listens on the phone
    assert await _link([], [])._pump(reader) is False


async def test_desynced_stream_ends_the_connection_instead_of_reading_garbage():
    frames, ends = [], []
    reader = asyncio.StreamReader()
    reader.feed_data(frame(1, 1, b"xy") + HEADER.pack(1, 0, 0, 99_999_999) + b"junk")
    reader.feed_eof()
    assert await _link(frames, ends)._pump(reader) is True
    assert len(frames) == 1
