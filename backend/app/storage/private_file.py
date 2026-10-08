"""Writing a secret to disk so that no other user of the machine can ever read it."""
from __future__ import annotations

import os
from pathlib import Path


def write_private(path: Path, text: str) -> None:
    """`text` + newline into `path`, mode 0600 from the first byte (no window in which the file is world-readable), parent
    directories created. A pre-existing file is narrowed to 0600 too. (POSIX modes mean little on Windows, where the
    per-user profile directory is the protection — the same trade the API token file makes.)"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, (text + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
