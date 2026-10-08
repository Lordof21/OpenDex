"""
OpenDeX Release Build Pipeline — compiles and obfuscates every layer, then produces the installer:
  [1/4] Java daemon   : R8 obfuscation + shrinking + debug-symbol stripping (backend/java/build.py)
  [2/4] Frontend SPA  : Vite build + JS obfuscator — control-flow flattening, string encryption, anti-debug
                        (frontend/vite.config.js)
  [3/4] Python backend: Nuitka native-code compilation, copied to frontend/src-tauri/binaries/ as the Tauri
                        sidecar (backend/build_nuitka.py --package-sidecar)
  [4/4] Installer     : `tauri build` — packages steps 1-3's outputs into the signed .msi/.dmg

Each earlier version of this pipeline step either silently skipped on a missing tool (Java) or built an artifact
nobody downstream actually used (the backend step used to land in a release/OpenDeX/ folder that `tauri build`
never reads — the sidecar it really bundled came from a *different*, unobfuscated script). This one script is now
the only path from source to installer; every step either finishes or stops the whole run.
"""
import os
import pathlib
import subprocess
import sys
import time

ROOT_DIR = pathlib.Path(__file__).parent.parent.resolve()
BACKEND_DIR = ROOT_DIR / "backend"
FRONTEND_DIR = ROOT_DIR / "frontend"
# `--no-obfuscate`: a plain, debuggable Java dex and JS bundle (the backend is still compiled by Nuitka). The source is public; this is
# for contributors, packagers and anyone auditing a build — see docs/BUILD_AND_RELEASE.md.
NO_OBFUSCATE = "--no-obfuscate" in sys.argv


def banner(msg: str):
    print("\n" + "=" * 70)
    print(f"  {msg}")
    print("=" * 70 + "\n")


def step_1_java():
    banner("[1/4] Compiling & obfuscating the Java daemon (R8)" if not NO_OBFUSCATE else "[1/4] Compiling the Java daemon (R8 obfuscation OFF)")
    subprocess.check_call([sys.executable, str(BACKEND_DIR / "java" / "build.py"), *(["--no-obfuscate"] if NO_OBFUSCATE else [])])


def step_2_frontend():
    banner("[2/4] Building & obfuscating the frontend (Vite + JS obfuscator)")
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    env = {**os.environ, **({"OPENDEX_NO_OBFUSCATE": "1"} if NO_OBFUSCATE else {})}
    subprocess.check_call([npm_cmd, "run", "build"], cwd=str(FRONTEND_DIR), env=env)


def step_3_backend_sidecar():
    banner("[3/4] Compiling the Python backend to native code (Nuitka) and packaging the sidecar")
    subprocess.check_call(
        [sys.executable, str(BACKEND_DIR / "build_nuitka.py"), "--package-sidecar"],
        cwd=str(BACKEND_DIR),
    )


def _rust_path_remap_env() -> dict:
    """Keeps the builder's home / checkout paths out of the shipped exe: rustc embeds absolute source paths (panic locations,
    `file!()`), e.g. `<home>\\.cargo\\registry\\src\\...\\tauri-2.x\\src\\plugin.rs`. `CARGO_ENCODED_RUSTFLAGS` (0x1f-separated, so
    paths with spaces are safe) takes precedence over RUSTFLAGS, so an existing RUSTFLAGS is folded in."""
    home = pathlib.Path.home()
    cargo_home = pathlib.Path(os.environ.get("CARGO_HOME", home / ".cargo"))
    rustup_home = pathlib.Path(os.environ.get("RUSTUP_HOME", home / ".rustup"))
    flags = os.environ.get("RUSTFLAGS", "").split()
    for src, dst in ((cargo_home, "/cargo"), (rustup_home, "/rustup"), (ROOT_DIR, "/opendex"), (home, "/home")):
        flags.append(f"--remap-path-prefix={src}={dst}")
    return {"CARGO_ENCODED_RUSTFLAGS": "\x1f".join(flags)}


def step_4_tauri_build():
    banner("[4/4] Building the installer (tauri build)")
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    subprocess.check_call([npm_cmd, "run", "tauri", "build"], cwd=str(FRONTEND_DIR), env={**os.environ, **_rust_path_remap_env()})


def main():
    t0 = time.time()
    banner("OpenDeX release build")

    skip_backend = "--skip-backend" in sys.argv
    skip_installer = "--skip-installer" in sys.argv

    step_1_java()
    step_2_frontend()

    if skip_backend:
        print("\n[INFO] Backend compilation skipped (--skip-backend) — the installer step needs a sidecar already")
        print("       in frontend/src-tauri/binaries/ from a previous run, or it will fail.")
    else:
        step_3_backend_sidecar()

    if skip_installer:
        print("\n[INFO] Installer step skipped (--skip-installer).")
    else:
        step_4_tauri_build()

    dt = time.time() - t0
    banner(f"Release build finished in {dt:.1f}s")


if __name__ == "__main__":
    main()
