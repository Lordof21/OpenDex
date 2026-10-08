"""One error type for the whole file system layer: a stable machine code, a Turkish message for the UI, an HTTP status.

The frontend switches on `code` (never on the message), so the codes are API: add one, never rename one.
"""
from __future__ import annotations

# code -> (HTTP status, default message shown to the user)
ERROR_TABLE: dict[str, tuple[int, str]] = {
    "bad_request":      (400, "Geçersiz istek."),
    "invalid_name":     (422, "Bu ad kullanılamaz."),
    "outside_roots":    (403, "Bu konuma erişim izni yok."),
    "permission":       (403, "Erişim reddedildi."),
    "read_only":        (403, "Konum salt okunur."),
    "not_found":        (404, "Öğe bulunamadı."),
    "exists":           (409, "Aynı adlı bir öğe zaten var."),
    "not_a_dir":        (409, "Bu bir klasör değil."),
    "is_a_dir":         (409, "Bu bir klasör."),
    "not_empty":        (409, "Klasör boş değil."),
    "cross_device":     (409, "Öğe başka bir depolama birimine taşınamaz; kopyalayıp silmek gerekir."),
    "in_use":           (423, "Dosya başka bir program tarafından kullanılıyor."),
    "device_offline":   (409, "Cihaz bağlı değil."),
    "busy":             (429, "Çok fazla eşzamanlı işlem var; biraz sonra tekrar deneyin."),
    "conflict_pending": (409, "Önce çakışmayı çözün."),
    "cancelled":        (409, "İşlem iptal edildi."),
    "too_large":        (413, "Öğe bu işlem için çok büyük."),
    "unsupported":      (501, "Bu işlem bu cihazda desteklenmiyor."),
    "timeout":          (504, "İşlem zaman aşımına uğradı."),
    "no_space":         (507, "Hedefte yeterli boş alan yok."),
    "trash_unavailable": (501, "Geri dönüşüm kutusu kullanılamıyor."),
    "io":               (500, "Dosya işlemi başarısız oldu."),
}


class FsError(Exception):
    """A file operation that cannot be done, and why."""

    def __init__(self, code: str, message: str | None = None, *, path: str | None = None, detail: str | None = None):
        if code not in ERROR_TABLE:
            raise ValueError(f"unknown fs error code {code!r}")
        self.code = code
        self.path = path
        self.detail = detail
        self.message = message or ERROR_TABLE[code][1]
        super().__init__(f"{code}: {self.message}" + (f" ({path})" if path else ""))

    @property
    def status(self) -> int:
        return ERROR_TABLE[self.code][0]

    def to_dict(self) -> dict[str, str | None]:
        return {"code": self.code, "message": self.message, "path": self.path, "detail": self.detail}


_ERRNO_CODES = {
    "ENOENT": "not_found", "EACCES": "permission", "EPERM": "permission", "EEXIST": "exists",
    "ENOTDIR": "not_a_dir", "EISDIR": "is_a_dir", "ENOTEMPTY": "not_empty", "ENOSPC": "no_space",
    "EDQUOT": "no_space", "EROFS": "read_only", "EXDEV": "cross_device", "ENAMETOOLONG": "invalid_name",
    "ETXTBSY": "in_use", "EBUSY": "in_use",
}
# Windows: 32 = ERROR_SHARING_VIOLATION, 33 = ERROR_LOCK_VIOLATION, 112 = ERROR_DISK_FULL, 183 = ERROR_ALREADY_EXISTS,
# 206 = ERROR_FILENAME_EXCED_RANGE, 267 = ERROR_DIRECTORY (not a directory), 145 = ERROR_DIR_NOT_EMPTY.
_WINERROR_CODES = {32: "in_use", 33: "in_use", 112: "no_space", 183: "exists", 206: "invalid_name", 267: "not_a_dir", 145: "not_empty"}


def from_oserror(exc: OSError, path: str | None = None) -> FsError:
    """Maps an OSError to the API's codes, on every platform (errno names, and Windows' WinError numbers)."""
    import errno

    code = _WINERROR_CODES.get(getattr(exc, "winerror", None) or -1)
    if code is None:
        name = errno.errorcode.get(exc.errno or 0, "")
        code = _ERRNO_CODES.get(name, "io")
    return FsError(code, path=path, detail=exc.strerror or None)
