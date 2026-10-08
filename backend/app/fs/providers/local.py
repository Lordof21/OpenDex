"""This PC's file system, behind the same contract as the phone's.

All blocking I/O runs in worker threads (`asyncio.to_thread`) so a slow disk, a sleeping HDD or a network share never
stalls the event loop that also carries video frames. Every path goes through `RootRegistry.check` first.
"""
from __future__ import annotations

import asyncio
import contextlib
import errno
import functools
import hashlib
import os
import shutil
import stat as stat_mod
import sys
import time
from collections import deque
from pathlib import Path
from typing import AsyncIterator, Callable

from ..errors import FsError, from_oserror
from ..models import Entry, FreeSpace, WalkItem
from ..names import split_extension, validate_name
from ..roots import RootRegistry
from .base import CHUNK_BYTES, Reader, ResumeRejected, Writer

_IS_WINDOWS = sys.platform == "win32"
_FILE_ATTRIBUTE_READONLY = 0x1
_FILE_ATTRIBUTE_HIDDEN = 0x2
_FILE_ATTRIBUTE_SYSTEM = 0x4
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400
PAGE = 1000
# Executables a user can double-click into running. A file that comes from the phone gets Windows' "downloaded from the
# Internet" mark for these, so SmartScreen asks before the first run — the same protection a browser download gets.
RISKY_EXTENSIONS = frozenset({
    ".exe", ".msi", ".bat", ".cmd", ".com", ".scr", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".hta", ".lnk",
    ".jar", ".reg", ".cpl", ".msc", ".dll",
})


def _verbatim(path: str) -> str:
    """Windows' 260-character MAX_PATH does not apply to `\\\\?\\` paths: a deep tree from the phone must not fail on the PC."""
    if not _IS_WINDOWS or path.startswith("\\\\?\\") or len(path) < 240:
        return path
    return "\\\\?\\UNC\\" + path[2:] if path.startswith("\\\\") else "\\\\?\\" + path


def _zone_identifier(path: str) -> None:  # pragma: no cover - Windows only (alternate data stream)
    with open(path + ":Zone.Identifier", "w", encoding="ascii") as stream:
        stream.write("[ZoneTransfer]\r\nZoneId=3\r\n")


class LocalReader:
    def __init__(self, path: str, size: int, offset: int = 0) -> None:
        self._path = path
        self.size = size
        self._file = open(_verbatim(path), "rb")  # noqa: SIM115 - closed in aclose()
        if offset:
            self._file.seek(offset)

    async def chunks(self) -> AsyncIterator[bytes]:
        while True:
            try:
                data = await asyncio.to_thread(self._file.read, CHUNK_BYTES)
            except OSError as exc:
                raise from_oserror(exc, self._path) from exc
            if not data:
                return
            yield data

    async def aclose(self) -> None:
        await asyncio.to_thread(self._file.close)


class LocalWriter:
    def __init__(self, final: str, temp: str, *, windows: bool, overwrite: bool, zone_marker: Callable[[str], None],
                 resume_at: int = 0) -> None:
        self._overwrite = overwrite
        self._final = final
        self._temp = temp
        self.temp_path = temp                    # the engine records it in the partial ledger (a crash leaves it findable)
        self._windows = windows
        self._zone_marker = zone_marker
        if resume_at:
            # Continue a kept partial file. It must be EXACTLY the bytes written so far — anything else cannot be trusted
            # to be a prefix of the source, so the engine starts over instead.
            try:
                if os.stat(_verbatim(temp)).st_size != resume_at:
                    raise ResumeRejected(temp)
            except FileNotFoundError as exc:
                raise ResumeRejected(temp) from exc
            self._file = open(_verbatim(temp), "r+b")  # noqa: SIM115 - closed in commit()/abort()/suspend()
            self._file.seek(resume_at)
        else:
            self._file = open(_verbatim(temp), "xb")  # noqa: SIM115 - closed in commit()/abort()
        self._done = False

    async def write(self, data: bytes) -> None:
        try:
            await asyncio.to_thread(self._file.write, data)
        except OSError as exc:
            raise from_oserror(exc, self._final) from exc

    async def commit(self, *, mtime: float | None) -> None:
        def publish() -> None:
            self._file.flush()
            os.fsync(self._file.fileno())
            self._file.close()
            if mtime is not None:
                os.utime(_verbatim(self._temp), (mtime, mtime))
            if not self._overwrite and os.path.lexists(_verbatim(self._final)):
                raise FileExistsError(errno.EEXIST, "target appeared during the transfer", self._final)
            os.replace(_verbatim(self._temp), _verbatim(self._final))
            if self._windows and split_extension(os.path.basename(self._final))[1].lower() in RISKY_EXTENSIONS:
                with contextlib.suppress(OSError):
                    self._zone_marker(_verbatim(self._final))

        try:
            await asyncio.to_thread(publish)
        except OSError as exc:
            await self.abort()
            raise from_oserror(exc, self._final) from exc
        self._done = True

    async def abort(self) -> None:
        if self._done:
            return
        self._done = True

        def cleanup() -> None:
            with contextlib.suppress(OSError):
                self._file.close()
            with contextlib.suppress(OSError):
                os.remove(_verbatim(self._temp))

        await asyncio.to_thread(cleanup)

    async def suspend(self) -> int:
        """Closes the file but KEEPS the temporary file; returns how many bytes it holds (what a resume continues from)."""
        if self._done:
            raise ResumeRejected(self._temp)
        self._done = True

        def close() -> int:
            self._file.flush()
            os.fsync(self._file.fileno())
            self._file.close()
            return os.stat(_verbatim(self._temp)).st_size

        try:
            return await asyncio.to_thread(close)
        except OSError as exc:
            with contextlib.suppress(OSError):
                os.remove(_verbatim(self._temp))
            raise from_oserror(exc, self._final) from exc


