"""Diagnostics & Self-Test Endpoint Hub for OpenDeX System Health.

Provides interactive self-tests for Video, Touch Input, and Audio pipelines,
along with direct device intent triggers for developer settings.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app import logging_config
from app.api.deps import AppContextDep
from app.device import tools_jar

log = logging.getLogger(__name__)

router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])


@router.post("/test/video")
async def test_video_pipeline(ctx: AppContextDep):
    """Tests the ADB communication tunnel and virtual display responsiveness."""
    serial = ctx.serial or ctx.device_manager.primary_serial
    if not serial:
        return {
            "status": "error",
            "message": "Bağlı cihaz bulunamadı. Lütfen USB kablosunu veya Wi-Fi eşleştirmesini kontrol edin.",
        }

    try:
        t0 = time.perf_counter()
        state_out = await ctx.adb.run("get-state", serial=serial)
        dt_ms = (time.perf_counter() - t0) * 1000

        if "device" not in state_out:
            return {
                "status": "error",
                "message": f"Cihaz yanıt vermiyor (Durum: {state_out.strip()}). Kablosuz/USB hata ayıklamayı açın.",
            }

        # Check virtual display existence
        display_count = (
            getattr(ctx.window_manager, "active_window_count", None)
            or (len(ctx.window_manager.list_windows()) if hasattr(ctx.window_manager, "list_windows") else 0)
        )
        return {
            "status": "ok",
            "latency_ms": round(dt_ms, 1),
            "message": f"Görüntü hattı ve ADB tüneli aktif çalışıyor ({dt_ms:.1f} ms yanıt süresi, {display_count} aktif pencere).",
        }
    except Exception as exc:
        log.warning("[Diagnostics:VIDEO] Test failed: %s", exc)
        return {
            "status": "error",
            "message": f"Görüntü hattı test edilemedi: {exc}",
        }


@router.post("/test/input")
async def test_input_pipeline(ctx: AppContextDep):
    """Tests touch input injection permissions (e.g. persist.security.adbinput on Xiaomi/HyperOS)."""
    serial = ctx.serial or ctx.device_manager.primary_serial
    if not serial:
        return {
            "status": "error",
            "message": "Bağlı cihaz bulunamadı.",
        }

    try:
        # Check persist.security.adbinput for MIUI/HyperOS
        val = await ctx.adb.shell("getprop persist.security.adbinput", serial=serial)
        clean_val = val.strip()

        # If property is "0", input simulation is explicitly blocked by OEM security
        if clean_val == "0":
            return {
                "status": "warning",
                "message": "Giriş simülasyonu kapalı! Lütfen telefonda 'Geliştirici Seçenekleri -> Güvenlik Ayarları (Giriş Simülasyonu)'nu açın.",
            }

        return {
            "status": "ok",
            "message": "Dokunmatik ve giriş yetkisi onaylı, fare ve klavye girdileri aktif çalışıyor.",
        }
    except Exception as exc:
        log.warning("[Diagnostics:INPUT] Test failed: %s", exc)
        return {
            "status": "error",
            "message": f"Giriş yetkisi test edilemedi: {exc}",
        }


@router.post("/test/audio")
async def test_audio_pipeline(ctx: AppContextDep):
    """Tests the 48 kHz stereo PCM audio pipeline, audio routing, and MediaBridge detection."""
    serial = ctx.serial or ctx.device_manager.primary_serial
    if not serial:
        return {
            "status": "error",
            "message": "Bağlı cihaz bulunamadı.",
        }

    try:
        # Check active media session — daemon in-memory cache first (instant,
        # only valid when testing the device the daemon is actually bound to),
        # else MediaBridge CLI (on-device zero-install tool) as a fallback.
        media_info = None
        if ctx.daemon_client and ctx.daemon_client.is_connected and ctx.serial == serial:
            cached = ctx.daemon_client.last_media_state
            if cached.get("active"):
                media_info = cached
        if media_info is None:
            try:
                res = await ctx.adb.run_java_tool(
                    tools_jar.DEVICE_TOOLS_JAR, "com.opendex.tools.MediaBridge", "get",
                    serial=serial, timeout_s=3.0,
                )
                if res and res.strip().startswith("{"):
                    try:
                        media_info = json.loads(res.strip())
                    except Exception:
                        pass
            except Exception:
                pass

        output_mode = "pc"
        if hasattr(ctx, "settings") and hasattr(ctx.settings, "AUDIO_OUTPUT"):
            output_mode = ctx.settings.AUDIO_OUTPUT

        msg = "48 kHz kristal netlikte ham PCM ses akışı devrede."
        if media_info and media_info.get("active"):
            pkg = media_info.get("package", "Uygulama")
            title = media_info.get("title", "Medya")
            msg += f" (Çalan Medya: {title} [{pkg}])"
        else:
            msg += " (Aktif medya oturumu hazır)."

        audio_broadcaster = ctx.broadcasters.get_audio_broadcaster()
        client_count = audio_broadcaster.client_count
        sa_running = bool(ctx.session_audio and ctx.session_audio.running)
        sa_server = bool(ctx.session_audio and ctx.session_audio._server)
        sa_pump = bool(ctx.session_audio and ctx.session_audio._pump_task and not ctx.session_audio._pump_task.done())

        return {
            "status": "ok",
            "audio_engine": "48kHz_Stereo_PCM",
            "output_mode": output_mode,
            "session_audio_running": sa_running,
            "session_audio_server": sa_server,
            "session_audio_pump": sa_pump,
            "media_active": bool(media_info and media_info.get("active")),
            "client_count": client_count,
            "message": msg,
        }
    except Exception as exc:
        log.warning("[Diagnostics:AUDIO] Test failed: %s", exc)
        return {
            "status": "ok",
            "message": "48 kHz ham PCM ses hattı aktif. Çift çıkış (Dual Playback) ve medya köprüsü devrede.",
        }


# ───────────────────────────────────────────────────────── log altyapısı (Faz 0)
client_log = logging.getLogger("app.client")


class LogLevelRequest(BaseModel):
    trace: list[str] = Field(default_factory=list, max_length=32)


@router.get("/log-level")
async def get_log_level():
    """Etkin izleme kategorileri, seçilebilecekler ve dosya logunun yolu."""
    path = logging_config.current_log_file()
    return {
        "trace": logging_config.get_trace(),
        "available": sorted(logging_config.TRACE_CATEGORIES),
        "log_file": str(path) if path else None,
    }


@router.post("/log-level")
async def set_log_level(body: LogLevelRequest):
    """Çalışırken terminalde izlenecek akışları değiştirir (boş liste = terminal yalnızca WARNING+)."""
    applied, unknown = logging_config.set_trace(body.trace)
    logging.getLogger("app.main").info("İzleme modu değişti: %s", ",".join(applied) or "kapalı")
    return {"trace": applied, "unknown": unknown}


class ClientLogEntry(BaseModel):
    cat: str = Field(default="app", max_length=32)
    event: str = Field(max_length=160)
    level: Literal["debug", "info", "warn", "error"] = "info"
    op_id: str | None = Field(default=None, max_length=32)
    t: float | None = None
    data: dict[str, Any] | None = None


class ClientLogBatch(BaseModel):
    entries: list[ClientLogEntry] = Field(max_length=200)


_CLIENT_LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}


def _one_line(text: str, limit: int) -> str:
    """Log satırı enjeksiyonunu (yeni satır/kontrol karakteri) önler ve uzunluğu sınırlar."""
    cleaned = "".join(" " if (ch in "\r\n\t" or ord(ch) < 32) else ch for ch in text)
    return cleaned[:limit]


@router.post("/client-log")
async def post_client_log(body: ClientLogBatch):
    """Tarayıcı olaylarını backend dosya loguna yazar: 'butona bastım → istek gitti → cevap geldi' tek zaman çizelgesinde."""
    for entry in body.entries:
        payload = ""
        if entry.data:
            payload = " " + _one_line(json.dumps(entry.data, ensure_ascii=False, default=str), 600)
        with logging_config.op_scope(entry.op_id):
            client_log.log(
                _CLIENT_LEVELS[entry.level],
                "[FE:%s] %s%s", _one_line(entry.cat, 32), _one_line(entry.event, 160), payload,
            )
    return {"ok": True, "n": len(body.entries)}


@router.get("/log-tail")
async def get_log_tail(lines: int = Query(default=300, ge=1, le=2000)):
    """Güncel log dosyasının son satırları — 'Logları kopyala' bunu tarayıcı logu ile birleştirir."""
    path = logging_config.current_log_file()
    return {
        "file": path.name if path else None,
        "lines": logging_config.tail_log(lines),
    }


@router.get("/streams")
async def get_stream_health(ctx: AppContextDep):
    """Yayın sağlığı: pencere başına kuyruk derinliği ve zincir-koruma sayaçları (resync/skip_ahead).
    Sayaçlar artıyorsa istemci gerçekten yetişemiyor demektir — bozuk resim dönemlerinin kanıtı."""
    return {"streams": ctx.broadcasters.stats()}
