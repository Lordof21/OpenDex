"""The daemon's `fs_*` commands, seen from the backend: how a request line is built and how a reply is read.

The Java twin is backend/java/src/com/opendex/tools/FsWire.java (+ FsService.java). Every path is base64 on the wire: a
path is arbitrary text (spaces, quotes, a newline) and the daemon's protocol is one command per LINE.

    fs_roots
    fs_list <b64 path> <b64 after | -> <limit>        → {path, items:[[name, dir, size, mtime, flags, target]…], next}
    fs_stat <b64 path>                                 → {path, item}
    fs_stat_many <b64 (paths joined by \\n)>            → {items:[item | null …]}
    fs_mkdir <b64 path> <p | ->        fs_rename <b64 from> <b64 to> <o | ->        fs_delete <b64 path>
    fs_thumb <b64 path> <px>           fs_scan <b64 (paths joined by \\n)>
"""
from __future__ import annotations

import base64
import binascii
from typing import Any

from .errors import ERROR_TABLE, FsError
from .models import Entry, Place

FLAG_SYMLINK = 1
FLAG_HIDDEN = 2
MAX_BATCH = 500
MAX_PAGE = 2000


def b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def unb64(text: str) -> str:
    try:
        return base64.b64decode(text.encode("ascii"), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeError, ValueError) as exc:
        raise FsError("io", detail="daemon sent a malformed cursor") from exc


def _batch(paths: list[str]) -> str:
    if not paths or len(paths) > MAX_BATCH or any(not p or "\n" in p for p in paths):
        raise FsError("bad_request", "Geçersiz toplu istek.")
    return b64("\n".join(paths))


def roots_request() -> str:
    return "fs_roots"


def list_request(path: str, after: str | None, limit: int) -> str:
    return f"fs_list {b64(path)} {b64(after) if after is not None else '-'} {max(1, min(int(limit), MAX_PAGE))}"


def stat_request(path: str) -> str:
    return f"fs_stat {b64(path)}"


def stat_many_request(paths: list[str]) -> str:
    return f"fs_stat_many {_batch(paths)}"


def mkdir_request(path: str, *, parents: bool) -> str:
    return f"fs_mkdir {b64(path)} {'p' if parents else '-'}"


def rename_request(src: str, dst: str, *, overwrite: bool) -> str:
    return f"fs_rename {b64(src)} {b64(dst)} {'o' if overwrite else '-'}"


def delete_request(path: str) -> str:
    return f"fs_delete {b64(path)}"


def thumb_request(path: str, px: int) -> str:
    return f"fs_thumb {b64(path)} {max(32, min(int(px), 1024))}"


def scan_request(paths: list[str]) -> str:
    return f"fs_scan {_batch(paths)}"


# ------------------------------------------------------------------------------------------------ replies


def check(reply: dict[str, Any] | None, path: str | None = None) -> dict[str, Any]:
    """The reply when it is ok; FsError(code) for a daemon refusal. None (daemon gone / no answer) is the CALLER's cue to
    fall back, so it is never passed here."""
    if reply is None:
        raise FsError("timeout", "Cihaz yanıt vermedi.")
    if reply.get("ok"):
        return reply
    code = reply.get("error")
    raise FsError(code if code in ERROR_TABLE else "io", path=path, detail=reply.get("detail") or str(code))


def parse_item(raw: Any) -> Entry:
    """[name, dir(0|1), size, mtime, flags, link_target | null] → Entry."""
    if not isinstance(raw, list) or len(raw) < 6:
        raise FsError("io", detail="daemon sent a malformed entry")
    name, is_dir, size, mtime, flags, target = raw[:6]
    return Entry(
        name=str(name),
        kind="dir" if is_dir else "file",
        size=int(size),
        mtime=float(mtime),
        hidden=bool(int(flags) & FLAG_HIDDEN),
        symlink=bool(int(flags) & FLAG_SYMLINK),
        link_target=str(target) if target else None,
    )


def parse_roots(reply: dict[str, Any]) -> list[Place]:
    """The daemon's volumes → sidebar places. Labels are the UI's business (it knows the language); `name` is the volume
    folder's own name (`0`, `1234-ABCD`, `tmp`)."""
    places: list[Place] = []
    for root in reply.get("roots") or []:
        path = str(root.get("path", ""))
        kind = str(root.get("kind", ""))
        if not path:
            continue
        mapped = {"internal": "internal", "removable": "sdcard", "tmp": "tmp"}.get(kind, "internal")
        name = {"internal": "Dahili depolama", "sdcard": path.rstrip("/").rsplit("/", 1)[-1], "tmp": "Geçici (adb)"}[mapped]
        places.append(Place(
            id=f"phone:{mapped}:{path}", provider="phone", kind=mapped, name=name, path=path,
            total=int(root.get("total") or 0) or None, free=int(root.get("free") or 0) or None,
            removable=mapped == "sdcard",
        ))
    return places
