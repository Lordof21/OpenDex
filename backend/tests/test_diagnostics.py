"""Tests for system diagnostics and permission self-test endpoints."""
import pytest
from unittest.mock import AsyncMock, MagicMock
from app.api.v1.endpoints.diagnostics import (
    test_video_pipeline as ep_test_video,
    test_input_pipeline as ep_test_input,
    test_audio_pipeline as ep_test_audio,
)


@pytest.fixture
def mock_ctx():
    ctx = MagicMock()
    ctx.serial = "SERIAL_TEST"
    ctx.device_manager.primary_serial = "SERIAL_TEST"
    ctx.adb = MagicMock()
    ctx.adb.run = AsyncMock(return_value="device\n")
    ctx.adb.shell = AsyncMock(return_value="1\n")
    ctx.window_manager.active_window_count = 1
    return ctx


async def test_endpoint_video_pipeline_success(mock_ctx):
    res = await ep_test_video(mock_ctx)
    assert res["status"] == "ok"
    assert "Görüntü hattı" in res["message"]
    assert "latency_ms" in res


async def test_endpoint_video_pipeline_no_device(mock_ctx):
    mock_ctx.serial = None
    mock_ctx.device_manager.primary_serial = None
    res = await ep_test_video(mock_ctx)
    assert res["status"] == "error"
    assert "Bağlı cihaz bulunamadı" in res["message"]


async def test_endpoint_input_pipeline_authorized(mock_ctx):
    mock_ctx.adb.shell = AsyncMock(return_value="1\n")
    res = await ep_test_input(mock_ctx)
    assert res["status"] == "ok"
    assert "onaylı" in res["message"]


async def test_endpoint_input_pipeline_blocked(mock_ctx):
    mock_ctx.adb.shell = AsyncMock(return_value="0\n")
    res = await ep_test_input(mock_ctx)
    assert res["status"] == "warning"
    assert "Giriş simülasyonu kapalı" in res["message"]


async def test_endpoint_audio_pipeline(mock_ctx):
    mock_ctx.adb.shell = AsyncMock(return_value="")
    res = await ep_test_audio(mock_ctx)
    assert res["status"] == "ok"
    assert "48 kHz" in res["message"]
    assert res["audio_engine"] == "48kHz_Stereo_PCM"


