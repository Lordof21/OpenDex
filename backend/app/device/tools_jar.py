"""opendex-tools.jar — the ONE on-device Java artifact (OpenDexDaemon, MediaBridge, NotificationInvoker, IconExtractor).

Single owner of the jar's paths and of getting it onto the phone. Before, icon_service pushed a byte-identical copy
under a second name (`opendex-icon-extractor.jar`) with force=True on every batch — up to four parallel prefetch
fetchers could push at once — while main.py pushed `opendex-tools.jar` separately.

Now: one file; it is pushed only when the device copy is missing or differs (md5), and pushes are serialized per
device. A device verified once in this backend process is trusted until `forget()` (device unbound) or `force=True`.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
from typing import Any

from ..config import BACKEND_ROOT

log = logging.getLogger(__name__)

# BACKEND_ROOT, not a __file__-relative path: in the Nuitka onefile sidecar __file__ points into the temp extraction
# dir, where vendor/ does not exist ("opendex-tools.jar bulunamadı" in the packaged app); vendor/ ships beside the exe.
LOCAL_TOOLS_JAR = BACKEND_ROOT / "vendor" / "opendex-tools.jar"
DEVICE_TOOLS_JAR = "/data/local/tmp/opendex-tools.jar"

# Copies left on devices by older builds; removed once per device and process after verification.
_LEGACY_DEVICE_JARS = ("/data/local/tmp/opendex-icon-extractor.jar",)

_verified: set[str] = set()
_locks: dict[str, asyncio.Lock] = {}


def _local_md5() -> str:
    return hashlib.md5(LOCAL_TOOLS_JAR.read_bytes()).hexdigest()


def local_md5() -> str | None:
    """md5 of the backend's jar = the build id a daemon started from it reports; None when the jar is missing."""
    try:
        return _local_md5()
    except OSError:
        return None


async def _device_md5(adb: Any, serial: str) -> str | None:
    """md5 of the device copy; None when missing or unreadable (then we push)."""
    try:
        out = await adb.shell(f"md5sum {DEVICE_TOOLS_JAR} 2>/dev/null", serial=serial, timeout_s=3.0)
    except Exception:  # noqa: BLE001 — unreadable means "push to be sure"
        return None
    first = out.strip().split()[0] if isinstance(out, str) and out.strip() else ""
    return first.lower() if len(first) == 32 else None


async def ensure_tools_jar(adb: Any, serial: str, *, force: bool = False) -> bool:
    """True when the device holds the current jar. `force=True` re-checks even a device verified in this process."""
    if not force and serial in _verified:
        return True
    lock = _locks.setdefault(serial, asyncio.Lock())
    async with lock:
        if not force and serial in _verified:
            return True
        if not LOCAL_TOOLS_JAR.is_file():
            log.error("[ToolsJar] %s bulunamadı — `py backend/java/build.py` ile derleyin", LOCAL_TOOLS_JAR)
            return False
        local = _local_md5()
        if await _device_md5(adb, serial) != local:
            try:
                await adb.push(str(LOCAL_TOOLS_JAR), DEVICE_TOOLS_JAR, serial=serial)
            except Exception as exc:  # noqa: BLE001
                log.error("[ToolsJar] cihaza aktarılamadı (%s): %s", serial, exc)
                return False
            log.info("[ToolsJar] opendex-tools.jar cihaza yüklendi (%s, md5=%s)", serial, local[:8])
        if serial not in _verified:
            with contextlib.suppress(Exception):
                await adb.shell("rm -f " + " ".join(_LEGACY_DEVICE_JARS), serial=serial, timeout_s=2.0)
        _verified.add(serial)
        return True


def forget(serial: str | None = None) -> None:
    """Drops the "verified" mark (one device, or all) so the next call checks the device again."""
    if serial is None:
        _verified.clear()
    else:
        _verified.discard(serial)
