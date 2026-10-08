"""File system endpoints: browsing, changes, transfers, previews — over the PC and the phone.

Thin on purpose: input validation and response shaping only; every rule lives in app/fs. A failure is an FsError whose
`code` the UI switches on; the handler registered in main.py turns it into `{detail, code, path}` with the right status.
"""
from __future__ import annotations

import json
from typing import Annotated, AsyncIterator, Literal

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.api.deps import AppContextDep
from app.fs import ranged
from app.fs.content import SANDBOX_HEADERS, ContentPolicy
from app.fs.errors import FsError
from app.fs.models import Location
from app.schemas.fs import (
    DeleteRequest,
    FavoriteRequest,
    FolderRequest,
    FsLocation,
    GrantRequest,
    MkdirRequest,
    OpenRequest,
    RenameRequest,
    ResolveRequest,
    TransferRequest,
    TrashDeleteRequest,
    TrashRestoreRequest,
)

router = APIRouter(prefix="/fs")

ProviderQ = Annotated[Literal["pc", "phone"], Query()]
PathQ = Annotated[str, Query(min_length=1, max_length=4096)]
DeviceQ = Annotated[str | None, Query(max_length=128)]


def _fs(ctx):
    if not ctx.settings.FS_ENABLED:
        raise HTTPException(status_code=404, detail="Dosya yöneticisi kapalı.")
    return ctx.fs


def _loc(fs, loc: FsLocation) -> Location:
    return fs.locate(loc.provider, loc.path, loc.device)


# ---------------------------------------------------------------------------------------------- places


@router.get("/places")
async def places(ctx: AppContextDep, device: DeviceQ = None):
    """The places the file manager starts from: this PC's allowed folders (with free space), the bound phone's volumes, the user's favorites and the PC access level (`folders` | `home` | `all`)."""
    return await _fs(ctx).places(device)


@router.post("/folders")
async def add_folder(ctx: AppContextDep, body: FolderRequest, x_opendex_shell: Annotated[str | None, Header()] = None):
    """Widen what the file manager may browse — PERMANENTLY. Like a grant, only a folder the user picked through the native
    dialog counts, so this needs the shell token a page never holds (narrowing, DELETE, needs nothing extra)."""
    fs = _fs(ctx)
    if not fs.verify_shell_token(x_opendex_shell):
        return JSONResponse({"detail": "Klasör eklemek yalnız uygulama kabuğundan yapılabilir.", "code": "permission"}, status_code=403)
    return await fs.add_folder(body.path)


@router.delete("/folders")
async def remove_folder(ctx: AppContextDep, path: PathQ):
    """Narrows the file manager again: forgets a folder that was added before. Only WIDENING needs the shell token, so this does not."""
    await _fs(ctx).remove_folder(path)
    return {"ok": True}


@router.get("/favorites")
async def favorites(ctx: AppContextDep):
    """The user's favorite places."""
    return {"items": await _fs(ctx).store.favorites()}


@router.post("/favorites")
async def add_favorite(ctx: AppContextDep, body: FavoriteRequest):
    """Adds a favorite place (a folder on the PC or on the phone)."""
    fs = _fs(ctx)
    loc = _loc(fs, body.location)
    return await fs.store.add_favorite(loc.provider, loc.device, loc.path, body.name)


@router.delete("/favorites/{favorite_id}")
async def remove_favorite(ctx: AppContextDep, favorite_id: str):
    """Removes a favorite place by its id."""
    await _fs(ctx).store.remove_favorite(favorite_id)
    return {"ok": True}


# ---------------------------------------------------------------------------------------------- browsing


@router.get("/list")
async def list_folder(ctx: AppContextDep, provider: ProviderQ, path: PathQ, device: DeviceQ = None):
    """A folder as NDJSON, so the first entries paint while a 20 000-file folder is still being read:

        {"type":"meta","provider","device","path","parent"}
        {"type":"entries","items":[{name,kind,size,mtime,hidden,readonly,symlink,link_target?,mode?}…]}   (repeated)
        {"type":"end","total":N}                         or, if it breaks halfway:  {"type":"error","code","message"}
    """
    fs = _fs(ctx)
    loc = fs.locate(provider, path, device)
    canonical, first, rest = await fs.open_list(loc)           # raises before the response starts: a real HTTP error
    prov = fs.provider_for(loc)

    async def stream() -> AsyncIterator[bytes]:
        total = len(first)
        yield _line({"type": "meta", "provider": loc.provider, "device": loc.device, "path": canonical,
                     "parent": None if prov.parent(canonical) == canonical else prov.parent(canonical)})
        if first:
            yield _line({"type": "entries", "items": [e.to_dict() for e in first]})
        try:
            async for page in rest:
                total += len(page)
                yield _line({"type": "entries", "items": [e.to_dict() for e in page]})
            yield _line({"type": "end", "total": total})
        except FsError as exc:
            yield _line({"type": "error", "code": exc.code, "message": exc.message})

    return StreamingResponse(stream(), media_type="application/x-ndjson", headers={"X-Accel-Buffering": "no"})


