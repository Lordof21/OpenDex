"""Görev-çözümleyici merdiveni: "PC'ye geri al".

Senaryo (kullanıcının saha raporu): DeX'te Galeri açık → "Telefona aktar" → telefonda Son
Kullanılanlar'dan sil → Galeri'yi telefonda yeniden aç → DeX'te "PC'ye geri al".
Beklenen: telefondaki CANLI görev varsa o getirilir; yoksa / taşınamıyorsa uygulama sanal
ekranda SIFIRDAN başlatılır. Eskiden `move_task_to_display` istisnası `reclaim`'i yarıda
kesiyordu: "yeniden başlat" dalı hiç çalışmıyor, `handoff_to_phone` True kalıyor, kullanıcı
"çalışmadı" görüyordu.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.config import Settings
from app.events import EventBus
from app.schemas import WindowState
from app.windows import handoff_manager as hm_module
from app.windows.handoff_manager import HandoffManager

PKG = "com.google.android.apps.photos"


class _FakeAdb:
    def __init__(self) -> None:
        self.shell_calls: list[str] = []

    async def shell(self, cmd, *, serial=None, timeout_s=3.0):
        self.shell_calls.append(cmd)
        return ""


def _build(monkeypatch, *, find_returns, move_raises: bool):
    adb = _FakeAdb()
    events = EventBus()
    seen: dict[str, dict] = {}

    async def _capture_resolved(**kw):
        seen["resolved"] = kw

    async def _capture_result(**kw):
        seen["result"] = kw

    events.on("app_handoff_resolved", _capture_resolved)
    events.on("app_reclaim_result", _capture_result)

    state = WindowState(window_id="w1", package=PKG, width=800, height=600, z_index=1)
    state.handoff_to_phone = True
    session = SimpleNamespace(
        state=state,
        server=SimpleNamespace(is_alive=True, display_id="7"),
        dpi=420,
        landing=None,
    )
    moves: list[tuple] = []

    async def _fake_move(_adb, task_id, display, **_kw):
        moves.append((str(task_id), str(display)))
        if move_raises:
            raise RuntimeError("Task not found: bayat kayıt")

    async def _fake_find(_adb, pkg, display_id=None, serial=None):
        return find_returns

    async def _fake_dpi(_adb, _serial):
        return 0  # Stealth DPI dalını devre dışı bırak: bu test yalnızca merdiveni sınar

    from app.device import deep_navigator
    from app.device import android_shell

    monkeypatch.setattr(hm_module, "move_task_to_display", _fake_move)
    monkeypatch.setattr(deep_navigator, "find_task_id_for_package", _fake_find)
    monkeypatch.setattr(android_shell, "phone_density", _fake_dpi)

    async def _unfreeze(_wid):  # bu senaryolarda sunucu ayakta: çağrılmamalı
        raise AssertionError("unfreeze çağrılmamalı")

    mgr = HandoffManager(
        adb, Settings(), events, {"w1": session},
        serial_getter=lambda: "SER123",
        unfreeze_locked=_unfreeze,
    )
    return mgr, session, adb, moves, seen


@pytest.mark.asyncio
async def test_live_task_is_moved_and_reported_as_moved(monkeypatch):
    mgr, session, adb, moves, seen = _build(monkeypatch, find_returns="42", move_raises=False)

    assert await mgr.reclaim("w1") is True
    await asyncio.sleep(0)  # EventBus async dinleyicileri create_task ile çalışır

    assert moves == [("42", "7")]
    assert session.state.handoff_to_phone is False
    assert seen["result"]["outcome"] == "moved"
    assert "resolved" in seen


@pytest.mark.asyncio
async def test_stale_task_move_failure_falls_back_to_cold_relaunch(monkeypatch):
    """REGRESYON (asıl hata): taşıma istisnası reclaim'i KESMEZ; sanal ekranda yeniden başlatılır."""
    mgr, session, adb, moves, seen = _build(monkeypatch, find_returns="42", move_raises=True)

    assert await mgr.reclaim("w1") is True
    await asyncio.sleep(0)  # EventBus async dinleyicileri create_task ile çalışır   # eskiden istisna yukarı çıkardı

    assert moves == [("42", "7")]
    starts = [c for c in adb.shell_calls if c.startswith("am start --display 7") and PKG in c]
    assert starts, f"yeniden başlatma (am start --display 7 … {PKG}) çağrılmalı: {adb.shell_calls}"
    assert session.state.handoff_to_phone is False
    assert seen["result"]["outcome"] == "relaunched"


@pytest.mark.asyncio
async def test_no_task_at_all_is_relaunched_on_the_virtual_display(monkeypatch):
    """Kullanıcı Son Kullanılanlar'dan sildi ve hiç açmadı: görev yok → sıfırdan başlat."""
    mgr, session, adb, moves, seen = _build(monkeypatch, find_returns=None, move_raises=False)

    assert await mgr.reclaim("w1") is True
    await asyncio.sleep(0)  # EventBus async dinleyicileri create_task ile çalışır

    assert moves == []                                   # taşınacak bir şey yok
    assert any(c.startswith("am start --display 7") and PKG in c for c in adb.shell_calls)
    assert session.state.handoff_to_phone is False
    assert seen["result"]["outcome"] == "relaunched"
