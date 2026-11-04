"""Uploads the finished build (download/) to a GitHub Release, so installers never enter git history.

    python scripts/release_github.py                 # release v<version> from tauri.conf.json
    python scripts/release_github.py --draft         # create it as a draft (not public until you press Publish)
    python scripts/release_github.py --tag v0.9 --prerelease --notes "text"   # a named pre-release
    python scripts/release_github.py --notes "text"  # release notes (default: the checksums)
    derle_tam.bat --release                          # build, then upload (build_release.py calls this)

download/ is a build output and is NOT committed (.gitignore). The release keeps one set of files per version: running it again for
the same version replaces the assets of that release (same names), it does not create a second release.

Authentication: GITHUB_TOKEN / GH_TOKEN if set, otherwise the GitHub login git already has (Git Credential Manager,
`git credential fill`). No extra program (gh) is needed. The token needs the `repo` scope.

The tag is created by GitHub on the remote's default branch HEAD when the release is new: push the commit the build came from first,
or the tag points to an older commit than the files in it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT_DIR = pathlib.Path(__file__).parent.parent.resolve()
TAURI_DIR = ROOT_DIR / "frontend" / "src-tauri"
DOWNLOAD_DIR = ROOT_DIR / "download"
API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"
FALLBACK_REPO = "Lordof21/OpenDex"
CONNECTION_ATTEMPTS = 4
CONTENT_TYPES = {".zip": "application/zip", ".msi": "application/x-msi", ".txt": "text/plain"}


def parse_repo(remote_url: str) -> str:
    """'owner/name' from an https or ssh GitHub remote URL; '' when it is not a GitHub URL."""
    match = re.search(r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", remote_url.strip())
    return f"{match.group(1)}/{match.group(2)}" if match else ""


def repo_slug() -> str:
    try:
        url = subprocess.run(
            ["git", "remote", "get-url", "origin"], cwd=ROOT_DIR, capture_output=True, text=True, timeout=15
        ).stdout
    except (OSError, subprocess.SubprocessError):
        url = ""
    return parse_repo(url) or FALLBACK_REPO


def find_token() -> str:
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        if os.environ.get(name):
            return os.environ[name]
    result = subprocess.run(
        ["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n", capture_output=True, text=True, timeout=60
    )
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    token = fields.get("password", "")
    if not token:
        raise RuntimeError("GitHub oturumu bulunamadı: GITHUB_TOKEN ayarla ya da bir kez `git push` ile oturum aç.")
    return token


def _tls_context() -> ssl.SSLContext | None:
    """certifi's current root list when the package is there (the Windows store on some machines lacks a root GitHub's chain ends in and
    answers "unable to get issuer certificate" now and then); otherwise Python's default."""
    try:
        import certifi
    except ImportError:
        return None
    return ssl.create_default_context(cafile=certifi.where())


