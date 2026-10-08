"""build_nuitka.py: the script that produces the ONE backend binary scripts/build-backend-sidecar.ps1 and
scripts/build_release.py copy into frontend/src-tauri/binaries/ for `tauri build` to bundle (see app/config.py's
resolve_backend_root for the matching runtime half of this). Real compilation needs Nuitka + a C toolchain, neither
of which this environment has — these tests exercise the parts that don't: flag composition, and the self-check
that is meant to catch a regression in those flags automatically on every real build."""
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ itself: build_nuitka.py is not in app/
import build_nuitka as bn  # noqa: E402


def test_nuitka_args_strip_docstrings_and_asserts_and_never_embed_vendor():
    args = bn.nuitka_args(onefile=True)
    assert "--onefile" in args
    assert "--standalone" not in args
    assert any(a.startswith("--python-flag=") and "no_docstrings" in a and "-O" in a for a in args)
    assert "--lto=yes" in args
    # vendor/ ships as a Tauri resource now (tauri.conf.json), not embedded — see the module docstring and
    # app/config.py's resolve_backend_root(). A stray --include-data-dir here would silently resurrect the old
    # (unused, onefile-extraction-dependent) path.
    assert not any("include-data-dir" in a for a in args)
    assert str(bn.ENTRY_POINT) in args


def test_standalone_mode_omits_onefile_flag():
    args = bn.nuitka_args(onefile=False)
    assert "--standalone" in args
    assert "--onefile" not in args


class _FakeCompleted:
    def __init__(self, stdout):
        self.stdout = stdout


def test_host_triple_parses_rustc_vV(monkeypatch):
    sample = "rustc 1.80.0\nhost: x86_64-pc-windows-msvc\nrelease: 1.80.0\n"
    monkeypatch.setattr(bn.subprocess, "run", lambda *a, **k: _FakeCompleted(sample))
    assert bn.host_triple() == "x86_64-pc-windows-msvc"


def test_host_triple_raises_build_error_on_unparseable_output(monkeypatch):
    monkeypatch.setattr(bn.subprocess, "run", lambda *a, **k: _FakeCompleted("not rustc output"))
    with pytest.raises(bn.BuildError):
        bn.host_triple()


def test_verify_no_source_leak_passes_on_a_clean_binary(tmp_path):
    exe = tmp_path / "opendex-backend.exe"
    exe.write_bytes(b"\x00compiled machine code, no python text here\x00" * 10)
    bn.verify_no_source_leak(exe)  # must not raise


def test_verify_no_source_leak_catches_a_stray_pdb(tmp_path):
    exe = tmp_path / "opendex-backend.exe"
    exe.write_bytes(b"binary")
    (tmp_path / "opendex-backend.pdb").write_bytes(b"debug symbols")
    with pytest.raises(bn.BuildError, match="Debug symbol"):
        bn.verify_no_source_leak(exe)


def test_verify_no_source_leak_catches_an_unstripped_docstring(tmp_path):
    """Regression guard for the guard itself: if --python-flag=no_docstrings is ever dropped from nuitka_args,
    this is exactly what would show up in the real compiled binary."""
    exe = tmp_path / "opendex-backend.exe"
    exe.write_bytes(b"...junk..." + bn._SOURCE_MARKERS[0] + b"...more junk...")
    with pytest.raises(bn.BuildError, match="Readable source text"):
        bn.verify_no_source_leak(exe)


def test_package_sidecar_copies_to_the_triple_suffixed_path_tauri_expects(tmp_path, monkeypatch):
    src = tmp_path / "src" / "opendex-backend.exe"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"clean compiled binary with no markers")

    dest_dir = tmp_path / "sidecar-binaries"
    monkeypatch.setattr(bn, "SIDECAR_BINARIES_DIR", dest_dir)
    monkeypatch.setattr(bn, "host_triple", lambda: "x86_64-pc-windows-msvc")

    dest = bn.package_sidecar(src)

    assert dest == dest_dir / "opendex-backend-x86_64-pc-windows-msvc.exe"
    assert dest.read_bytes() == src.read_bytes()


def test_package_sidecar_refuses_a_binary_that_fails_the_source_leak_check(tmp_path, monkeypatch):
    src = tmp_path / "opendex-backend.exe"
    src.write_bytes(bn._SOURCE_MARKERS[0])
    monkeypatch.setattr(bn, "SIDECAR_BINARIES_DIR", tmp_path / "out")
    monkeypatch.setattr(bn, "host_triple", lambda: "x86_64-pc-windows-msvc")

    with pytest.raises(bn.BuildError):
        bn.package_sidecar(src)
    assert not (tmp_path / "out").exists()  # nothing copied — a rejected build leaves no half-shipped artifact


def test_cli_is_not_invoked_as_a_subprocess(tmp_path):
    """Sanity: the module imports cleanly standalone (as the other tests above rely on) without Nuitka installed —
    `ensure_nuitka()`/`ensure_vendor_jar()`/the real compile only run from main(), never at import time."""
    res = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0, {str(bn.BACKEND_DIR)!r}); import build_nuitka"], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
