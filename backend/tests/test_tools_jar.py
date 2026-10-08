"""tools_jar: the single owner of opendex-tools.jar on the device (push only when the device copy differs)."""
import asyncio
import hashlib
import pathlib
import re
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.device import tools_jar

BACKEND = pathlib.Path(__file__).resolve().parents[1]
JAR_BYTES = b"PK\x03\x04 fake dex payload"
JAR_MD5 = hashlib.md5(JAR_BYTES).hexdigest()


@pytest.fixture(autouse=True)
def local_jar(tmp_path, monkeypatch):
    jar = tmp_path / "opendex-tools.jar"
    jar.write_bytes(JAR_BYTES)
    monkeypatch.setattr(tools_jar, "LOCAL_TOOLS_JAR", jar)
    monkeypatch.setattr(tools_jar, "_verified", set())
    monkeypatch.setattr(tools_jar, "_locks", {})
    return jar


def make_adb(device_md5: str | None):
    """md5sum reports `device_md5` (None = file missing); every other shell call succeeds silently."""
    adb = MagicMock()
    adb.push = AsyncMock()

    async def shell(cmd, serial=None, timeout_s=None):
        await asyncio.sleep(0)  # a real round-trip suspends — lets concurrent callers interleave
        if cmd.startswith("md5sum"):
            return f"{device_md5}  {tools_jar.DEVICE_TOOLS_JAR}\n" if device_md5 else ""
        return ""

    adb.shell = AsyncMock(side_effect=shell)
    return adb


def md5_calls(adb) -> int:
    return sum(1 for c in adb.shell.await_args_list if c.args[0].startswith("md5sum"))


async def test_current_device_copy_is_not_pushed_again():
    adb = make_adb(JAR_MD5)
    assert await tools_jar.ensure_tools_jar(adb, "S1") is True
    adb.push.assert_not_awaited()


async def test_missing_or_different_copy_is_pushed_once_then_trusted():
    adb = make_adb("0" * 32)
    assert await tools_jar.ensure_tools_jar(adb, "S1") is True
    assert await tools_jar.ensure_tools_jar(adb, "S1") is True
    adb.push.assert_awaited_once_with(str(tools_jar.LOCAL_TOOLS_JAR), tools_jar.DEVICE_TOOLS_JAR, serial="S1")
    assert md5_calls(adb) == 1  # the second call trusts the verification from the first


async def test_force_rechecks_a_verified_device():
    adb = make_adb(JAR_MD5)
    await tools_jar.ensure_tools_jar(adb, "S1")
    await tools_jar.ensure_tools_jar(adb, "S1", force=True)
    assert md5_calls(adb) == 2
    adb.push.assert_not_awaited()


async def test_concurrent_callers_push_only_once():
    """icon prefetch runs 4 fetchers in parallel; they used to push the jar concurrently."""
    adb = make_adb(None)
    results = await asyncio.gather(*(tools_jar.ensure_tools_jar(adb, "S1") for _ in range(4)))
    assert results == [True] * 4
    adb.push.assert_awaited_once()


async def test_unreadable_md5_means_push():
    adb = make_adb(None)
    adb.shell = AsyncMock(side_effect=RuntimeError("adb gone"))
    assert await tools_jar.ensure_tools_jar(adb, "S1") is True
    adb.push.assert_awaited_once()


async def test_failed_push_is_not_cached(caplog):
    adb = make_adb(None)
    adb.push = AsyncMock(side_effect=[RuntimeError("no space"), None])
    assert await tools_jar.ensure_tools_jar(adb, "S1") is False
    assert await tools_jar.ensure_tools_jar(adb, "S1") is True
    assert adb.push.await_count == 2


async def test_missing_local_jar_fails_without_touching_the_device(local_jar):
    local_jar.unlink()
    adb = make_adb(None)
    assert await tools_jar.ensure_tools_jar(adb, "S1") is False
    adb.push.assert_not_awaited()
    adb.shell.assert_not_awaited()


async def test_legacy_icon_jar_is_removed_once_per_device():
    adb = make_adb(JAR_MD5)
    await tools_jar.ensure_tools_jar(adb, "S1")
    await tools_jar.ensure_tools_jar(adb, "S1", force=True)
    rm_calls = [c.args[0] for c in adb.shell.await_args_list if c.args[0].startswith("rm -f")]
    assert rm_calls == ["rm -f /data/local/tmp/opendex-icon-extractor.jar"]


async def test_forget_makes_the_next_call_check_again():
    adb = make_adb(JAR_MD5)
    await tools_jar.ensure_tools_jar(adb, "S1")
    tools_jar.forget("S1")
    await tools_jar.ensure_tools_jar(adb, "S1")
    assert md5_calls(adb) == 2


def test_device_jar_path_has_a_single_owner():
    """Every caller uses tools_jar.DEVICE_TOOLS_JAR — a second literal is how the duplicate jar crept in."""
    offenders = [
        str(p.relative_to(BACKEND))
        for p in (BACKEND / "app").rglob("*.py")
        if p.name != "tools_jar.py"
        and re.search(r"/data/local/tmp/opendex-(tools|icon-extractor)\.jar", p.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_java_tools_never_hand_build_json():
    """CLI output goes through org.json (Json.obj); hand-concatenated JSON broke on quotes/control characters."""
    java_dir = BACKEND / "java" / "src" / "com" / "opendex" / "tools"
    offenders = [
        f"{p.name}:{i}"
        for p in java_dir.glob("*.java")
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
        if re.search(r'"\{\\"', line) or "escapeJson(" in line
    ]
    assert offenders == []