def _entry_from_stat(name: str, st: os.stat_result, *, is_link: bool, link_target: str | None, is_dir: bool) -> Entry:
    attrs = getattr(st, "st_file_attributes", 0)
    if _IS_WINDOWS:
        hidden = bool(attrs & (_FILE_ATTRIBUTE_HIDDEN | _FILE_ATTRIBUTE_SYSTEM))
        readonly = bool(attrs & _FILE_ATTRIBUTE_READONLY) and not is_dir
        mode = None
    else:
        hidden = name.startswith(".")
        readonly = not (st.st_mode & 0o200)
        mode = stat_mod.S_IMODE(st.st_mode)
    return Entry(
        name=name,
        kind="dir" if is_dir else "file",
        size=0 if is_dir else st.st_size,
        mtime=st.st_mtime,
        hidden=hidden,
        readonly=readonly,
        symlink=is_link,
        link_target=link_target,
        mode=mode,
    )


def _entry_of(dirent: os.DirEntry[str]) -> Entry:
    """One scandir result as an Entry. Never raises: an entry whose stat fails (a dangling link, a locked file) is
    still shown — as an empty file — instead of making the whole folder unreadable."""
    name = dirent.name
    is_link = dirent.is_symlink() or bool(getattr(dirent, "is_junction", lambda: False)())
    target = None
    if is_link:
        with contextlib.suppress(OSError):
            target = os.readlink(dirent.path)
    try:
        is_dir = dirent.is_dir(follow_symlinks=True)
    except OSError:
        is_dir = False
    try:
        st = dirent.stat(follow_symlinks=not is_link)
    except OSError:
        try:
            st = dirent.stat(follow_symlinks=False)
        except OSError:
            return Entry(name=name, kind="dir" if is_dir else "file", hidden=name.startswith("."), symlink=is_link, link_target=target)
    return _entry_from_stat(name, st, is_link=is_link, link_target=target, is_dir=is_dir)


