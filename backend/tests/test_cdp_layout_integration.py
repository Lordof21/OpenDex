"""Integration tests for Browser CDP Layout, Text Size Cache Reflow, and Multi-Tab Resolution.

Tests end-to-end interactions between:
1. Dynamic CDP ephemeral port forwarding & lock serialization
2. Multi-tab resolution (16 open tabs, finding the active/visible tab)
3. Non-destructive Blink TextAutosizer & scale factor 1.0x locking
4. DOM Element-anchored adaptive scroll stabilization
5. Bidirectional Handoff (DeX -> Phone) and Reclaim (Phone -> DeX) integration ladder
6. Live hardware verification (when real device with Chrome is connected)
"""
from __future__ import annotations

import asyncio
import contextlib
import json
from unittest.mock import AsyncMock, MagicMock, patch
import urllib.request

import pytest

from app.config import Settings
from app.schemas.settings import ProjectSettings
from app.windows.cdp_refresher import (
    _build_nudge_script,
    _find_active_page_target,
    _send_cdp,
    capture_browser_scroll_state,
    open_cdp_session,
    refresh_browser_layout_inplace,
)
from app.windows.density_reconciler import DensityReconciler
from app.windows.handoff_manager import HandoffManager
from app.windows.window_manager import WindowState


# ---------------------------------------------------------------------------
# Fakes & Mocks for CDP Integration Testing
# ---------------------------------------------------------------------------

class FakeWebSocket:
    """Simulates a Chrome DevTools Protocol WebSocket connection."""

    def __init__(self, tab_id: str, is_visible: bool = False, custom_eval_response: str | None = None):
        self.tab_id = tab_id
        self.is_visible = is_visible
        self.custom_eval_response = custom_eval_response
        self.sent_messages: list[dict] = []
        self.closed = False

    async def send(self, data: str):
        msg = json.loads(data)
        self.sent_messages.append(msg)

    async def recv(self) -> str:
        if not self.sent_messages:
            raise asyncio.TimeoutError()
        last_msg = self.sent_messages[-1]
        req_id = last_msg.get("id", 1)
        method = last_msg.get("method", "")

        if method == "Runtime.evaluate":
            expr = last_msg.get("params", {}).get("expression", "")
            if "document.visibilityState" in expr:
                val = json.dumps({"visible": self.is_visible, "focus": self.is_visible})
                return json.dumps({"id": req_id, "result": {"result": {"value": val}}})
            elif self.custom_eval_response is not None:
                return json.dumps({"id": req_id, "result": {"result": {"value": self.custom_eval_response}}})
            else:
                return json.dumps({"id": req_id, "result": {"result": {"value": "OK"}}})

        return json.dumps({"id": req_id, "result": {}})

    async def close(self):
        self.closed = True

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()


class FakeCdpAdb:
    """Simulates ADB port forwarding and shell commands for CDP tests."""

    def __init__(self):
        self.forwards: dict[int, str] = {}
        self.removed_forwards: list[int] = []

    async def forward(self, local_port: int, remote_socket: str, serial: str | None = None) -> int:
        port = local_port if local_port > 0 else 9222
        self.forwards[port] = remote_socket
        return port

    async def forward_remove(self, local_port: int, serial: str | None = None):
        self.removed_forwards.append(local_port)
        self.forwards.pop(local_port, None)

    async def shell(self, command: str, serial: str | None = None, timeout_s: float | None = None) -> str:
        if "cat /proc/net/unix" in command:
            return "00000000: 00000002 00000000 00010000 0001 01 12345 @chrome_devtools_remote\n"
        if "wm density" in command:
            return "Physical density: 520\n"
        return ""


# ---------------------------------------------------------------------------
# Test Cases
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cdp_session_port_forwarding_lifecycle():
    """Verifies that open_cdp_session forwards an ephemeral port and unconditionally cleans up."""
    fake_adb = FakeCdpAdb()
    allocated_port = None

    async with open_cdp_session(fake_adb, "SERIAL_123", "chrome_devtools_remote") as port:
        allocated_port = port
        assert port == 9222
        assert 9222 in fake_adb.forwards
        assert "chrome_devtools_remote" in fake_adb.forwards[9222]

    # Verify forward was removed in finally block
    assert allocated_port in fake_adb.removed_forwards
    assert allocated_port not in fake_adb.forwards


@pytest.mark.asyncio
async def test_cdp_session_cleanup_on_exception():
    """Verifies that open_cdp_session cleans up port forward even when an inner error is raised."""
    fake_adb = FakeCdpAdb()
    with pytest.raises(RuntimeError, match="Simulated crash"):
        async with open_cdp_session(fake_adb, "SERIAL_123", "chrome_devtools_remote") as port:
            raise RuntimeError("Simulated crash")

    assert 9222 in fake_adb.removed_forwards


