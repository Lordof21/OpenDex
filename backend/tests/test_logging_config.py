"""Faz 0 — log altyapısı: terminal sessiz, dosya her şeyi tutar, izleme modu akış bazında açar.

Saha sorunu: kritik akış modülleri (handoff/teleport/lifecycle/supervisor…) terminalden ERROR'a kadar
susturulmuştu, dosya logu yoktu — 3a/7/11/21 hataları teşhis edilemiyordu.
"""
from __future__ import annotations

import asyncio
import logging
import logging.handlers

import pytest

from app import logging_config as lc
from app.api.v1.endpoints import diagnostics as diag


@pytest.fixture
def isolated(tmp_path, monkeypatch, capsys):
    """setup() küresel log durumunu değiştirir: her testte kendi dizini + geri yükleme."""
    monkeypatch.setenv("OPENDEX_LOG_DIR", str(tmp_path))
    monkeypatch.delenv("OPENDEX_TRACE", raising=False)
    root = logging.getLogger()
    app_logger = logging.getLogger("app")
    saved = (list(root.handlers), root.level, app_logger.level, lc._log_file,
             lc._console_gate.traced, lc._console_gate.categories, lc._daemon_filter.enabled)
    lc.setup("INFO")
    yield tmp_path
    for h in list(root.handlers):
        if h not in saved[0]:
            root.removeHandler(h)
            h.close()
    root.handlers[:] = saved[0]
    root.setLevel(saved[1])
    app_logger.setLevel(saved[2])
    lc._log_file = saved[3]
    lc._console_gate.traced, lc._console_gate.categories, lc._daemon_filter.enabled = saved[4], saved[5], saved[6]


def _flush():
    for h in logging.getLogger().handlers:
        h.flush()


def _file_text() -> str:
    _flush()
    return lc.current_log_file().read_text(encoding="utf-8")


# ---------------------------------------------------------------- dosya her şeyi tutar
def test_file_keeps_info_from_modules_the_terminal_used_to_hide_but_not_debug_by_default(isolated, capsys):
    log = logging.getLogger("app.windows.handoff_manager")
    log.debug("reclaim aday listesi")
    log.info("reclaim sonucu moved")
    text = _file_text()
    assert "reclaim sonucu moved" in text
    assert "reclaim aday listesi" not in text            # DEBUG yalnız LOG_LEVEL=DEBUG ile dosyaya girer
    out = capsys.readouterr().out
    assert "reclaim" not in out                          # terminal sessiz


def test_log_level_debug_also_writes_debug_lines_to_the_file(isolated):
    lc.setup("DEBUG")
    logging.getLogger("app.windows.handoff_manager").debug("reclaim aday listesi")
    assert "reclaim aday listesi" in _file_text()


# ---------------------------------------------------------------- saklama: eski dosyalar silinir, klasör sınırlı kalır
def _make(directory, name, size, age_days, now):
    path = directory / name
    path.write_bytes(b"x" * size)
    mtime = now - age_days * 86400
    import os
    os.utime(path, (mtime, mtime))
    return path


def test_prune_removes_files_older_than_the_retention_but_never_the_live_log(tmp_path):
    now = 1_800_000_000.0
    live = _make(tmp_path, "opendex-20260101.log", 10, 30, now)          # old, but it is the live file
    old_log = _make(tmp_path, "opendex-20260102.log.3", 10, 8, now)
    old_tel = _make(tmp_path, "telemetry-20260102.jsonl", 10, 9, now)
    fresh = _make(tmp_path, "opendex-20260110.log", 10, 2, now)
    other = _make(tmp_path, "notes.txt", 10, 90, now)                    # not a log: untouched
    removed = lc.prune_logs(tmp_path, keep=[live], now=now)
    assert {p.name for p in removed} == {old_log.name, old_tel.name}
    assert live.exists() and fresh.exists() and other.exists()


def test_prune_trims_the_oldest_files_until_the_folder_fits_the_cap(tmp_path):
    now = 1_800_000_000.0
    a = _make(tmp_path, "opendex-20260101.log", 100, 5, now)
    b = _make(tmp_path, "opendex-20260102.log", 100, 3, now)
    c = _make(tmp_path, "telemetry-20260103.jsonl", 100, 1, now)
    removed = lc.prune_logs(tmp_path, max_total_bytes=150, now=now)
    assert [p.name for p in removed] == [a.name, b.name]                 # oldest first, stops once 100 <= 150
    assert c.exists()


def test_prune_survives_a_missing_directory_and_a_locked_file(tmp_path, monkeypatch):
    assert lc.prune_logs(tmp_path / "yok") == []
    now = 1_800_000_000.0
    locked = _make(tmp_path, "opendex-20260101.log", 10, 30, now)
    monkeypatch.setattr(type(locked), "unlink", lambda self, *a, **k: (_ for _ in ()).throw(PermissionError()))
    assert lc.prune_logs(tmp_path, now=now) == []                        # nothing raised, nothing claimed removed


