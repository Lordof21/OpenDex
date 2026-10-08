"""12-byte header parsing, NAL boundaries, audio/video separation, broadcaster.

scrcpy v4.x protocol note: FLAG_CONFIG/FLAG_KEY_FRAME sit one bit lower than
in v3.3.1 (bit62/bit61 instead of bit63/bit62) to make room for a new top-bit
"session packet" discriminator (PR #6159) — see video_stream.py's docstring. Every test below goes through the
named constants, never a hardcoded shift, so it is agnostic to exactly which
bit each flag lives at.
"""
import asyncio
import struct

import pytest

from app.streams.audio_stream import read_audio_socket
from app.streams.broadcaster import AUDIO_KEY, CLOSE_SENTINEL, BroadcasterRegistry
from app.streams.video_stream import (
    FLAG_CONFIG,
    FLAG_KEY_FRAME,
    HEADER_SIZE,
    find_sps_profile,
    is_session_header,
    parse_frame_header,
    parse_session_header,
    read_video_socket,
)


def _header(pts: int, size: int, *, config=False, key=False) -> bytes:
    value = pts
    if config:
        value |= FLAG_CONFIG
    if key:
        value |= FLAG_KEY_FRAME
    return value.to_bytes(8, "big") + size.to_bytes(4, "big")


def _session_header(width: int, height: int, *, client_resized: bool) -> bytes:
    flags = 0x80000000 | (1 if client_resized else 0)
    return struct.pack("!III", flags, width, height)


def _annex_b_nal(nal_type: int, *rbsp_bytes: int, start_code_4=False) -> bytes:
    start = b"\x00\x00\x00\x01" if start_code_4 else b"\x00\x00\x01"
    return start + bytes([nal_type, *rbsp_bytes])


class TestFindSpsProfile:
    """Diagnostic-only SPS profile/level scan. The flex-display work established the real Annex-B header shape; this
    checks the SEPARATE question of what profile/level byte the config
    packet's SPS NAL actually carries (videoDecoder.js hardcodes Baseline/L3.0
    as a guess, since scrcpy_launcher.py never pins an encoder profile)."""

    def test_extracts_profile_and_level_from_an_sps_nal(self):
        # NAL type 7 = SPS; RBSP byte 0 = profile_idc, byte 1 = constraint
        # flags (ignored), byte 2 = level_idc.
        payload = _annex_b_nal(7, 0x64, 0x00, 0x1F, 0xAC, 0xD9)  # High profile, level 3.1
        sps = find_sps_profile(payload)
        assert sps is not None
        assert (sps.profile_idc, sps.level_idc) == (0x64, 0x1F)

    def test_returns_none_when_only_a_pps_nal_is_present(self):
        payload = _annex_b_nal(8, 0xE9, 0x78)  # NAL type 8 = PPS, no SPS here
        assert find_sps_profile(payload) is None

    def test_skips_a_leading_pps_to_find_the_sps_that_follows(self):
        # A real config packet is SPS+PPS together — order isn't guaranteed,
        # so this must not stop at the first NAL it sees.
        payload = _annex_b_nal(8, 0xE9, 0x78) + _annex_b_nal(7, 0x4D, 0x00, 0x28)
        sps = find_sps_profile(payload)
        assert sps is not None
        assert (sps.profile_idc, sps.level_idc) == (0x4D, 0x28)  # Main, level 4.0

    def test_handles_a_4_byte_start_code(self):
        payload = _annex_b_nal(7, 0x42, 0x00, 0x1E, start_code_4=True)  # Baseline, level 3.0
        sps = find_sps_profile(payload)
        assert sps is not None
        assert (sps.profile_idc, sps.level_idc) == (0x42, 0x1E)

    def test_returns_none_for_empty_or_garbage_input(self):
        assert find_sps_profile(b"") is None
        assert find_sps_profile(b"\x01\x02\x03\x04") is None


class TestFrameHeader:
    def test_plain_frame(self):
        meta = parse_frame_header(_header(123_456, 99))
        assert meta.pts_us == 123_456
        assert meta.size == 99
        assert not meta.is_config and not meta.is_key_frame

    def test_config_packet_flag(self):
        meta = parse_frame_header(_header(0, 32, config=True))
        assert meta.is_config
        assert meta.pts_us == 0

    def test_key_frame_flag_and_pts_mask(self):
        meta = parse_frame_header(_header(42, 10, key=True))
        assert meta.is_key_frame
        assert meta.pts_us == 42  # flags never leak into PTS

    def test_wrong_size_rejected(self):
        with pytest.raises(ValueError):
            parse_frame_header(b"\x00" * (HEADER_SIZE - 1))


