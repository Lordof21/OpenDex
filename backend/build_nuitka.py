"""OpenDeX Backend — native-code build for the shipped Tauri sidecar.

Compiles the FastAPI backend with Nuitka: the whole app, interpreter included, becomes a single compiled native
binary — there is no .py/.pyc payload left to extract (contrast scripts/build-backend-sidecar.ps1's OLD PyInstaller
path, which just zips the original .pyc bytecode: trivially reversed with pyinstxtractor + decompyle3/uncompyle6,
near-perfect source back). That PyInstaller path still exists for quick local iteration (opendex-backend.spec), but
it must never be the one that ships — this script is the only one `--package-sidecar` writes into
frontend/src-tauri/binaries/, which is what `tauri build` actually bundles.

Usage:
  python build_nuitka.py [--onefile] [--package-sidecar]
    --onefile          single .exe (the shape Tauri's sidecar mechanism needs — implied by --package-sidecar)
    --package-sidecar   after compiling, verify the output and copy it into
                        frontend/src-tauri/binaries/opendex-backend-<rustc-host-triple>.exe
"""
from __future__ import annotations

import pathlib
import re
import subprocess
import sys

BACKEND_DIR = pathlib.Path(__file__).parent.resolve()
PROJECT_ROOT = BACKEND_DIR.parent
DIST_DIR = BACKEND_DIR / "dist"
ENTRY_POINT = BACKEND_DIR / "opendex_backend.py"  # NOT app/main.py: its relative imports need the package context
VENDOR_DIR = BACKEND_DIR / "vendor"
SIDECAR_BINARIES_DIR = PROJECT_ROOT / "frontend" / "src-tauri" / "binaries"
SIDECAR_NAME = "opendex-backend"

# A handful of distinctive, multi-word phrases lifted verbatim from docstrings/comments in the real source. None of
# these are meant to survive compilation — `--python-flag=no_docstrings` strips module/function/class docstrings,
# and ordinary `#` comments were never bytecode to begin with. Finding any of them in the shipped binary means the
# protection regressed (flag dropped, wrong entry point, a stray debug build copied over the release one).
_SOURCE_MARKERS = (
    b"Application settings",  # app/config.py module docstring (first words)
    b"Android multi-window mirroring session",  # backend/pyproject.toml description, echoed in app/main.py's own docstring intro
)


class BuildError(RuntimeError):
    """Raised for anything that must stop a release build cold rather than ship a weaker artifact."""


