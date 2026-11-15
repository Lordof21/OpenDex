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


# ── The icon is on this PC's disk: served from memory, with an ETag, and WITHOUT a phone ─────────────────────────────────────────

PNG = b"\x89PNG\r\n\x1a\n" + b"\x01" * 150


def test_cached_icon_reads_the_file_once_and_revalidates_by_size_and_time(tmp_path):
    (tmp_path / "com.a.png").write_bytes(PNG)
    with patch.object(icon_service, "ICON_CACHE_DIR", tmp_path), patch.object(icon_service, "_MEM", icon_service.OrderedDict()):
        first = icon_service.cached_icon("com.a")
        assert first is not None and first[0] == PNG
        with patch.object(pathlib_path_type(), "read_bytes", side_effect=AssertionError("read again")):
            again = icon_service.cached_icon("com.a")      # from memory: the file is not opened again
        assert again == first
        # a refreshed icon (new bytes, new size) is NOT served from memory
        (tmp_path / "com.a.png").write_bytes(PNG + b"\x02" * 40)
        fresh = icon_service.cached_icon("com.a")
        assert fresh[0] == PNG + b"\x02" * 40 and fresh[1] != first[1]


def test_cached_icon_unknown_or_broken_files_are_not_icons(tmp_path):
    (tmp_path / "com.broken.png").write_bytes(b"not a png at all" * 20)
    with patch.object(icon_service, "ICON_CACHE_DIR", tmp_path), patch.object(icon_service, "_MEM", icon_service.OrderedDict()):
        assert icon_service.cached_icon("com.nope") is None
        assert icon_service.cached_icon("com.broken") is None
        assert not (tmp_path / "com.broken.png").exists()      # a broken file is dropped, the icon is fetched again


def test_memory_is_bounded(tmp_path):
    with patch.object(icon_service, "ICON_CACHE_DIR", tmp_path), patch.object(icon_service, "_MEM", icon_service.OrderedDict()), \
         patch.object(icon_service, "_MEM_MAX", 3):
        for i in range(6):
            (tmp_path / f"com.p{i}.png").write_bytes(PNG + bytes([i]) * 10)
            icon_service.cached_icon(f"com.p{i}")
        assert len(icon_service._MEM) == 3
        assert list(icon_service._MEM) == ["com.p3", "com.p4", "com.p5"]


async def test_endpoint_serves_a_cached_icon_without_a_phone_and_answers_304(tmp_path):
    from types import SimpleNamespace

    from app.api.v1.endpoints import apps as ep

    (tmp_path / "com.a.png").write_bytes(PNG)
    ctx = SimpleNamespace(ensure_device=AsyncMock(return_value=None))      # no phone bound
    request = SimpleNamespace(headers={})
    with patch.object(icon_service, "ICON_CACHE_DIR", tmp_path), patch.object(icon_service, "_MEM", icon_service.OrderedDict()):
        response = await ep.get_app_icon(request, ctx, package="com.a", force=False)
        assert response.status_code == 200 and response.body == PNG
        assert response.headers["cache-control"] == ep.ICON_CACHE_CONTROL
        ctx.ensure_device.assert_not_awaited()

        revalidate = await ep.get_app_icon(SimpleNamespace(headers={"if-none-match": response.headers["etag"]}), ctx, package="com.a", force=False)
        assert revalidate.status_code == 304


async def test_endpoint_needs_the_phone_only_for_an_icon_never_seen(tmp_path):
    from types import SimpleNamespace

    from fastapi import HTTPException

    from app.api.v1.endpoints import apps as ep

    ctx = SimpleNamespace(ensure_device=AsyncMock(return_value=None))
    with patch.object(icon_service, "ICON_CACHE_DIR", tmp_path), patch.object(icon_service, "_MEM", icon_service.OrderedDict()):
        with pytest.raises(HTTPException) as err:
            await ep.get_app_icon(SimpleNamespace(headers={}), ctx, package="com.unseen", force=False)
        assert err.value.status_code == 409


def pathlib_path_type():
    import pathlib

    return type(pathlib.Path())
