"""Finding adb — and, when the computer has none, installing Google's official platform-tools for OpenDeX alone.

Everything OpenDeX does with the phone goes through `adb`, and the app does not bundle it. Without it the boot screen used to
end on "no phone connected" and the pairing dialog (which needs adb too): a first-time user could not tell what was missing.
The backend now looks for adb at start (this module), tells the boot screen (`StartupSnapshot.adb`), and the boot screen
offers a short flow: install it (one click), pick an adb the user already has, or look again.

Where adb is looked for, in order — the first one that RUNS (`adb version`) wins:
  1. OPENDEX_ADB_PATH, when it names something other than the bare word "adb" (an explicit choice);
  2. the file the user picked in the boot screen (settings.ADB_CHOICE_FILE);
  3. `adb` on PATH (what OpenDeX always used);
  4. OpenDeX's own copy (settings.ADB_MANAGED_DIR), made by `install()`;
  5. the Android SDK's platform-tools (ANDROID_HOME / ANDROID_SDK_ROOT / the default SDK folders).

Install: Google's own SDK manifest (dl.google.com/android/repository/repository2-3.xml) names the newest STABLE platform-tools
for this OS with its size and SHA-1. The zip is downloaded over HTTPS from dl.google.com, checked against both, unpacked into a
staging folder next to the final one, started once (`adb version`) and only then swapped in. Nothing outside the OpenDeX
folder is touched: no PATH, no registry, no administrator rights. A failure at any step leaves what was there as it was.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal, Mapping
from urllib.parse import urljoin
from xml.etree import ElementTree

from ..config import Settings
from ..events import cancel_and_wait
from .adb import Adb

log = logging.getLogger(__name__)

REPOSITORY_BASE = "https://dl.google.com/android/repository/"
MANIFEST_URL = REPOSITORY_BASE + "repository2-3.xml"
DOWNLOAD_PAGE = "https://developer.android.com/tools/releases/platform-tools"
_TRUSTED_PREFIX = "https://dl.google.com/"
MANIFEST_MAX_BYTES = 4 * 1024 * 1024
UNPACKED_MAX_BYTES = 256 * 1024 * 1024        # platform-tools is ~30 MB unpacked: anything near this is not it
CHUNK = 64 * 1024
_NET_TIMEOUT_S = 20.0
STAGING_PREFIX = ".adb-install-"
APPROX_MB = {"windows": 8, "macosx": 16, "linux": 10}      # what the offer says before the manifest is read (the real size is)

AdbState = Literal["checking", "ok", "missing"]
InstallPhase = Literal["idle", "manifest", "download", "verify", "extract", "done", "error"]
Source = Literal["env", "chosen", "path", "managed", "sdk"]


class AdbSetupError(Exception):
    """`code` is what the UI words: network | manifest | unsupported_os | checksum | size | disk | bad_archive |
    verify_failed | not_found | not_adb | broken | failed."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


@dataclass
class InstallProgress:
    phase: InstallPhase = "idle"
    received: int = 0
    total: int = 0
    error: str | None = None
    version: str | None = None


@dataclass(frozen=True)
class PlatformTools:
    version: str
    url: str
    sha1: str
    size: int


# ------------------------------------------------------------------ pure helpers (unit-tested)

_VERSION_RE = re.compile(r"^Version\s+(\d+(?:\.\d+)*)", re.MULTILINE)


def parse_adb_version(text: str) -> str | None:
    """`adb version` prints "Android Debug Bridge version 1.0.41\\nVersion 37.0.1-14910828 …": the second number is the
    platform-tools release a person knows. None: that is not adb's answer."""
    match = _VERSION_RE.search(text or "")
    return match.group(1) if match else None


def host_key(platform: str | None = None) -> str | None:
    """The `host-os` name Google's manifest uses for this computer (None: no official platform-tools for it)."""
    platform = platform or sys.platform
    if platform.startswith("win"):
        return "windows"
    if platform == "darwin":
        return "macosx"
    if platform.startswith("linux"):
        return "linux"
    return None


def adb_filename(platform: str | None = None) -> str:
    return "adb.exe" if host_key(platform) == "windows" else "adb"


