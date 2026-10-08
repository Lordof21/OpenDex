"""The file system's tables in settings.db: user-added folders, favourites, transfer history, the ledger of temp files
a transfer left behind, and the phone's Recycle Bin."""
from __future__ import annotations

import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

from ..storage import settings_db

HISTORY_LIMIT = 200


@dataclass(slots=True)
class TrashItem:
    id: str
    device: str
    original: str
    trash_path: str
    name: str
    size: int
    is_dir: bool
    deleted: float

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "device": self.device, "original": self.original, "name": self.name,
                "size": self.size, "is_dir": self.is_dir, "deleted": self.deleted}


class FsStore:
    # ------------------------------------------------------------------ folders the user added

    async def roots(self) -> list[str]:
        async with settings_db.connect() as db:
            rows = await (await db.execute("SELECT path FROM fs_roots ORDER BY added")).fetchall()
        return [r[0] for r in rows]

    async def add_root(self, path: str) -> None:
        async with settings_db.connect() as db:
            await db.execute("INSERT OR REPLACE INTO fs_roots (path, added) VALUES (?, ?)", (path, time.time()))
            await db.commit()

    async def remove_root(self, path: str) -> None:
        async with settings_db.connect() as db:
            await db.execute("DELETE FROM fs_roots WHERE path = ?", (path,))
            await db.commit()

    # ------------------------------------------------------------------ the same phone under a new serial

    async def rekey_device(self, old: str, new: str) -> None:
        """USB <-> Wi-Fi changes the phone's serial, not the phone: what was filed under the old one follows it."""
        async with settings_db.connect() as db:
            for table in ("fs_favorites", "fs_partials", "fs_trash"):
                await db.execute(f"UPDATE OR REPLACE {table} SET device = ? WHERE device = ?", (new, old))
            await db.commit()

    # ------------------------------------------------------------------ favourites

    async def favorites(self) -> list[dict[str, Any]]:
        async with settings_db.connect() as db:
            rows = await (await db.execute(
                "SELECT id, provider, device, path, name FROM fs_favorites ORDER BY position")).fetchall()
        return [{"id": r[0], "provider": r[1], "device": r[2] or None, "path": r[3], "name": r[4]} for r in rows]

    async def add_favorite(self, provider: str, device: str | None, path: str, name: str) -> dict[str, Any]:
        async with settings_db.connect() as db:
            dup = await (await db.execute(
                "SELECT id FROM fs_favorites WHERE provider = ? AND device = ? AND path = ?", (provider, device or "", path))).fetchone()
            if dup:
                return {"id": dup[0], "provider": provider, "device": device, "path": path, "name": name}
            position = (await (await db.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM fs_favorites")).fetchone())[0]
            fav_id = secrets.token_hex(6)
            await db.execute("INSERT INTO fs_favorites (id, provider, device, path, name, position) VALUES (?,?,?,?,?,?)",
                             (fav_id, provider, device or "", path, name, position))
            await db.commit()
        return {"id": fav_id, "provider": provider, "device": device, "path": path, "name": name}

    async def remove_favorite(self, fav_id: str) -> None:
        async with settings_db.connect() as db:
            await db.execute("DELETE FROM fs_favorites WHERE id = ?", (fav_id,))
            await db.commit()

    # ------------------------------------------------------------------ transfer history

    async def save_job(self, snapshot: dict[str, Any]) -> None:
        async with settings_db.connect() as db:
            await db.execute("INSERT OR REPLACE INTO fs_transfers (id, finished, data) VALUES (?, ?, ?)",
                             (snapshot["id"], snapshot.get("finished") or time.time(), json.dumps(snapshot)))
            await db.execute(
                "DELETE FROM fs_transfers WHERE id NOT IN (SELECT id FROM fs_transfers ORDER BY finished DESC LIMIT ?)",
                (HISTORY_LIMIT,))
            await db.commit()

    async def history(self, limit: int = 50) -> list[dict[str, Any]]:
        async with settings_db.connect() as db:
            rows = await (await db.execute("SELECT data FROM fs_transfers ORDER BY finished DESC LIMIT ?", (limit,))).fetchall()
        return [json.loads(r[0]) for r in rows]

    # ------------------------------------------------------------------ the ledger of temp files in flight

    async def add_partial(self, provider: str, device: str | None, path: str, job_id: str) -> None:
        async with settings_db.connect() as db:
            await db.execute("INSERT OR REPLACE INTO fs_partials (provider, device, path, job_id, created) VALUES (?,?,?,?,?)",
                             (provider, device or "", path, job_id, time.time()))
            await db.commit()

    async def remove_partial(self, provider: str, device: str | None, path: str) -> None:
        async with settings_db.connect() as db:
            await db.execute("DELETE FROM fs_partials WHERE provider = ? AND device = ? AND path = ?", (provider, device or "", path))
            await db.commit()

    async def partials(self, job_id: str | None = None, device: str | None = None, provider: str | None = None) -> list[tuple[str, str | None, str]]:
        query, args = "SELECT provider, device, path FROM fs_partials WHERE 1=1", []
        for column, value in (("job_id", job_id), ("device", device), ("provider", provider)):
            if value is not None:
                query += f" AND {column} = ?"
                args.append(value)
        async with settings_db.connect() as db:
            rows = await (await db.execute(query, args)).fetchall()
        return [(r[0], r[1] or None, r[2]) for r in rows]

    # ------------------------------------------------------------------ the phone's Recycle Bin

    async def add_trash(self, item: TrashItem) -> None:
        async with settings_db.connect() as db:
            await db.execute("INSERT INTO fs_trash (id, device, original, trash_path, name, size, is_dir, deleted) VALUES (?,?,?,?,?,?,?,?)",
                             (item.id, item.device, item.original, item.trash_path, item.name, item.size, int(item.is_dir), item.deleted))
            await db.commit()

    async def trash(self, device: str, ids: list[str] | None = None) -> list[TrashItem]:
        query, args = "SELECT id, device, original, trash_path, name, size, is_dir, deleted FROM fs_trash WHERE device = ?", [device]
        if ids is not None:
            query += f" AND id IN ({','.join('?' * len(ids))})"
            args += ids
        async with settings_db.connect() as db:
            rows = await (await db.execute(query + " ORDER BY deleted DESC", args)).fetchall()
        return [TrashItem(r[0], r[1], r[2], r[3], r[4], r[5], bool(r[6]), r[7]) for r in rows]

    async def forget_trash(self, ids: list[str]) -> None:
        if ids:
            async with settings_db.connect() as db:
                await db.execute(f"DELETE FROM fs_trash WHERE id IN ({','.join('?' * len(ids))})", ids)
                await db.commit()
