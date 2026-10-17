"""Puts the finished release into the repo's download/ folder (called by build_release.py after the installer step).

download/ holds what a user downloads, committed with the project:
  * OpenDeX_<version>_windows-x64_portable.zip — the app folder as the installer ships it (the Tauri exe, its sidecar and vendor/),
    unzipped it runs as-is: the folder layout is the one `tauri build` leaves in frontend/src-tauri/target/release;
  * OpenDeX_<version>_x64_<wix-language>.msi — the installer `tauri build` wrote for the language in tauri.conf.json;
  * SHA256SUMS.txt — the checksums of both, in `sha256sum` format.

Every file is taken from THIS build only: a file older than the build's start means the step it comes from did not run
(e.g. --skip-backend keeps an old sidecar), and the publish stops instead of shipping it.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import tempfile
import zipfile

ROOT_DIR = pathlib.Path(__file__).parent.parent.resolve()
TAURI_DIR = ROOT_DIR / "frontend" / "src-tauri"
RELEASE_DIR = TAURI_DIR / "target" / "release"
DOWNLOAD_DIR = ROOT_DIR / "download"
APP_FOLDER = "OpenDeX"
# File times on NTFS are not exact to the second against the clock the build reads: a small slack, not a loophole.
CLOCK_SLACK_S = 5.0


def _tauri_conf() -> dict:
    return json.loads((TAURI_DIR / "tauri.conf.json").read_text(encoding="utf-8"))


def _msi_name(conf: dict) -> str:
    lang = conf.get("bundle", {}).get("windows", {}).get("wix", {}).get("language", "en-US")
    return f"OpenDeX_{conf['version']}_x64_{lang}.msi"


def _portable_name(conf: dict) -> str:
    return f"OpenDeX_{conf['version']}_windows-x64_portable.zip"


def _fresh(path: pathlib.Path, since: float) -> None:
    if not path.is_file():
        raise RuntimeError(f"{path} yok — derlemenin bu adımı üretmemiş")
    if path.stat().st_mtime + CLOCK_SLACK_S < since:
        raise RuntimeError(
            f"{path.name} bu derlemeden ÖNCE üretilmiş ({path.stat().st_mtime:.0f} < {since:.0f}). Eski bir çıktıyı "
            "yayımlamamak için durduruldu — derlemeyi bu adımı da çalıştıracak şekilde (--skip-backend/--skip-installer olmadan) "
            "yeniden çalıştır."
        )


def _sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_portable_zip(target: pathlib.Path, since: float, conf: dict) -> None:
    exe = RELEASE_DIR / "opendex.exe"
    sidecar = RELEASE_DIR / "opendex-backend.exe"
    vendor = RELEASE_DIR / "vendor"
    for path in (exe, sidecar):
        _fresh(path, since)
    vendor_files = sorted(p for p in vendor.iterdir() if p.is_file()) if vendor.is_dir() else []
    if not vendor_files:
        raise RuntimeError(f"{vendor} boş ya da yok — scrcpy sunucusu ve opendex-tools.jar eksik kalır")
    # Only what THIS build produces must be fresh (the jar). The scrcpy servers in vendor/ are fetched/prebuilt assets that keep their own
    # (old) timestamps — requiring them to be newer than the build stopped every publish after the first one.
    for path in vendor_files:
        if path.suffix == ".jar":
            _fresh(path, since)

    # Written beside the target and renamed into place: a failed zip never replaces the last good one.
    fd, tmp_name = tempfile.mkstemp(suffix=".zip", dir=str(target.parent))
    os.close(fd)
    tmp = pathlib.Path(tmp_name)
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            archive.write(exe, f"{APP_FOLDER}/{exe.name}")
            archive.write(sidecar, f"{APP_FOLDER}/{sidecar.name}")
            for path in vendor_files:
                archive.write(path, f"{APP_FOLDER}/vendor/{path.name}")
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink()


def publish(since: float) -> None:
    """Writes the portable zip, the installer and SHA256SUMS.txt into download/. `since`: the build's start (time.time())."""
    conf = _tauri_conf()
    msi_src = RELEASE_DIR / "bundle" / "msi" / _msi_name(conf)
    _fresh(msi_src, since)

    DOWNLOAD_DIR.mkdir(exist_ok=True)
    build_portable_zip(DOWNLOAD_DIR / _portable_name(conf), since, conf)
    shutil.copy2(msi_src, DOWNLOAD_DIR / msi_src.name)

    shipped = sorted(p for p in DOWNLOAD_DIR.iterdir() if p.suffix in (".zip", ".msi"))
    sums = "".join(f"{_sha256(p)}  {p.name}\n" for p in shipped)
    (DOWNLOAD_DIR / "SHA256SUMS.txt").write_text(sums, encoding="utf-8", newline="\n")

    print(f"[download] {DOWNLOAD_DIR} güncellendi:")
    for p in shipped:
        print(f"[download]   {p.name}  {p.stat().st_size / 1e6:.1f} MB")
    print("[download]   SHA256SUMS.txt yazıldı")