def request(method: str, url: str, token: str, body: dict | None = None, file: pathlib.Path | None = None) -> dict | list | None:
    """One GitHub API call. `file`: the request body is that file's bytes (asset upload). Returns the decoded JSON ('' → None)."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opendex-release",
    }
    if file is not None:
        headers["Content-Type"] = CONTENT_TYPES.get(file.suffix.lower(), "application/octet-stream")
        headers["Content-Length"] = str(file.stat().st_size)
    elif body is not None:
        headers["Content-Type"] = "application/json"
    # A connection-level failure (an occasional "certificate verify failed" or a reset on this machine) is retried; an HTTP answer is not.
    for attempt in range(1, CONNECTION_ATTEMPTS + 1):
        handle = file.open("rb") if file is not None else None
        data = handle if handle else (json.dumps(body).encode("utf-8") if body is not None else None)
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=600, context=_tls_context()) as resp:
                raw = resp.read()
            return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:400]
            raise RuntimeError(f"GitHub {method} {url.split('?')[0]} → {err.code}: {detail}") from err
        except (urllib.error.URLError, ConnectionError, TimeoutError) as err:
            if attempt == CONNECTION_ATTEMPTS:
                raise RuntimeError(f"GitHub {method} {url.split('?')[0]}: bağlantı kurulamadı ({err})") from err
            print(f"[release] bağlantı hatası ({err}); {attempt}/{CONNECTION_ATTEMPTS}, yeniden deneniyor...")
            time.sleep(3 * attempt)
        finally:
            if handle:
                handle.close()
    return None


def _sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_assets(download_dir: pathlib.Path) -> list[pathlib.Path]:
    """The files to upload. Refuses to ship when SHA256SUMS.txt does not describe exactly the zip/msi next to it (a stale or half-written
    download/ would publish files whose checksums do not match)."""
    sums_file = download_dir / "SHA256SUMS.txt"
    shipped = sorted(p for p in download_dir.glob("*") if p.suffix in (".zip", ".msi")) if download_dir.is_dir() else []
    if not shipped or not sums_file.is_file():
        raise RuntimeError(f"{download_dir} içinde yüklenecek derleme yok — önce derle_tam.bat çalıştır.")
    listed = {}
    for line in sums_file.read_text(encoding="utf-8").splitlines():
        digest, _, name = line.partition("  ")
        if name:
            listed[name] = digest
    for path in shipped:
        if listed.get(path.name) != _sha256(path):
            raise RuntimeError(f"{path.name} SHA256SUMS.txt ile uyuşmuyor — derlemeyi yeniden çalıştır, eski/yarım dosya yüklenmedi.")
    extra = set(listed) - {p.name for p in shipped}
    if extra:
        raise RuntimeError(f"SHA256SUMS.txt şu dosyaları listeliyor ama yok: {', '.join(sorted(extra))}")
    return shipped + [sums_file]


def release(tag: str, assets: list[pathlib.Path], notes: str, draft: bool, repo: str, token: str, prerelease: bool = False) -> str:
    """Creates the release for `tag` (or reuses it), replaces its assets of the same names, returns the release's web URL."""
    base = f"{API}/repos/{repo}"
    try:
        current = request("GET", f"{base}/releases/tags/{urllib.parse.quote(tag)}", token)
    except RuntimeError as err:
        if "→ 404" not in str(err):
            raise
        current = None
    if current is None:
        current = request(
            "POST", f"{base}/releases", token,
            {"tag_name": tag, "name": f"OpenDeX {tag.lstrip('v')}", "body": notes, "draft": draft, "prerelease": prerelease},
        )
        print(f"[release] {tag} oluşturuldu" + (" (taslak)" if draft else ""))
    else:
        request("PATCH", f"{base}/releases/{current['id']}", token, {"body": notes})
        print(f"[release] {tag} zaten var: dosyaları yenileniyor")
    names = {p.name for p in assets}
    for old in current.get("assets", []):
        if old["name"] in names:
            request("DELETE", f"{base}/releases/assets/{old['id']}", token)
    for path in assets:
        print(f"[release]   {path.name}  {path.stat().st_size / 1e6:.1f} MB yükleniyor...")
        request("POST", f"{UPLOADS}/repos/{repo}/releases/{current['id']}/assets?name={urllib.parse.quote(path.name)}", token, file=path)
    return current["html_url"]


def default_notes(assets: list[pathlib.Path]) -> str:
    sums = next(p for p in assets if p.name == "SHA256SUMS.txt").read_text(encoding="utf-8").strip()
    return "Windows (x64): installer (.msi) or portable (.zip). SHA-256 checksums:\n\n```\n" + sums + "\n```"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--tag", help="release tag (default: v<version> from tauri.conf.json)")
    parser.add_argument("--notes", help="release notes (default: the checksums)")
    parser.add_argument("--draft", action="store_true", help="create as a draft")
    parser.add_argument("--prerelease", action="store_true", help="mark as a pre-release (not shown as the 'latest' release)")
    args = parser.parse_args(argv)

    conf = json.loads((TAURI_DIR / "tauri.conf.json").read_text(encoding="utf-8"))
    tag = args.tag or f"v{conf['version']}"
    assets = collect_assets(DOWNLOAD_DIR)
    url = release(tag, assets, args.notes or default_notes(assets), args.draft, repo_slug(), find_token(), args.prerelease)
    print(f"[release] bitti: {url}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as err:
        print(f"[release] HATA: {err}", file=sys.stderr)
        sys.exit(1)
