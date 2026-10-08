"""resolve_backend_root: which `vendor/` a compiled sidecar binary finds, depending on which compiler produced it
(app/config.py). A wrong answer here doesn't just weaken obfuscation — it means the shipped exe can't find adb /
scrcpy / opendex-tools.jar at all and the daemon never starts, so this is tested as plain correctness, not security."""
from pathlib import Path

from app.config import resolve_backend_root


def test_dev_interpreter_uses_source_tree():
    """Plain `python -m app.main`: neither marker set — backend/ is two parents up from this file."""
    got = resolve_backend_root(compiled=False, frozen=False, executable="/usr/bin/python3", meipass=None, file="/src/backend/app/config.py")
    assert got == Path("/src/backend")


def test_nuitka_onefile_uses_the_exes_own_directory():
    """Release build: vendor/ ships as a Tauri resource next to the installed exe, not inside the onefile payload —
    sys.executable (Nuitka's documented stand-in for the compiled binary's own path) must be trusted over __file__,
    which would otherwise point into Nuitka's internal module layout. (A POSIX absolute path, not a Windows
    drive-letter one: the function calls `.resolve()` on it, which `pathlib` only recognizes as already-absolute in
    a way this suite can assert on portably when run on Linux CI — the branch logic under test is OS-independent.)"""
    got = resolve_backend_root(
        compiled=True,
        frozen=False,
        executable="/opt/OpenDeX/opendex-backend",
        meipass=None,
        file="/nuitka-internal/app/config.py",  # must be ignored when compiled=True
    )
    assert got == Path("/opt/OpenDeX")


def test_pyinstaller_onefile_uses_meipass_not_the_exe_directory():
    """Dev/legacy path: --add-data unpacks into a fresh temp dir every run — the DATA lives there, not next to the
    exe (the opposite of the Nuitka case)."""
    got = resolve_backend_root(
        compiled=False,
        frozen=True,
        executable="C:/Program Files/OpenDeX/opendex-backend.exe",
        meipass="C:/Users/x/AppData/Local/Temp/_MEI123456",
        file="C:/Users/x/AppData/Local/Temp/_MEI123456/app/config.py",
    )
    assert got == Path("C:/Users/x/AppData/Local/Temp/_MEI123456")


def test_compiled_takes_priority_over_frozen():
    """A future compiler could plausibly set both markers; Nuitka's own-exe-directory rule must win (it's the one
    actually wired into the shipping pipeline) rather than silently falling through to a PyInstaller-shaped path."""
    got = resolve_backend_root(
        compiled=True,
        frozen=True,
        executable="/opt/OpenDeX/opendex-backend",
        meipass="/tmp/_MEI999",
        file="/tmp/_MEI999/app/config.py",
    )
    assert got == Path("/opt/OpenDeX")


def test_frozen_without_meipass_fails_loudly_instead_of_guessing():
    """sys.frozen=True with no sys._MEIPASS would be a genuinely unknown runtime shape — better to crash at startup
    (a visible, debuggable failure) than to silently resolve vendor/ to the wrong directory."""
    import pytest

    with pytest.raises(RuntimeError):
        resolve_backend_root(compiled=False, frozen=True, executable="/x/exe", meipass=None, file="/x/app/config.py")
