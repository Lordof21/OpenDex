"""How the backend process ends: on request (the desktop shell's "quit") or when the shell that started it is gone.

The desktop build runs the backend as a Tauri sidecar. A hard kill (TerminateProcess / SIGKILL) skips the lifespan's
`finally` — the phone keeps its scrcpy servers and virtual displays until the next start reaps them. So the shell asks
first (`request_exit`, through POST /api/system/shutdown) and kills only if the backend does not end in time; and when
the shell itself dies without asking (crash, Task Manager), `watch_parent` notices its PID is gone and ends the backend
the same graceful way instead of leaving it orphaned on port 8710.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys

log = logging.getLogger(__name__)

PARENT_PID_ENV = "OPENDEX_PARENT_PID"
_PARENT_POLL_S = 2.0

_server = None  # the uvicorn.Server run() started; None under a test client or another runner


def register_server(server) -> None:
    global _server
    _server = server


def request_exit(reason: str) -> bool:
    """Asks the running server to stop: it stops accepting, then the lifespan cleanup runs. False: no server to ask."""
    if _server is None:
        return False
    log.info("🛑 [Lifecycle] kapanış istendi (%s)", reason)
    _server.should_exit = True
    return True


def _parent_probe(pid: int):
    """A callable answering "is the parent still alive?" — or None when that cannot be asked.

    Windows: a SYNCHRONIZE handle opened now stays bound to THAT process, so a reused PID can never pass for it (and
    `os.kill(pid, 0)` would terminate the process there). POSIX: signal 0 checks existence without touching it."""
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return None
        return lambda: kernel32.WaitForSingleObject(handle, 0) != 0  # WAIT_OBJECT_0 (0) = the process has ended

    def alive() -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True  # exists, owned by someone else
        return True

    return alive


async def watch_parent() -> None:
    """Ends the backend gracefully once the process named in OPENDEX_PARENT_PID is gone. No-op without it (a backend
    started by hand, tests)."""
    raw = os.environ.get(PARENT_PID_ENV, "")
    if not raw.isdigit():
        return
    alive = _parent_probe(int(raw))
    if alive is None:
        log.warning("[Lifecycle] üst süreç %s izlenemiyor — izleme kapalı", raw)
        return
    while alive():
        await asyncio.sleep(_PARENT_POLL_S)
    log.warning("[Lifecycle] üst süreç %s kapandı — backend kendini kapatıyor", raw)
    request_exit("parent_gone")