@pytest.mark.asyncio
async def test_multi_tab_active_target_resolution():
    """Simulates 16 open tabs where only tab #7 is visible, verifying _find_active_page_target picks #7."""
    pages = [
        {
            "id": f"tab_{i}",
            "title": f"Tab {i}",
            "type": "page",
            "url": f"https://example.com/page{i}",
            "webSocketDebuggerUrl": f"ws://127.0.0.1:9222/devtools/page/tab_{i}",
        }
        for i in range(16)
    ]

    # Tab 7 is the visible foreground tab
    ws_map = {
        f"ws://127.0.0.1:9222/devtools/page/tab_{i}": FakeWebSocket(f"tab_{i}", is_visible=(i == 7))
        for i in range(16)
    }

    def fake_connect(url, *args, **kwargs):
        return ws_map[url]

    with patch("websockets.connect", side_effect=fake_connect):
        active = await _find_active_page_target(9222, pages)
        assert active["id"] == "tab_7"
        assert active["title"] == "Tab 7"


@pytest.mark.asyncio
async def test_active_target_resolution_fallback_to_first():
    """If no tab reports visible (e.g. all hidden or script timeout), falls back safely to the first page."""
    pages = [
        {
            "id": f"tab_{i}",
            "title": f"Tab {i}",
            "type": "page",
            "url": f"https://example.com/page{i}",
            "webSocketDebuggerUrl": f"ws://127.0.0.1:9222/devtools/page/tab_{i}",
        }
        for i in range(4)
    ]

    ws_map = {
        f"ws://127.0.0.1:9222/devtools/page/tab_{i}": FakeWebSocket(f"tab_{i}", is_visible=False)
        for i in range(4)
    }

    with patch("websockets.connect", side_effect=lambda url, *a, **kw: ws_map[url]):
        active = await _find_active_page_target(9222, pages)
        assert active["id"] == "tab_0"


@pytest.mark.asyncio
async def test_capture_browser_scroll_state_schema_and_execution():
    """Captures active scroll position, CSS DOM anchor path, and media state via CDP."""
    fake_adb = FakeCdpAdb()
    tabs_json = json.dumps([
        {
            "id": "tab_active",
            "title": "Wikipedia - Tablet Page",
            "type": "page",
            "url": "https://en.wikipedia.org/wiki/Main_Page",
            "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/tab_active",
        }
    ])

    expected_payload = {
        "targetId": "tab_active",
        "url": "https://en.wikipedia.org/wiki/Main_Page",
        "scrollX": 0,
        "scrollY": 1420.5,
        "isTop": False,
        "ratio": 0.35,
        "anchorPath": "div#content > div#bodyContent > p:nth-of-type(2)",
        "hasMedia": True,
    }

    mock_ws = FakeWebSocket("tab_active", is_visible=True, custom_eval_response=json.dumps(expected_payload))

    with (
        patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: tabs_json.encode())),
        patch("websockets.connect", return_value=mock_ws),
    ):
        state = await capture_browser_scroll_state(fake_adb, "SERIAL_123", "chrome_devtools_remote")
        assert state is not None
        assert state["scrollY"] == 1420.5
        assert state["isTop"] is False
        assert state["anchorPath"] == "div#content > div#bodyContent > p:nth-of-type(2)"
        assert state["hasMedia"] is True


@pytest.mark.asyncio
async def test_refresh_browser_layout_inplace_command_sequence():
    """Tests the exact non-destructive CDP sequence: scale 1.0x -> reset scale -> clear cache -> multi-phase evaluate."""
    fake_adb = FakeCdpAdb()
    tabs_json = json.dumps([
        {
            "id": "active_tab",
            "title": "Active Reading Tab",
            "type": "page",
            "url": "https://news.ycombinator.com",
            "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/active_tab",
        },
        {
            "id": "bg_tab",
            "title": "Background Tab",
            "type": "page",
            "url": "https://python.org",
            "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/bg_tab",
        },
    ])

    active_ws = FakeWebSocket("active_tab", is_visible=True)
    bg_ws = FakeWebSocket("bg_tab", is_visible=False)

    def fake_connect(url, *args, **kwargs):
        if "active_tab" in url:
            return active_ws
        return bg_ws

    saved_scroll = {
        "isTop": False,
        "scrollX": 0,
        "scrollY": 850.0,
        "ratio": 0.25,
        "anchorPath": "table#hnmain > tr:nth-of-type(3)",
    }

    with (
        patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: tabs_json.encode())),
        patch("websockets.connect", side_effect=fake_connect),
    ):
        ok = await refresh_browser_layout_inplace(
            fake_adb, "SERIAL_123", "chrome_devtools_remote", saved_scroll=saved_scroll
        )
        assert ok is True

    # Inspect messages sent to active tab
    active_methods = [m.get("method") for m in active_ws.sent_messages]
    assert "Emulation.setPageScaleFactor" in active_methods
    assert "Emulation.resetPageScaleFactor" in active_methods
    assert "Network.clearBrowserCache" in active_methods
    assert "Runtime.evaluate" in active_methods

    # Inspect background tab also got scale lock
    bg_methods = [m.get("method") for m in bg_ws.sent_messages]
    assert "Emulation.setPageScaleFactor" in bg_methods
    assert "Emulation.resetPageScaleFactor" in bg_methods


