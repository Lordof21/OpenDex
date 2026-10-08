"""Loglama: terminal sessiz, DOSYA her şeyi tutar, izleme modu akış bazında terminali açar.

Üç katman (satırların NEREYE gittiği değişir, silinmez — tek istisna daemon DIAG/RPC gürültüsü: dosyaya da yazılmaz,
``daemon_raw`` ya da ``all`` izlemesi (ortam değişkeni, ``LOG_LEVEL=DEBUG`` ya da çalışırken
``POST /api/diagnostics/log-level``) açılınca dosyaya da, terminale de gelir):
  * Dosya (her zaman): ``backend/logs/opendex-YYYYMMDD.log`` — varsayılan INFO+ (``LOG_LEVEL=DEBUG`` ile DEBUG dahil),
    10 MB × 5 döner dosya. Açılışta 7 günden eski log/telemetri dosyaları silinir ve klasör 150 MB'ın altına çekilir
    (:func:`prune_logs`).
  * Terminal (varsayılan): WARNING+ ve küçük bir "önemli olaylar" listesi (bağlantı, güç).
  * İzleme modu: ``OPENDEX_TRACE=handoff,applock,power`` ortam değişkeni ya da çalışırken
    ``POST /api/diagnostics/log-level`` seçilen akışların INFO/DEBUG satırlarını terminale de açar.

Her HTTP isteği bir ``op_id`` taşır (``X-Op-Id`` başlığı ya da üretilir); o isteğin — ve başlattığı görevlerin —
tüm satırlarında ``[op:a3f9k2]`` görünür, böylece tarayıcı logu ile backend logu aynı numarayla eşleşir.
"""
from __future__ import annotations

import contextlib
import contextvars
import logging
import logging.handlers
import os
import pathlib
import re
import sys
import time
import uuid
from collections.abc import Iterable, Iterator
from typing import Any

LOG_MAX_BYTES = 10 * 1024 * 1024
LOG_BACKUPS = 5
# Saklama: günlük dosya adı yüzünden RotatingFileHandler eski günleri hiç silmez; telemetri .jsonl dosyası da sınırsızdı.
LOG_RETENTION_DAYS = 7
LOG_DIR_MAX_BYTES = 150 * 1024 * 1024
_PRUNABLE_PATTERNS = ("opendex-*.log*", "telemetry-*.jsonl")

# ─────────────────────────────────────────────────────────────── op_id (akış numarası)
_OP_ID_RE = re.compile(r"[^A-Za-z0-9_-]")
_op_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("opendex_op_id", default="-")


def new_op_id() -> str:
    return uuid.uuid4().hex[:6]


def sanitize_op_id(raw: str | None) -> str | None:
    """Dışarıdan gelen (başlık) akış numarasını log satırını bozamayacak hâle getirir."""
    if not raw:
        return None
    cleaned = _OP_ID_RE.sub("", raw)[:16]
    return cleaned or None


def current_op_id() -> str:
    return _op_id_var.get()


@contextlib.contextmanager
def op_scope(op_id: str | None = None) -> Iterator[str]:
    """Bu blok (ve içinde başlatılan görevler) boyunca tüm log satırlarına ``[op:<id>]`` eklenir."""
    token = _op_id_var.set(sanitize_op_id(op_id) or new_op_id())
    try:
        yield _op_id_var.get()
    finally:
        _op_id_var.reset(token)


class OpIdMiddleware:
    """Saf ASGI: her HTTP isteğini bir op_id kapsamına alır (BaseHTTPMiddleware'in bağlam sorunları yok)."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        raw = None
        for key, value in scope.get("headers", ()):
            if key == b"x-op-id":
                raw = value.decode("latin-1", errors="replace")
                break
        with op_scope(raw):
            await self.app(scope, receive, send)


# ─────────────────────────────────────────────────────────────── filtreler
class WindowContextFilter(logging.Filter):
    """Her kayıtta ``window_id`` ve ``op_id`` alanlarının bulunmasını garanti eder."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "window_id"):
            record.window_id = "-"
        if not hasattr(record, "op_id"):
            record.op_id = _op_id_var.get()
        return True