def _line(obj: dict) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


@router.get("/stat")
async def stat(ctx: AppContextDep, provider: ProviderQ, path: PathQ, device: DeviceQ = None):
    """Metadata of one file or folder."""
    fs = _fs(ctx)
    return (await fs.stat(fs.locate(provider, path, device))).to_dict()


@router.get("/search")
async def search(ctx: AppContextDep, provider: ProviderQ, path: PathQ, q: Annotated[str, Query(min_length=1, max_length=100)],
                 device: DeviceQ = None, limit: Annotated[int, Query(ge=1, le=500)] = 500):
    """Entries whose name contains `q` under a folder: at most `limit` (never more than 500); `truncated` says the limit cut the list."""
    fs = _fs(ctx)
    return await fs.search(fs.locate(provider, path, device), q, limit)


# ---------------------------------------------------------------------------------------------- changes


@router.post("/mkdir")
async def mkdir(ctx: AppContextDep, body: MkdirRequest):
    """Creates the folder `name` inside `parent`; answers the new path."""
    fs = _fs(ctx)
    return {"path": await fs.mkdir(_loc(fs, body.parent), body.name)}


@router.post("/rename")
async def rename(ctx: AppContextDep, body: RenameRequest):
    """Renames an entry within its folder; answers the new path."""
    fs = _fs(ctx)
    return {"path": await fs.rename(_loc(fs, body.location), body.name)}


@router.post("/delete")
async def delete(ctx: AppContextDep, body: DeleteRequest):
    """Deletes each item on its own — to the Recycle Bin / the phone's trash unless `permanent` — so one that cannot go does not stop the others. Answers `results: [{path, ok, …}]`."""
    fs = _fs(ctx)
    return {"results": await fs.delete([_loc(fs, i) for i in body.items], permanent=body.permanent)}


@router.get("/trash")
async def trash(ctx: AppContextDep, device: DeviceQ = None):
    """The items in the trash that OpenDeX can restore."""
    return {"items": await _fs(ctx).trash_items(device)}


@router.post("/trash/restore")
async def trash_restore(ctx: AppContextDep, body: TrashRestoreRequest):
    """Puts trashed items back where they were deleted from; one result per id."""
    return {"results": await _fs(ctx).trash_restore(body.device, body.ids)}


@router.post("/trash/delete")
async def trash_delete(ctx: AppContextDep, body: TrashDeleteRequest):
    """Deletes trashed items for good; answers how many were deleted."""
    return {"deleted": await _fs(ctx).trash_delete(body.device, body.ids)}


# ---------------------------------------------------------------------------------------------- transfers


@router.post("/transfers", status_code=202)
async def create_transfer(ctx: AppContextDep, body: TransferRequest):
    """Starts a copy or move job (`op`, `sources` → `dest`, conflict `policy`, optional `verify`) and answers its snapshot at once (202); progress arrives as `fs_transfer` events."""
    fs = _fs(ctx)
    job = fs.start_transfer(body.op, [_loc(fs, s) for s in body.sources], _loc(fs, body.dest), body.policy, body.verify)
    return job.snapshot()


@router.get("/transfers")
async def list_transfers(ctx: AppContextDep):
    """The running, queued and recent transfer jobs."""
    return {"items": _fs(ctx).engine.list()}


@router.get("/transfers/history")
async def transfer_history(ctx: AppContextDep, limit: Annotated[int, Query(ge=1, le=200)] = 50):
    """Finished transfer jobs from the history store (`limit` 1–200)."""
    return {"items": await _fs(ctx).store.history(limit)}


@router.post("/transfers/clear")
async def clear_transfers(ctx: AppContextDep):
    """Removes the finished jobs from the list; answers how many."""
    return {"removed": _fs(ctx).engine.clear_finished()}


