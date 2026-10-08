"""What the transfer engine and the service need from a provider — one contract for the PC and the phone.

Paths are strings in the provider's own syntax (native on the PC, POSIX on the phone) and every method validates them
itself: the provider is the last line of defence, whatever called it.
"""
from __future__ import annotations

from typing import AsyncIterator, Protocol, runtime_checkable

from ..models import Entry, FreeSpace, WalkItem

CHUNK_BYTES = 1 << 20        # what a reader yields at a time (the phone's wire cuts it into 64 KiB DATA frames)


class ResumeRejected(Exception):
    """A writer was asked to continue a partial file that is not exactly what the engine thinks it is (gone, shorter,
    longer). Not a failure: the engine drops the leftover and starts the file again from its first byte."""


@runtime_checkable
class Reader(Protocol):
    """An open file being read. `size` is known up front (STAT/stat before the first byte). A reader opened with
    `offset=N` (providers with `resumable_read`) yields the bytes from N on; `size` is still the whole file's."""

    size: int

    def chunks(self) -> AsyncIterator[bytes]: ...

    async def aclose(self) -> None: ...


@runtime_checkable
class Writer(Protocol):
    """A file being written ATOMICALLY: bytes go to a hidden temporary sibling; `commit` publishes it under the final
    name (rename), `abort` removes it. Nothing is ever visible under the final name half-written."""

    async def write(self, data: bytes) -> None: ...

    async def commit(self, *, mtime: float | None) -> None: ...

    async def abort(self) -> None: ...


# A writer MAY also offer `async def suspend(self) -> int`: close the file but KEEP the temporary file, returning the number
# of bytes it holds (the engine continues it later through `open_writer(..., resume_at=that)`). Only providers that set
# `resumable_write` do; the engine never resumes into a destination without it.


@runtime_checkable
class FsProvider(Protocol):
    name: str
    casefold: bool           # do two names that differ only by case collide? (Windows/macOS yes, the phone no)
    windows: bool            # must names obey Windows rules? (names.validate_name / windows_safe_name)
    resumable_read: bool     # `open_reader(path, offset=N)` can start at byte N (a pulled file continues where it stopped)
    resumable_write: bool    # `open_writer(..., resume_at=N)` can continue a kept partial file (and writers `suspend`)

    def list(self, path: str) -> AsyncIterator[list[Entry]]: ...

    async def stat(self, path: str) -> Entry: ...

    async def names(self, path: str) -> set[str]: ...

    async def mkdir(self, path: str, *, parents: bool = False) -> None: ...

    async def rename(self, src: str, dst: str, *, overwrite: bool = False) -> None: ...

    async def delete(self, path: str) -> None: ...

    async def free_space(self, path: str) -> FreeSpace: ...

    def walk(self, path: str) -> AsyncIterator[WalkItem]: ...

    async def open_reader(self, path: str, *, offset: int = 0) -> Reader: ...

    async def open_writer(self, path: str, *, size: int, tag: str, overwrite: bool = False, resume_at: int = 0) -> Writer: ...

    def canonical(self, path: str, *, follow_leaf: bool = True) -> str: ...

    async def checksum(self, path: str) -> str: ...

    def join(self, parent: str, name: str) -> str: ...

    def parent(self, path: str) -> str: ...

    def basename(self, path: str) -> str: ...