class _Formatter(logging.Formatter):
    """``[op:xxxxxx]`` yalnızca bir akış numarası varsa yazılır (gürültü yok)."""

    def format(self, record: logging.LogRecord) -> str:
        op = getattr(record, "op_id", "-")
        record.op_tag = f" [op:{op}]" if op and op != "-" else ""
        return super().format(record)


# İzleme kategorisi → ilgili logger önekleri. Terminalde bu önekler için INFO/DEBUG açılır.
TRACE_CATEGORIES: dict[str, tuple[str, ...]] = {
    "handoff": ("app.windows.handoff_manager",),
    "teleport": (
        "app.windows.task_teleporter", "app.windows.task_windowing", "app.windows.task_movement",
        "app.windows.surfaceflinger_probe",
    ),
    "applock": ("app.windows.window_lifecycle_coordinator", "app.device.deep_navigator"),
    "workspace": ("app.windows.eco_workspace",),
    "windows": (
        "app.windows.window_manager", "app.windows.session_reconfigure", "app.windows.budget_reallocator",
        "app.windows.session_table", "app.windows.encoder_stress_test", "app.windows.display_ids",
    ),
    "density": ("app.windows.density_reconciler", "app.windows.app_restart"),
    "continuity": ("app.windows.app_continuity", "app.windows.app_presence"),
    "power": ("app.device.display_power", "app.device.phone_awake"),
    "supervisor": ("app.device.connection_supervisor",),
    "media": (
        "app.device.device_daemon_client",
        "app.api.websockets",
        "app.device.notification_service",
        "app.device.notification_parser",
        "app.api.v1.endpoints.notifications",
        "app.device.media_control",
        "app.streams.audio_stream",
        "app.streams.app_audio",
        "app.streams.app_audio_link",
    ),
    "video": ("app.streams.video_stream", "app.streams.broadcaster"),
    "adb": (
        "app.device.adb", "app.device.device_manager", "app.device.device_tracker", "app.device.capability_probe",
        "app.device.android_shell", "app.device.tools_jar", "app.device.xml_inspector", "app.device.network_utils",
        "app.device.daemon_auth", "app.device.device_queries",
    ),
    "scrcpy": ("app.windows.scrcpy_launcher",),
    "input": ("app.input.touch_control", "app.input.keyboard_control", "app.input.keyboard_setup"),
    "files": ("app.fs",),
    "telemetry": ("app.telemetry", "app.windows.thermal_monitor"),
    "pairing": ("app.wireless",),
    "api": ("app.api",),
    "apps": ("app.apps",),
    "core": ("app.events", "app.storage"),
    "client": ("app.client",),
    "daemon_raw": (),  # yalnızca _DaemonMediaFilter'ı kapatır (DIAG/RPC gürültüsü de görünsün)
    "all": ("app",),
}

# Terminalde INFO seviyesinde her zaman görünen az sıklıkta "önemli olay" kaynakları.
_ALWAYS_INFO: tuple[str, ...] = (
    "app.main",
    "app.device.connection_supervisor",
    "app.device.display_power",
    "app.device.phone_awake",
)


def _matches(name: str, prefixes: Iterable[str]) -> bool:
    return any(name == p or name.startswith(p + ".") for p in prefixes)


class _ConsoleGate(logging.Filter):
    """Terminal kapısı: WARNING+ her zaman; INFO yalnızca önemli-olay listesi; DEBUG/INFO izleme modunda."""

    def __init__(self) -> None:
        super().__init__()
        self.traced: tuple[str, ...] = ()
        self.categories: tuple[str, ...] = ()

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno >= logging.WARNING:
            return True
        if self.traced and _matches(record.name, self.traced):
            return True
        return record.levelno >= logging.INFO and _matches(record.name, _ALWAYS_INFO)


