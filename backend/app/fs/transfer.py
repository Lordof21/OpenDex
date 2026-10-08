"""The transfer engine: copy and move between any two places — phone ↔ PC, PC ↔ PC, phone ↔ phone — as jobs a person
can watch, pause, cancel and answer.

What it guarantees, and how:

  * NOTHING IS EVER HALF-WRITTEN under its final name. Bytes go to a hidden sibling temp file (the provider's atomic
    writer); only a finished, size-checked file is renamed into place. Cancel, a crash or a pulled cable leaves a stray
    `.opdx-…part` file the partial ledger finds again — never a truncated photo that looks real.
  * NOTHING IS LOST BY A MOVE. A source file is deleted only after its copy was committed and verified; a source folder
    only after everything under it moved and it is empty. Cancel a move halfway and what had not moved is still there.
  * NOTHING IS OVERWRITTEN BY SURPRISE. A name that already exists is a conflict: ask / replace / skip / keep both /
    replace if newer — per job, or "apply to all". Names are compared the way the DESTINATION compares them (Windows and
    the phone's shared storage ignore case), and names the destination cannot hold (a phone file called `a:b?.jpg` on
    Windows) are converted, never failed.
  * A DEAD LINK DOES NOT KILL A JOB. A transient failure retries the file; a vanished device parks the job (`paused`,
    reason `device_offline`) until it is back. A file pulled from the phone to the PC then CONTINUES from the byte it had
    reached (the kept `.opdx-…part` file is checked against the source first); every other combination — an upload to the
    phone cannot append — starts the file again from its beginning. Resuming lives in memory: after the app restarts a
    half file is swept, never trusted.
  * ONE FAILED FILE DOES NOT STOP THE REST. Errors are collected per item; the job completes with its error list.
"""
from __future__ import annotations

import asyncio
import contextlib
import functools
import hashlib
import logging
import secrets
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Protocol

from .errors import FsError
from .models import Entry, Location
from .names import comparison_key, phone_safe_name, unique_name, windows_safe_name
from .providers.base import FsProvider, ResumeRejected

log = logging.getLogger(__name__)

Op = Literal["copy", "move"]
Policy = Literal["ask", "replace", "skip", "keep_both", "replace_if_newer"]
State = Literal["queued", "scanning", "running", "waiting", "paused", "completed", "failed", "cancelled"]
POLICIES = ("ask", "replace", "skip", "keep_both", "replace_if_newer")
RESOLUTIONS = ("replace", "skip", "keep_both")
TERMINAL: frozenset[str] = frozenset({"completed", "failed", "cancelled"})
MAX_SOURCES = 5000
MAX_RECORDED = 50                        # errors / renames kept on a job
RETRIES = 2
RETRY_DELAY_S = 1.0
DEVICE_WAIT_S = 600.0
EMIT_INTERVAL_S = 0.2
CHANGED_INTERVAL_S = 1.0
SPEED_WINDOW_S = 3.0
MEDIA_EXTENSIONS = frozenset({
    "jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp", "mp4", "mkv", "webm", "3gp", "mov", "avi",
    "mp3", "m4a", "flac", "ogg", "opus", "wav", "aac", "pdf",
})
TRANSIENT = frozenset({"timeout", "io", "device_offline"})


class Store(Protocol):
    """What the engine reports to persistence (the file system's SQLite tables — or nothing, in tests)."""

    async def save_job(self, snapshot: dict[str, Any]) -> None: ...

    async def add_partial(self, provider: str, device: str | None, path: str, job_id: str) -> None: ...

    async def remove_partial(self, provider: str, device: str | None, path: str) -> None: ...

    async def sweep_job(self, job_id: str) -> None:
        """Deletes the temp files this job recorded and left behind (cancel / failure), then forgets them."""


class NullStore:
    async def save_job(self, snapshot: dict[str, Any]) -> None: ...

    async def add_partial(self, provider: str, device: str | None, path: str, job_id: str) -> None: ...

    async def remove_partial(self, provider: str, device: str | None, path: str) -> None: ...

    async def sweep_job(self, job_id: str) -> None: ...


ProviderFor = Callable[[Location], FsProvider]
Emit = Callable[[str, dict[str, Any]], None]


@dataclass(slots=True)
class DirTask:
    src: Location
    dest: Location                       # the folder to create (or merge into)
    parent: "DirTask | None" = None
    pending: int = 0                     # files under it not yet moved (move only)
    keep: bool = False                   # something under it stays behind (skipped / failed / a link): the source folder stays
    broken: bool = False                 # it could not be created: nothing under it is transferred


@dataclass(slots=True)
class ResumePoint:
    """What an interrupted copy left behind: `offset` bytes of the file are in the kept temporary file `temp`."""
    offset: int
    temp: str
    size: int                            # the source's size when those bytes were read
    mtime: float                         # ... and its modification time: both must still match before the bytes are trusted


