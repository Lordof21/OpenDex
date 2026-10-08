"""Which folders of THIS PC the file manager may touch.

The API is bearer-protected and loopback-only, but a file API is the one place where "a script in the page" would turn
into "reads C:\\Users\\me\\.ssh". So the PC side is deny-by-default and the user picks how much to trust it
(`OPENDEX_FS_PC_ACCESS`):

  * ``folders`` (default) — only the user's known folders (Desktop, Documents, Downloads, Pictures, Music, Videos), the
    folders the user adds through the native picker, and one-off *grants* (below).
  * ``home``    — the whole user profile.
  * ``all``     — every drive. For people who treat OpenDeX as their file manager.

Whatever the mode, a hard deny-list stays closed: OpenDeX's own data folder (it holds the API and daemon tokens), the
usual credential stores (.ssh, .gnupg, .aws …) and Windows' credential vaults. Deny wins over every root and grant.

A *grant* is a path the Tauri shell registered for a drag-and-drop or a "pick files" dialog: a session-long permission
minted only by native UI (the webview cannot forge one — the grant call needs the shell token).

Every path is resolved (symlinks, junctions, `..`) BEFORE it is compared, and mutating calls resolve the PARENT only,
so deleting a link removes the link, never its target.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .errors import FsError
from .models import Place

_IS_WINDOWS = sys.platform == "win32"
Access = Literal["folders", "home", "all"]

KNOWN_FOLDERS = (
    ("desktop", "Desktop"),
    ("documents", "Documents"),
    ("downloads", "Downloads"),
    ("pictures", "Pictures"),
    ("music", "Music"),
    ("videos", "Videos"),
)
GRANT_TTL_S = 8 * 3600

# Relative to the user's home. Matched on the RESOLVED path, so a junction into one of them is caught as well.
_HOME_DENY = (
    ".opendex", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud",
    "AppData/Roaming/Microsoft/Credentials", "AppData/Roaming/Microsoft/Protect",
    "AppData/Roaming/Microsoft/Crypto", "AppData/Local/Microsoft/Credentials",
)


def _norm(path: str | os.PathLike[str]) -> str:
    return os.path.normcase(os.path.realpath(os.fspath(path)))


def _inside(candidate: str, root: str) -> bool:
    if candidate == root:
        return True
    return candidate.startswith(root if root.endswith(os.sep) else root + os.sep)


@dataclass(slots=True)
class Grant:
    id: str
    path: str
    expires: float


class RootRegistry:
    """Thread-safe: file calls run in worker threads while the API changes the set."""

    def __init__(
        self,
        *,
        access: Access = "folders",
        known: dict[str, Path] | None = None,
        extra: list[Path] | None = None,
        home: Path | None = None,
        deny: list[Path] | None = None,
        clock=time.monotonic,
    ) -> None:
        self._lock = threading.Lock()
        self._clock = clock
        self._access: Access = access
        self._home = home if home is not None else Path.home()
        self._known: dict[str, Path] = dict(known) if known is not None else default_known_folders()
        self._custom: dict[str, Path] = {}
        self._grants: dict[str, Grant] = {}
        self._deny = [_norm(self._home / rel) for rel in _HOME_DENY] + [_norm(p) for p in (deny or [])]
        for path in extra or []:
            self._custom[_norm(path)] = Path(os.path.realpath(path))

    @property
    def access(self) -> Access:
        return self._access

    # ------------------------------------------------------------------ the set

    def _live_roots(self) -> list[str]:
        now = self._clock()
        with self._lock:
            for gid in [g for g, grant in self._grants.items() if grant.expires <= now]:
                del self._grants[gid]
            roots = [_norm(p) for p in self._known.values()]
            roots += list(self._custom)
            roots += [_norm(g.path) for g in self._grants.values()]
        if self._access == "home":
            roots.append(_norm(self._home))
        return roots

    def add_custom(self, path: str | os.PathLike[str]) -> Path:
        resolved = Path(os.path.realpath(os.fspath(path)))
        if not resolved.is_dir():
            raise FsError("not_a_dir", path=str(path))
        if self._denied(os.path.normcase(str(resolved))):
            raise FsError("outside_roots", path=str(path))
        with self._lock:
            self._custom[os.path.normcase(str(resolved))] = resolved
        return resolved

    def remove_custom(self, path: str | os.PathLike[str]) -> bool:
        with self._lock:
            return self._custom.pop(_norm(path), None) is not None

    def grant(self, grant_id: str, path: str | os.PathLike[str]) -> Grant:
        resolved = os.path.realpath(os.fspath(path))
        if not os.path.exists(resolved):
            raise FsError("not_found", path=str(path))
        if self._denied(os.path.normcase(resolved)):
            raise FsError("outside_roots", path=str(path))
        grant = Grant(grant_id, resolved, self._clock() + GRANT_TTL_S)
        with self._lock:
            self._grants[grant_id] = grant
        return grant

    # ------------------------------------------------------------------ the check

    def _denied(self, candidate: str) -> bool:
        return any(_inside(candidate, blocked) for blocked in self._deny)

    def check(self, raw: str, *, follow_leaf: bool = True) -> Path:
        """The resolved path, or FsError('outside_roots'). `follow_leaf=False` resolves only the parent and keeps the
        last component as given — for operations on a link itself (delete, rename)."""
        if not isinstance(raw, str) or not raw or "\x00" in raw:
            raise FsError("bad_request", "Geçersiz yol.")
        if not Path(raw).is_absolute():
            raise FsError("bad_request", "PC yolu mutlak olmalı.")
        if follow_leaf:
            resolved = os.path.realpath(raw)
        else:
            trimmed = raw.rstrip("\\/") or raw
            resolved = os.path.join(os.path.realpath(os.path.dirname(trimmed) or trimmed), os.path.basename(trimmed))
        candidate = os.path.normcase(resolved)
        if self._denied(candidate):
            raise FsError("outside_roots", path=raw)
        if self._access == "all" or any(_inside(candidate, root) for root in self._live_roots()):
            return Path(resolved)
        raise FsError("outside_roots", path=raw)

    def is_root(self, path: str | os.PathLike[str]) -> bool:
        """True for a root folder itself (or a drive root): browsable, never deletable or renamable."""
        candidate = _norm(path)
        return candidate in self._live_roots() or candidate == os.path.normcase(os.path.realpath(Path(candidate).anchor))

    # ------------------------------------------------------------------ places for the sidebar

    def places(self) -> list[Place]:
        out: list[Place] = []
        if self._access in ("home", "all") and self._home.is_dir():
            out.append(Place("pc:home", "pc", "home", "Ana klasör", str(self._home)))
        for kind, path in self._known.items():
            if path.is_dir():
                out.append(Place(f"pc:{kind}", "pc", kind, path.name, str(path)))
        with self._lock:
            customs = list(self._custom.values())
        for path in customs:
            if path.is_dir():
                out.append(Place(f"pc:custom:{os.path.normcase(str(path))}", "pc", "custom", path.name or str(path), str(path)))
        if self._access == "all":
            for drive in list_drives():
                out.append(Place(f"pc:drive:{drive}", "pc", "drive", drive, drive))
        return out


def list_drives() -> list[str]:
    """Windows drive roots ('C:\\', 'D:\\'…); '/' elsewhere."""
    if not _IS_WINDOWS:
        return ["/"]
    import string
    return [f"{letter}:\\" for letter in string.ascii_uppercase if os.path.exists(f"{letter}:\\")]  # pragma: no cover


def default_known_folders() -> dict[str, Path]:
    home = Path.home()
    folders: dict[str, Path] = {}
    for kind, leaf in KNOWN_FOLDERS:
        found = _windows_known_folder(kind) if _IS_WINDOWS else None
        path = found or home / leaf
        if path.is_dir():
            folders[kind] = path
    return folders


# SHGetKnownFolderPath: the one right answer on Windows (OneDrive-redirected Desktop/Documents/Pictures are NOT under
# %USERPROFILE%\Desktop any more). Not exercised by the Linux test suite — it is on the Windows checklist in the plan.
_FOLDERID = {
    "desktop": "B4BFCC3A-DB2C-424C-B029-7FE99A87C641",
    "documents": "FDD39AD0-238F-46AF-ADB4-6C85480369C7",
    "downloads": "374DE290-123F-4565-9164-39C4925E467B",
    "pictures": "33E28130-4E1E-4676-835A-98395C3BC3BB",
    "music": "4BD8D571-6D19-48D3-BE97-422220080E43",
    "videos": "18989B1D-99B5-455B-841C-AB7C74E4DDFC",
}


def _windows_known_folder(kind: str) -> Path | None:  # pragma: no cover - Windows only
    try:
        import ctypes
        import uuid
        from ctypes import wintypes

        guid = uuid.UUID(_FOLDERID[kind])

        class GUID(ctypes.Structure):
            _fields_ = [("a", wintypes.DWORD), ("b", wintypes.WORD), ("c", wintypes.WORD), ("d", ctypes.c_ubyte * 8)]

        ref = GUID(guid.time_low, guid.time_mid, guid.time_hi_version, (ctypes.c_ubyte * 8)(*guid.bytes[8:]))
        out = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(ref), 0, None, ctypes.byref(out)) != 0:
            return None
        try:
            return Path(out.value)
        finally:
            ctypes.windll.ole32.CoTaskMemFree(out)
    except Exception:
        return None