_console_gate = _ConsoleGate()


class _FileGate(logging.Filter):
    """Dosya kapısı: INFO+ her zaman; DEBUG yalnızca ``LOG_LEVEL=DEBUG`` iken ya da bir izleme (trace) açıkken
    (izlenen akışın ayrıntısı dosyada da olsun). Dosya sınırsız büyümesin diye varsayılan INFO."""

    debug = False

    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno >= logging.INFO or self.debug or bool(_console_gate.categories)


_file_gate = _FileGate()

# device_daemon_client DIAG gürültüsü (bağlantı döngüsü, RPC gidiş-dönüşü): medya/bağlantı ile ilgisiz.
_DAEMON_NOISE_PREFIXES = (
    "[OpenDexDaemon:DIAG]",
    "[OpenDexDaemon:IN]",
    "[OpenDexDaemon:SEND_RPC",
    "[OpenDexDaemon:RECV_RPC",
    "[OpenDexDaemon:RPC_",
    "[OpenDexDaemon] Dropped",
    "[OpenDexDaemon] adb forward",
    "🔌 [OpenDexDaemon] Stopped",
)


class _DaemonMediaFilter(logging.Filter):
    """device_daemon_client'tan yalnızca medya/bağlantı durumu satırlarını geçirir (dosyada da gürültü birikmesin)."""

    enabled = True

    def filter(self, record: logging.LogRecord) -> bool:
        if not self.enabled or record.levelno >= logging.WARNING:
            return True
        msg = record.getMessage()
        return not any(msg.startswith(p) or p in msg for p in _DAEMON_NOISE_PREFIXES)


_daemon_filter = _DaemonMediaFilter()


# ─────────────────────────────────────────────────────────────── izleme modu
def set_trace(categories: Iterable[str]) -> tuple[list[str], list[str]]:
    """Terminalde izlenecek akışları ayarlar. ``(uygulanan, bilinmeyen)`` döner."""
    applied: list[str] = []
    unknown: list[str] = []
    prefixes: list[str] = []
    for raw in categories:
        cat = str(raw).strip().lower()
        if not cat:
            continue
        if cat in TRACE_CATEGORIES:
            if cat not in applied:
                applied.append(cat)
                prefixes.extend(TRACE_CATEGORIES[cat])
        else:
            unknown.append(cat)
    _console_gate.traced = tuple(prefixes)
    _console_gate.categories = tuple(applied)
    _daemon_filter.enabled = "daemon_raw" not in applied and "all" not in applied
    return applied, unknown


def get_trace() -> list[str]:
    return list(_console_gate.categories)


# ─────────────────────────────────────────────────────────────── yardımcı sınıflar

class BackoffLogLimiter:
    """Rate-limits repetitive warning/error logs with exponential backoff intervals:
    1s, 2s, 4s, 8s, 8s... (capped at max_interval). If silent for reset_timeout,
    intervals reset back to 1s.
    """

    def __init__(
        self,
        intervals: tuple[float, ...] = (1.0, 2.0, 4.0, 8.0),
        max_interval: float = 8.0,
        reset_timeout: float = 30.0,
    ) -> None:
        self._intervals = intervals
        self._max_interval = max_interval
        self._reset_timeout = reset_timeout
        self._history: dict[str, tuple[float, int]] = {}

    def should_log(self, key: str) -> bool:
        now = time.monotonic()
        if key not in self._history:
            self._history[key] = (now, 1)
            return True

        last_time, count = self._history[key]
        if now - last_time >= self._reset_timeout:
            self._history[key] = (now, 1)
            return True

        idx = min(count - 1, len(self._intervals) - 1)
        gap = self._intervals[idx]
        if now - last_time >= gap:
            self._history[key] = (now, count + 1)
            return True

        return False