@dataclass(slots=True)
class FileTask:
    src: Location
    dest_dir: Location                   # the folder the file goes into
    name: str                            # its name there, before conflict handling
    size: int
    mtime: float
    owner: DirTask | None = None         # the planned folder it belongs to (None: a file picked directly)
    decided: tuple[str, bool] | None = None   # (final name, overwrite) once conflict handling is done — a retry keeps it
    counted: int = 0                     # bytes of this file already added to the job (taken back on a retry)
    attempts: int = 0
    resume: ResumePoint | None = None    # set while a cut copy waits to be continued (providers permitting)
    digest: Any = None                   # the running hash of the bytes before `resume.offset` (verify jobs)
    reached: int = 0                     # the furthest byte any cut attempt got to: only going PAST it counts as progress


@dataclass(slots=True)
class Conflict:
    name: str
    incoming: dict[str, Any]
    existing: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "incoming": self.incoming, "existing": self.existing,
                "choices": list(RESOLUTIONS)}


@dataclass(slots=True)
class TransferSpec:
    op: Op
    sources: list[Location]
    dest: Location
    policy: Policy = "ask"
    verify: bool = False


class TransferJob:
    """The mutable record of one transfer. Everything the UI shows comes from `snapshot()`."""

    def __init__(self, spec: TransferSpec, clock: Callable[[], float]) -> None:
        self.id = secrets.token_hex(6)
        self.tag = self.id[:8]
        self.spec = spec
        self.policy: Policy = spec.policy
        self.state: State = "queued"
        self.pause_reason: str | None = None
        self.created = time.time()
        self.started: float | None = None
        self.finished: float | None = None
        self.scanned = 0
        self.total_files = 0
        self.total_bytes = 0
        self.done_files = 0
        self.done_bytes = 0
        self.skipped = 0
        self.failed = 0
        self.current: list[str] = []
        self.errors: list[dict[str, Any]] = []
        self.renamed: list[dict[str, str]] = []
        self.conflict: Conflict | None = None
        self.error: dict[str, Any] | None = None
        self.task: asyncio.Task | None = None
        self.gate = asyncio.Event()                         # cleared while paused
        self.gate.set()
        self.answer: asyncio.Future[tuple[str, bool]] | None = None
        self.ask_lock = asyncio.Lock()
        self.cancelled = False
        self.dirs: list[DirTask] = []
        self.files: list[FileTask] = []
        self.touched: dict[str, Location] = {}               # folders whose content changed
        self.media: list[str] = []                           # files the phone's media scanner should learn about
        self._clock = clock
        self._samples: deque[tuple[float, int]] = deque()

    # ------------------------------------------------------------------ progress

    def sample(self) -> None:
        now = self._clock()
        self._samples.append((now, self.done_bytes))
        while self._samples and now - self._samples[0][0] > SPEED_WINDOW_S:
            self._samples.popleft()

    @property
    def speed(self) -> float:
        if len(self._samples) < 2:
            return 0.0
        (t0, b0), (t1, b1) = self._samples[0], self._samples[-1]
        return max(0.0, (b1 - b0) / (t1 - t0)) if t1 > t0 else 0.0

    @property
    def eta(self) -> float | None:
        remaining = self.total_bytes - self.done_bytes
        return remaining / self.speed if self.speed > 0 and remaining > 0 else None

    def give_up_on(self, task: FileTask, error: FsError | None) -> None:
        """A file that will not be transferred: out of the totals (so the bar can still reach 100 %), into the tallies."""
        self.total_files -= 1
        self.total_bytes -= task.size
        if error is None:
            self.skipped += 1
        else:
            self.failed += 1
            if len(self.errors) < MAX_RECORDED:
                self.errors.append({"name": task.name, **error.to_dict()})
        node = task.owner
        while node is not None:
            node.keep = True
            node = node.parent

    def note_rename(self, original: str, final: str) -> None:
        if len(self.renamed) < MAX_RECORDED:
            self.renamed.append({"from": original, "to": final})

    @property
    def public_state(self) -> State:
        """What the UI is told. `state` is the engine's own phase (scanning / running …); a job whose gate is shut — the
        user paused it, or a vanished device parked it — is `paused`, whatever phase it stopped in. A pending conflict
        stays `waiting`: that card needs the user's answer, and the pause only takes hold again once it is given."""
        if self.pause_reason is not None and self.state not in TERMINAL and self.state != "waiting":
            return "paused"
        return self.state

    def snapshot(self) -> dict[str, Any]:
        eta = self.eta
        return {
            "id": self.id,
            "op": self.spec.op,
            "state": self.public_state,
            "pause_reason": self.pause_reason,
            "policy": self.policy,
            "verify": self.spec.verify,
            "sources": [{"provider": s.provider, "device": s.device, "path": s.path} for s in self.spec.sources[:20]],
            "source_count": len(self.spec.sources),
            "dest": {"provider": self.spec.dest.provider, "device": self.spec.dest.device, "path": self.spec.dest.path},
            "scanned": self.scanned,
            "total_files": self.total_files,
            "total_bytes": self.total_bytes,
            "done_files": self.done_files,
            "done_bytes": self.done_bytes,
            "skipped": self.skipped,
            "failed": self.failed,
            "speed": round(self.speed),
            "eta": None if eta is None else round(eta),
            "current": list(self.current),
            "errors": list(self.errors),
            "renamed": list(self.renamed),
            "conflict": self.conflict.to_dict() if self.conflict else None,
            "error": self.error,
            "created": self.created,
            "started": self.started,
            "finished": self.finished,
        }