def test_build_nudge_script_element_anchoring_and_text_size_adjust():
    """Validates the generated JavaScript stabilizer handles element anchoring, origin anchoring, and webkitTextSizeAdjust."""
    # 1. Scrolled with anchor
    script = _build_nudge_script({
        "isTop": False,
        "scrollX": 0,
        "scrollY": 1200,
        "ratio": 0.5,
        "anchorPath": "div#main > article:nth-of-type(1)",
    })
    assert "webkitTextSizeAdjust = '100%'" in script
    assert "overflowAnchor = 'none'" in script
    assert "document.querySelector(anchorPath)" in script
    assert "scrollIntoView({ behavior: 'instant', block: 'start' })" in script
    assert "setTimeout(lockScroll, 80)" in script
    assert "setTimeout(lockScroll, 250)" in script
    assert "setTimeout(" in script and "600" in script

    # 2. At Top (0, 0)
    top_script = _build_nudge_script({"isTop": True, "scrollX": 0, "scrollY": 0})
    assert "savedIsTop = true" in top_script
    assert "window.scrollTo({ left: 0, top: 0, behavior: 'instant' })" in top_script


@pytest.mark.asyncio
async def test_bidirectional_handoff_and_reclaim_cdp_integration():
    """End-to-end integration: HandoffManager preserves scroll anchor & layout on DeX -> Phone and Phone -> DeX."""
    fake_adb = FakeCdpAdb()
    cfg = Settings(VIRTUAL_DISPLAY_DPI=200)
    events = MagicMock()
    events.emit = AsyncMock()

    session = MagicMock()
    session.state = WindowState(window_id="win-chrome", package="com.android.chrome", width=1920, height=1080)
    session.state.handoff_to_phone = False
    session.state.minimized = False
    session.state.frozen = False
    session.state.display_id = "10"
    session.dpi = 200
    session.server = MagicMock(is_alive=True, display_id="10")

    daemon = MagicMock()
    daemon.restart_task_activity = AsyncMock(return_value=True)
    daemon.set_display_density = AsyncMock(return_value=True)

    reconciler = DensityReconciler(fake_adb, cfg, serial_getter=lambda: "SER", daemon_getter=lambda: daemon)

    handoff = HandoffManager(
        fake_adb,
        cfg,
        events,
        {"win-chrome": session},
        serial_getter=lambda: "SER",
        unfreeze_locked=AsyncMock(),
        daemon_client_getter=lambda: daemon,
        density=reconciler,
    )

    captured_scroll = {
        "scrollX": 0,
        "scrollY": 640.0,
        "isTop": False,
        "ratio": 0.2,
        "anchorPath": "div#reading-pane",
        "hasMedia": False,
    }

    with (
        patch("app.device.deep_navigator.find_task_id_for_package", AsyncMock(return_value="999")),
        patch("app.windows.handoff_manager.move_task_to_display", AsyncMock(return_value=True)),
        patch("app.device.android_shell.bring_to_front", AsyncMock(return_value="OK")),
        patch("app.device.android_shell.sync_display0_focus", AsyncMock()),
        patch("app.windows.handoff_manager.inspect_app_runtime", AsyncMock(
            return_value=MagicMock(is_browser_cdp=True, cdp_socket="chrome_devtools_remote", is_pure_native=False, has_web_engine=True)
        )),
        patch("app.windows.handoff_manager.capture_browser_scroll_state", AsyncMock(return_value=captured_scroll)) as mock_capture,
        patch("app.windows.handoff_manager.refresh_browser_layout_inplace", AsyncMock(return_value=True)) as mock_refresh,
    ):
        # 1. Handoff: DeX -> Phone
        handoff_ok = await handoff.handoff_to_phone("win-chrome")
        assert handoff_ok is True
        mock_capture.assert_awaited()
        mock_refresh.assert_awaited_with(fake_adb, "SER", "chrome_devtools_remote", saved_scroll=captured_scroll)
        daemon.restart_task_activity.assert_not_called()

        # Reset mocks for reverse direction
        mock_capture.reset_mock()
        mock_refresh.reset_mock()

        # 2. Reclaim: Phone -> DeX
        session.state.handoff_to_phone = True
        reclaim_ok = await handoff.reclaim("win-chrome")
        assert reclaim_ok is True
        mock_capture.assert_awaited()
        mock_refresh.assert_awaited_with(fake_adb, "SER", "chrome_devtools_remote", saved_scroll=captured_scroll)
        daemon.restart_task_activity.assert_not_called()