class TestSessionHeader:
    """scrcpy v4.x session packet — announces the encoder's actual output
    size, no payload of its own. See video_stream.py docstring."""

    def test_round_trip(self):
        header = _session_header(1920, 1032, client_resized=True)
        assert is_session_header(header)
        meta = parse_session_header(header)
        assert (meta.width, meta.height, meta.client_resized) == (1920, 1032, True)

    def test_client_resized_false_for_initial_handshake(self):
        meta = parse_session_header(_session_header(1280, 720, client_resized=False))
        assert meta.client_resized is False

    def test_media_header_not_detected_as_session(self):
        assert not is_session_header(_header(123, 10))

    def test_config_and_key_frame_flags_do_not_look_like_a_session_packet(self):
        # Top bit (byte[0] & 0x80) must stay 0 for every ordinary media
        # packet, config or not, keyframe or not — only the NEW discriminator
        # bit distinguishes a session packet, never FLAG_CONFIG/FLAG_KEY_FRAME.
        assert not is_session_header(_header(0, 1, config=True))
        assert not is_session_header(_header(0, 1, key=True))

    def test_wrong_size_rejected(self):
        with pytest.raises(ValueError):
            parse_session_header(b"\x00" * (HEADER_SIZE - 1))


async def test_read_video_socket_routes_session_packets_to_on_session_not_on_chunk():
    """A session packet must never reach the broadcaster/WS clients (it has no
    NAL payload — the frontend's videoDecoder.js would desync trying to parse
    it as a media chunk); it is consumed here and only here."""
    reader = asyncio.StreamReader()
    reader.feed_data(_session_header(1600, 900, client_resized=True))
    reader.feed_data(_header(1, 3, key=True) + b"KEY")  # an ordinary frame follows
    reader.feed_eof()

    chunks: list[bytes] = []
    sessions: list = []

    async def on_chunk(meta, chunk):
        chunks.append(chunk)

    async def on_session(meta):
        sessions.append(meta)

    await read_video_socket(reader, on_chunk, on_session)

    assert len(sessions) == 1
    assert (sessions[0].width, sessions[0].height) == (1600, 900)
    assert len(chunks) == 1  # only the ordinary media packet reached on_chunk


async def test_read_video_socket_works_without_an_on_session_callback():
    """on_session is optional — callers that don't care about mid-stream
    resize confirmations (i.e. everyone except window_manager) must not be
    forced to supply one."""
    reader = asyncio.StreamReader()
    reader.feed_data(_session_header(1280, 720, client_resized=False))
    reader.feed_eof()

    chunks: list[bytes] = []

    async def on_chunk(meta, chunk):
        chunks.append(chunk)

    await read_video_socket(reader, on_chunk)
    assert chunks == []


async def test_read_audio_socket_ignores_an_unexpected_session_header():
    """Defense in depth (audio_stream.py): scrcpy never actually emits a
    session packet on the audio socket, but the header SHAPE is shared code
    on scrcpy's side — if one ever arrived, blindly parsing it as a media
    header would misread its height field as a payload length and desync the
    whole socket. Confirms it is skipped, not misparsed."""
    reader = asyncio.StreamReader()
    reader.feed_data(_session_header(999, 999, client_resized=False))
    payload = b"\x01\x02\x03\x04"
    reader.feed_data(_header(5, len(payload)) + payload)
    reader.feed_eof()

    received: list[tuple] = []

    async def on_chunk(meta, chunk):
        received.append((meta, chunk))

    await read_audio_socket(reader, on_chunk)

    assert len(received) == 1
    assert received[0][0].pts_us == 5


async def test_read_video_socket_preserves_packet_boundaries():
    reader = asyncio.StreamReader()
    payload_a, payload_b = b"\x00\x00\x01A" * 3, b"\x00\x00\x01B" * 5
    reader.feed_data(_header(1, len(payload_a), config=True) + payload_a)
    reader.feed_data(_header(2, len(payload_b), key=True) + payload_b)
    reader.feed_eof()

    received: list[tuple] = []

    async def on_chunk(meta, chunk):
        received.append((meta, chunk))

    await read_video_socket(reader, on_chunk)

    assert len(received) == 2
    meta_a, chunk_a = received[0]
    assert meta_a.is_config and chunk_a.endswith(payload_a)
    meta_b, chunk_b = received[1]
    assert meta_b.is_key_frame and chunk_b.endswith(payload_b)
    assert len(chunk_b) == HEADER_SIZE + len(payload_b)


