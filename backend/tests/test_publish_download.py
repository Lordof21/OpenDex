"""scripts/publish_download.py: download/ gets THIS build's installer and portable zip, never an older file."""
import importlib.util
import pathlib
import time
import zipfile

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]


@pytest.fixture
def pub(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("publish_download", ROOT / "scripts" / "publish_download.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tauri = tmp_path / "tauri"
    release = tauri / "target" / "release"
    (release / "bundle" / "msi").mkdir(parents=True)
    (release / "vendor").mkdir(parents=True)
    (tauri / "tauri.conf.json").write_text(
        '{"version": "0.1.0", "bundle": {"windows": {"wix": {"language": "tr-TR"}}}}', encoding="utf-8"
    )
    (release / "opendex.exe").write_bytes(b"app")
    (release / "opendex-backend.exe").write_bytes(b"sidecar")
    (release / "vendor" / "opendex-tools.jar").write_bytes(b"jar")
    (release / "vendor" / "scrcpy-server-v4.1-opendex").write_bytes(b"scrcpy")
    (release / "bundle" / "msi" / "OpenDeX_0.1.0_x64_tr-TR.msi").write_bytes(b"msi")
    monkeypatch.setattr(module, "TAURI_DIR", tauri)
    monkeypatch.setattr(module, "RELEASE_DIR", release)
    monkeypatch.setattr(module, "DOWNLOAD_DIR", tmp_path / "download")
    return module


def test_publishes_zip_installer_and_checksums_of_this_build(pub):
    pub.publish(since=0)
    out = pub.DOWNLOAD_DIR
    with zipfile.ZipFile(out / "OpenDeX_0.1.0_windows-x64_portable.zip") as archive:
        assert sorted(archive.namelist()) == [
            "OpenDeX/opendex-backend.exe", "OpenDeX/opendex.exe",
            "OpenDeX/vendor/opendex-tools.jar", "OpenDeX/vendor/scrcpy-server-v4.1-opendex",
        ]
    assert (out / "OpenDeX_0.1.0_x64_tr-TR.msi").read_bytes() == b"msi"
    sums = (out / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines()
    assert [line.split("  ")[1] for line in sums] == ["OpenDeX_0.1.0_windows-x64_portable.zip", "OpenDeX_0.1.0_x64_tr-TR.msi"]


def test_an_installer_from_before_this_build_is_refused_and_nothing_is_replaced(pub):
    pub.DOWNLOAD_DIR.mkdir()
    (pub.DOWNLOAD_DIR / "SHA256SUMS.txt").write_text("keep", encoding="utf-8")
    old = pub.RELEASE_DIR / "bundle" / "msi" / "OpenDeX_0.1.0_x64_tr-TR.msi"
    import os
    os.utime(old, (time.time() - 3600, time.time() - 3600))

    with pytest.raises(RuntimeError, match="ÖNCE üretilmiş"):
        pub.publish(since=time.time())
    assert (pub.DOWNLOAD_DIR / "SHA256SUMS.txt").read_text(encoding="utf-8") == "keep"
    assert not (pub.DOWNLOAD_DIR / "OpenDeX_0.1.0_windows-x64_portable.zip").exists()


def test_an_empty_vendor_folder_is_refused(pub):
    for f in (pub.RELEASE_DIR / "vendor").iterdir():
        f.unlink()
    with pytest.raises(RuntimeError, match="vendor"):
        pub.publish(since=0)


def test_old_prebuilt_vendor_files_do_not_block_a_publish_but_a_stale_jar_does(pub):
    """The scrcpy servers in vendor/ are fetched once and keep their own old timestamps (a field report: every publish after the first
    one stopped on them); only the jar, which every build regenerates, must be newer than the build."""
    import os

    old = time.time() - 86400 * 30
    os.utime(pub.RELEASE_DIR / "vendor" / "scrcpy-server-v4.1-opendex", (old, old))
    pub.publish(since=time.time() - 3600)

    os.utime(pub.RELEASE_DIR / "vendor" / "opendex-tools.jar", (old, old))
    with pytest.raises(RuntimeError, match="opendex-tools.jar"):
        pub.publish(since=time.time() - 3600)
