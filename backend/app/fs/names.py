"""File names: what each side accepts, how a name is made acceptable, and how "Keep both" picks a new one.

The phone (ext4/f2fs/FUSE) is case-sensitive, allows every character but '/' and NUL and caps a name at 255 BYTES. Windows
is case-insensitive, forbids `<>:"/\\|?*`, control characters, trailing dots/spaces and the device names (CON, NUL, COM1…),
and caps a name at 255 UTF-16 units. A photo named "IMG: 2024?.jpg" is legal on the phone and impossible on the PC — the
transfer engine therefore never copies a name blindly to a Windows destination.
"""
from __future__ import annotations

import re
import unicodedata

from .errors import FsError

MAX_NAME_BYTES = 255                      # phone / POSIX: bytes of UTF-8
MAX_NAME_UNITS = 255                      # Windows: UTF-16 code units

_WINDOWS_INVALID = set('<>:"/\\|?*') | {chr(c) for c in range(32)}
_WINDOWS_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
    | {"COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"}
)
_COMPOUND_EXTENSIONS = (".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst")
# Right-to-left override and friends: a name that *displays* as "photo_gpj.exe" while being "photo_‮exe.jpg".
_BIDI_CONTROLS = frozenset("‪‫‬‭‮⁦⁧⁨⁩")

_COPY_SUFFIX = re.compile(r"^(?P<stem>.*) \((?P<n>\d{1,6})\)$")


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def split_extension(name: str) -> tuple[str, str]:
    """('archive', '.tar.gz'), ('photo', '.jpg'), ('.bashrc', ''), ('README', '')."""
    lowered = name.lower()
    for compound in _COMPOUND_EXTENSIONS:
        if lowered.endswith(compound) and len(name) > len(compound):
            return name[: -len(compound)], name[-len(compound):]
    dot = name.rfind(".")
    if dot <= 0:                                  # no dot, or a leading dot only (".bashrc")
        return name, ""
    return name[:dot], name[dot:]


def has_bidi_controls(name: str) -> bool:
    return any(ch in _BIDI_CONTROLS for ch in name)


def validate_name(name: str, *, windows: bool) -> str:
    """The name, or FsError('invalid_name'). Used for every name a CLIENT supplies (rename, new folder)."""
    if not isinstance(name, str) or not name or name in (".", ".."):
        raise FsError("invalid_name", "Ad boş olamaz.")
    if "\x00" in name or "/" in name:
        raise FsError("invalid_name", "Ad '/' ya da boş karakter içeremez.")
    if has_bidi_controls(name):
        raise FsError("invalid_name", "Ad görünmez yön denetim karakterleri içeremez.")
    if windows:
        bad = sorted({ch for ch in name if ch in _WINDOWS_INVALID})
        if bad:
            shown = " ".join(repr(c)[1:-1] for c in bad)
            raise FsError("invalid_name", f"Ad şu karakterleri içeremez: {shown}")
        if name != name.rstrip(" ."):
            raise FsError("invalid_name", "Ad nokta ya da boşlukla bitemez.")
        if name.split(".", 1)[0].rstrip(" ").upper() in _WINDOWS_RESERVED:
            raise FsError("invalid_name", "Bu ad Windows'ta ayrılmış bir aygıt adıdır.")
        if utf16_len(name) > MAX_NAME_UNITS:
            raise FsError("invalid_name", "Ad çok uzun (en fazla 255 karakter).")
    elif len(name.encode("utf-8")) > MAX_NAME_BYTES:
        raise FsError("invalid_name", "Ad çok uzun (en fazla 255 bayt).")
    return name


def windows_safe_name(name: str) -> str:
    """The closest name Windows accepts: forbidden characters become '_', reserved device names get a '_' prefix,
    trailing dots/spaces go, and an over-long name is shortened keeping its extension. Idempotent."""
    cleaned = "".join("_" if (ch in _WINDOWS_INVALID or ch in _BIDI_CONTROLS) else ch for ch in name)
    cleaned = cleaned.rstrip(" .") or "_"
    if cleaned.split(".", 1)[0].rstrip(" ").upper() in _WINDOWS_RESERVED:
        cleaned = "_" + cleaned
    if utf16_len(cleaned) > MAX_NAME_UNITS:
        stem, ext = split_extension(cleaned)
        keep = MAX_NAME_UNITS - utf16_len(ext)
        stem = stem.encode("utf-16-le")[: keep * 2].decode("utf-16-le", errors="ignore")
        cleaned = (stem.rstrip(" .") or "_") + ext
    return cleaned


def phone_safe_name(name: str) -> str:
    """A name the phone accepts: no '/', no NUL, at most 255 UTF-8 bytes (cut on a character boundary)."""
    cleaned = name.replace("/", "_").replace("\x00", "_") or "_"
    if len(cleaned.encode("utf-8")) > MAX_NAME_BYTES:
        stem, ext = split_extension(cleaned)
        room = MAX_NAME_BYTES - len(ext.encode("utf-8"))
        stem = stem.encode("utf-8")[:room].decode("utf-8", errors="ignore")
        cleaned = (stem or "_") + ext
    return cleaned


def comparison_key(name: str, *, casefold: bool) -> str:
    """How two names are compared for "is it the same file". Windows folds case (and NFC-normalises: macOS-made names
    arrive decomposed); the phone compares exactly."""
    return unicodedata.normalize("NFC", name).casefold() if casefold else name


def unique_name(name: str, taken: set[str], *, casefold: bool) -> str:
    """'photo.jpg' -> 'photo (2).jpg' -> 'photo (3).jpg'… the first variant whose comparison key is not in `taken`
    (which holds comparison keys). An existing '(n)' suffix is continued, not stacked: 'a (2).txt' -> 'a (3).txt'."""
    if comparison_key(name, casefold=casefold) not in taken:
        return name
    stem, ext = split_extension(name)
    match = _COPY_SUFFIX.match(stem)
    base, start = (match.group("stem"), int(match.group("n")) + 1) if match else (stem, 2)
    for n in range(start, start + 10_000):
        candidate = f"{base} ({n}){ext}"
        if comparison_key(candidate, casefold=casefold) not in taken:
            return candidate
    raise FsError("exists", "Uygun bir ad bulunamadı.")