def pick_platform_tools(manifest_xml: str | bytes, host_os: str) -> PlatformTools | None:
    """The newest STABLE platform-tools for `host_os` in Google's SDK manifest (dev / beta / canary builds sit in the same
    file under other channels). None: the manifest has none for this OS. The download must live on dl.google.com."""
    try:
        root = ElementTree.fromstring(manifest_xml)
    except ElementTree.ParseError:
        return None
    stable = {c.get("id") for c in root.iter("channel") if (c.text or "").strip().lower() == "stable"} or {"channel-0"}
    best: tuple[tuple[int, int, int], PlatformTools] | None = None
    for package in root.iter("remotePackage"):
        if package.get("path") != "platform-tools":
            continue
        channel = package.find("channelRef")
        if channel is None or channel.get("ref") not in stable:
            continue
        revision = package.find("revision")
        try:
            numbers = tuple(int((revision.findtext(part) or "0").strip()) for part in ("major", "minor", "micro"))
        except (AttributeError, ValueError):
            continue
        for archive in package.iterfind("./archives/archive"):
            if (archive.findtext("host-os") or "").strip() != host_os:
                continue
            complete = archive.find("complete")
            if complete is None:
                continue
            checksum = complete.find("checksum")
            url = urljoin(REPOSITORY_BASE, (complete.findtext("url") or "").strip())
            try:
                size = int((complete.findtext("size") or "0").strip())
            except ValueError:
                continue
            sha1 = (checksum.text or "").strip().lower() if checksum is not None and checksum.get("type") == "sha1" else ""
            if not (url.startswith(_TRUSTED_PREFIX) and url.endswith(".zip") and len(sha1) == 40 and size > 0):
                continue
            release = PlatformTools(".".join(map(str, numbers)), url, sha1, size)
            if best is None or numbers > best[0]:
                best = (numbers, release)
    return best[1] if best else None


def candidate_paths(
    *,
    configured: str,
    chosen: str | None,
    on_path: str | None,
    managed: Path,
    env: Mapping[str, str],
    home: Path,
    platform: str | None = None,
    managed_only: bool = False,
) -> list[tuple[Source, str]]:
    """Where to try adb, most deliberate choice first, without repeats (see the module docstring for the order).
    `managed_only` (OPENDEX_ADB_MANAGED_ONLY): just the picked file and OpenDeX's own copy."""
    name = adb_filename(platform)
    found: list[tuple[Source, str]] = []
    if configured and configured != "adb" and not managed_only:
        found.append(("env", configured))
    if chosen:
        found.append(("chosen", chosen))
    if on_path and not managed_only:
        found.append(("path", on_path))
    found.append(("managed", str(managed / name)))
    if managed_only:
        return found
    sdk_roots = [env.get("ANDROID_HOME"), env.get("ANDROID_SDK_ROOT")]
    key = host_key(platform)
    if key == "windows":
        sdk_roots.append(os.path.join(env["LOCALAPPDATA"], "Android", "Sdk") if env.get("LOCALAPPDATA") else None)
    elif key == "macosx":
        sdk_roots.append(str(home / "Library" / "Android" / "sdk"))
    else:
        sdk_roots.append(str(home / "Android" / "Sdk"))
    for root in sdk_roots:
        if root:
            found.append(("sdk", str(Path(root) / "platform-tools" / name)))
    seen: set[str] = set()
    unique: list[tuple[Source, str]] = []
    for source, path in found:
        marker = os.path.normcase(os.path.normpath(path))
        if marker not in seen:
            seen.add(marker)
            unique.append((source, path))
    return unique


async def run_adb_version(path: str) -> str | None:
    """The platform-tools version if `path` is a working adb, else None (the process itself belongs to Adb)."""
    text = await Adb.version_text(path)
    return parse_adb_version(text) if text is not None else None


