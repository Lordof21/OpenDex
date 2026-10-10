# -*- mode: python ; coding: utf-8 -*-
# The quick sidecar build: `python scripts/build_release.py --pyinstaller` (no C compiler, about a minute).
# PyInstaller ships the .pyc bytecode almost unchanged, so unlike the Nuitka build (backend/build_nuitka.py, native code,
# the default of scripts/build_release.py) the Python source can be recovered from the exe. The source of this project is
# public, so that costs no secrecy; the trade is a larger exe and a slower first start (onefile unpacks to a temp dir).
# `vendor/` is embedded below and found through sys._MEIPASS (app/config.py).
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
    # The dev environment carries far more than the backend imports (notebooks, plotting, numeric stacks, test tools); a PyInstaller
    # run in it sweeps whatever a hook happens to touch. Nothing here is imported by app/ (see backend/pyproject.toml dependencies).
    excludes=[
        'numpy', 'scipy', 'pandas', 'matplotlib', 'sympy', 'numba', 'sklearn', 'cv2', 'torch', 'tensorflow',
        'IPython', 'ipykernel', 'ipywidgets', 'jupyter_client', 'jupyter_core', 'notebook', 'nbformat', 'nbconvert', 'zmq', 'tornado',
        'jedi', 'parso', 'astroid', 'prompt_toolkit', 'pygments', 'lark',
        'pytest', '_pytest', 'setuptools', 'pkg_resources', 'wheel', 'tkinter', 'PyQt5', 'PyQt6', 'PySide6',
    ],
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