def test_daily_named_rotating_file_handler_with_the_planned_limits(isolated):
    handlers = [h for h in logging.getLogger().handlers if isinstance(h, logging.handlers.RotatingFileHandler)]
    assert len(handlers) == 1
    h = handlers[0]
    assert h.maxBytes == 10 * 1024 * 1024 and h.backupCount == 5
    assert lc.current_log_file().parent == isolated
    assert lc.current_log_file().name.startswith("opendex-") and lc.current_log_file().suffix == ".log"


def test_unwritable_log_dir_does_not_stop_startup(monkeypatch, tmp_path):
    blocker = tmp_path / "file-not-dir"
    blocker.write_text("x")
    monkeypatch.setenv("OPENDEX_LOG_DIR", str(blocker / "sub"))   # dizin oluşturulamaz
    root = logging.getLogger()
    saved = (list(root.handlers), root.level, logging.getLogger("app").level, lc._log_file)
    try:
        lc.setup("INFO")                                          # patlamamalı
        assert lc.current_log_file() is None
        assert any(isinstance(h, logging.StreamHandler) for h in root.handlers)
    finally:
        for h in list(root.handlers):
            if h not in saved[0]:
                root.removeHandler(h)
        root.handlers[:] = saved[0]
        root.setLevel(saved[1])
        logging.getLogger("app").setLevel(saved[2])
        lc._log_file = saved[3]


# ---------------------------------------------------------------- terminal kapısı
def test_console_always_shows_warning_and_above(isolated, capsys):
    logging.getLogger("app.windows.handoff_manager").warning("uyarı görünür")
    logging.getLogger("app.device.adb").error("hata görünür")
    out = capsys.readouterr().out
    assert "uyarı görünür" in out and "hata görünür" in out


def test_console_shows_info_only_for_the_important_event_sources(isolated, capsys):
    logging.getLogger("app.device.display_power").info("güç önemli")
    logging.getLogger("app.device.connection_supervisor").info("bağlantı önemli")
    logging.getLogger("app.windows.window_manager").info("pencere ayrıntısı")
    out = capsys.readouterr().out
    assert "güç önemli" in out and "bağlantı önemli" in out
    assert "pencere ayrıntısı" not in out
    assert "pencere ayrıntısı" in _file_text()           # ama dosyada var


def test_media_and_daemon_debug_are_quiet_on_the_terminal_by_default(isolated, capsys):
    capsys.readouterr()                                   # başlangıçtaki "Log: dosya=…" satırını at
    logging.getLogger("app.device.device_daemon_client").debug("medya güncellemesi")
    logging.getLogger("app.api.websockets").debug("medya dispatch")
    assert capsys.readouterr().out == ""
    text = _file_text()
    assert "medya güncellemesi" not in text and "medya dispatch" not in text     # DEBUG: dosyaya da yalnızca LOG_LEVEL=DEBUG / trace ile


def test_trace_category_opens_only_that_flow_on_the_terminal(isolated, capsys):
    applied, unknown = lc.set_trace(["handoff", "bogus"])
    assert applied == ["handoff"] and unknown == ["bogus"]
    logging.getLogger("app.windows.handoff_manager").debug("handoff detay")
    logging.getLogger("app.windows.task_teleporter").info("teleport detay")
    out = capsys.readouterr().out
    assert "handoff detay" in out and "teleport detay" not in out
    lc.set_trace([])
    logging.getLogger("app.windows.handoff_manager").info("kapandı")
    assert "kapandı" not in capsys.readouterr().out


def test_applock_trace_reaches_the_lifecycle_coordinator_not_window_manager(isolated, capsys):
    """Kilit bekleyicisi artık kendi logger adında (eskiden window_manager adını ödünç alıyordu)."""
    lc.set_trace(["applock"])
    logging.getLogger("app.windows.window_lifecycle_coordinator").info("kilit yoklaması")
    logging.getLogger("app.windows.window_manager").info("yeniden boyutlama gürültüsü")
    out = capsys.readouterr().out
    assert "kilit yoklaması" in out and "yeniden boyutlama gürültüsü" not in out


def test_env_var_enables_trace_at_startup(isolated, monkeypatch):
    monkeypatch.setenv("OPENDEX_TRACE", "power, handoff ,nonsense")
    lc.setup("INFO")
    assert lc.get_trace() == ["power", "handoff"]


def test_debug_log_level_opens_everything(isolated, capsys):
    lc.setup("DEBUG")
    logging.getLogger("app.windows.window_manager").debug("her şey görünür")
    assert "her şey görünür" in capsys.readouterr().out


def test_third_party_noise_stays_out_of_the_file(isolated):
    logging.getLogger("asyncio").warning("üçüncü taraf gürültüsü")
    logging.getLogger("aiosqlite").info("sql gürültüsü")
    assert "gürültüsü" not in _file_text()