def _extract(zip_path: Path, dest: Path, platform: str | None = None) -> Path:
    """Unpacks Google's zip into `dest` and returns the adb inside. Refuses anything that is not a plain platform-tools
    archive: a corrupt zip, entries that would land outside `dest` ("zip slip"), an absurd unpacked size, no adb in it."""
    try:
        archive = zipfile.ZipFile(zip_path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise AdbSetupError("bad_archive", str(exc)) from exc
    with archive:
        if archive.testzip() is not None:
            raise AdbSetupError("bad_archive", "corrupt entry")
        root = dest.resolve()
        total = 0
        for info in archive.infolist():
            total += info.file_size
            if not (root / info.filename).resolve().is_relative_to(root):
                raise AdbSetupError("bad_archive", f"entry outside the folder: {info.filename}")
        if total > UNPACKED_MAX_BYTES:
            raise AdbSetupError("bad_archive", "unpacked size")
        try:
            archive.extractall(dest)
        except OSError as exc:
            raise AdbSetupError("disk", str(exc)) from exc
    adb = dest / "platform-tools" / adb_filename(platform)
    if not adb.is_file():
        raise AdbSetupError("bad_archive", "no adb in the archive")
    if os.name != "nt":
        for tool in (dest / "platform-tools").iterdir():
            if tool.is_file() and tool.suffix == "":
                tool.chmod(tool.stat().st_mode | 0o755)
    return adb


def _sha1_of(path: Path) -> str:
    digest = hashlib.sha1()  # noqa: S324 — the checksum Google publishes for the archive, not a security primitive here
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


# ------------------------------------------------------------------ the service


class AdbSetup:
    """Knows which adb OpenDeX runs, and can install or pick one. One per backend (AppContext.adb_setup)."""

    def __init__(
        self,
        adb: Adb,
        settings: Settings,
        *,
        configured: str = "adb",
        on_change: Callable[[], Awaitable[None]] | None = None,
        version_runner: Callable[[str], Awaitable[str | None]] = run_adb_version,
        opener: Callable[..., Any] | None = None,
        which: Callable[[str], str | None] = shutil.which,
        environ: Mapping[str, str] | None = None,
        home: Path | None = None,
        platform: str | None = None,
        install_root: Path | None = None,
    ) -> None:
        self._adb = adb
        self._settings = settings
        self._configured = configured          # OPENDEX_ADB_PATH as the app was started with (main.py passes it)
        self._on_change = on_change
        self._run_version = version_runner
        self._open = opener or urllib.request.urlopen
        self._which = which
        self._environ = os.environ if environ is None else environ
        self._home = home or Path.home()
        self._platform = platform
        self._install_root = install_root or settings.ADB_MANAGED_DIR.parent
        self.state: AdbState = "checking"
        self.path: str | None = None
        self.version: str | None = None
        self.source: Source | None = None
        self.progress = InstallProgress()
        self._found = asyncio.Event()
        self._inspect_lock = asyncio.Lock()
        self._install_task: asyncio.Task | None = None
        self._cancel = threading.Event()

    # ------------------------------------------------------------------ what is known

    def snapshot(self) -> dict[str, Any]:
        """The boot screen's read model (GET /api/adb). In memory: it runs nothing."""
        managed = self._settings.ADB_MANAGED_DIR
        try:
            shown = "~/" + managed.relative_to(self._home).as_posix()
        except ValueError:
            shown = str(managed)
        return {
            "state": self.state,
            "path": self.path,
            "version": self.version,
            "source": self.source,
            "install": asdict(self.progress),
            "can_install": host_key(self._platform) is not None,
            "approx_mb": APPROX_MB.get(host_key(self._platform) or ""),
            "install_dir": shown,
            "download_page": DOWNLOAD_PAGE,
        }

    def assume_working(self) -> None:
        """Records that adb works without running anything — for a caller that already knows (the test suites that replace
        `Adb` with a recording fake and exercise what comes after finding it)."""
        self.state = "ok"
        self.version = self.version or "0"
        self._found.set()

    async def wait_until_found(self) -> None:
        """Returns once a working adb is known (immediately when one is)."""
        await self._found.wait()

    # ------------------------------------------------------------------ finding

    def _read_choice(self) -> str | None:
        try:
            text = self._settings.ADB_CHOICE_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return text or None

    async def inspect(self) -> dict[str, Any]:
        """Looks for a working adb (the order in the module docstring) and uses the first one. Safe to call again: the
        boot screen's "Tekrar ara" and the end of an install both do."""
        async with self._inspect_lock:
            candidates = candidate_paths(
                configured=self._configured,
                chosen=self._read_choice(),
                on_path=self._which("adb"),
                managed=self._settings.ADB_MANAGED_DIR,
                env=self._environ,
                home=self._home,
                platform=self._platform,
                managed_only=self._settings.ADB_MANAGED_ONLY,
            )
            for source, path in candidates:
                version = await self._run_version(path)
                if version:
                    await self._accept(path, version, source)
                    return self.snapshot()
                log.debug("[AdbSetup] %s (%s) çalışmıyor", path, source)
            if self.state != "missing":
                log.warning("[AdbSetup] bilgisayarda çalışan bir adb bulunamadı — açılış ekranı kurulumu sunacak")
            self.path = self.version = self.source = None
            self.state = "missing"
            self._found.clear()
            await self._changed()
            return self.snapshot()

    async def _accept(self, path: str, version: str, source: Source) -> None:
        changed = (self.state, self.path, self.version) != ("ok", path, version)
        self._adb.set_path(path)
        self.state, self.path, self.version, self.source = "ok", path, version, source
        self._found.set()
        if changed:
            log.info("[AdbSetup] adb: %s (sürüm %s, kaynak: %s)", path, version, source)
            await self._changed()

    async def _changed(self) -> None:
        if self._on_change is not None:
            try:
                await self._on_change()
            except Exception:  # noqa: BLE001 — telling the boot screen must never break finding adb
                log.exception("[AdbSetup] değişiklik bildirimi başarısız")

    async def locate(self, raw_path: str) -> dict[str, Any]:
        """Uses the adb the user picked (the boot screen's file picker). The file must exist, be called adb[.exe] and run."""
        path = Path(os.path.expandvars(raw_path.strip().strip('"')))
        if not path.is_file():
            raise AdbSetupError("not_found", str(path))
        if path.stem.lower() != "adb":
            raise AdbSetupError("not_adb", path.name)
        version = await self._run_version(str(path))
        if not version:
            raise AdbSetupError("broken", str(path))
        with contextlib.suppress(OSError):
            self._settings.ADB_CHOICE_FILE.parent.mkdir(parents=True, exist_ok=True)
            self._settings.ADB_CHOICE_FILE.write_text(str(path), encoding="utf-8")
        await self._accept(str(path), version, "chosen")
        return self.snapshot()

    # ------------------------------------------------------------------ installing

    async def install(self) -> dict[str, Any]:
        """Starts the install and returns at once (the boot screen polls `snapshot()["install"]`). A second call while one
        runs changes nothing."""
        if self.state == "ok":
            return self.snapshot()
        if self._install_task is None or self._install_task.done():
            self._cancel = threading.Event()
            self.progress = InstallProgress(phase="manifest")
            self._install_task = asyncio.create_task(self._install(), name="adb-install")
        return self.snapshot()

    async def cancel_install(self) -> dict[str, Any]:
        """"Vazgeç": stops the download, removes what was started, back to the offer (no error shown)."""
        task = self._install_task
        if task is not None and not task.done():
            # The download runs in a thread that looks at this flag between blocks: letting it end by itself (a few ms)
            # means its staging folder is closed before it is removed. Cancelling the task is only the fallback for a phase
            # that cannot look (the manifest read).
            self._cancel.set()
            done, _ = await asyncio.wait({task}, timeout=3.0)
            if not done:
                await cancel_and_wait(task)
        self.progress = InstallProgress()
        return self.snapshot()

    async def shutdown(self) -> None:
        task, self._install_task = self._install_task, None
        if task is not None and not task.done():
            self._cancel.set()
            await cancel_and_wait(task)

    async def _install(self) -> None:
        staging: Path | None = None
        try:
            host = host_key(self._platform)
            if host is None:
                raise AdbSetupError("unsupported_os", sys.platform)
            release = await self._release(host)
            self.progress.version, self.progress.total, self.progress.phase = release.version, release.size, "download"
            self._install_root.mkdir(parents=True, exist_ok=True)
            self._sweep_stale_staging()
            staging = self._install_root / f"{STAGING_PREFIX}{os.getpid()}-{int(time.time() * 1000)}"
            staging.mkdir()
            archive = staging / "platform-tools.zip"
            await asyncio.to_thread(self._download, release.url, archive, release.size, self._cancel)
            self.progress.phase = "verify"
            if archive.stat().st_size != release.size:
                raise AdbSetupError("size", f"{archive.stat().st_size} != {release.size}")
            if await asyncio.to_thread(_sha1_of, archive) != release.sha1:
                raise AdbSetupError("checksum", release.url)
            self.progress.phase = "extract"
            staged_adb = await asyncio.to_thread(_extract, archive, staging, self._platform)
            if not await self._run_version(str(staged_adb)):
                raise AdbSetupError("verify_failed", str(staged_adb))
            self._swap_in(staging / "platform-tools")
            await self.inspect()
            if self.state != "ok":
                raise AdbSetupError("verify_failed", "installed adb not found after the swap")
            self.progress = InstallProgress(phase="done", version=release.version, received=release.size, total=release.size)
            log.info("[AdbSetup] platform-tools %s kuruldu: %s", release.version, self.path)
        except asyncio.CancelledError:
            log.info("[AdbSetup] kurulum iptal edildi")
            self.progress = InstallProgress()
            raise
        except AdbSetupError as exc:
            if exc.code == "cancelled":
                self.progress = InstallProgress()
            else:
                log.warning("[AdbSetup] kurulum başarısız: %s", exc)
                self.progress = InstallProgress(phase="error", error=exc.code, version=self.progress.version)
        except Exception:  # noqa: BLE001 — whatever it was, the boot screen must get an answer, not a hang
            log.exception("[AdbSetup] kurulum beklenmedik şekilde başarısız")
            self.progress = InstallProgress(phase="error", error="failed", version=self.progress.version)
        finally:
            if staging is not None:
                shutil.rmtree(staging, ignore_errors=True)

    def _sweep_stale_staging(self) -> None:
        """An install that was killed midway (the backend ended, the PC lost power) leaves its staging folder behind."""
        with contextlib.suppress(OSError):
            for leftover in self._install_root.glob(f"{STAGING_PREFIX}*"):
                if leftover.is_dir():
                    shutil.rmtree(leftover, ignore_errors=True)

    async def _release(self, host: str) -> PlatformTools:
        manifest = await asyncio.to_thread(self._read_manifest)
        release = pick_platform_tools(manifest, host)
        if release is None:
            raise AdbSetupError("manifest", f"no stable platform-tools for {host}")
        return release

    def _read_manifest(self) -> bytes:
        try:
            with self._open(urllib.request.Request(MANIFEST_URL, headers={"User-Agent": "OpenDeX"}), timeout=_NET_TIMEOUT_S) as resp:
                data = resp.read(MANIFEST_MAX_BYTES + 1)
        except (urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
            raise AdbSetupError("network", str(exc)) from exc
        if len(data) > MANIFEST_MAX_BYTES:
            raise AdbSetupError("manifest", "manifest too large")
        return data

    def _download(self, url: str, dest: Path, expected: int, cancel: threading.Event) -> None:
        """Blocking (runs in a thread): the zip to `dest`, counting bytes into `self.progress` as they arrive."""
        try:
            out = dest.open("wb")
        except OSError as exc:
            raise AdbSetupError("disk", str(exc)) from exc
        with out:
            try:
                with self._open(urllib.request.Request(url, headers={"User-Agent": "OpenDeX"}), timeout=_NET_TIMEOUT_S) as resp:
                    length = int(resp.headers.get("Content-Length") or 0) if getattr(resp, "headers", None) else 0
                    if length:
                        self.progress.total = length
                    while True:
                        if cancel.is_set():
                            raise AdbSetupError("cancelled")
                        block = resp.read(CHUNK)
                        if not block:
                            return
                        try:
                            out.write(block)
                        except OSError as exc:
                            raise AdbSetupError("disk", str(exc)) from exc
                        self.progress.received += len(block)
                        if self.progress.received > max(expected, length) + CHUNK:
                            raise AdbSetupError("size", "more data than announced")
            except (urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
                raise AdbSetupError("network", str(exc)) from exc

    def _swap_in(self, unpacked: Path) -> None:
        """Puts the verified, unpacked folder in place of the managed one; an earlier copy is kept until the swap worked."""
        final = self._settings.ADB_MANAGED_DIR
        old: Path | None = None
        try:
            final.parent.mkdir(parents=True, exist_ok=True)
            if final.exists():
                old = final.with_name(f"{final.name}.old-{int(time.time() * 1000)}")
                os.replace(final, old)
            os.replace(unpacked, final)
        except OSError as exc:
            if old is not None and old.exists() and not final.exists():
                with contextlib.suppress(OSError):
                    os.replace(old, final)
            raise AdbSetupError("disk", str(exc)) from exc
        if old is not None:
            shutil.rmtree(old, ignore_errors=True)