def ensure_nuitka() -> None:
    try:
        import nuitka  # noqa: F401
    except ImportError:
        print("[Nuitka] Nuitka not found. Installing nuitka and zstandard...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "nuitka", "zstandard"])


def ensure_vendor_jar() -> None:
    jar_path = VENDOR_DIR / "opendex-tools.jar"
    if not jar_path.exists():
        print("[Nuitka] opendex-tools.jar missing. Compiling Java daemon...")
        build_java = BACKEND_DIR / "java" / "build.py"
        subprocess.check_call([sys.executable, str(build_java)])


def nuitka_args(*, onefile: bool) -> list[str]:
    return [
        sys.executable,
        "-m", "nuitka",
        "--onefile" if onefile else "--standalone",
        "--follow-imports",
        "--include-package=app",
        "--enable-plugin=anti-bloat",
        "--assume-yes-for-downloads",
        f"--output-dir={DIST_DIR}",
        "--output-filename=opendex-backend.exe",
        "--remove-output",
        "--lto=yes",  # whole-program link-time optimization: also inlines/erases more of the original function shape
        # Strips docstrings AND `assert` statements from the compiled output (-O); together with --lto this is the
        # practical ceiling for "no leftover Python-shaped text" in a Nuitka build — Nuitka compiles to C regardless
        # of identifier names, so (unlike the Java/JS layers) there is no separate renaming pass to add on top.
        "--python-flag=no_docstrings,-O",
        # `vendor/` (adb, scrcpy servers, opendex-tools.jar) is deliberately NOT embedded here — see the long
        # comment in app/config.py. It ships as a Tauri bundle resource and is resolved at runtime relative to
        # sys.executable, sidestepping Nuitka onefile's internal temp-extraction mechanics entirely.
        str(ENTRY_POINT),
    ]


def build_nuitka(*, onefile: bool) -> pathlib.Path:
    """Compiles and returns the path to the produced executable."""
    ensure_nuitka()
    ensure_vendor_jar()

    print("=" * 60)
    print("Compiling OpenDeX Backend to native code with Nuitka")
    print(f"Entry Point : {ENTRY_POINT}")
    print(f"Output Dir  : {DIST_DIR}")
    print(f"Format      : {'Single Executable (.onefile)' if onefile else 'Standalone Folder (.standalone)'}")
    print("=" * 60)

    res = subprocess.run(nuitka_args(onefile=onefile), cwd=str(BACKEND_DIR))
    if res.returncode != 0:
        raise BuildError(f"Nuitka compilation failed with code: {res.returncode}")

    exe_name = "opendex-backend.exe" if sys.platform == "win32" or onefile else "opendex-backend"
    exe_path = DIST_DIR / exe_name if onefile else DIST_DIR / "main.dist" / exe_name
    if not exe_path.exists():
        raise BuildError(f"Nuitka reported success but the expected output is missing: {exe_path}")

    print(f"\n[OK] Compilation completed: {exe_path} ({exe_path.stat().st_size} bytes)")
    return exe_path


def verify_no_source_leak(exe_path: pathlib.Path) -> None:
    """Fails loudly if the compiled binary still contains readable source text, or a debug-symbol file shipped
    alongside it — a self-check that catches a regression in the flags above automatically, every build, instead
    of relying on a one-time claim that they work."""
    pdb_files = list(exe_path.parent.glob("*.pdb"))
    if pdb_files:
        raise BuildError(
            "Debug symbol file(s) sit next to the compiled exe — these carry full function/variable names and must "
            f"never ship: {[str(p) for p in pdb_files]}"
        )

    data = exe_path.read_bytes()
    leaked = [marker.decode() for marker in _SOURCE_MARKERS if marker in data]
    if leaked:
        raise BuildError(
            "Readable source text found inside the compiled binary (docstring stripping did not take effect): "
            f"{leaked}"
        )
    print("[OK] No debug symbols next to the binary, no known source text inside it.")


def host_triple() -> str:
    """The rustc target triple for this machine — the same suffix `tauri build` expects on sidecar binaries
    (see scripts/build-backend-sidecar.ps1, which this replaces, and src-tauri/src/sidecar.rs)."""
    res = subprocess.run(["rustc", "-vV"], capture_output=True, text=True, check=True)
    match = re.search(r"^host:\s*(\S+)$", res.stdout, re.MULTILINE)
    if not match:
        raise BuildError(f"Could not parse 'host:' from `rustc -vV` output:\n{res.stdout}")
    return match.group(1)


def package_sidecar(exe_path: pathlib.Path) -> pathlib.Path:
    """Verifies and copies the compiled exe to where Tauri's `externalBin` (tauri.conf.json) expects it. This is
    the ONE place that produces what `tauri build` actually bundles — scripts/build-backend-sidecar.ps1 and
    scripts/build_release.py both call into this instead of each hand-rolling their own copy logic (the previous
    drift between them — one Nuitka, one still PyInstaller — is exactly how the weaker build ended up being the
    one that shipped)."""
    verify_no_source_leak(exe_path)
    SIDECAR_BINARIES_DIR.mkdir(parents=True, exist_ok=True)
    dest = SIDECAR_BINARIES_DIR / f"{SIDECAR_NAME}-{host_triple()}.exe"
    dest.write_bytes(exe_path.read_bytes())
    print(f"[OK] Sidecar ready: {dest} ({dest.stat().st_size} bytes)")
    print("     vendor/ ships separately as a Tauri bundle resource (tauri.conf.json → bundle.resources) — nothing more to copy here.")
    return dest


def main() -> None:
    onefile = "--onefile" in sys.argv or "--package-sidecar" in sys.argv  # packaging needs the single-file shape
    exe_path = build_nuitka(onefile=onefile)
    if "--package-sidecar" in sys.argv:
        package_sidecar(exe_path)


if __name__ == "__main__":
    try:
        main()
    except BuildError as err:
        print(f"\n[FAILED] {err}")
        sys.exit(1)