class TestBroadcaster:
    async def test_late_joiner_receives_config_first(self):
        registry = BroadcasterRegistry()
        b = registry.get_or_create("w1")
        config_chunk = _header(0, 4, config=True) + b"SPS!"
        b.remember_config(config_chunk)
        await b.broadcast(_header(1, 3) + b"abc")

        _, queue = b.register()  # joins after the stream started
        assert queue.get_nowait() == config_chunk

    async def test_late_joiner_replays_config_plus_gop_from_keyframe(self):
        """Regression: a client subscribing after the stream started must get
        SPS/PPS + the last keyframe + following deltas — otherwise the decoder
        has nothing decodable until the next keyframe, which a static virtual
        display may never produce (black-screen field bug)."""
        registry = BroadcasterRegistry()
        b = registry.get_or_create("w1")
        config = _header(0, 4, config=True) + b"SPS!"
        b.remember_config(config)
        await b.broadcast(config, is_config=True)
        old_key = _header(1, 3, key=True) + b"OLD"
        await b.broadcast(old_key, is_key_frame=True)
        new_key = _header(2, 3, key=True) + b"KEY"
        await b.broadcast(new_key, is_key_frame=True)  # resets the GOP anchor
        delta = _header(3, 3) + b"DLT"
        await b.broadcast(delta)

        _, queue = b.register()  # late joiner
        replay = [queue.get_nowait() for _ in range(queue.qsize())]
        assert replay == [config, new_key, delta]  # old GOP gone, order intact

    async def test_config_packets_never_pollute_the_gop_cache(self):
        registry = BroadcasterRegistry()
        b = registry.get_or_create("w1")
        key = _header(1, 3, key=True) + b"KEY"
        await b.broadcast(key, is_key_frame=True)
        config = _header(2, 4, config=True) + b"SPS2"
        b.remember_config(config)
        await b.broadcast(config, is_config=True)

        _, queue = b.register()
        replay = [queue.get_nowait() for _ in range(queue.qsize())]
        assert replay == [config, key]  # config once (from remember), not twice

    async def test_audio_full_queue_drops_oldest_keeps_newest(self):
        """Ses kodek-bağımlı DEĞİLDİR: tıkanınca en eski parça atılır (tazelik önce)."""
        registry = BroadcasterRegistry()
        b = registry.get_audio_broadcaster()
        _, queue = b.register()
        for i in range(b.queue_size + 3):
            await b.broadcast(_header(i, 1) + bytes([i % 256]))
        assert queue.qsize() == b.queue_size
        first = queue.get_nowait()
        assert parse_frame_header(first[:HEADER_SIZE]).pts_us == 3  # 0..2 dropped

    async def test_video_client_without_a_keyframe_is_not_fed_undecodable_deltas(self):
        """Eski davranış (video kuyruğunda 'en eskiyi at') referans zincirini kırıyordu; artık
        keyframe'siz bir video istemcisine delta kare hiç gönderilmez, keyframe gelince akış
        onunla başlar (ayrıntılı GOP değişmezleri: test_broadcaster.py)."""
        registry = BroadcasterRegistry()
        b = registry.get_or_create("w1")
        _, queue = b.register()
        for i in range(b.QUEUE_SIZE + 3):
            await b.broadcast(_header(i, 1) + bytes([i % 256]))
        assert queue.qsize() == 0
        key = _header(99, 3, key=True) + b"KEY"
        await b.broadcast(key, is_key_frame=True)
        assert queue.get_nowait() == key

    async def test_remove_signals_close_sentinel(self):
        registry = BroadcasterRegistry()
        b = registry.get_or_create("w1")
        _, queue = b.register()
        registry.remove("w1")
        assert queue.get_nowait() == CLOSE_SENTINEL

    async def test_audio_broadcaster_is_shared_and_separate_from_video(self):
        registry = BroadcasterRegistry()
        video = registry.get_or_create("w1")
        audio1 = registry.get_audio_broadcaster()
        audio2 = registry.get_audio_broadcaster()
        assert audio1 is audio2          # one session-wide audio
        assert audio1 is not video       # never mixed with per-window video
        assert registry.get(AUDIO_KEY) is audio1
