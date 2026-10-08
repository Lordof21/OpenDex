"""Plain data the file system layer passes around. The REST schemas (app/schemas/fs.py) mirror these field for field."""
from __future__ import annotations

import posixpath
import re
from dataclasses import asdict, dataclass, field
from typing import Literal

from .errors import FsError

Provider = Literal["pc", "phone"]
Kind = Literal["file", "dir"]

# What the phone side may be browsed under. Everything the shell user can read OUTSIDE these (/data/data, /proc, …) stays
# out of reach of the UI even though adbd could serve it. '/sdcard' is an alias of the internal volume (the daemon
# applies the same rules again, after resolving links — FsPolicy.java).
DEFAULT_PHONE_ROOTS = ("/storage", "/data/local/tmp")
INTERNAL_STORAGE = "/storage/emulated/0"
_PHONE_PROTECTED = re.compile(
    r"^(/|/storage|/storage/emulated|/storage/emulated/\d+|/storage/[^/]+|/data/local/tmp"
    r"|/storage/[^/]+/Android|/storage/[^/]+/Android/(data|obb|media)"
    r"|/storage/emulated/\d+/Android|/storage/emulated/\d+/Android/(data|obb|media))$"
)


@dataclass(frozen=True, slots=True)
class Location:
    """A place a file can be: a provider, a device (phone only) and an absolute path in that provider's own syntax."""

    provider: Provider
    path: str
    device: str | None = None

    def key(self) -> str:
        return f"{self.provider}:{self.device or '-'}:{self.path}"

    def child(self, name: str) -> "Location":
        sep = "/" if self.provider == "phone" or "/" in self.path and "\\" not in self.path else "\\"
        base = self.path.rstrip(sep) if self.path not in ("/", "\\") else ""
        return Location(self.provider, f"{base}{sep}{name}", self.device)


@dataclass(slots=True)
class Entry:
    """One directory entry. `mtime` is epoch seconds; `size` is 0 for directories."""

    name: str
    kind: Kind
    size: int = 0
    mtime: float = 0.0
    hidden: bool = False
    readonly: bool = False
    symlink: bool = False
    link_target: str | None = None
    mode: int | None = None            # POSIX permission bits (phone, Linux/macOS hosts); None on Windows

    @property
    def is_dir(self) -> bool:
        return self.kind == "dir"

    def to_dict(self) -> dict:
        data = asdict(self)
        if data["link_target"] is None:
            del data["link_target"]
        if data["mode"] is None:
            del data["mode"]
        return data


@dataclass(slots=True)
class Place:
    """A starting point in the sidebar: a phone volume, a PC known folder, a drive, a user-added folder."""

    id: str
    provider: Provider
    kind: str                           # phone: internal|sdcard|usb|tmp  pc: home|desktop|documents|downloads|pictures|music|videos|drive|custom
    name: str
    path: str
    device: str | None = None
    total: int | None = None
    free: int | None = None
    removable: bool = False

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass(slots=True)
class WalkItem:
    """One node of a recursive listing: `rel` is the POSIX-style path relative to the walk's root."""

    rel: str
    entry: Entry


@dataclass(slots=True)
class FreeSpace:
    total: int
    free: int


@dataclass(slots=True)
class ListMeta:
    path: str                           # canonical path that was listed (symlinks resolved on the phone)
    total_hint: int | None = None
    extra: dict = field(default_factory=dict)


def normalize_phone_path(raw: str, roots: tuple[str, ...] | None = None) -> str:
    """Lexical normalisation + allow-list for a phone path. `..` is resolved BEFORE the root check, so '/sdcard/../data'
    is refused. Symlinks are the device side's business (the daemon canonicalises; see FsPaths.java)."""
    roots = DEFAULT_PHONE_ROOTS if roots is None else roots                  # read at call time: tests may point it elsewhere
    if not isinstance(raw, str) or not raw or "\x00" in raw or "\n" in raw or "\r" in raw:
        raise FsError("bad_request", "Geçersiz yol.")
    if len(raw.encode("utf-8")) > 4096:
        raise FsError("bad_request", "Yol çok uzun.")
    if not raw.startswith("/"):
        raise FsError("bad_request", "Telefon yolu '/' ile başlamalı.")
    path = posixpath.normpath(raw)
    if path.startswith("//"):                    # POSIX keeps exactly two leading slashes
        path = "/" + path.lstrip("/")
    if path == "/sdcard" or path.startswith("/sdcard/"):
        path = INTERNAL_STORAGE + path[len("/sdcard"):]
    for root in roots:
        if path == root or path.startswith(root.rstrip("/") + "/"):
            return path
    raise FsError("outside_roots", path=path)


def is_protected_phone_path(path: str) -> bool:
    """A volume's top folders and Android/{data,obb,media}: browsable, but never deleted or renamed (the daemon refuses too)."""
    return _PHONE_PROTECTED.match(path) is not None