class LocalProvider:
    name = "pc"

    def __init__(self, roots: RootRegistry, *, windows: bool = _IS_WINDOWS, zone_marker: Callable[[str], None] = _zone_identifier):
        self._roots = roots
        self.windows = windows
        self.casefold = windows or sys.platform == "darwin"
        self._zone_marker = zone_marker

    # ------------------------------------------------------------------ path helpers (native syntax)

    def join(self, parent: str, name: str) -> str:
        return os.path.join(parent, name)

    def parent(self, path: str) -> str:
        return os.path.dirname(path.rstrip("\\/")) or path

    def basename(self, path: str) -> str:
        return os.path.basename(path.rstrip("\\/"))

    def canonical(self, path: str, *, follow_leaf: bool = True) -> str:
        """The checked, resolved path (FsError outside the roots). `follow_leaf=False` keeps a link as the link."""
        return str(self._roots.check(path, follow_leaf=follow_leaf))

    async def checksum(self, path: str) -> str:
        resolved = str(self._roots.check(path))

        def digest() -> str:
            h = hashlib.sha256()
            with open(_verbatim(resolved), "rb") as stream:
                for block in iter(lambda: stream.read(CHUNK_BYTES), b""):
                    h.update(block)
            return h.hexdigest()

        try:
            return await asyncio.to_thread(digest)
        except OSError as exc:
            raise from_oserror(exc, path) from exc

    # ------------------------------------------------------------------ reading

    async def list(self, path: str) -> AsyncIterator[list[Entry]]:
        resolved = str(self._roots.check(path))
        try:
            scan = await asyncio.to_thread(os.scandir, _verbatim(resolved))
        except OSError as exc:
            raise from_oserror(exc, path) from exc
        try:
            while True:
                page = await asyncio.to_thread(self._take_page, scan)
                if not page:
                    return
                yield page
        finally:
            await asyncio.to_thread(scan.close)

    @staticmethod
    def _take_page(scan) -> list[Entry]:
        page: list[Entry] = []
        for dirent in scan:
            page.append(_entry_of(dirent))
            if len(page) >= PAGE:
                break
        return page

    async def stat(self, path: str) -> Entry:
        resolved = str(self._roots.check(path, follow_leaf=False))

        def read() -> Entry:
            st = os.lstat(_verbatim(resolved))
            is_link = stat_mod.S_ISLNK(st.st_mode) or bool(st.st_file_attributes & _FILE_ATTRIBUTE_REPARSE_POINT if _IS_WINDOWS else 0)
            target = None
            is_dir = stat_mod.S_ISDIR(st.st_mode)
            if is_link:
                with contextlib.suppress(OSError):
                    target = os.readlink(_verbatim(resolved))
                with contextlib.suppress(OSError):
                    followed = os.stat(_verbatim(resolved))
                    is_dir = stat_mod.S_ISDIR(followed.st_mode)
                    st = followed
            return _entry_from_stat(os.path.basename(resolved.rstrip("\\/")) or resolved, st, is_link=is_link, link_target=target, is_dir=is_dir)

        try:
            return await asyncio.to_thread(read)
        except OSError as exc:
            raise from_oserror(exc, path) from exc

    async def names(self, path: str) -> set[str]:
        resolved = str(self._roots.check(path))
        try:
            return set(await asyncio.to_thread(os.listdir, _verbatim(resolved)))
        except FileNotFoundError:
            return set()
        except OSError as exc:
            raise from_oserror(exc, path) from exc

    async def free_space(self, path: str) -> FreeSpace:
        resolved = str(self._roots.check(path))
        probe = resolved
        while not os.path.exists(probe) and os.path.dirname(probe) != probe:
            probe = os.path.dirname(probe)            # a destination that does not exist yet: ask its nearest parent
        try:
            usage = await asyncio.to_thread(shutil.disk_usage, probe)
        except OSError as exc:
            raise from_oserror(exc, path) from exc
        return FreeSpace(total=usage.total, free=usage.free)

    async def walk(self, path: str) -> AsyncIterator[WalkItem]:
        """Pre-order (a folder is yielded before its content), symlinks and junctions reported but never entered."""
        root = str(self._roots.check(path))
        stack: list[tuple[str, str]] = [("", root)]
        while stack:
            rel, folder = stack.pop()
            try:
                scan = await asyncio.to_thread(os.scandir, _verbatim(folder))
            except OSError as exc:
                raise from_oserror(exc, folder) from exc
            try:
                while True:
                    page = await asyncio.to_thread(self._take_page, scan)
                    if not page:
                        break
                    for entry in page:
                        child_rel = f"{rel}/{entry.name}" if rel else entry.name
                        yield WalkItem(child_rel, entry)
                        if entry.is_dir and not entry.symlink:
                            stack.append((child_rel, os.path.join(folder, entry.name)))
            finally:
                await asyncio.to_thread(scan.close)

    async def search(self, path: str, query: str, *, limit: int = 500, budget_s: float = 15.0) -> tuple[list[tuple[str, Entry]], bool]:
        """Entries under `path` whose NAME contains `query` (case-insensitive, accents kept), breadth-first, links not
        entered, at most `limit` of them and at most `budget_s` seconds. Returns (hits, truncated)."""
        root = str(self._roots.check(path))
        needle = query.casefold()
        deadline = time.monotonic() + budget_s

        def scan() -> tuple[list[tuple[str, Entry]], bool]:
            hits: list[tuple[str, Entry]] = []
            queue = deque([root])
            while queue:
                folder = queue.popleft()
                try:
                    with os.scandir(_verbatim(folder)) as it:
                        for dirent in it:
                            if time.monotonic() > deadline or len(hits) >= limit:
                                return hits, True
                            entry = _entry_of(dirent)
                            if needle in dirent.name.casefold():
                                hits.append((os.path.join(folder, dirent.name), entry))
                            if entry.is_dir and not entry.symlink:
                                queue.append(os.path.join(folder, dirent.name))
                except OSError:
                    continue                                            # a folder we may not read: the rest is still searched
            return hits, False

        return await asyncio.to_thread(scan)

    # ------------------------------------------------------------------ changing

    async def mkdir(self, path: str, *, parents: bool = False) -> None:
        resolved = self._roots.check(path, follow_leaf=False)
        validate_name(resolved.name, windows=self.windows)
        try:
            await asyncio.to_thread(os.makedirs if parents else os.mkdir, _verbatim(str(resolved)))
        except OSError as exc:
            raise from_oserror(exc, path) from exc

    async def rename(self, src: str, dst: str, *, overwrite: bool = False) -> None:
        source = self._roots.check(src, follow_leaf=False)
        target = self._roots.check(dst, follow_leaf=False)
        if self._roots.is_root(source):
            raise FsError("permission", "Kök klasörler yeniden adlandırılamaz.", path=src)
        validate_name(target.name, windows=self.windows)

        def move() -> None:
            if not overwrite and os.path.lexists(target):
                same = os.path.samefile(source, target) if os.path.exists(target) else False
                if not same:                                   # a case-only rename on Windows IS the same file
                    raise FsError("exists", path=dst)
            (os.replace if overwrite else os.rename)(_verbatim(str(source)), _verbatim(str(target)))

        try:
            await asyncio.to_thread(move)
        except OSError as exc:
            raise from_oserror(exc, src) from exc

    async def delete(self, path: str) -> None:
        """Permanent deletion. A link is removed itself, its target is never touched."""
        resolved = self._roots.check(path, follow_leaf=False)
        if self._roots.is_root(resolved):
            raise FsError("permission", "Kök klasörler silinemez.", path=path)

        def remove() -> None:
            target = _verbatim(str(resolved))
            st = os.lstat(target)
            if stat_mod.S_ISDIR(st.st_mode) and not stat_mod.S_ISLNK(st.st_mode) and not (
                _IS_WINDOWS and st.st_file_attributes & _FILE_ATTRIBUTE_REPARSE_POINT
            ):
                shutil.rmtree(target, onerror=_clear_readonly_and_retry)
            elif _IS_WINDOWS and stat_mod.S_ISDIR(st.st_mode):
                os.rmdir(target)                                # a junction/dir-symlink: remove the link only
            else:
                try:
                    os.remove(target)
                except PermissionError:
                    os.chmod(target, stat_mod.S_IWRITE)         # Windows: read-only files need the flag cleared
                    os.remove(target)

        try:
            await asyncio.to_thread(remove)
        except OSError as exc:
            raise from_oserror(exc, path) from exc

    async def trash(self, path: str) -> None:
        """To the system's Recycle Bin / Trash (restorable by the user outside OpenDeX too)."""
        resolved = self._roots.check(path, follow_leaf=False)
        if self._roots.is_root(resolved):
            raise FsError("permission", "Kök klasörler silinemez.", path=path)
        try:
            from send2trash import send2trash
        except ImportError as exc:
            raise FsError("trash_unavailable") from exc
        try:
            await asyncio.to_thread(send2trash, str(resolved))
        except OSError as exc:
            raise from_oserror(exc, path) from exc
        except Exception as exc:  # send2trash raises its own TrashPermissionError (an OSError) or plain Exception
            raise FsError("trash_unavailable", detail=str(exc)) from exc

    # ------------------------------------------------------------------ transfers

    resumable_read = True        # a reader can start at any byte
    resumable_write = True       # a writer can continue a kept `.opdx-…part` file

    async def open_reader(self, path: str, *, offset: int = 0) -> Reader:
        resolved = str(self._roots.check(path))
        try:
            size = (await asyncio.to_thread(os.stat, _verbatim(resolved))).st_size
            return await asyncio.to_thread(LocalReader, resolved, size, offset)
        except OSError as exc:
            raise from_oserror(exc, path) from exc

    async def open_writer(self, path: str, *, size: int, tag: str, overwrite: bool = False, resume_at: int = 0) -> Writer:
        final = self._roots.check(path, follow_leaf=False)
        validate_name(final.name, windows=self.windows)
        temp = final.with_name(f"{final.name}.opdx-{tag}.part")
        try:
            return await asyncio.to_thread(
                functools.partial(LocalWriter, str(final), str(temp), windows=self.windows, overwrite=overwrite,
                                  zone_marker=self._zone_marker, resume_at=resume_at)
            )
        except OSError as exc:
            raise from_oserror(exc, path) from exc


def _clear_readonly_and_retry(func, path, _exc_info) -> None:
    """shutil.rmtree onerror: a read-only file (Windows) blocks its own removal."""
    with contextlib.suppress(OSError):
        os.chmod(path, stat_mod.S_IWRITE)
    func(path)


def open_with_default_app(path: Path) -> None:  # pragma: no cover - Windows/macOS/Linux shell integration
    if _IS_WINDOWS:
        os.startfile(str(path))  # type: ignore[attr-defined]  # noqa: S606
    elif sys.platform == "darwin":
        import subprocess
        subprocess.Popen(["open", str(path)])  # noqa: S603,S607
    else:
        import subprocess
        subprocess.Popen(["xdg-open", str(path)])  # noqa: S603,S607
