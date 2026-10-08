"""Tests for On-Device Java App-Icon Service."""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.apps import icon_service
from app.device import tools_jar


@pytest.fixture
def mock_adb():
    adb = MagicMock()
    adb.push = AsyncMock()
    adb.exec_out = AsyncMock()
    adb.shell = AsyncMock()

    async def _run_java_tool(jar_device_path, class_name, *args, serial=None, timeout_s=5.0, capture_bytes=False):
        cmd = f"CLASSPATH={jar_device_path} app_process / {class_name} " + " ".join(str(a) for a in args)
        if capture_bytes:
            return await adb.exec_out("sh", "-c", cmd, serial=serial, timeout_s=timeout_s)
        return await adb.shell(cmd, serial=serial, timeout_s=timeout_s)

    adb.run_java_tool = AsyncMock(side_effect=_run_java_tool)
    return adb


@pytest.mark.asyncio
async def test_get_app_icon_bytes_from_device(mock_adb, tmp_path):
    fake_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 120
    mock_adb.exec_out.return_value = fake_png

    with patch.object(icon_service, "ICON_CACHE_DIR", tmp_path), \
         patch.object(tools_jar, "_verified", set()):
        
        result = await icon_service.get_app_icon_bytes(mock_adb, "serial123", "com.android.chrome")
        assert result == fake_png
        assert (tmp_path / "com.android.chrome.png").is_file()

        # Second call should read from disk cache without invoking adb.exec_out again
        mock_adb.exec_out.reset_mock()
        cached_result = await icon_service.get_app_icon_bytes(mock_adb, "serial123", "com.android.chrome")
        assert cached_result == fake_png
        mock_adb.exec_out.assert_not_called()


@pytest.mark.asyncio
async def test_batch_extract_icons(mock_adb, tmp_path):
    json_output = (
        json.dumps({"package": "com.android.chrome", "label": "Chrome"}) + "\n" +
        json.dumps({"package": "com.android.settings", "label": "Ayarlar"}) + "\n"
    )
    mock_adb.shell.return_value = json_output

    with patch.object(icon_service, "ICON_CACHE_DIR", tmp_path), \
         patch.object(tools_jar, "_verified", set()):

        labels = await icon_service.batch_extract_icons(mock_adb, "serial123")
        assert labels == {
            "com.android.chrome": "Chrome",
            "com.android.settings": "Ayarlar",
        }
