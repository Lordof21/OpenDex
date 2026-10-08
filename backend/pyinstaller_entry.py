# PyInstaller entry point — DEV/LEGACY ONLY, see opendex-backend.spec; the release sidecar is built by
# backend/build_nuitka.py instead (Tauri sidecar build — src-tauri/src/sidecar.rs).
#
# NOT app/main.py directly: PyInstaller runs its entry script as a
# top-level, package-less __main__, which breaks every relative import
# inside app/ (`from . import logging_config`, `from ..config import
# Settings`, etc — this package uses them throughout). Importing `app.main`
# as a real package here, instead of executing it as a loose script,
# preserves all of that.
from app.main import run

if __name__ == "__main__":
    run()
