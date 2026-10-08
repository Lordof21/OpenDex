# Builds backend/ into the native sidecar `.exe` (Nuitka — compiles the whole app, interpreter included, to
# machine code; see backend/build_nuitka.py's module docstring for why this is the one that must ship, never the
# PyInstaller spec) and places it where Tauri's sidecar mechanism expects it
# (frontend/src-tauri/binaries/opendex-backend-<rustc-host-triple>.exe — see src-tauri/src/sidecar.rs).
# Re-run this after any backend code change that should ship in the native app; the frontend build does NOT
# rebuild the Python side automatically.
#
# All the real work (compiling, the no-leaked-source self-check, computing the rustc triple, copying into place)
# lives in one place — backend/build_nuitka.py --package-sidecar — so this script and scripts/build_release.py
# can't drift into using two different compilers the way build-backend-sidecar.ps1/build_release.py once did.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$backend = Join-Path $root "backend"

Push-Location $backend
try {
    python build_nuitka.py --package-sidecar
} finally {
    Pop-Location
}

Write-Host "Run 'npm run tauri build' (or 'tauri dev') from frontend/ to pick it up."