@router.post("/transfers/{job_id}/pause")
async def pause_transfer(ctx: AppContextDep, job_id: str):
    """Pauses a transfer job."""
    _fs(ctx).engine.pause(job_id)
    return {"ok": True}


@router.post("/transfers/{job_id}/resume")
async def resume_transfer(ctx: AppContextDep, job_id: str):
    """Resumes a paused transfer job."""
    _fs(ctx).engine.resume(job_id)
    return {"ok": True}


@router.post("/transfers/{job_id}/cancel")
async def cancel_transfer(ctx: AppContextDep, job_id: str):
    """Cancels a transfer job."""
    _fs(ctx).engine.cancel(job_id)
    return {"ok": True}


@router.post("/transfers/{job_id}/resolve")
async def resolve_conflict(ctx: AppContextDep, job_id: str, body: ResolveRequest):
    """Answers the conflict a transfer is waiting on: `resolution` (and `apply_to_all` for the remaining conflicts of that job)."""
    _fs(ctx).engine.resolve(job_id, body.resolution, body.apply_to_all)
    return {"ok": True}


@router.delete("/transfers/{job_id}")
async def remove_transfer(ctx: AppContextDep, job_id: str):
    """Removes one finished job from the list."""
    _fs(ctx).engine.remove(job_id)
    return {"ok": True}


# ---------------------------------------------------------------------------------------------- bytes for the page


@router.get("/thumb")
async def thumb(ctx: AppContextDep, provider: ProviderQ, path: PathQ, device: DeviceQ = None,
                px: Annotated[int, Query(ge=48, le=512)] = 160, v: str | None = None):
    """A WebP/JPEG thumbnail, held in the backend's memory. `v` (the file's mtime+size, which the listing already carries) is
    part of the URL so an edited file asks for a new one; the response is never stored by the browser either (`no-store`):
    a thumbnail is a preview, and previews do not reach the disk."""
    fs = _fs(ctx)
    data, media_type = await fs.thumbnail(fs.locate(provider, path, device), px)
    return ranged.serve_bytes(data, media_type, None, dict(SANDBOX_HEADERS))


@router.get("/content")
async def content(request: Request, ctx: AppContextDep, provider: ProviderQ, path: PathQ, device: DeviceQ = None,
                  download: bool = False):
    """The file for a preview: images, audio, video and text inline (as a SAFE media type — see fs/content.py), everything
    else as a download (the page's document viewers read those bytes with fetch and render them themselves). A phone file
    is served from memory (a phone video/audio is read from the phone as it plays), a PC file in place. Supports Range, so a video can seek. Never cached by the browser."""
    fs = _fs(ctx)
    served = await fs.content(fs.locate(provider, path, device))
    policy = served.policy
    if download:
        policy = ContentPolicy("application/octet-stream", False, "other")
    wanted = request.headers.get("range")
    if served.stream is not None:
        return ranged.serve_stream(served.size, policy.media_type, wanted, policy.headers(served.filename), served.stream)
    if served.data is not None:
        return ranged.serve_bytes(served.data, policy.media_type, wanted, policy.headers(served.filename))
    return ranged.serve(served.path, served.size, policy.media_type, wanted, policy.headers(served.filename))


# ---------------------------------------------------------------------------------------------- the desktop


@router.post("/open")
async def open_file(ctx: AppContextDep, body: OpenRequest):
    """Opens a file with its default program — never an executable (those are refused with 403 `permission`; use `reveal`). A phone file is copied to a temp folder first."""
    fs = _fs(ctx)
    await fs.open_on_pc(_loc(fs, body.location))
    return {"ok": True}


@router.post("/reveal")
async def reveal(ctx: AppContextDep, body: OpenRequest):
    """Shows a PC item in the system file manager (PC items only)."""
    fs = _fs(ctx)
    await fs.reveal_on_pc(_loc(fs, body.location))
    return {"ok": True}


@router.post("/grants")
async def grants(ctx: AppContextDep, body: GrantRequest, x_opendex_shell: Annotated[str | None, Header()] = None):
    """Paths the user dropped or picked through NATIVE UI. Only the Tauri shell holds the token this needs, so a page —
    however it got its script — cannot widen what the file manager may read."""
    fs = _fs(ctx)
    if not fs.verify_shell_token(x_opendex_shell):
        return JSONResponse({"detail": "Bu işlem yalnız uygulama kabuğundan yapılabilir.", "code": "permission"}, status_code=403)
    return {"items": await fs.grant(body.paths)}