class SafeStreamHandler(logging.StreamHandler):
    """Guarantees logs never crash on Windows terminals (cp1254/cp1252) when printing emojis."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            super().emit(record)
        except UnicodeEncodeError:
            try:
                msg = self.format(record)
                # Fallback: encode with replace to strip unencodable codepoints safely
                safe_msg = msg.encode("ascii", errors="replace").decode("ascii")
                self.stream.write(safe_msg + self.terminator)
                self.flush()
            except Exception:
                self.handleError(record)
        except Exception:
            self.handleError(record)


class _LiveStdoutHandler(SafeStreamHandler):
    """Her yazışta GÜNCEL ``sys.stdout``'a yazar: sonradan yönlendirilse/değiştirilse de (uvicorn, sidecar,
    ``redirect_stdout``, test yakalama) kapanmış eski bir akışa yazıp log kaybetmez."""

    def __init__(self) -> None:
        super().__init__(sys.stdout)

    @property
    def stream(self):  # type: ignore[override]
        return sys.stdout

    @stream.setter
    def stream(self, _value) -> None:
        pass


# ─────────────────────────────────────────────────────────────── dosya logu
_log_file: pathlib.Path | None = None


def log_dir() -> pathlib.Path:
    override = os.environ.get("OPENDEX_LOG_DIR")
    if override:
        return pathlib.Path(override)
    if getattr(sys, "frozen", False):  # paketlenmiş sürüm: geçici açılım dizinine değil, exe'nin yanına
        return pathlib.Path(sys.executable).resolve().parent / "logs"
    # BACKEND_ROOT: backend/ in dev, the exe's folder in the Nuitka sidecar (a __file__ path would land in the onefile
    # temp extraction dir, deleted on exit). Imported here: config.py must not be pulled in while logging is set up.
    from .config import BACKEND_ROOT

    return BACKEND_ROOT / "logs"


def current_log_file() -> pathlib.Path | None:
    return _log_file


def prune_logs(
    directory: pathlib.Path,
    *,
    max_age_days: float = LOG_RETENTION_DAYS,
    max_total_bytes: int = LOG_DIR_MAX_BYTES,
    keep: Iterable[pathlib.Path] = (),
    now: float | None = None,
) -> list[pathlib.Path]:
    """Deletes log / telemetry files older than ``max_age_days``, then the oldest ones until the folder is within
    ``max_total_bytes``. Only ``opendex-*.log*`` and ``telemetry-*.jsonl`` are touched; ``keep`` (the live log) never is.
    Errors are swallowed (a locked file stays): logging must never stop the app from starting. Returns what was removed."""
    now = time.time() if now is None else now
    protected = {pathlib.Path(p).resolve() for p in keep}
    files: list[tuple[float, int, pathlib.Path]] = []
    try:
        for pattern in _PRUNABLE_PATTERNS:
            for path in directory.glob(pattern):
                try:
                    st = path.stat()
                except OSError:
                    continue
                if path.is_file():
                    files.append((st.st_mtime, st.st_size, path))
    except OSError:
        return []

    removed: list[pathlib.Path] = []

    def drop(entry: tuple[float, int, pathlib.Path]) -> bool:
        if entry[2].resolve() in protected:
            return False
        try:
            entry[2].unlink()
        except OSError:
            return False
        removed.append(entry[2])
        return True

    cutoff = now - max_age_days * 86400
    remaining = []
    for entry in files:
        if entry[0] < cutoff and drop(entry):
            continue
        remaining.append(entry)

    total = sum(size for _, size, _ in remaining)
    for entry in sorted(remaining):  # oldest first
        if total <= max_total_bytes:
            break
        if drop(entry):
            total -= entry[1]
    return removed


def _make_file_handler() -> logging.Handler | None:
    global _log_file
    try:
        directory = log_dir()
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"opendex-{time.strftime('%Y%m%d')}.log"
        prune_logs(directory, keep=[path])
        handler = logging.handlers.RotatingFileHandler(
            path, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUPS, encoding="utf-8", delay=False
        )
    except OSError as exc:  # log yazılamıyorsa uygulama yine de açılmalı
        sys.stderr.write(f"[logging] dosya logu açılamadı ({exc}); yalnızca terminal kullanılacak\n")
        _log_file = None
        return None
    _log_file = path
    return handler


def tail_log(lines: int = 300) -> list[str]:
    """Güncel log dosyasının son ``lines`` satırı (bulunamazsa boş liste)."""
    path = _log_file
    if path is None or not path.exists():
        return []
    from collections import deque

    with path.open("r", encoding="utf-8", errors="replace") as fh:
        return [ln.rstrip("\n") for ln in deque(fh, maxlen=max(1, min(lines, 5000)))]


# ─────────────────────────────────────────────────────────────── kurulum
_CONSOLE_FMT = "%(asctime)s %(levelname)-7s [%(name)s] [win:%(window_id)s]%(op_tag)s %(message)s"
_FILE_FMT = "%(asctime)s.%(msecs)03d %(levelname)-7s [%(name)s] [win:%(window_id)s]%(op_tag)s %(message)s"

# Gürültülü 3. taraf kütüphaneler: kayıt ÜRETİLMESİN (dosyayı da doldurmasınlar).
_THIRD_PARTY_QUIET = (
    "zeroconf",
    "uvicorn",
    "uvicorn.access",
    "uvicorn.error",
    "asyncio",
    "websockets",
    "aiosqlite",
)


def setup(level: str = "INFO") -> None:
    # Configure stdout/stderr to UTF-8 with replace on Windows if supported
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass

    root = logging.getLogger()
    # Root WARNING: 3. taraf kütüphaneler sessiz. `app.*` DEBUG: kayıtlar ÜRETİLİR, hangi handler'a
    # gideceğine aşağıdaki kapılar karar verir (terminal sessiz, dosya tam).
    root.setLevel(logging.WARNING)
    logging.getLogger("app").setLevel(logging.DEBUG)
    for handler in list(root.handlers):
        root.removeHandler(handler)
        with contextlib.suppress(Exception):
            handler.close()

    context = WindowContextFilter()

    console = _LiveStdoutHandler()
    console.addFilter(context)
    console.addFilter(_console_gate)
    console.setFormatter(_Formatter(_CONSOLE_FMT, datefmt="%H:%M:%S"))
    root.addHandler(console)

    file_handler = _make_file_handler()
    if file_handler is not None:
        # INFO+ by default; LOG_LEVEL=DEBUG (or an active trace) lets DEBUG lines into the file too — see _FileGate.
        _file_gate.debug = str(level).upper() == "DEBUG"
        file_handler.setLevel(logging.DEBUG)
        file_handler.addFilter(_file_gate)
        file_handler.addFilter(context)
        file_handler.setFormatter(_Formatter(_FILE_FMT, datefmt="%Y-%m-%d %H:%M:%S"))
        root.addHandler(file_handler)

    for name in _THIRD_PARTY_QUIET:
        logging.getLogger(name).setLevel(logging.ERROR)

    logging.getLogger("app.device.device_daemon_client").addFilter(_daemon_filter)

    # OPENDEX_TRACE=handoff,applock,... ; LOG_LEVEL=DEBUG tüm akışları terminale açar.
    requested = [c for c in os.environ.get("OPENDEX_TRACE", "").split(",") if c.strip()]
    if str(level).upper() == "DEBUG":
        requested.append("all")
    applied, unknown = set_trace(requested)
    logging.getLogger("app.main").info(
        "Log: dosya=%s terminal=WARNING+ izleme=%s%s",
        _log_file or "(yok)", ",".join(applied) or "kapalı",
        f" bilinmeyen={','.join(unknown)}" if unknown else "",
    )


def window_logger(name: str, window_id: str) -> logging.LoggerAdapter:
    """Logger adapter that stamps every record with the owning window id."""
    return logging.LoggerAdapter(logging.getLogger(name), extra={"window_id": window_id})
