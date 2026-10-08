"""Serving a local file with HTTP Range support (a <video> seeks with it, an <audio> resumes with it).

Written out instead of leaning on a framework's FileResponse: the range rules are four lines, and what the response
carries (sandboxing headers, a download name, no caching of private files) must be exactly ours on every version.
"""
from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import AsyncIterator, Callable

from starlette.responses import Response, StreamingResponse

CHUNK = 256 * 1024
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


def parse_range(header: str | None, size: int) -> tuple[int, int] | None | str:
    """(first, last) inclusive for a satisfiable single range, None for 'send it all', 'invalid' when unsatisfiable.
    Multi-range requests are answered with the whole file (legal, and no player sends them)."""
    if not header:
        return None
    match = _RANGE.match(header.strip())
    if match is None:
        return None
    start_s, end_s = match.groups()
    if not start_s and not end_s:
        return None
    if not start_s:                                             # "-N": the last N bytes
        length = int(end_s)
        if length == 0:
            return "invalid"
        return max(0, size - length), size - 1
    start = int(start_s)
    end = min(int(end_s), size - 1) if end_s else size - 1
    if start >= size or start > end:
        return "invalid"
    return start, end


async def _iterate(path: Path, start: int, end: int) -> AsyncIterator[bytes]:
    remaining = end - start + 1
    with open(path, "rb") as stream:
        stream.seek(start)
        while remaining > 0:
            data = await asyncio.to_thread(stream.read, min(CHUNK, remaining))
            if not data:
                return
            remaining -= len(data)
            yield data


async def _iterate_bytes(data: bytes, start: int, end: int) -> AsyncIterator[bytes]:
    view = memoryview(data)
    pos = start
    while pos <= end:
        step = min(CHUNK, end - pos + 1)
        yield bytes(view[pos:pos + step])
        pos += step


def serve_stream(size: int, media_type: str, range_header: str | None, headers: dict[str, str],
                 body: Callable[[int, int], AsyncIterator[bytes]]) -> Response:
    """A body produced on demand for the (first, last) byte range the client asked for — a phone video that is never held
    in full anywhere. A stream that ends short fails the response (the Content-Length promise is not kept)."""
    base = {"Accept-Ranges": "bytes", "Cache-Control": "private, no-store", **headers}      # the caller's headers win
    wanted = parse_range(range_header, size)
    if wanted == "invalid":
        return Response(status_code=416, headers={**base, "Content-Range": f"bytes */{size}"})
    if wanted is None:
        return StreamingResponse(body(0, size - 1) if size else _empty(), media_type=media_type,
                                 headers={**base, "Content-Length": str(size)})
    start, end = wanted  # type: ignore[misc]
    return StreamingResponse(body(start, end), status_code=206, media_type=media_type,
                             headers={**base, "Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(end - start + 1)})


def serve(path: Path, size: int, media_type: str, range_header: str | None, headers: dict[str, str]) -> Response:
    return serve_stream(size, media_type, range_header, headers, lambda start, end: _iterate(path, start, end))


def serve_bytes(data: bytes, media_type: str, range_header: str | None, headers: dict[str, str]) -> Response:
    """The same for bytes held in memory (a previewed phone file, a thumbnail): nothing touches the disk."""
    return serve_stream(len(data), media_type, range_header, headers, lambda start, end: _iterate_bytes(data, start, end))


async def _empty() -> AsyncIterator[bytes]:
    return
    yield b""


def file_size(path: Path) -> int:
    return os.stat(path).st_size
