# -*- mode: python ; coding: utf-8 -*-
# DEV/LEGACY ONLY — do not use this for a release artifact.
# PyInstaller ships the original .pyc bytecode almost unchanged (trivially reversed with pyinstxtractor +
# decompyle3/uncompyle6 — near-perfect source back); it exists here only for fast local sidecar iteration without a
# C toolchain. The build that actually ships — Nuitka, which compiles the whole app to native code — lives in
# backend/build_nuitka.py and is the only one scripts/build-backend-sidecar.ps1 / scripts/build_release.py call.
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = ['aiosqlite']
hiddenimports += collect_submodules('uvicorn')
hiddenimports += collect_submodules('websockets')
hiddenimports += collect_submodules('zeroconf')
hiddenimports += collect_submodules('send2trash')   # lazily imported by app/fs/providers/local.py (PC recycle bin)


import os
import sys

conda_bin_dir = os.path.join(sys.prefix, 'Library', 'bin')
needed_dll_prefixes = (
    'libexpat', 'sqlite3', 'ffi', 'liblzma', 'libbz2', 'zlib', 'openssl',
    'libcrypto', 'libssl', 'vcruntime', 'msvcp', 'concrt'
)
extra_binaries = []
if os.path.exists(conda_bin_dir):
    for f in os.listdir(conda_bin_dir):
        if f.lower().endswith('.dll') and any(f.lower().startswith(p) for p in needed_dll_prefixes):
            extra_binaries.append((os.path.join(conda_bin_dir, f), '.'))

a = Analysis(
    ['pyinstaller_entry.py'],
    pathex=['.'],
    binaries=extra_binaries,
    datas=[('vendor', 'vendor')],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='opendex-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
