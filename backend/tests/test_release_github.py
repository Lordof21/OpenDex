"""scripts/release_github.py: only a download/ whose checksums match is uploaded; a repeat run replaces the assets of the same release."""
import hashlib
import importlib.util
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]


@pytest.fixture
def rel():
    spec = importlib.util.spec_from_file_location("release_github", ROOT / "scripts" / "release_github.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _download(tmp_path, tamper=False, drop_sums=False):
    (tmp_path / "a.msi").write_bytes(b"msi")
    (tmp_path / "a.zip").write_bytes(b"zip")
    sums = "".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in sorted(tmp_path.glob("a.*")))
    if tamper:
        (tmp_path / "a.zip").write_bytes(b"changed after the checksums were written")
    if not drop_sums:
        (tmp_path / "SHA256SUMS.txt").write_text(sums, encoding="utf-8")
    return tmp_path


def test_parse_repo_from_https_and_ssh_remotes(rel):
    assert rel.parse_repo("https://github.com/Lordof21/OpenDex.git") == "Lordof21/OpenDex"
    assert rel.parse_repo("git@github.com:Lordof21/OpenDex.git\n") == "Lordof21/OpenDex"
    assert rel.parse_repo("https://gitlab.com/x/y.git") == ""


def test_matching_download_is_collected_with_its_checksums(rel, tmp_path):
    assets = rel.collect_assets(_download(tmp_path))
    assert [p.name for p in assets] == ["a.msi", "a.zip", "SHA256SUMS.txt"]


def test_a_file_that_no_longer_matches_its_checksum_is_refused(rel, tmp_path):
    with pytest.raises(RuntimeError, match="uyuşmuyor"):
        rel.collect_assets(_download(tmp_path, tamper=True))


def test_missing_checksums_or_empty_folder_is_refused(rel, tmp_path):
    with pytest.raises(RuntimeError, match="derleme yok"):
        rel.collect_assets(_download(tmp_path, drop_sums=True))
    with pytest.raises(RuntimeError, match="derleme yok"):
        rel.collect_assets(tmp_path / "nowhere")


def test_new_release_is_created_and_every_asset_uploaded(rel, tmp_path, monkeypatch):
    calls = []

    def fake(method, url, token, body=None, file=None):
        calls.append((method, url.split("?")[0].replace(rel.API, "").replace(rel.UPLOADS, "UP"), file.name if file else None))
        if method == "GET":
            raise RuntimeError("GitHub GET x → 404: Not Found")
        if method == "POST" and url.endswith("/releases"):
            return {"id": 7, "html_url": "https://example/r", "assets": []}
        return {}

    monkeypatch.setattr(rel, "request", fake)
    url = rel.release("v0.1.0", rel.collect_assets(_download(tmp_path)), "notes", False, "o/r", "tok")
    assert url == "https://example/r"
    assert [c[0] for c in calls] == ["GET", "POST", "POST", "POST", "POST"]
    assert [c[2] for c in calls if c[2]] == ["a.msi", "a.zip", "SHA256SUMS.txt"]


def test_existing_release_has_its_same_named_assets_replaced_not_duplicated(rel, tmp_path, monkeypatch):
    calls = []

    def fake(method, url, token, body=None, file=None):
        calls.append((method, url.replace(rel.API, "").replace(rel.UPLOADS, "UP").split("?")[0]))
        if method == "GET":
            return {"id": 7, "html_url": "https://example/r", "assets": [{"id": 11, "name": "a.zip"}, {"id": 12, "name": "other.txt"}]}
        return {}

    monkeypatch.setattr(rel, "request", fake)
    rel.release("v0.1.0", rel.collect_assets(_download(tmp_path)), "notes", False, "o/r", "tok")
    deletes = [c for c in calls if c[0] == "DELETE"]
    assert deletes == [("DELETE", "/repos/o/r/releases/assets/11")]         # a.zip replaced; other.txt left alone
    assert not any(c[0] == "POST" and c[1].endswith("/releases") for c in calls)   # no second release
