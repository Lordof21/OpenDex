"""The file system facade the API and the application context talk to.

Everything stateful lives here: the PC and phone providers, the transfer engine, the caches, the Recycle Bin, the folders
the user added. The REST layer (api/v1/endpoints/fs.py) only validates input and shapes output; the rules are all below.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Callable

from ..config import Settings
from ..device.daemon_auth import load_or_create_token
from ..events import EventBus, cancel_and_wait, spawn_background
from .adb_sync import AdbSync
from .content import ContentPolicy, policy_for
from .errors import FsError
from .memcache import MemoryCache, purge_legacy_disk_cache
from .models import Entry, Location
from .names import comparison_key, unique_name, validate_name, windows_safe_name
from .providers.base import FsProvider
from .providers.local import RISKY_EXTENSIONS, LocalProvider
from .providers.phone import PhoneProvider
from .roots import RootRegistry
from .store import FsStore, TrashItem
from .thumbs import Thumbnailer
from .transfer import TransferEngine, TransferJob, TransferSpec

log = logging.getLogger(__name__)

TRASH_DIR = ".opendex-trash"
SEARCH_MAX_QUERY = 100
SEARCH_LIMIT = 500
PLACE_CAPACITY_TIMEOUT_S = 1.5


@dataclass(slots=True)
class ContentFile:
    """What the preview endpoint serves: a PC file in place (`path` — already on the disk, nothing is copied), a phone file
    held in memory (`data`), or a phone video/audio read from the phone while it plays (`stream` — no size limit, nothing
    is kept: a 2 GB video never sits in RAM or on the disk)."""

    policy: ContentPolicy
    filename: str
    size: int
    path: Path | None = None
    data: bytes | None = None
    stream: Callable[[int, int], AsyncIterator[bytes]] | None = None    # (first, last) → bytes, read from the phone on demand


class EventPump:
    """The engine reports from sync code; the bus wants `await emit`. One consumer keeps their ORDER — a late progress
    event must never overtake the final 'completed'."""

    def __init__(self, bus: EventBus) -> None:
        self._bus = bus
        self._queue: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue()
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._run(), name="fs-event-pump")

    def put(self, event: str, payload: dict[str, Any]) -> None:
        self._queue.put_nowait((event, payload))

    async def _run(self) -> None:
        while True:
            event, payload = await self._queue.get()
            try:
                await self._bus.emit(event, **payload)  # type: ignore[arg-type]
            except Exception:
                log.exception("[fs] could not publish %s", event)

    async def stop(self) -> None:
        await cancel_and_wait(self._task)
        self._task = None


class FsService:
    def __init__(
        self,
        *,
        settings: Settings,
        adb: Any,
        daemon: Any,
        events: EventBus,
        active_serial: Callable[[], str | None],
        store: FsStore | None = None,
    ) -> None:
        self._settings = settings
        self._adb = adb
        self._daemon = daemon
        self._active_serial = active_serial
        self._bound: tuple[str | None, str | None] = (None, None)      # (serial, android id) of the phone last seen
        self.store = store or FsStore()
        self.roots = RootRegistry(
            access=settings.FS_PC_ACCESS,
            extra=list(settings.FS_EXTRA_ROOTS),
            deny=[Path(settings.API_TOKEN_FILE).parent, Path(settings.DAEMON_TOKEN_FILE).parent, settings.FS_CACHE_DIR],
        )
        self.local = LocalProvider(self.roots)
        self._sync = AdbSync(host=settings.FS_ADB_HOST, port=settings.FS_ADB_PORT)
        self._phones: dict[str, PhoneProvider] = {}
        self._pump = EventPump(events)
        # Previews and thumbnails live in memory only (memcache.py): a file the user just LOOKED at is not left on the disk.
        self.previews = MemoryCache(settings.FS_CACHE_MB * 1024 * 1024)
        self.thumbs = Thumbnailer(MemoryCache(settings.FS_THUMB_CACHE_MB * 1024 * 1024))
        self._staged_dir = Path(tempfile.gettempdir()) / "opendex-open"     # where "Bilgisayarda aç" puts a phone file
        self.engine = TransferEngine(
            self.provider_for,
            emit=self._pump.put,
            store=_EngineStore(self),
            workers=settings.FS_TRANSFER_WORKERS,
            max_jobs=settings.FS_MAX_JOBS,
        )
        self._fetching: dict[str, asyncio.Lock] = {}
        self._shell_token: str | None = None
        self._unsubscribe: list[Callable[[], None]] = []
        self._events = events

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        self._pump.start()
        for raw in await self.store.roots():
            with contextlib.suppress(FsError, OSError):
                self.roots.add_custom(raw)
        self._shell_token = load_or_create_token(self._settings.FS_SHELL_TOKEN_FILE)   # same 0600 secret-file helper as the daemon key
        for event in ("device_connected", "device_reconnected"):
            self._unsubscribe.append(self._events.on(event, self._on_device_back))
        for stale in await self.store.partials(provider="pc"):
            await self._sweep_partial(*stale)
        gone = await asyncio.to_thread(purge_legacy_disk_cache, self._settings.FS_CACHE_DIR)
        await asyncio.to_thread(shutil.rmtree, self._staged_dir, True)       # files an earlier run opened on the PC
        if gone:
            log.info("[fs] %d file(s) of the old on-disk preview cache removed (previews stay in memory now)", gone)
        log.info("[fs] ready (PC access: %s)", self._settings.FS_PC_ACCESS)

    async def stop(self) -> None:
        for off in self._unsubscribe:
            off()
        await self.engine.aclose()
        for phone in self._phones.values():
            await phone.aclose()
        await self._pump.stop()
        self.previews.clear()
        await asyncio.to_thread(shutil.rmtree, self._staged_dir, True)

    async def _on_device_back(self, **payload: Any) -> None:
        serial = self._active_serial()
        if not serial:
            return
        android_id = payload.get("android_id")
        old_serial, old_id = self._bound
        self._bound = (serial, android_id or old_id)
        if old_serial and old_serial != serial and (android_id is None or old_id is None or android_id == old_id):
            await self._adopt_transport(old_serial, serial)
        self.engine.device_online(serial)
        spawn_background(self._sweep_device(serial), "fs-sweep-device")

    async def _adopt_transport(self, old: str, new: str) -> None:
        """The session moved between USB and Wi-Fi: same phone, new serial. Its folders/trash/leftovers follow, the old
        connection pool goes, and jobs parked for the old serial go on (their locations now resolve to the new one)."""
        log.info("[fs] phone moved from %s to %s", old, new)
        stale = self._phones.pop(old, None)
        if stale is not None:
            await stale.aclose()
        with contextlib.suppress(Exception):
            await self.store.rekey_device(old, new)
        self.engine.device_online(old)

    async def _sweep_device(self, serial: str) -> None:
        """A device came back: temp files an interrupted transfer left on it go now."""
        for stale in await self.store.partials(provider="phone", device=serial):
            await self._sweep_partial(*stale)
        await self.purge_trash(serial)

    async def _sweep_partial(self, provider: str, device: str | None, path: str) -> None:
        loc = Location("pc" if provider == "pc" else "phone", path, device)
        try:
            await self.provider_for(loc).delete(path)
        except FsError as exc:
            if exc.code not in ("not_found", "outside_roots"):
                return                                      # still unreachable: the ledger keeps it for next time
        await self.store.remove_partial(provider, device, path)

    # ------------------------------------------------------------------ providers

    def serial_for(self, device: str | None) -> str:
        # ONE phone is bound at a time and its serial changes when the session moves between USB and Wi-Fi
        # (`R5CT…` <-> `192.168.1.7:5555`). A panel that still remembers the old serial means that same phone.
        serial = self._active_serial() or device
        if not serial:
            raise FsError("device_offline")
        return serial

    def phone(self, device: str | None) -> PhoneProvider:
        serial = self.serial_for(device)
        if serial not in self._phones:
            self._phones[serial] = PhoneProvider(serial, sync=self._sync, daemon=self._daemon, shell=self._adb)
        return self._phones[serial]

    def provider_for(self, loc: Location) -> FsProvider:
        return self.local if loc.provider == "pc" else self.phone(loc.device)

    def locate(self, provider: str, path: str, device: str | None = None) -> Location:
        if provider not in ("pc", "phone"):
            raise FsError("bad_request", "Bilinmeyen sağlayıcı.")
        return Location(provider, path, self.serial_for(device) if provider == "phone" else None)

    # ------------------------------------------------------------------ places

    async def places(self, device: str | None) -> dict[str, Any]:
        phone: list[dict[str, Any]] = []
        serial = self._active_serial() or device
        if serial:
            with contextlib.suppress(FsError):
                phone = [p.to_dict() for p in await self.phone(serial).places()]
        return {
            "pc": await self._pc_places_with_capacity(),
            "phone": phone,
            "device": serial,
            "favorites": await self.store.favorites(),
            "pc_access": self.roots.access,
        }

    async def _pc_places_with_capacity(self) -> list[dict[str, Any]]:
        """The sidebar shows a capacity bar for drives and the home folder. `disk_usage` on a disconnected network drive can
        block for many seconds: it runs in a worker thread under a short deadline and a drive that does not answer simply
        has no bar."""
        places = [p.to_dict() for p in self.roots.places()]

        def measure(path: str) -> tuple[int, int] | None:
            try:
                usage = shutil.disk_usage(path)
            except OSError:
                return None
            return usage.total, usage.free

        for place in places:
            if place["kind"] not in ("drive", "home"):
                continue
            try:
                got = await asyncio.wait_for(asyncio.to_thread(measure, place["path"]), PLACE_CAPACITY_TIMEOUT_S)
            except asyncio.TimeoutError:
                continue
            if got is not None:
                place["total"], place["free"] = got
        return places

    async def add_folder(self, path: str) -> dict[str, Any]:
        resolved = self.roots.add_custom(path)
        await self.store.add_root(str(resolved))
        return {"path": str(resolved)}

    async def remove_folder(self, path: str) -> None:
        self.roots.remove_custom(path)
        await self.store.remove_root(path)

    # ------------------------------------------------------------------ listing

    async def open_list(self, loc: Location) -> tuple[str, list[Entry], AsyncIterator[list[Entry]]]:
        """(canonical path, first page, the remaining pages). The first page is read BEFORE the response starts, so a
        missing or forbidden folder is an HTTP error and not a broken stream."""
        provider = self.provider_for(loc)
        canonical = provider.canonical(loc.path)
        pages = provider.list(canonical)
        try:
            first = await pages.__anext__()
        except StopAsyncIteration:
            first = []

        async def rest() -> AsyncIterator[list[Entry]]:
            async for page in pages:
                yield page

        return canonical, first, rest()

    async def stat(self, loc: Location) -> Entry:
        return await self.provider_for(loc).stat(loc.path)

    # ------------------------------------------------------------------ changing

    async def mkdir(self, parent: Location, name: str) -> str:
        provider = self.provider_for(parent)
        validate_name(name, windows=provider.windows)
        target = provider.join(provider.canonical(parent.path), name)
        await provider.mkdir(target)
        self._changed(parent)
        return target

    async def rename(self, loc: Location, new_name: str) -> str:
        provider = self.provider_for(loc)
        validate_name(new_name, windows=provider.windows)
        source = provider.canonical(loc.path, follow_leaf=False)
        target = provider.join(provider.parent(source), new_name)
        old_name = provider.basename(source)
        if provider.casefold and comparison_key(old_name, casefold=True) == comparison_key(new_name, casefold=True) and old_name != new_name:
            # A case-only rename ('a.txt' → 'A.txt') is a collision with itself on a case-insensitive place: go via a
            # temporary name, so it works on Windows shares and on the phone's shared storage alike.
            hop = provider.join(provider.parent(source), f".{secrets.token_hex(4)}.opdx-rename")
            await provider.rename(source, hop)
            await provider.rename(hop, target)
        else:
            await provider.rename(source, target)
        self._changed(Location(loc.provider, provider.parent(source), loc.device))
        return target

    async def delete(self, locs: list[Location], *, permanent: bool) -> list[dict[str, Any]]:
        """Each item on its own: one that cannot go does not stop the others. To the Recycle Bin unless `permanent`."""
        results: list[dict[str, Any]] = []
        for loc in locs:
            provider = self.provider_for(loc)
            try:
                if loc.provider == "pc":
                    path = provider.canonical(loc.path, follow_leaf=False)
                    await (provider.delete(path) if permanent else provider.trash(path))  # type: ignore[attr-defined]
                else:
                    await (provider.delete(loc.path) if permanent else self._phone_trash(provider, loc))  # type: ignore[arg-type]
                results.append({"path": loc.path, "ok": True})
                self._changed(Location(loc.provider, provider.parent(loc.path), loc.device))
            except FsError as exc:
                results.append({"path": loc.path, "ok": False, "error": exc.to_dict()})
        return results

    # --- the phone's Recycle Bin: a hidden folder per volume, a row per item

    @staticmethod
    def _volume_of(path: str) -> str | None:
        parts = path.split("/")
        if path.startswith("/storage/emulated/") and len(parts) > 4:
            return "/".join(parts[:5])
        if path.startswith("/storage/") and len(parts) > 3 and parts[2] != "emulated":
            return "/".join(parts[:3])
        return None

    async def _phone_trash(self, phone: PhoneProvider, loc: Location) -> None:
        from .models import normalize_phone_path

        path = normalize_phone_path(loc.path)
        volume = self._volume_of(path)
        if volume is None:
            raise FsError("trash_unavailable", "Bu konumda geri dönüşüm kutusu yok; kalıcı olarak silin.", path=path)
        entry = await phone.stat(path)
        bin_root = f"{volume}/{TRASH_DIR}"
        item_id = secrets.token_hex(6)
        folder = f"{bin_root}/{item_id}"
        with contextlib.suppress(FsError):
            await phone.mkdir(bin_root, parents=True)
            await phone.touch(f"{bin_root}/.nomedia")           # the Gallery must not show what was deleted
        await phone.mkdir(folder, parents=True)
        trash_path = f"{folder}/{entry.name}"
        await phone.rename(path, trash_path)
        await self.store.add_trash(TrashItem(item_id, phone.serial, path, trash_path, entry.name, entry.size, entry.is_dir, time.time()))

    async def trash_items(self, device: str | None) -> list[dict[str, Any]]:
        return [t.to_dict() for t in await self.store.trash(self.serial_for(device))]

    async def trash_restore(self, device: str | None, ids: list[str]) -> list[dict[str, Any]]:
        phone = self.phone(device)
        results = []
        for item in await self.store.trash(phone.serial, ids):
            try:
                parent = phone.parent(item.original)
                if not await _exists(phone, parent):
                    await phone.mkdir(parent, parents=True)
                target = item.original
                if await _exists(phone, target):
                    taken = {comparison_key(n, casefold=True) for n in await phone.names(parent)}
                    target = phone.join(parent, unique_name(item.name, taken, casefold=True))
                await phone.rename(item.trash_path, target)
                await phone.delete(phone.parent(item.trash_path))
                await self.store.forget_trash([item.id])
                results.append({"id": item.id, "ok": True, "path": target})
            except FsError as exc:
                results.append({"id": item.id, "ok": False, "error": exc.to_dict()})
        return results

    async def trash_delete(self, device: str | None, ids: list[str] | None) -> int:
        """Empties the bin (`ids` None) or removes the given items for good."""
        phone = self.phone(device)
        gone = 0
        for item in await self.store.trash(phone.serial, ids):
            with contextlib.suppress(FsError):
                await phone.delete(phone.parent(item.trash_path))
            await self.store.forget_trash([item.id])
            gone += 1
        return gone

    async def purge_trash(self, device: str | None) -> int:
        days = self._settings.FS_TRASH_DAYS
        if days <= 0:
            return 0
        phone = self.phone(device)
        cutoff = time.time() - days * 86400
        old = [t.id for t in await self.store.trash(phone.serial) if t.deleted < cutoff]
        return await self.trash_delete(phone.serial, old) if old else 0

    # ------------------------------------------------------------------ transfers

    def start_transfer(self, op: str, sources: list[Location], dest: Location, policy: str, verify: bool) -> TransferJob:
        return self.engine.create(TransferSpec(op, sources, dest, policy, verify))  # type: ignore[arg-type]

    # ------------------------------------------------------------------ search

    async def search(self, loc: Location, query: str, limit: int = SEARCH_LIMIT) -> dict[str, Any]:
        query = query.strip()
        if not query or len(query) > SEARCH_MAX_QUERY or any(c in query for c in "\x00\r\n"):
            raise FsError("bad_request", "Arama metni geçersiz.")
        provider = self.provider_for(loc)
        hits, truncated = await provider.search(provider.canonical(loc.path), query, limit=min(limit, SEARCH_LIMIT))  # type: ignore[attr-defined]
        return {"items": [{"path": path, **entry.to_dict()} for path, entry in hits], "truncated": truncated}

    # ------------------------------------------------------------------ thumbnails and previews

    async def thumbnail(self, loc: Location, px: int) -> tuple[bytes, str]:
        px = max(48, min(px, 512))
        if loc.provider == "pc":
            media_type, data = await self.thumbs.for_pc(self.roots.check(loc.path), px)
            return data, media_type
        phone = self.phone(loc.device)
        entry = await phone.stat(loc.path)
        if entry.is_dir:
            raise FsError("unsupported")
        media_type, data = await self.thumbs.for_phone(phone, phone.serial, phone.canonical(loc.path), px, entry.mtime, entry.size)
        return data, media_type

    async def content(self, loc: Location) -> ContentFile:
        """What the preview endpoint may serve: the PC file itself, or the phone file fetched INTO MEMORY (never to the disk)."""
        if loc.provider == "pc":
            path = self.roots.check(loc.path)
            st = await asyncio.to_thread(path.stat)
            return ContentFile(policy_for(path.name), path.name, st.st_size, path=path)
        phone = self.phone(loc.device)
        canonical = phone.canonical(loc.path)
        entry = await phone.stat(canonical)
        if entry.is_dir:
            raise FsError("is_a_dir", path=canonical)
        policy = policy_for(entry.name)
        if policy.kind in ("video", "audio"):
            return ContentFile(policy, entry.name, entry.size,
                               stream=lambda first, last: phone.read_range(canonical, first, last - first + 1))
        limit = min(self._settings.FS_PREVIEW_MAX_MB, self._settings.FS_CACHE_MB) * 1024 * 1024
        if entry.size > limit:
            raise FsError("too_large", "Dosya önizleme için çok büyük; bilgisayara kopyalayın.")
        key = MemoryCache.key("preview", phone.serial, canonical, int(entry.mtime), entry.size)
        hit = self.previews.get(key)
        if hit is None:
            lock = self._fetching.setdefault(key, asyncio.Lock())
            async with lock:
                hit = self.previews.get(key)
                if hit is None:
                    data = await self._fetch_to_memory(phone, canonical, limit)
                    self.previews.put(key, data)
                    hit = ("", data)
            self._fetching.pop(key, None)
        return ContentFile(policy, entry.name, len(hit[1]), data=hit[1])

    @staticmethod
    async def _fetch_to_memory(phone: PhoneProvider, path: str, limit: int) -> bytes:
        data = bytearray()
        reader = await phone.open_reader(path)
        try:
            async for chunk in reader.chunks():
                data += chunk
                if len(data) > limit:                                  # it grew since the listing
                    raise FsError("too_large", "Dosya önizleme için çok büyük; bilgisayara kopyalayın.")
        finally:
            await reader.aclose()
        return bytes(data)

    # ------------------------------------------------------------------ the desktop: open, reveal, grants

    async def open_on_pc(self, loc: Location) -> None:
        """Opens a file with its default program — never an executable: that is the one request a page must not be able to
        make (an `.exe` in Downloads would run). For those, 'show in folder' is the answer. A phone file is copied to the
        PC's temp folder under its own name first (the program needs a real file with the right extension): this is the one
        place, besides a transfer, where a phone file reaches the disk — and the user asked for it. The folder is emptied
        when the backend starts and stops."""
        if loc.provider == "pc":
            path = self.roots.check(loc.path)
            name = path.name
        else:
            name = loc.path.rsplit("/", 1)[-1]
        if os.path.splitext(name)[1].lower() in RISKY_EXTENSIONS:
            raise FsError("permission", "Bu dosya türü güvenlik nedeniyle doğrudan açılmaz; klasörde gösterin.")
        if loc.provider != "pc":
            path = await self._stage_phone_file(loc)
        await asyncio.to_thread(_open_default, path)

    async def _stage_phone_file(self, loc: Location) -> Path:
        phone = self.phone(loc.device)
        canonical = phone.canonical(loc.path)
        entry = await phone.stat(canonical)
        if entry.is_dir:
            raise FsError("is_a_dir", path=canonical)
        folder = self._staged_dir / secrets.token_hex(6)
        target = folder / windows_safe_name(entry.name)
        await asyncio.to_thread(folder.mkdir, parents=True)
        reader = await phone.open_reader(canonical)
        try:
            with open(target, "wb") as out:
                async for chunk in reader.chunks():
                    await asyncio.to_thread(out.write, chunk)
        except BaseException:
            await asyncio.to_thread(shutil.rmtree, folder, True)
            raise
        finally:
            await reader.aclose()
        return target

    async def reveal_on_pc(self, loc: Location) -> None:
        if loc.provider != "pc":
            raise FsError("unsupported", "Yalnız bilgisayardaki öğeler gösterilebilir.")
        path = self.roots.check(loc.path, follow_leaf=False)
        await asyncio.to_thread(_reveal, path)

    def verify_shell_token(self, presented: str | None) -> bool:
        import hmac

        return bool(self._shell_token and presented and hmac.compare_digest(presented, self._shell_token))

    async def grant(self, paths: list[str]) -> list[dict[str, Any]]:
        out = []
        for raw in paths[:200]:
            grant = self.roots.grant(secrets.token_hex(6), raw)
            entry = await self.local.stat(grant.path)
            out.append({"grant": grant.id, "path": grant.path, **entry.to_dict()})
        return out

    # ------------------------------------------------------------------ events

    def _changed(self, loc: Location) -> None:
        self._pump.put("fs_changed", {"provider": loc.provider, "device": loc.device, "path": loc.path})


class _EngineStore:
    """The engine's persistence port, backed by FsStore, plus the sweep of a finished job's leftovers."""

    def __init__(self, service: FsService) -> None:
        self._svc = service

    async def save_job(self, snapshot: dict[str, Any]) -> None:
        await self._svc.store.save_job(snapshot)

    async def add_partial(self, provider: str, device: str | None, path: str, job_id: str) -> None:
        await self._svc.store.add_partial(provider, device, path, job_id)

    async def remove_partial(self, provider: str, device: str | None, path: str) -> None:
        await self._svc.store.remove_partial(provider, device, path)

    async def sweep_job(self, job_id: str) -> None:
        for stale in await self._svc.store.partials(job_id=job_id):
            await self._svc._sweep_partial(*stale)


# ------------------------------------------------------------------------------------------------ helpers


async def _exists(provider: FsProvider, path: str) -> bool:
    try:
        await provider.stat(path)
        return True
    except FsError as exc:
        if exc.code == "not_found":
            return False
        raise


def _open_default(path: Path) -> None:  # pragma: no cover - desktop shell integration
    if sys.platform == "win32":
        os.startfile(str(path))  # type: ignore[attr-defined]  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])  # noqa: S603,S607
    else:
        subprocess.Popen(["xdg-open", str(path)])  # noqa: S603,S607


def _reveal(path: Path) -> None:  # pragma: no cover - desktop shell integration
    if sys.platform == "win32":
        subprocess.Popen(["explorer", f"/select,{path}"])  # noqa: S603,S607
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)])  # noqa: S603,S607
    else:
        subprocess.Popen(["xdg-open", str(path.parent)])  # noqa: S603,S607
