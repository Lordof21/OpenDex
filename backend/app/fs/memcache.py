"""Where previewed phone files and thumbnails live: process memory, with a byte budget — never the disk.

A file the user only LOOKED at must not be left behind in a folder. The earlier cache kept up to 512 MB of the phone's
photos and documents under ~/.opendex/cache; a preview is now held here and is gone when the backend stops. The only ways a
phone file reaches the disk are the ones the user asks for: a transfer ("indir"/"Bilgisayara kaydet") and "Bilgisayarda aç".

Least recently used items go first when the budget is exceeded. An item bigger than the whole budget is not kept (the
caller still serves the bytes it has in hand).
"""
from __future__ import annotations

import contextlib
import hashlib
import re
from collections import OrderedDict
from pathlib import Path


class MemoryCache:
    def __init__(self, max_bytes: int) -> None:
        self._max = max(0, int(max_bytes))
        self._items: OrderedDict[str, tuple[str, bytes]] = OrderedDict()
        self._used = 0

    @staticmethod
    def key(*parts: object) -> str:
        return hashlib.sha256("\x00".join(str(p) for p in parts).encode("utf-8")).hexdigest()

    @property
    def bytes_used(self) -> int:
        return self._used

    def get(self, key: str) -> tuple[str, bytes] | None:
        """(media type, bytes), or None. A hit becomes the most recently used."""
        item = self._items.get(key)
        if item is not None:
            self._items.move_to_end(key)
        return item

    def put(self, key: str, data: bytes, media_type: str = "") -> bool:
        """True when the item is kept."""
        self._drop(key)
        if len(data) > self._max:
            return False
        self._items[key] = (media_type, data)
        self._used += len(data)
        while self._used > self._max:
            oldest = next(iter(self._items))
            self._drop(oldest)
        return True

    def clear(self) -> None:
        self._items.clear()
        self._used = 0

    def _drop(self, key: str) -> None:
        item = self._items.pop(key, None)
        if item is not None:
            self._used -= len(item[1])


# What the earlier disk cache wrote: `<2 hex>/<64 hex>[.bin|.webp|.jpg]` and its unfinished `….<pid>[.<id>].tmp` twins.
_LEGACY_NAME = re.compile(r"^[0-9a-f]{64}(\.[a-z]+)?(\.\d+(\.\d+)?\.tmp)?$")


def purge_legacy_disk_cache(root: Path) -> int:
    """Deletes the files an older version cached on disk for previews and thumbnails (only files that match what it wrote,
    only below `root`); returns how many went. Never raises: a locked file is left for the next start."""
    removed = 0
    try:
        buckets = [p for p in root.iterdir() if p.is_dir() and re.fullmatch(r"[0-9a-f]{2}", p.name)]
    except OSError:
        return 0
    for bucket in buckets:
        for item in bucket.iterdir():
            if item.is_file() and _LEGACY_NAME.match(item.name):
                with contextlib.suppress(OSError):
                    item.unlink()
                    removed += 1
        with contextlib.suppress(OSError):
            bucket.rmdir()                                       # only succeeds when nothing foreign is left in it
    with contextlib.suppress(OSError):
        root.rmdir()
    return removed
