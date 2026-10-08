"""On-Device Java Renderer App-Icon Service.

Zero-Install: Cihaza hiçbir şey kurmadan opendex-tools.jar içindeki IconExtractor
üzerinden doğrudan Android'in yerel Grafik ve PackageManager motoruyla %100
orijinal PNG ikonları çeker ve ~/.opendex/icon_cache/ dizininde saklar.
Jar'ı cihaza göndermek bu modülün işi değildir: tek sahibi `device.tools_jar`.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import pathlib
import time

from ..device import tools_jar
from ..device.adb import Adb

log = logging.getLogger(__name__)

ICON_CACHE_DIR = pathlib.Path.home() / ".opendex" / "icon_cache"
ICON_CACHE_DIR.mkdir(parents=True, exist_ok=True)

_PKG_LOCKS: dict[str, asyncio.Lock] = {}
_PREFETCH_TASK: asyncio.Task | None = None


def _get_pkg_lock(pkg: str) -> asyncio.Lock:
    if pkg not in _PKG_LOCKS:
        _PKG_LOCKS[pkg] = asyncio.Lock()
    return _PKG_LOCKS[pkg]


def _extract_pure_png(data: bytes | None) -> bytes | None:
    """Stream çıktısı içinden PNG baytlarını ayıklar ve doğrular."""
    if not data:
        return None
    png_idx = data.find(b"\x89PNG\r\n\x1a\n")
    if png_idx != -1:
        pure = data[png_idx:]
        if len(pure) > 100:
            return pure
    return None


async def get_app_icon_bytes(adb: Adb, serial: str, package: str, size: int = 128, force: bool = False) -> bytes | None:
    """İstenen paketin ikonunu önbellekten veya doğrudan cihazda render ederek getirir."""
    cached = ICON_CACHE_DIR / f"{package}.png"

    if not force and cached.is_file():
        with contextlib.suppress(Exception):
            data = cached.read_bytes()
            pure = _extract_pure_png(data)
            if pure:
                log.debug("[IconService:CACHE_HIT] %s -> %d bytes", package, len(pure))
                return pure
            cached.unlink(missing_ok=True)

    async with _get_pkg_lock(package):
        # Double check inside lock
        if not force and cached.is_file():
            with contextlib.suppress(Exception):
                data = cached.read_bytes()
                pure = _extract_pure_png(data)
                if pure:
                    return pure
                cached.unlink(missing_ok=True)

        if force and cached.is_file():
            with contextlib.suppress(Exception):
                cached.unlink(missing_ok=True)
                log.info("[IconService:FORCE_REFRESH] Önbellek silindi: %s", cached)

        await tools_jar.ensure_tools_jar(adb, serial)

        t0 = time.perf_counter()
        try:
            raw_output = await adb.run_java_tool(
                tools_jar.DEVICE_TOOLS_JAR, "com.opendex.tools.IconExtractor", "get", package, size,
                serial=serial, timeout_s=6.0, capture_bytes=True,
            )
            dt_ms = (time.perf_counter() - t0) * 1000
            png_bytes = _extract_pure_png(raw_output)

            if png_bytes:
                with contextlib.suppress(Exception):
                    cached.write_bytes(png_bytes)
                log.info("[IconService:SUCCESS] %s -> %d bytes (%.1f ms)", package, len(png_bytes), dt_ms)
                return png_bytes
            else:
                log.warning(
                    "[IconService:INVALID_PNG] %s -> output was %d bytes, starts with %r (%.1f ms)",
                    package, len(raw_output) if raw_output else 0, raw_output[:32] if raw_output else b"", dt_ms
                )
        except Exception as exc:
            dt_ms = (time.perf_counter() - t0) * 1000
            log.error("[IconService:EXCEPTION] %s çekilemedi (%.1f ms): %s", package, dt_ms, exc)

        return None


async def force_reextract_icon(adb: Adb, serial: str, package: str, size: int = 128) -> dict:
    """Sağ tık debug için ikonu zorla baştan çeker ve detaylı tanı raporu döner."""
    t0 = time.perf_counter()
    pushed = await tools_jar.ensure_tools_jar(adb, serial, force=True)
    if not pushed:
        return {
            "ok": False,
            "package": package,
            "bytes": 0,
            "error": "opendex-tools.jar cihaza kopyalanamadı",
            "duration_ms": round((time.perf_counter() - t0) * 1000, 1),
        }

    png_bytes = await get_app_icon_bytes(adb, serial, package, size=size, force=True)
    dt_ms = round((time.perf_counter() - t0) * 1000, 1)

    if png_bytes:
        return {
            "ok": True,
            "package": package,
            "bytes": len(png_bytes),
            "error": None,
            "duration_ms": dt_ms,
            "cached_path": str(ICON_CACHE_DIR / f"{package}.png"),
        }
    else:
        return {
            "ok": False,
            "package": package,
            "bytes": 0,
            "error": f"Cihazdan PNG üretilemedi ({dt_ms} ms)",
            "duration_ms": dt_ms,
        }


async def _prefetch_missing_icons(adb: Adb, serial: str, packages: list[str]) -> None:
    """Arka planda önbellekte henüz olmayan ikonları sessizce hazırlar."""
    missing = [pkg for pkg in packages if not (ICON_CACHE_DIR / f"{pkg}.png").is_file()]
    if not missing:
        return

    log.info("[IconService:PREFETCH_START] %d eksik ikon arka planda yükleniyor...", len(missing))
    sem = asyncio.Semaphore(4)

    async def _fetch(pkg: str):
        async with sem:
            await get_app_icon_bytes(adb, serial, pkg)

    await asyncio.gather(*[_fetch(pkg) for pkg in missing], return_exceptions=True)
    log.info("[IconService:PREFETCH_DONE] Tüm eksik ikonlar diske yazıldı.")


async def batch_extract_icons(adb: Adb, serial: str, size: int = 128) -> dict[str, str]:
    """Tüm cihazdaki uygulamaların isimlerini anında listeler ve eksikleri arka planda hazırlar."""
    await tools_jar.ensure_tools_jar(adb, serial)

    package_labels: dict[str, str] = {}
    t0 = time.perf_counter()

    try:
        output = await adb.run_java_tool(
            tools_jar.DEVICE_TOOLS_JAR, "com.opendex.tools.IconExtractor", "list-apps",
            serial=serial, timeout_s=15.0,
        )
        for line in output.splitlines():
            line = line.strip()
            if not line.startswith("{") or not line.endswith("}"):
                continue
            try:
                item = json.loads(line)
                pkg = item.get("package")
                lbl = item.get("label")
                if pkg and lbl:
                    package_labels[pkg] = lbl
            except Exception:
                continue

        dt_ms = (time.perf_counter() - t0) * 1000
        log.info(
            "[IconService:APP_LIST_READY] %d uygulama listelendi (%.1f ms)",
            len(package_labels), dt_ms
        )

        # Arka planda eksik olan ikonları diske yaz
        global _PREFETCH_TASK
        if _PREFETCH_TASK and not _PREFETCH_TASK.done():
            _PREFETCH_TASK.cancel()
        _PREFETCH_TASK = asyncio.create_task(
            _prefetch_missing_icons(adb, serial, list(package_labels.keys()))
        )

    except Exception as exc:
        dt_ms = (time.perf_counter() - t0) * 1000
        log.error("[IconService:LIST_FAILED] Uygulama listeleme hatası (%.1f ms): %s", dt_ms, exc)

    return package_labels
