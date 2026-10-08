"""What the preview endpoint is willing to serve INLINE, and as what.

A file manager hands the page arbitrary bytes from disk. Served with the type its extension suggests, an `.html` or `.svg`
from a Downloads folder would be a document with the page's origin and the API's reach — a script away from every file
the API can read. So nothing is served as it claims: images/audio/video from a short list by their real media type,
text as `text/plain`, everything else as a download (`attachment`, `application/octet-stream`). Every response also
carries a sandboxing CSP and `nosniff` (the middleware's), so even a file opened in a tab runs nothing.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import quote

_INLINE = {
    # images
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp",
    "bmp": "image/bmp", "avif": "image/avif", "ico": "image/x-icon",
    # video / audio the webview can play
    "mp4": "video/mp4", "m4v": "video/mp4", "webm": "video/webm", "ogv": "video/ogg",
    # Phone recordings in the MP4 family: the container is read from the bytes, so they play as MP4 (H.264/AAC).
    "mov": "video/mp4", "3gp": "video/mp4", "3g2": "video/mp4",
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "ogg": "audio/ogg", "oga": "audio/ogg",
    "opus": "audio/ogg", "wav": "audio/wav", "flac": "audio/flac",
}
_TEXT = frozenset({
    "txt", "md", "log", "csv", "tsv", "json", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties",
    "py", "js", "mjs", "ts", "tsx", "jsx", "java", "kt", "c", "h", "cpp", "hpp", "cs", "go", "rs", "rb", "php",
    "sh", "bat", "cmd", "ps1", "sql", "css", "scss", "gradle", "svg", "html", "htm", "vtt", "srt", "gitignore", "env",
})
TEXT_PREVIEW_BYTES = 1_000_000

SANDBOX_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    # The app window (tauri.localhost / localhost:5173) and the API (127.0.0.1:8710) are different SITES, and <img>, <video> and
    # <audio> are plain cross-site loads: "same-site" here made the browser block every preview ("Önizleme yüklenemedi").
    # The request itself is still gated by the API token; the body stays a whitelisted media type under a sandbox CSP.
    "Cross-Origin-Resource-Policy": "cross-origin",
}


@dataclass(frozen=True, slots=True)
class ContentPolicy:
    media_type: str
    inline: bool
    kind: str                       # image | video | audio | text | other

    def headers(self, filename: str) -> dict[str, str]:
        disposition = "inline" if self.inline else "attachment"
        ascii_name = filename.encode("ascii", "replace").decode("ascii").replace('"', "'").replace("\\", "_")
        return {
            **SANDBOX_HEADERS,
            "Content-Disposition": f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename, safe='')}",
        }


def extension(name: str) -> str:
    """The text after the last dot, lower-cased ('' when there is none). '.env' is the extension 'env'."""
    base = os.path.basename(name)
    return base.rsplit(".", 1)[-1].lower() if "." in base else ""


def policy_for(name: str) -> ContentPolicy:
    ext = extension(name)
    if ext in _INLINE:
        media = _INLINE[ext]
        return ContentPolicy(media, True, media.split("/")[0])
    if ext in _TEXT:
        return ContentPolicy("text/plain; charset=utf-8", True, "text")
    return ContentPolicy("application/octet-stream", False, "other")


def can_thumbnail_on_pc(name: str) -> bool:
    return extension(name) in {"jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "ico", "avif"}
