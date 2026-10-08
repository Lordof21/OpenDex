"""Thumbnails: the PC's images by Pillow, the phone's photos/videos/music art by the phone's own decoder (fs_thumb), both
kept in memory (memcache.py — a thumbnail is a preview: it never reaches the disk) under a key that contains the file's size
and modification time — an edited file gets a new thumbnail and an unchanged one is not decoded twice.
"""
from __future__ import annotations

import asyncio
import io
import os
from pathlib import Path
from typing import BinaryIO

from .content import can_thumbnail_on_pc
from .errors import FsError
from .memcache import MemoryCache

MAX_SOURCE_BYTES = 64 * 1024 * 1024
PULL_MAX_BYTES = 24 * 1024 * 1024          # a phone photo this big is fetched and decoded here when the phone cannot do it
WIRELESS_PULL_MAX_BYTES = 6 * 1024 * 1024  # ...but over Wi-Fi the daemon's ~20 KB thumbnail is the way; only small photos are pulled
Thumb = tuple[str, bytes]                  # (media type, bytes)


def _render(source: str | BinaryIO, px: int) -> bytes:
    from PIL import Image, ImageOps

    with Image.open(source) as image:
        if image.format == "JPEG":
            image.draft("RGB", (px * 2, px * 2))              # decode at 1/2–1/8 scale: most of the time of a big photo
        image = ImageOps.exif_transpose(image)
        image.thumbnail((px, px), Image.Resampling.LANCZOS)
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        out = io.BytesIO()
        image.save(out, "WEBP", quality=80, method=4)
        return out.getvalue()


class Thumbnailer:
    def __init__(self, cache: MemoryCache, *, concurrency: int = 2) -> None:
        self._cache = cache
        self._cpu = asyncio.Semaphore(concurrency)              # decoding is CPU work: never let it starve the event loop
        self._pulls = asyncio.Semaphore(2)                      # and fetching a photo takes a sync stream of its own
        self._inflight: dict[str, asyncio.Future[Thumb]] = {}

    async def for_pc(self, path: Path, px: int) -> Thumb:
        if not can_thumbnail_on_pc(path.name):
            raise FsError("unsupported", "Bu dosya türü için küçük resim yok.")
        st = await asyncio.to_thread(os.stat, path)
        if st.st_size > MAX_SOURCE_BYTES:
            raise FsError("too_large", "Dosya küçük resim için çok büyük.")
        key = MemoryCache.key("pc", path, px, st.st_mtime_ns, st.st_size)

        async def make() -> Thumb:
            async with self._cpu:
                try:
                    data = await asyncio.to_thread(_render, str(path), px)
                except Exception as exc:                        # a corrupt or exotic image: the icon stays, nothing breaks
                    raise FsError("unsupported", "Resim çözülemedi.", detail=str(exc)) from exc
            return "image/webp", data

        return await self._shared(key, make)

    async def for_phone(self, phone, serial: str, path: str, px: int, mtime: float, size: int) -> Thumb:
        key = MemoryCache.key("phone", serial, path, px, int(mtime), size)

        async def make() -> Thumb:
            got = await phone.thumbnail(path, px)
            if got is None:
                got = await self._decode_here(phone, path, px, size)
            if got is None:
                raise FsError("unsupported", "Bu dosya için küçük resim yok.")
            return got

        return await self._shared(key, make)

    async def _decode_here(self, phone, path: str, px: int, size: int) -> Thumb | None:
        """The phone's decoder is not available (daemon not connected yet — e.g. while the session moves to Wi-Fi —, an
        older jar, a format it refuses): fetch the photo over sync and decode it with Pillow. Only images, only up to
        PULL_MAX_BYTES (less over Wi-Fi), two at a time. The daemon stays the first choice: it sends ~20 KB, not the photo.
        The photo is held in memory for the decode and dropped: nothing is written to the disk."""
        wireless = ":" in phone.serial or phone.serial.startswith("adb-")          # ip:port, or an mDNS name
        limit = WIRELESS_PULL_MAX_BYTES if wireless else PULL_MAX_BYTES
        if not can_thumbnail_on_pc(path) or size > limit:
            return None
        async with self._pulls:
            photo = bytearray()
            reader = await phone.open_reader(path)
            try:
                async for chunk in reader.chunks():
                    photo += chunk
                    if len(photo) > limit:                      # it grew since the listing
                        return None
            finally:
                await reader.aclose()
            try:
                async with self._cpu:
                    return "image/webp", await asyncio.to_thread(_render, io.BytesIO(bytes(photo)), px)
            except Exception as exc:                            # a corrupt or exotic image: the icon stays
                raise FsError("unsupported", "Resim çözülemedi.", detail=str(exc)) from exc

    async def _shared(self, key: str, make) -> Thumb:
        """One decode per key at a time: a grid asks for the same thumbnail from several places while it scrolls."""
        hit = self._cache.get(key)
        if hit:
            return hit
        pending = self._inflight.get(key)
        if pending is not None:
            return await asyncio.shield(pending)
        future: asyncio.Future[Thumb] = asyncio.get_running_loop().create_future()
        self._inflight[key] = future
        try:
            media_type, data = await make()
            self._cache.put(key, data, media_type)
            future.set_result((media_type, data))
            return media_type, data
        except BaseException as exc:
            future.set_exception(exc)
            future.exception()                                  # retrieved: no "never retrieved" noise when nobody else waits
            raise
        finally:
            self._inflight.pop(key, None)
