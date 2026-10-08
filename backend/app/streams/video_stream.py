"""Video socket reader.

Reads with asyncio.StreamReader (never a blocking socket.recv). Every 12-byte
block read from the video socket is ONE of two kinds, discriminated by the top
bit of byte 0 (scrcpy v4.x, PR #6159 "Add session metadata for the video
stream"):

  * SESSION packet (byte[0] & 0x80): carries NO trailing payload. Bytes 4:8 =
    video width (u32 BE), bytes 8:12 = video height (u32 BE), bit 0 of byte 3
    = "client_resized" — set when this packet is the direct result of a
    RESIZE_DISPLAY control message WE sent (a flex-display resize), clear for
    the very first session packet at stream start.
  * MEDIA packet (byte[0] & 0x80 == 0): the pre-v4.x header shape, shifted
    down one bit to make room for the new session-packet discriminator:
        8 bytes  PTS + flags (bit62 = config packet, bit61 = keyframe)
        4 bytes  packet length (big endian)
    followed by exactly that many payload bytes.

v3.3.1 used bit63/bit62 for config/keyframe with no session-packet concept at
all; those two flags moved down by one bit in v4.x specifically to free bit63
as the session-packet discriminator. Verified against scrcpy v4.0 AND v4.1
source (app/src/demuxer.c).
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable

log = logging.getLogger(__name__)

HEADER_SIZE = 12

# v4.x bit layout (shifted down one bit from v3.3.1 — see module docstring).
FLAG_SESSION = 1 << 63
FLAG_CONFIG = 1 << 62
FLAG_KEY_FRAME = 1 << 61
PTS_MASK = (1 << 61) - 1

_CLIENT_RESIZED_BIT = 0x01  # byte[3] bit 0 — only meaningful on a session header


@dataclass(frozen=True)
class FrameMeta:
    pts_us: int
    is_config: bool
    is_key_frame: bool
    size: int


@dataclass(frozen=True)
class SessionMeta:
    """A v4.x "session packet" — announces the encoder's actual output size.
    Carries no payload of its own; never forwarded to WS video clients (the
    frontend's videoDecoder.js only understands header+NAL chunks)."""

    width: int
    height: int
    client_resized: bool


def is_session_header(header: bytes) -> bool:
    if len(header) != HEADER_SIZE:
        raise ValueError(f"header must be {HEADER_SIZE} bytes, got {len(header)}")
    return bool(header[0] & 0x80)


def parse_frame_header(header: bytes) -> FrameMeta:
    if len(header) != HEADER_SIZE:
        raise ValueError(f"frame header must be {HEADER_SIZE} bytes, got {len(header)}")
    pts_and_flags = int.from_bytes(header[:8], "big")
    size = int.from_bytes(header[8:12], "big")
    return FrameMeta(
        pts_us=pts_and_flags & PTS_MASK,
        is_config=bool(pts_and_flags & FLAG_CONFIG),
        is_key_frame=bool(pts_and_flags & FLAG_KEY_FRAME),
        size=size,
    )


def parse_session_header(header: bytes) -> SessionMeta:
    if len(header) != HEADER_SIZE:
        raise ValueError(f"session header must be {HEADER_SIZE} bytes, got {len(header)}")
    return SessionMeta(
        width=int.from_bytes(header[4:8], "big"),
        height=int.from_bytes(header[8:12], "big"),
        client_resized=bool(header[3] & _CLIENT_RESIZED_BIT),
    )


_SPS_NAL_TYPE = 7
_START_CODE_3 = b"\x00\x00\x01"
_START_CODE_4 = b"\x00\x00\x00\x01"


@dataclass(frozen=True)
class SpsProfile:
    """Diagnostic only. RFC 6381 codec strings like 'avc1.640028' encode
    exactly these three bytes as PP.CC.LL — the first three RBSP bytes right
    after any NAL header are always (profile_idc, constraint_flags,
    level_idc). Exists because scrcpy_launcher.py's _build_command() never
    sends video_codec_options=profile=...,level=... — nothing pins the
    on-device encoder to a specific profile, so videoDecoder.js's hardcoded
    'avc1.42E01E' (Baseline) is only ever a GUESS about what the hardware
    actually produces.
    """

    profile_idc: int
    level_idc: int


def find_sps_profile(config_payload: bytes) -> SpsProfile | None:
    """Scans an Annex-B config-packet payload (SPS+PPS, start codes intact)
    for the first SPS NAL. Diagnostic-only: does not handle emulation-
    prevention bytes (0x03) since none can legally appear this early in a
    valid SPS RBSP — good enough to log, not a general-purpose parser.
    """
    i, n = 0, len(config_payload)
    while i < n:
        if config_payload[i:i + 3] == _START_CODE_3:
            nal_start = i + 3
        elif config_payload[i:i + 4] == _START_CODE_4:
            nal_start = i + 4
        else:
            i += 1
            continue
        if nal_start >= n:
            break
        if (config_payload[nal_start] & 0x1F) == _SPS_NAL_TYPE and nal_start + 3 < n:
            return SpsProfile(
                profile_idc=config_payload[nal_start + 1],
                level_idc=config_payload[nal_start + 3],
            )
        i = nal_start
    return None


async def read_video_socket(
    reader: asyncio.StreamReader,
    on_chunk: Callable[[FrameMeta, bytes], Awaitable[None]],
    on_session: Callable[[SessionMeta], Awaitable[None]] | None = None,
) -> None:
    """Pumps header(+payload) units until EOF.

    ``on_chunk`` keeps its exact pre-v4.x contract: parsed media-packet meta
    plus the full wire chunk (header included), forwarded verbatim to the
    broadcaster/WS clients.

    ``on_session`` fires for a v4.x session packet — used by window_manager to
    resolve a pending flex-resize confirmation. Never confused with on_chunk:
    a session packet has no NAL payload, so it is consumed here and never
    reaches the broadcaster.
    """
    try:
        while True:
            header = await reader.readexactly(HEADER_SIZE)
            if is_session_header(header):
                if on_session is not None:
                    await on_session(parse_session_header(header))
                continue  # no payload follows a session packet
            meta = parse_frame_header(header)
            payload = await reader.readexactly(meta.size)
            await on_chunk(meta, header + payload)
    except asyncio.IncompleteReadError:
        log.info("video socket closed by server")
    except asyncio.CancelledError:
        raise