class DirIndex:
    """What a destination folder holds, read ONCE and kept current as this job adds to it, compared the way that
    destination compares names. One lock per folder: two workers can never claim the same name."""

    def __init__(self) -> None:
        self._entries: dict[str, dict[str, Entry]] = {}
        self._claimed: dict[str, set[str]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def lock(self, loc: Location) -> asyncio.Lock:
        return self._locks.setdefault(loc.key(), asyncio.Lock())

    async def load(self, loc: Location, provider: FsProvider) -> tuple[dict[str, Entry], set[str]]:
        key = loc.key()
        if key not in self._entries:
            entries: dict[str, Entry] = {}
            try:
                async for page in provider.list(loc.path):
                    for entry in page:
                        entries[comparison_key(entry.name, casefold=provider.casefold)] = entry
            except FsError as exc:
                if exc.code != "not_found":              # a folder this job is about to create: nothing in it yet
                    raise
            self._entries[key] = entries
            self._claimed[key] = set()
        return self._entries[key], self._claimed[key]


def target_name(name: str, provider: FsProvider) -> str:
    """The name a file gets at `provider`: the destination's rules applied — a name is converted, never refused."""
    if provider.windows:
        return windows_safe_name(name)
    if provider.name == "phone":
        return phone_safe_name(name)
    return name


class TransferEngine:
    def __init__(
        self,
        provider_for: ProviderFor,
        *,
        emit: Emit,
        store: Store | None = None,
        workers: int = 3,
        max_jobs: int = 2,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._provider_for = provider_for
        self._emit = emit
        self._store: Store = store or NullStore()
        self._workers = max(1, workers)
        self._slots = asyncio.Semaphore(max(1, max_jobs))
        self._clock = clock
        self._sleep = sleep
        self._jobs: dict[str, TransferJob] = {}
        self._last_emit: dict[str, float] = {}
        self._changed_at: dict[str, float] = {}
        self._online: dict[str, asyncio.Event] = {}

    # ------------------------------------------------------------------ the API

    def create(self, spec: TransferSpec) -> TransferJob:
        """Validates (synchronously, so a bad request is an HTTP error, not a failed job) and queues the job."""
        if spec.op not in ("copy", "move") or spec.policy not in POLICIES:
            raise FsError("bad_request")
        if not spec.sources or len(spec.sources) > MAX_SOURCES:
            raise FsError("bad_request", "Kaynak listesi boş ya da çok uzun.")
        dest_provider = self._provider_for(spec.dest)
        dest = Location(spec.dest.provider, dest_provider.canonical(spec.dest.path), spec.dest.device)
        sources = []
        for src in spec.sources:                                   # a link is a source in its own right: never followed
            sources.append(Location(src.provider, self._provider_for(src).canonical(src.path, follow_leaf=False), src.device))
        if len({s.key() for s in sources}) != len(sources):
            raise FsError("bad_request", "Aynı öğe birden fazla kez seçilmiş.")
        job = TransferJob(TransferSpec(spec.op, sources, dest, spec.policy, spec.verify), self._clock)
        self._jobs[job.id] = job
        job.task = asyncio.create_task(self._supervise(job), name=f"fs-transfer-{job.id}")
        self._publish(job, force=True)
        return job

    def get(self, job_id: str) -> TransferJob:
        job = self._jobs.get(job_id)
        if job is None:
            raise FsError("not_found", "İşlem bulunamadı.")
        return job

    def list(self) -> list[dict[str, Any]]:
        return [j.snapshot() for j in sorted(self._jobs.values(), key=lambda j: j.created)]

    def pause(self, job_id: str) -> None:
        job = self.get(job_id)
        if job.state not in TERMINAL and job.pause_reason is None:
            job.pause_reason = "user"
            job.gate.clear()
            self._publish(job, force=True)

    def resume(self, job_id: str) -> None:
        """Continues a job the user paused — or one parked for a missing device (the user says: try now)."""
        job = self.get(job_id)
        if job.pause_reason == "user":
            job.pause_reason = None
            job.gate.set()
            self._publish(job, force=True)
        elif job.pause_reason == "device_offline":
            for event in self._online.values():
                event.set()

    def cancel(self, job_id: str) -> None:
        job = self.get(job_id)
        if job.state in TERMINAL:
            return
        job.cancelled = True
        job.gate.set()
        if job.answer is not None and not job.answer.done():
            job.answer.cancel()
        if job.task is not None:
            job.task.cancel()

    def remove(self, job_id: str) -> None:
        job = self.get(job_id)
        if job.state not in TERMINAL:
            raise FsError("busy", "Çalışan işlem silinemez; önce iptal edin.")
        del self._jobs[job_id]
        self._last_emit.pop(job_id, None)

    def clear_finished(self) -> int:
        done = [j.id for j in self._jobs.values() if j.state in TERMINAL]
        for job_id in done:
            self.remove(job_id)
        return len(done)

    def resolve(self, job_id: str, resolution: str, apply_to_all: bool) -> None:
        job = self.get(job_id)
        if resolution not in RESOLUTIONS:
            raise FsError("bad_request")
        if job.answer is None or job.answer.done():
            raise FsError("conflict_pending", "Bekleyen bir çakışma yok.")
        job.answer.set_result((resolution, bool(apply_to_all)))

    def device_online(self, serial: str) -> None:
        """The service reports a device reachable again: jobs parked for it go on."""
        event = self._online.get(serial)
        if event is not None:
            event.set()

    async def aclose(self) -> None:
        tasks = [j.task for j in self._jobs.values() if j.task is not None]
        for job in list(self._jobs.values()):
            self.cancel(job.id)
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    # ------------------------------------------------------------------ emitting

    def _publish(self, job: TransferJob, *, force: bool = False) -> None:
        now = self._clock()
        if not force and now - self._last_emit.get(job.id, -1e9) < EMIT_INTERVAL_S:
            return
        self._last_emit[job.id] = now
        self._emit("fs_transfer", job.snapshot())

    def _changed(self, loc: Location, *, force: bool = False) -> None:
        """A folder this job changed: open listings of it refresh (a folder at most once a second while a job runs)."""
        key, now = loc.key(), self._clock()
        if force or now - self._changed_at.get(key, -1e9) >= CHANGED_INTERVAL_S:
            self._changed_at[key] = now
            self._emit("fs_changed", {"provider": loc.provider, "device": loc.device, "path": loc.path})

    # ------------------------------------------------------------------ the job

    async def _supervise(self, job: TransferJob) -> None:
        try:
            async with self._slots:                                 # a third job waits here, `queued`, and can be cancelled there
                job.started = time.time()
                await self._run(job)
            job.state = "cancelled" if job.cancelled else ("failed" if job.failed and not job.done_files else "completed")
        except asyncio.CancelledError:
            job.state = "cancelled"
        except FsError as exc:
            job.state, job.error = "failed", exc.to_dict()
        except Exception as exc:  # one job's bug must not take the engine down
            log.exception("[fs] transfer %s crashed", job.id)
            job.state, job.error = "failed", FsError("io", detail=str(exc)).to_dict()
        finally:
            job.finished = time.time()
            job.current, job.conflict, job.pause_reason = [], None, None
            with contextlib.suppress(Exception):
                await self._after(job)
            job.files, job.dirs = [], []                          # the plan can be big; a finished job only needs its numbers
            self._publish(job, force=True)
            with contextlib.suppress(Exception):
                await self._store.save_job(job.snapshot())

    async def _after(self, job: TransferJob) -> None:
        """Whatever the outcome: stray temp files go, the phone's media scanner learns about new files, open listings refresh."""
        with contextlib.suppress(Exception):
            await self._store.sweep_job(job.id)
        for loc in job.touched.values():
            self._changed(loc, force=True)
        if job.media and job.spec.dest.provider == "phone":
            scan = getattr(self._provider_for(job.spec.dest), "scan", None)
            if scan is not None:
                await scan(job.media[:500])

    async def _run(self, job: TransferJob) -> None:
        dest = self._provider_for(job.spec.dest)
        if not (await dest.stat(job.spec.dest.path)).is_dir:
            raise FsError("not_a_dir", "Hedef bir klasör değil.", path=job.spec.dest.path)
        index = DirIndex()
        job.state = "scanning"
        self._publish(job, force=True)
        await self._scan(job, dest, index)
        await self._preflight(job, dest)
        job.state = "running"
        self._publish(job, force=True)
        await self._create_dirs(job, dest)
        await self._transfer_files(job, dest, index)
        if job.spec.op == "move" and not job.cancelled:
            await self._remove_moved_folders(job)

    # ------------------------------------------------------------------ 1. scan: what is to be done

    async def _scan(self, job: TransferJob, dest: FsProvider, index: DirIndex) -> None:
        spec = job.spec
        for src_loc in spec.sources:
            await job.gate.wait()
            src = self._provider_for(src_loc)
            entry = await src.stat(src_loc.path)
            here = src_loc.provider == spec.dest.provider and src_loc.device == spec.dest.device
            if here and spec.op == "move" and _same(src.parent(src_loc.path), spec.dest.path, src):
                job.skipped += 1                                  # moved into the folder it is already in
                continue
            if here and entry.is_dir and _inside(spec.dest.path, src_loc.path, src):
                raise FsError("bad_request", "Bir klasör kendi içine kopyalanamaz.", path=src_loc.path)
            if entry.symlink:                                     # links are never followed, never copied
                job.skipped += 1
                continue
            name = target_name(entry.name or src.basename(src_loc.path), dest)
            if entry.is_dir:
                name = await self._free_folder_name(job, dest, index, name)
                await self._plan_folder(job, src, src_loc, dest, name)
            else:
                job.files.append(FileTask(src_loc, spec.dest, name, entry.size, entry.mtime))
                job.total_files += 1
                job.total_bytes += entry.size
            job.scanned += 1
            self._publish(job)

    async def _free_folder_name(self, job: TransferJob, dest: FsProvider, index: DirIndex, name: str) -> str:
        """A source folder merges into a destination folder of the same name; if a FILE holds the name, the folder is
        renamed (keep both) — a folder never replaces a file."""
        entries, claimed = await index.load(job.spec.dest, dest)
        key = comparison_key(name, casefold=dest.casefold)
        existing = entries.get(key)
        if existing is not None and not existing.is_dir:
            fresh = unique_name(name, set(entries) | claimed, casefold=dest.casefold)
            job.note_rename(name, fresh)
            name, key = fresh, comparison_key(fresh, casefold=dest.casefold)
        claimed.add(key)
        return name

    async def _plan_folder(self, job: TransferJob, src: FsProvider, src_loc: Location, dest: FsProvider, name: str) -> None:
        """A folder and everything under it, in pre-order. Links are noted and left alone (a link into the tree itself
        would loop forever)."""
        top = DirTask(src_loc, Location(job.spec.dest.provider, dest.join(job.spec.dest.path, name), job.spec.dest.device))
        job.dirs.append(top)
        by_rel: dict[str, DirTask] = {"": top}
        move = job.spec.op == "move"
        async for item in src.walk(src_loc.path):
            parent = by_rel[item.rel.rpartition("/")[0]]
            child_name = target_name(item.entry.name, dest)
            child_src = Location(src_loc.provider, functools.reduce(src.join, item.rel.split("/"), src_loc.path), src_loc.device)
            job.scanned += 1
            if item.entry.symlink:
                job.skipped += 1
                parent.keep = True
            elif item.entry.is_dir:
                folder = DirTask(child_src, Location(parent.dest.provider, dest.join(parent.dest.path, child_name), parent.dest.device), parent)
                by_rel[item.rel] = folder
                job.dirs.append(folder)
            else:
                job.files.append(FileTask(child_src, parent.dest, child_name, item.entry.size, item.entry.mtime, parent))
                job.total_files += 1
                job.total_bytes += item.entry.size
                if move:
                    node: DirTask | None = parent
                    while node is not None:
                        node.pending += 1
                        node = node.parent
            self._publish(job)
            await job.gate.wait()

    async def _preflight(self, job: TransferJob, dest: FsProvider) -> None:
        """Refuses a transfer that cannot fit BEFORE a byte is written. A move inside one place copies nothing."""
        spec = job.spec
        inside_one_place = all(s.provider == spec.dest.provider and s.device == spec.dest.device for s in spec.sources)
        if job.total_bytes == 0 or (spec.op == "move" and inside_one_place):
            return
        free = (await dest.free_space(spec.dest.path)).free
        if job.total_bytes > free:
            raise FsError(
                "no_space",
                f"Hedefte yeterli yer yok: {_human(job.total_bytes)} gerekli, {_human(free)} boş.",
                detail=f"need={job.total_bytes} free={free}",
            )

    # ------------------------------------------------------------------ 2. folders

    async def _create_dirs(self, job: TransferJob, dest: FsProvider) -> None:
        for folder in job.dirs:
            await job.gate.wait()
            if folder.parent is not None and folder.parent.broken:
                folder.broken = True
                continue
            try:
                try:
                    existing = await dest.stat(folder.dest.path)
                except FsError as exc:
                    if exc.code != "not_found":
                        raise
                    existing = None
                if existing is None:
                    await dest.mkdir(folder.dest.path)
                elif not existing.is_dir:
                    raise FsError("exists", "Hedefte aynı adlı bir dosya var.", path=folder.dest.path)
            except FsError as exc:
                folder.broken = True
                folder.keep = True
                job.failed += 1
                if len(job.errors) < MAX_RECORDED:
                    job.errors.append({"name": dest.basename(folder.dest.path), **exc.to_dict()})
        runnable = []
        for task in job.files:                                  # nothing is attempted under a folder that could not exist
            if task.owner is not None and task.owner.broken:
                job.give_up_on(task, None)
            else:
                runnable.append(task)
        job.files = runnable

    # ------------------------------------------------------------------ 3. files

    async def _transfer_files(self, job: TransferJob, dest: FsProvider, index: DirIndex) -> None:
        queue: asyncio.Queue[FileTask] = asyncio.Queue()
        for task in job.files:
            queue.put_nowait(task)

        async def worker() -> None:
            while not job.cancelled:
                try:
                    task = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                await job.gate.wait()
                await self._one_file(job, task, dest, index)

        runners = [asyncio.create_task(worker(), name=f"fs-worker-{job.id}-{i}")
                   for i in range(min(self._workers, max(1, len(job.files))))]
        try:
            await asyncio.gather(*runners)
        except BaseException:
            for runner in runners:
                runner.cancel()
            await asyncio.gather(*runners, return_exceptions=True)
            raise

    async def _one_file(self, job: TransferJob, task: FileTask, dest: FsProvider, index: DirIndex) -> None:
        src = self._provider_for(task.src)
        job.current = (job.current + [task.name])[-3:]
        try:
            while True:
                try:
                    if task.decided is None:
                        decision = await self._decide(job, task, dest, index)
                        if decision is None:
                            job.give_up_on(task, None)
                            return
                        task.decided = decision                  # a retry must not meet its own claimed name again
                    await self._copy(job, task, src, dest, *task.decided)
                    return
                except FsError as exc:
                    kept = task.resume.offset if task.resume is not None else 0     # bytes a retry will not have to send again
                    job.done_bytes -= task.counted - kept
                    task.counted = kept
                    if exc.code in TRANSIENT and task.attempts < RETRIES and not job.cancelled:
                        task.attempts += 1
                        if exc.code == "device_offline":
                            await self._wait_for_device(job, task)
                        else:
                            await self._sleep(RETRY_DELAY_S * task.attempts)
                        continue
                    job.done_bytes -= task.counted
                    task.counted = 0
                    job.give_up_on(task, exc)
                    return
        finally:
            if task.resume is not None:                           # leaving the file unfinished: its kept half goes
                with contextlib.suppress(Exception):
                    await asyncio.shield(self._drop_resume(task, dest))
            if task.name in job.current:
                job.current.remove(task.name)
            self._publish(job)

    async def _wait_for_device(self, job: TransferJob, task: FileTask) -> None:
        """Parks the whole job until the device that dropped is reachable again (the service calls `device_online`)."""
        events = [self._online.setdefault(d, asyncio.Event()) for d in {task.src.device, task.dest_dir.device} if d]
        for event in events:
            event.clear()
        job.pause_reason = "device_offline"
        job.gate.clear()
        self._publish(job, force=True)
        try:
            await asyncio.wait_for(asyncio.gather(*(e.wait() for e in events)), DEVICE_WAIT_S)
        except asyncio.TimeoutError as exc:
            raise FsError("device_offline", "Cihaz geri gelmedi; işlem durduruldu.") from exc
        finally:
            if job.pause_reason == "device_offline":
                job.pause_reason = None
                job.gate.set()
                self._publish(job, force=True)

    # --- conflicts

    async def _decide(self, job: TransferJob, task: FileTask, dest: FsProvider, index: DirIndex) -> tuple[str, bool] | None:
        """(final name, overwrite) for a file, or None to skip it. Holds the destination folder's lock: two files can
        never claim one name."""
        async with index.lock(task.dest_dir):
            entries, claimed = await index.load(task.dest_dir, dest)
            key = comparison_key(task.name, casefold=dest.casefold)
            if key not in entries and key not in claimed:
                claimed.add(key)
                return task.name, False
            existing = entries.get(key)
            if existing is None or existing.is_dir:
                # Another file of THIS job holds the name, or a folder does: replacing is never right — keep both.
                resolution = "skip" if job.policy == "skip" else "keep_both"
            else:
                resolution = await self._resolve(job, task, existing)
            if resolution == "skip":
                return None
            if resolution == "replace":
                return task.name, True
            fresh = unique_name(task.name, set(entries) | claimed, casefold=dest.casefold)
            claimed.add(comparison_key(fresh, casefold=dest.casefold))
            job.note_rename(task.name, fresh)
            return fresh, False

    @staticmethod
    def _by_policy(policy: str, task: FileTask, existing: Entry) -> str:
        if policy == "replace_if_newer":
            return "replace" if task.mtime > existing.mtime + 1 else "skip"
        return policy

    async def _resolve(self, job: TransferJob, task: FileTask, existing: Entry) -> str:
        if job.policy != "ask":
            return self._by_policy(job.policy, task, existing)
        async with job.ask_lock:                                   # one question at a time
            if job.policy != "ask":                                # "apply to all" was answered while this one waited
                return self._by_policy(job.policy, task, existing)
            job.conflict = Conflict(
                task.name,
                {"size": task.size, "mtime": task.mtime, "path": task.src.path, "provider": task.src.provider},
                {"size": existing.size, "mtime": existing.mtime, "kind": existing.kind},
            )
            job.answer = asyncio.get_running_loop().create_future()
            job.state = "waiting"
            self._publish(job, force=True)
            try:
                resolution, apply_all = await job.answer
            finally:
                job.conflict, job.answer = None, None
                if not job.cancelled:
                    job.state = "running"
                    self._publish(job, force=True)
            if apply_all:
                job.policy = resolution
            return resolution

    # --- one file, start to finish

    async def _copy(self, job: TransferJob, task: FileTask, src: FsProvider, dest: FsProvider, name: str, overwrite: bool) -> None:
        final = dest.join(task.dest_dir.path, name)
        move = job.spec.op == "move"
        here = task.src.provider == task.dest_dir.provider and task.src.device == task.dest_dir.device
        if move and here and not overwrite:
            try:
                await dest.rename(task.src.path, final, overwrite=False)            # one volume: no bytes travel at all
            except FsError as exc:
                if exc.code != "cross_device":
                    raise
            else:
                job.done_bytes += task.size
                self._file_done(job, task, final)
                self._source_moved(task)
                return
        offset = await self._continue_point(job, task, src, dest) if task.resume is not None else 0
        reader = await (src.open_reader(task.src.path, offset=offset) if offset else src.open_reader(task.src.path))
        writer = None
        temp = None
        digest = task.digest if offset and task.digest is not None else (hashlib.sha256() if job.spec.verify else None)
        task.digest = digest
        sent = offset                    # absolute: bytes of the file that are in the temporary file
        stage = "read"                   # where an error came from: only a failed READ (link, sleep) may be continued
        try:
            try:
                writer = await dest.open_writer(final, size=reader.size, tag=job.tag, overwrite=overwrite,
                                                **({"resume_at": offset} if offset else {}))
            except ResumeRejected as exc:                          # the kept half is not what we thought: start over
                await self._drop_resume(task, dest)
                raise FsError("io", "Yarım kalan dosya doğrulanamadı; dosya baştan başlıyor.", path=task.src.path) from exc
            task.resume = None                                     # the half now belongs to this attempt's writer
            temp = getattr(writer, "temp_path", None)
            if temp:
                await self._store.add_partial(task.dest_dir.provider, task.dest_dir.device, temp, job.id)
            async for chunk in reader.chunks():
                await job.gate.wait()
                if job.cancelled:
                    raise asyncio.CancelledError
                stage = "write"
                await writer.write(chunk)
                stage = "read"
                sent += len(chunk)
                task.counted += len(chunk)
                job.done_bytes += len(chunk)
                if digest is not None:
                    digest.update(chunk)
                job.sample()
                self._publish(job)
            if sent != reader.size:
                stage = "read" if sent < reader.size else "check"   # cut short = continue it; MORE than expected = a changed file
                raise FsError("io", "Kaynak dosya aktarım sırasında değişti.", path=task.src.path,
                              detail=f"expected {reader.size} bytes, received {sent}")
            await writer.commit(mtime=task.mtime)
            writer = None
        except BaseException as exc:
            if writer is not None:
                if (stage == "read" and temp and sent > 0 and isinstance(exc, FsError) and exc.code in TRANSIENT
                        and not job.cancelled and hasattr(writer, "suspend")):
                    # The link broke while READING (a pulled cable, Wi-Fi, a sleeping PC): keep the half file so the retry
                    # carries on from there instead of sending it all again.
                    length = None
                    with contextlib.suppress(Exception):
                        length = await asyncio.shield(writer.suspend())
                    if length == sent:
                        task.resume = ResumePoint(offset=sent, temp=temp, size=reader.size, mtime=task.mtime)
                        if sent > task.reached:
                            task.reached = sent
                            task.attempts = 0                      # it moved forward: a flaky link that keeps advancing is not a dead one
                        writer = None
                if writer is not None:
                    with contextlib.suppress(Exception):
                        await asyncio.shield(writer.abort())
            raise
        finally:
            with contextlib.suppress(Exception):
                await asyncio.shield(reader.aclose())
        task.digest = None
        if temp:
            await self._store.remove_partial(task.dest_dir.provider, task.dest_dir.device, temp)   # committed: nothing to sweep
        await self._verify(dest, final, reader.size, digest)
        self._file_done(job, task, final)
        if move:
            await src.delete(task.src.path)                       # only now — copied, size-checked, optionally hashed
            self._source_moved(task)

    async def _continue_point(self, job: TransferJob, task: FileTask, src: FsProvider, dest: FsProvider) -> int:
        """Where a cut copy of `task` can carry on, or 0 once its leftover is dropped. It needs a source that can start at a
        byte and a destination that kept the half file, and the half must still be a prefix of THIS file: same size and
        modification time at the source, exactly the recorded length on disk. A failure to even ask (the link is still
        down) is not an answer: it propagates, the resume point stays, and the next attempt asks again."""
        resume = task.resume
        assert resume is not None
        if (not getattr(src, "resumable_read", False) or not getattr(dest, "resumable_write", False)
                or (job.spec.verify and task.digest is None)):
            await self._drop_resume(task, dest)
            return 0
        source = await src.stat(task.src.path)
        partial: Entry | None
        try:
            partial = await dest.stat(resume.temp)
        except FsError as exc:
            if exc.code != "not_found":
                raise
            partial = None
        if (partial is None or partial.size != resume.offset or source.size != resume.size
                or abs(source.mtime - resume.mtime) > 1):
            await self._drop_resume(task, dest)
            return 0
        return resume.offset

    async def _drop_resume(self, task: FileTask, dest: FsProvider) -> None:
        """Forgets a kept half file and deletes it (and its ledger entry)."""
        resume, task.resume, task.digest = task.resume, None, None
        if resume is None:
            return
        with contextlib.suppress(Exception):
            await dest.delete(resume.temp)
        with contextlib.suppress(Exception):
            await self._store.remove_partial(task.dest_dir.provider, task.dest_dir.device, resume.temp)

    @staticmethod
    async def _verify(dest: FsProvider, final: str, size: int, digest) -> None:
        """The size always; the whole content when the job asked for it (hashed on the destination itself)."""
        entry = await dest.stat(final)
        if entry.size != size:
            raise FsError("io", "Hedef dosya boyutu kaynakla uyuşmuyor.", path=final, detail=f"{entry.size} != {size}")
        if digest is not None and await dest.checksum(final) != digest.hexdigest():
            raise FsError("io", "Hedef dosyanın içeriği kaynakla uyuşmuyor.", path=final)

    def _file_done(self, job: TransferJob, task: FileTask, final: str) -> None:
        job.done_files += 1
        job.touched[task.dest_dir.key()] = task.dest_dir
        if job.spec.op == "move":
            parent = Location(task.src.provider, _parent_of(task.src.path), task.src.device)
            job.touched[parent.key()] = parent
        if "." in final and final.rsplit(".", 1)[-1].lower() in MEDIA_EXTENSIONS:
            job.media.append(final)
        self._changed(task.dest_dir)
        job.sample()
        self._publish(job)

    @staticmethod
    def _source_moved(task: FileTask) -> None:
        node = task.owner
        while node is not None:
            node.pending = max(0, node.pending - 1)
            node = node.parent

    # ------------------------------------------------------------------ 4. a move leaves no empty folders behind

    async def _remove_moved_folders(self, job: TransferJob) -> None:
        """Source folders go bottom-up, and only when EVERYTHING under them moved — never one that kept a skipped or
        failed file, a link, or gained a file meanwhile (checked empty just before)."""
        for folder in sorted(job.dirs, key=lambda f: len(f.src.path), reverse=True):
            if folder.keep or folder.broken or folder.pending:
                continue
            src = self._provider_for(folder.src)
            try:
                if await src.names(folder.src.path):
                    continue
                await src.delete(folder.src.path)
                parent = Location(folder.src.provider, _parent_of(folder.src.path), folder.src.device)
                job.touched[parent.key()] = parent
            except FsError as exc:
                job.failed += 1
                if len(job.errors) < MAX_RECORDED:
                    job.errors.append({"name": src.basename(folder.src.path), **exc.to_dict()})


# ------------------------------------------------------------------------------------------------ helpers


def _parent_of(path: str) -> str:
    stripped = path.rstrip("/\\")
    cut = max(stripped.rfind("/"), stripped.rfind("\\"))
    return stripped[:cut] if cut > 0 else (stripped[: cut + 1] or "/")


def _same(a: str, b: str, provider: FsProvider) -> bool:
    fold = (lambda s: s.rstrip("/\\").casefold()) if provider.casefold else (lambda s: s.rstrip("/\\"))
    return fold(a) == fold(b)


def _inside(path: str, folder: str, provider: FsProvider) -> bool:
    """Is `path` the folder itself or somewhere under it? Compared the way the provider compares names."""
    fold = (lambda s: s.rstrip("/\\").casefold()) if provider.casefold else (lambda s: s.rstrip("/\\"))
    a, b = fold(path), fold(folder)
    return a == b or (a.startswith(b) and a[len(b):][:1] in ("/", "\\"))


def _human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"