# ---------------------------------------------------------------- daemon DIAG gürültü filtresi
def test_daemon_diag_noise_is_dropped_but_media_lines_and_warnings_survive(isolated):
    d = logging.getLogger("app.device.device_daemon_client")
    d.debug("[OpenDexDaemon:DIAG] tik")
    d.info("[OpenDexDaemon:SEND_RPC id=1] x")
    d.info("[MediaUpdate] şarkı değişti")
    d.warning("[OpenDexDaemon:DIAG] uyarı yine de görünür")
    text = _file_text()
    assert "tik" not in text and "SEND_RPC" not in text
    assert "şarkı değişti" in text and "uyarı yine de görünür" in text


def test_daemon_raw_trace_lifts_the_noise_filter(isolated):
    lc.set_trace(["daemon_raw"])
    logging.getLogger("app.device.device_daemon_client").debug("[OpenDexDaemon:DIAG] ham")
    assert "ham" in _file_text()


# ---------------------------------------------------------------- op_id
def test_op_scope_stamps_every_line_including_spawned_tasks(isolated):
    async def child():
        logging.getLogger("app.windows.handoff_manager").info("görev içi satır")

    async def main():
        with lc.op_scope("abc123"):
            logging.getLogger("app.windows.handoff_manager").info("istek içi satır")
            await asyncio.create_task(child())
        logging.getLogger("app.windows.handoff_manager").info("kapsam dışı satır")

    asyncio.run(main())
    lines = _file_text().splitlines()
    assert "[op:abc123]" in next(ln for ln in lines if "istek içi satır" in ln)
    assert "[op:abc123]" in next(ln for ln in lines if "görev içi satır" in ln)
    assert "[op:" not in next(ln for ln in lines if "kapsam dışı satır" in ln)


def test_op_id_from_outside_is_sanitized_and_bounded():
    assert lc.sanitize_op_id("a b\n[x]") == "abx"
    assert lc.sanitize_op_id("x" * 40) == "x" * 16
    assert lc.sanitize_op_id("   ") is None and lc.sanitize_op_id(None) is None
    assert len(lc.new_op_id()) == 6


@pytest.mark.asyncio
async def test_middleware_uses_the_header_or_generates_one_per_request():
    seen: list[str] = []

    async def inner(scope, receive, send):
        seen.append(lc.current_op_id())

    mw = lc.OpIdMiddleware(inner)
    await mw({"type": "http", "headers": [(b"x-op-id", b"fe-42")]}, None, None)
    await mw({"type": "http", "headers": []}, None, None)
    await mw({"type": "websocket", "headers": [(b"x-op-id", b"ignored")]}, None, None)
    assert seen[0] == "fe-42"
    assert len(seen[1]) == 6 and seen[1] != "-"
    assert seen[2] == "-"                                # WS kapsamı değiştirilmez
    assert lc.current_op_id() == "-"                     # istek bitince sızıntı yok


# ---------------------------------------------------------------- tanılama uç noktaları
@pytest.mark.asyncio
async def test_client_log_lands_in_the_backend_file_with_the_same_op_id(isolated):
    body = diag.ClientLogBatch(entries=[
        diag.ClientLogEntry(cat="applock", event="retry_clicked", op_id="fe-42", data={"windowId": "w1"}),
        diag.ClientLogEntry(cat="handoff", event="hata\nSAHTE SATIR [op:evil]", level="error"),
    ])
    res = await diag.post_client_log(body)
    assert res == {"ok": True, "n": 2}
    lines = _file_text().splitlines()
    first = next(ln for ln in lines if "retry_clicked" in ln)
    assert "[FE:applock]" in first and "[op:fe-42]" in first and '"windowId": "w1"' in first
    injected = [ln for ln in lines if "SAHTE SATIR" in ln]
    assert len(injected) == 1 and "ERROR" in injected[0]     # yeni satır enjeksiyonu yok (tek satır)


@pytest.mark.asyncio
async def test_log_level_endpoints_round_trip(isolated):
    res = await diag.set_log_level(diag.LogLevelRequest(trace=["power", "nope"]))
    assert res == {"trace": ["power"], "unknown": ["nope"]}
    info = await diag.get_log_level()
    assert info["trace"] == ["power"] and "handoff" in info["available"]
    assert info["log_file"] == str(lc.current_log_file())


@pytest.mark.asyncio
async def test_log_tail_returns_the_latest_lines(isolated):
    for i in range(30):
        logging.getLogger("app.windows.handoff_manager").info("satır-%d", i)
    res = await diag.get_log_tail(lines=5)
    assert res["file"] == lc.current_log_file().name
    assert len(res["lines"]) == 5 and "satır-29" in res["lines"][-1]


def test_every_module_that_logs_belongs_to_a_trace_category():
    """Log yazan her modül bir izleme kategorisinde olmalı (yoksa yalnız 'all' ile görünür)."""
    import pathlib

    app_dir = pathlib.Path(lc.__file__).parent
    known = [p for prefixes in lc.TRACE_CATEGORIES.values() for p in prefixes if p != "app"] + list(lc._ALWAYS_INFO)
    names = ["app." + ".".join(p.relative_to(app_dir).with_suffix("").parts) for p in app_dir.rglob("*.py")
             if "getLogger(__name__)" in p.read_text(encoding="utf-8")]
    assert [n for n in names if not lc._matches(n, known)] == []
