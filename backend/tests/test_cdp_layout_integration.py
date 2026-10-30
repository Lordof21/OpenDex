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
from app.windows import cdp_refresher as cr
from app.windows.cdp_refresher import (
    _build_nudge_script,
    _find_active_page_target,
    _landed_on_stale_page,
    _mobile_site_url,
    _send_cdp,
    capture_browser_scroll_state,
    get_browser_auto_attach_watcher,
    open_cdp_session,
    refresh_browser_layout_inplace,
    start_browser_auto_attach_watcher,
    stop_browser_auto_attach_watcher,
    BrowserTabAutoAttachWatcher,
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
    # The init script dies with the DevTools session that added it; this short session closes right away, so it is not sent
    # (only the watcher's persistent session registers it).
    assert "Page.addScriptToEvaluateOnNewDocument" not in active_methods
    assert "Network.clearBrowserCache" not in active_methods  # Cache and images must be preserved!
    assert "Runtime.evaluate" in active_methods

    # Inspect background tab also got the scale lock
    bg_methods = [m.get("method") for m in bg_ws.sent_messages]
    assert "Emulation.setPageScaleFactor" in bg_methods
    assert "Emulation.resetPageScaleFactor" in bg_methods
    assert "Page.addScriptToEvaluateOnNewDocument" not in bg_methods


@pytest.mark.parametrize("saved, landed, stale", [
    # measured 2026-10-26 on Samsung Internet: the tab came back on the address of its last real page load
    ("https://m.youtube.com/watch?v=TVSkw5jQL8Y&pp=x", "https://m.youtube.com/watch?v=RfuTild14F0", True),     # next video
    ("https://m.youtube.com/watch?v=RfuTild14F0", "https://m.youtube.com/", True),                             # home -> a video
    ("https://www.youtube.com/watch?v=A", "https://m.youtube.com/watch?v=B", True),                           # host variants fold together
    ("https://claude.ai/chat/abc", "https://claude.ai/new", True),                                             # not site specific
    # the same page: nothing to put back
    ("https://m.youtube.com/watch?v=A&t=10s", "https://www.youtube.com/watch?app=desktop&v=A", False),
    ("https://www.google.com/search?q=a", "https://www.google.com/search?q=b", False),                        # same path: left alone
    # never overwrite another site's tab, never touch non-web pages
    ("https://m.youtube.com/watch?v=A", "https://tr.wikipedia.org/wiki/T%C3%BCrkiye", False),
    ("https://m.youtube.com/watch?v=A", "chrome://newtab/", False),
    ("", "https://m.youtube.com/", False),
])
def test_a_tab_the_app_rebuilt_from_an_older_address_is_recognised(saved, landed, stale):
    assert _landed_on_stale_page(saved, landed) is stale


class _NavigatingWebSocket(FakeWebSocket):
    """An active tab that was rebuilt by the app: it answers the freshness probe with 'fresh' and fires the load event after a navigation."""

    def __init__(self, tab_id: str):
        super().__init__(tab_id, is_visible=True)
        self._events: list[str] = []

    async def send(self, data: str):
        await super().send(data)
        if json.loads(data).get("method") == "Page.navigate":
            self._events.append(json.dumps({"method": "Page.loadEventFired", "params": {}}))

    async def recv(self) -> str:
        last = self.sent_messages[-1]
        if last.get("method") == "Page.navigate" and not getattr(self, "_answered", False):
            self._answered = True
            return json.dumps({"id": last["id"], "result": {"frameId": "f"}})
        if self._events:
            return self._events.pop(0)
        if last.get("method") == "Runtime.evaluate" and "__odxRestored" in last["params"]["expression"]:
            return json.dumps({"id": last["id"], "result": {"result": {"value": "fresh"}}})
        return await super().recv()


@pytest.mark.asyncio
@pytest.mark.parametrize("landed_url, expect_navigation", [
    ("https://m.youtube.com/watch?v=RfuTild14F0", True),      # rebuilt from the previous video
    ("https://m.youtube.com/watch?v=TVSkw5jQL8Y", False),     # already the right page: only the restore runs
])
async def test_the_tab_is_taken_back_to_the_address_it_was_on_after_the_app_rebuilt_it(landed_url, expect_navigation):
    fake_adb = FakeCdpAdb()
    tabs_json = json.dumps([{
        "id": "front", "title": "YouTube", "type": "page", "url": landed_url,
        "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/front",
    }])
    ws = _NavigatingWebSocket("front")
    saved = {"url": "https://m.youtube.com/watch?v=TVSkw5jQL8Y&pp=x", "t": 55.0, "playing": True, "scrollY": 0, "captured_at": 0}
    with (
        patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: tabs_json.encode())),
        patch("websockets.connect", return_value=ws),
    ):
        assert await refresh_browser_layout_inplace(fake_adb, "SERIAL_123", "chrome_devtools_remote", saved_scroll=saved) is True
    navigations = [m for m in ws.sent_messages if m.get("method") == "Page.navigate"]
    restores = [m for m in ws.sent_messages if m.get("method") == "Runtime.evaluate" and m["params"]["expression"].startswith("(async (saved)=>")]
    if expect_navigation:
        assert [m["params"]["url"] for m in navigations] == ["https://m.youtube.com/watch?v=TVSkw5jQL8Y&pp=x"]
    else:
        assert navigations == []
    assert len(restores) == 1 and restores[0]["params"].get("userGesture") is True   # the video is put back either way


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


class FakeBrowserWatcherWebSocket:
    def __init__(self, target_events: list[dict]):
        self.sent_messages: list[dict] = []
        self.target_events = target_events
        self.closed = False

    async def send(self, data: str):
        msg = json.loads(data)
        self.sent_messages.append(msg)

    async def recv(self) -> str:
        if self.target_events:
            ev = self.target_events.pop(0)
            return json.dumps(ev)
        await asyncio.sleep(10.0)
        return json.dumps({})

    async def close(self):
        self.closed = True

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()


_VERSION = json.dumps({
    "Browser": "Chrome/155.0.8059.39",
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser",
})
NATIVE = 513 / 160


async def _run_watcher(events, *, phone_dpr=NATIVE, key="chrome-pkg", mode="mobile"):
    """Starts a watcher against a fake browser that delivers `events`, returns (fake_ws, watcher) once they were consumed."""
    fake_ws = FakeBrowserWatcherWebSocket(events)
    with (
        patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: _VERSION.encode())),
        patch("websockets.connect", return_value=fake_ws),
    ):
        watcher = start_browser_auto_attach_watcher(FakeCdpAdb(), "SERIAL_123", "chrome_devtools_remote", key, phone_dpr, mode)
        assert await watcher.wait_ready()
        for _ in range(50):
            if not fake_ws.target_events:
                break
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.05)
    return fake_ws, watcher


def _session_methods(fake_ws, session_id):
    """What was sent to one session. The page's watch for its own frames (Target.setAutoAttach) is left out: it is not what these tests are about."""
    return [m.get("method") for m in fake_ws.sent_messages
            if m.get("sessionId") == session_id and m.get("method") != "Target.setAutoAttach"]


@pytest.mark.asyncio
async def test_a_new_tab_is_paused_given_the_phones_identity_and_scale_and_only_then_resumed():
    """A new tab is created paused: mobile user agent + native scale BEFORE it loads (so it never gets the desktop site or the
    x1.2 scale), then it is let go. The overrides must come before the resume."""
    events = [
        {"id": 1, "result": {}},
        {"id": 2, "result": {"targetInfos": []}},
        {"method": "Target.attachedToTarget", "params": {
            "sessionId": "S_NEW", "waitingForDebugger": True,
            "targetInfo": {"targetId": "T1", "type": "page", "url": "", "title": ""}}},
    ]
    fake_ws, watcher = await _run_watcher(events)
    try:
        assert fake_ws.sent_messages[0]["method"] == "Target.setAutoAttach"
        assert fake_ws.sent_messages[0]["params"] == {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}
        methods = _session_methods(fake_ws, "S_NEW")
        assert methods == ["Emulation.setUserAgentOverride", "Emulation.setDeviceMetricsOverride", "Runtime.runIfWaitingForDebugger"]
        by_method = {m["method"]: m["params"] for m in fake_ws.sent_messages if m.get("sessionId") == "S_NEW"}
        assert by_method["Emulation.setUserAgentOverride"]["userAgent"].endswith("Mobile Safari/537.36")
        assert by_method["Emulation.setUserAgentOverride"]["userAgentMetadata"]["mobile"] is True
        assert by_method["Emulation.setDeviceMetricsOverride"] == {
            "width": 0, "height": 0, "deviceScaleFactor": NATIVE, "mobile": True,
        }
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


@pytest.mark.asyncio
async def test_every_paused_target_is_resumed_not_only_pages():
    """With waitForDebuggerOnStart every new target pauses (workers, iframes): one that is not resumed hangs for good."""
    events = [
        {"id": 1, "result": {}},
        {"id": 2, "result": {"targetInfos": []}},
        {"method": "Target.attachedToTarget", "params": {
            "sessionId": "S_WORKER", "waitingForDebugger": True,
            "targetInfo": {"targetId": "W1", "type": "service_worker", "url": "https://x.example/sw.js"}}},
    ]
    fake_ws, _ = await _run_watcher(events)
    try:
        assert _session_methods(fake_ws, "S_WORKER") == ["Runtime.runIfWaitingForDebugger"]
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


def _tab_events(state: dict, *, then=()):
    """A browser with one open tab (S_A) that answers the watcher's state question with `state`."""
    return [
        {"id": 1, "result": {}},
        {"id": 2, "result": {"targetInfos": [
            {"targetId": "TAB_A", "type": "page", "url": "https://a.example/"},
            {"targetId": "TAB_NEW", "type": "page", "url": "chrome-native://newtab/"},
        ]}},
        {"method": "Target.attachedToTarget", "params": {
            "sessionId": "S_A", "waitingForDebugger": False,
            "targetInfo": {"targetId": "TAB_A", "type": "page", "url": "https://a.example/"}}},
        {"id": 4, "result": {"result": {"value": json.dumps(state)}}},
        *then,
    ]


_TAB = {"mobile": True, "visible": True, "t": 12.5, "playing": True, "y": 300, "url": "https://a.example/watch?v=1", "host": "a.example"}


@pytest.mark.asyncio
async def test_a_desktop_site_tab_in_front_is_reloaded_as_the_mobile_site_with_its_video_put_back():
    """A tab carried onto the phone as the DESKTOP site cannot be fixed by layout alone (the site differs): the tab the user
    looks at is reloaded under the phone's user agent, and once loaded its video and scroll are put back."""
    fake_ws, _ = await _run_watcher(_tab_events(
        {**_TAB, "mobile": False}, then=[{"method": "Page.loadEventFired", "sessionId": "S_A", "params": {}}],
    ))
    try:
        attach = [m for m in fake_ws.sent_messages if m.get("method") == "Target.attachToTarget"]
        assert [m["params"]["targetId"] for m in attach] == ["TAB_A"]          # only http(s) pages
        assert "Runtime.runIfWaitingForDebugger" not in _session_methods(fake_ws, "S_A")   # it was not paused
        methods = _session_methods(fake_ws, "S_A")
        assert methods[:3] == ["Runtime.evaluate", "Emulation.setUserAgentOverride", "Emulation.setDeviceMetricsOverride"]
        by_method = {m["method"]: m["params"] for m in fake_ws.sent_messages if m.get("sessionId") == "S_A"}
        assert by_method["Emulation.setUserAgentOverride"]["userAgent"].endswith("Mobile Safari/537.36")
        assert by_method["Emulation.setDeviceMetricsOverride"] == {"width": 0, "height": 0, "deviceScaleFactor": NATIVE, "mobile": True}
        assert methods.index("Page.reload") > methods.index("Emulation.setUserAgentOverride")
        restore = [m for m in fake_ws.sent_messages if m.get("sessionId") == "S_A" and m.get("method") == "Runtime.evaluate"][-1]
        assert restore["params"]["userGesture"] is True
        assert '"t": 12.5' in restore["params"]["expression"] and '"playing": true' in restore["params"]["expression"]
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


@pytest.mark.asyncio
async def test_a_tab_the_browser_auto_attached_and_we_attached_is_handled_once():
    """`Target.setAutoAttach` also attaches the tabs that are open; attaching them again from the target list gave one tab two sessions
    — two reloads and two restores ran against each other (the half-desktop, half-phone page)."""
    attached = {"method": "Target.attachedToTarget", "params": {
        "waitingForDebugger": False, "targetInfo": {"targetId": "TAB_A", "type": "page", "url": "https://a.example/"}}}
    events = [
        {"id": 1, "result": {}},
        {"id": 2, "result": {"targetInfos": [{"targetId": "TAB_A", "type": "page", "url": "https://a.example/"}]}},
        {**attached, "params": {**attached["params"], "sessionId": "S_AUTO"}},
        {**attached, "params": {**attached["params"], "sessionId": "S_MANUAL"}},
        {"id": 4, "result": {"result": {"value": json.dumps({**_TAB, "mobile": False})}}},
    ]
    fake_ws, _ = await _run_watcher(events)
    try:
        assert _session_methods(fake_ws, "S_MANUAL") == []                       # the second session is left alone
        assert _session_methods(fake_ws, "S_AUTO").count("Page.reload") == 1
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


@pytest.mark.asyncio
async def test_the_watcher_settles_after_the_reload_of_the_tab_in_front_has_loaded_and_its_state_was_sent_back():
    events = _tab_events({**_TAB, "mobile": False}, then=[{"method": "Page.loadEventFired", "sessionId": "S_A", "params": {}}])
    fake_ws = FakeBrowserWatcherWebSocket(events)
    with (
        patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: _VERSION.encode())),
        patch("websockets.connect", return_value=fake_ws),
    ):
        watcher = start_browser_auto_attach_watcher(FakeCdpAdb(), "SERIAL_123", "chrome_devtools_remote", "chrome-pkg", NATIVE)
        try:
            assert await watcher.wait_ready()
            assert await watcher.wait_settled(2.0)
        finally:
            stop_browser_auto_attach_watcher("chrome-pkg")
    assert "Page.reload" in _session_methods(fake_ws, "S_A")


@pytest.mark.asyncio
async def test_with_no_open_tab_the_watcher_is_settled_at_once():
    fake_ws = FakeBrowserWatcherWebSocket([{"id": 1, "result": {}}, {"id": 2, "result": {"targetInfos": []}}])
    with (
        patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: _VERSION.encode())),
        patch("websockets.connect", return_value=fake_ws),
    ):
        watcher = start_browser_auto_attach_watcher(FakeCdpAdb(), "SERIAL_123", "chrome_devtools_remote", "chrome-pkg", NATIVE)
        try:
            assert await watcher.wait_settled(1.0)
        finally:
            stop_browser_auto_attach_watcher("chrome-pkg")


@pytest.mark.parametrize("url, expected", [
    ("https://www.youtube.com/watch?app=desktop&v=abc&t=5s", "https://www.youtube.com/watch?v=abc&t=5s"),
    ("https://www.youtube.com/watch?v=abc&app=desktop", "https://www.youtube.com/watch?v=abc"),
    ("https://www.youtube.com/watch?v=abc", None),
    ("https://a.example/page?app=mobile", None),
])
def test_the_desktop_flag_in_a_page_address_is_dropped_for_the_mobile_site(url, expected):
    assert _mobile_site_url(url) == expected


@pytest.mark.asyncio
async def test_a_tab_whose_address_forces_the_desktop_site_is_navigated_without_the_flag_not_reloaded():
    """YouTube's `app=desktop` wins over the user agent: a reload kept the desktop layout on the phone (half-desktop page)."""
    url = "https://www.youtube.com/watch?app=desktop&v=1"
    fake_ws, _ = await _run_watcher(_tab_events(
        {**_TAB, "mobile": False, "url": url}, then=[{"method": "Page.loadEventFired", "sessionId": "S_A", "params": {}}],
    ))
    try:
        methods = _session_methods(fake_ws, "S_A")
        assert "Page.reload" not in methods
        nav = [m for m in fake_ws.sent_messages if m.get("sessionId") == "S_A" and m.get("method") == "Page.navigate"]
        assert [m["params"]["url"] for m in nav] == ["https://www.youtube.com/watch?v=1"]
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


@pytest.mark.asyncio
async def test_a_desktop_site_tab_behind_is_not_reloaded_and_keeps_the_layout_it_runs_in():
    fake_ws, _ = await _run_watcher(_tab_events({**_TAB, "mobile": False, "visible": False}))
    try:
        by_method = {m["method"]: m["params"] for m in fake_ws.sent_messages if m.get("sessionId") == "S_A"}
        assert by_method["Emulation.setDeviceMetricsOverride"]["mobile"] is False
        assert "Page.reload" not in _session_methods(fake_ws, "S_A")
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


@pytest.mark.asyncio
async def test_a_mobile_tab_on_the_phone_only_gets_the_scale():
    fake_ws, _ = await _run_watcher(_tab_events(_TAB))
    try:
        by_method = {m["method"]: m["params"] for m in fake_ws.sent_messages if m.get("sessionId") == "S_A"}
        assert by_method["Emulation.setDeviceMetricsOverride"] == {"width": 0, "height": 0, "deviceScaleFactor": NATIVE, "mobile": True}
        assert "Page.reload" not in _session_methods(fake_ws, "S_A")
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


@pytest.mark.asyncio
async def test_an_m_site_under_a_desktop_agent_counts_as_the_mobile_site():
    """A page carried out of a wide window can be the m. site while the browser already reports a desktop agent: it is the SITE that
    decides, so in a window it is reloaded (and on the phone it is left alone)."""
    fake_ws, _ = await _run_watcher(_tab_events({**_TAB, "mobile": False, "host": "m.youtube.com"}))
    try:
        assert "Page.reload" not in _session_methods(fake_ws, "S_A")        # phone mode: it is the mobile site already
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")

    fake_ws, _ = await _run_watcher(
        _tab_events({**_TAB, "mobile": False, "host": "m.youtube.com"}), phone_dpr=None, mode="desktop",
    )
    try:
        assert "Page.reload" in _session_methods(fake_ws, "S_A")
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


@pytest.mark.asyncio
async def test_in_a_window_a_mobile_tab_in_front_gets_the_desktop_agent_and_is_reloaded_without_a_scale():
    fake_ws, watcher = await _run_watcher(_tab_events(_TAB), phone_dpr=None, mode="desktop")
    try:
        assert watcher.mode == "desktop"
        by_method = {m["method"]: m["params"] for m in fake_ws.sent_messages if m.get("sessionId") == "S_A"}
        assert "X11; Linux" in by_method["Emulation.setUserAgentOverride"]["userAgent"]
        assert by_method["Emulation.setUserAgentOverride"]["userAgentMetadata"]["mobile"] is False
        assert "Emulation.setDeviceMetricsOverride" not in by_method           # the window's own scale is the browser's
        assert "Page.reload" in _session_methods(fake_ws, "S_A")
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


@pytest.mark.asyncio
async def test_in_a_window_a_new_tab_starts_with_the_desktop_agent():
    events = [
        {"id": 1, "result": {}},
        {"id": 2, "result": {"targetInfos": []}},
        {"method": "Target.attachedToTarget", "params": {
            "sessionId": "S_NEW", "waitingForDebugger": True, "targetInfo": {"targetId": "T1", "type": "page", "url": ""}}},
    ]
    fake_ws, _ = await _run_watcher(events, phone_dpr=None, mode="desktop")
    try:
        assert _session_methods(fake_ws, "S_NEW") == ["Emulation.setUserAgentOverride", "Runtime.runIfWaitingForDebugger"]
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


@pytest.mark.asyncio
async def test_stopping_the_watcher_clears_the_scale_override_of_every_tab():
    """Back in a DeX window the tabs must not keep the phone's scale: the override is cleared while the connection is open."""
    events = [
        {"id": 1, "result": {}},
        {"id": 2, "result": {"targetInfos": []}},
        {"method": "Target.attachedToTarget", "params": {
            "sessionId": "S_NEW", "waitingForDebugger": True,
            "targetInfo": {"targetId": "T1", "type": "page", "url": ""}}},
    ]
    fake_ws, watcher = await _run_watcher(events)
    assert get_browser_auto_attach_watcher("chrome-pkg") is watcher
    stop_browser_auto_attach_watcher("chrome-pkg")
    assert get_browser_auto_attach_watcher("chrome-pkg") is None
    for _ in range(40):
        if "Emulation.clearDeviceMetricsOverride" in _session_methods(fake_ws, "S_NEW"):
            break
        await asyncio.sleep(0.02)
    assert "Emulation.clearDeviceMetricsOverride" in _session_methods(fake_ws, "S_NEW")


@pytest.mark.asyncio
async def test_without_a_phone_density_only_the_identity_of_new_tabs_is_set():
    events = [
        {"id": 1, "result": {}},
        {"id": 2, "result": {"targetInfos": []}},
        {"method": "Target.attachedToTarget", "params": {
            "sessionId": "S_NEW", "waitingForDebugger": True,
            "targetInfo": {"targetId": "T1", "type": "page", "url": ""}}},
    ]
    fake_ws, _ = await _run_watcher(events, phone_dpr=None)
    try:
        assert _session_methods(fake_ws, "S_NEW") == ["Emulation.setUserAgentOverride", "Runtime.runIfWaitingForDebugger"]
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


def test_the_nudge_script_no_longer_writes_a_zoom_into_the_page():
    script = _build_nudge_script(None)
    assert "3.20625" not in script and "normZoom" not in script and "hasStaleTabletZoom" not in script
    assert "if (root.style.zoom) root.style.zoom = '';" in script          # residue of the old compensation is cleared


class _HangingConnect:
    """A tab whose renderer never answers: the websocket handshake does not finish (a frozen / discarded tab)."""

    async def __aenter__(self):
        await asyncio.sleep(60)

    async def __aexit__(self, *exc):
        return False


def _many_tabs(count):
    return [
        {
            "id": f"tab_{i}", "title": f"Tab {i}", "type": "page", "url": f"https://site{i}.example/",
            "webSocketDebuggerUrl": f"ws://127.0.0.1:9222/devtools/page/tab_{i}",
        }
        for i in range(count)
    ]


@pytest.mark.asyncio
async def test_frozen_tabs_cannot_hold_the_refresh_for_seconds():
    """Handoff holds the window lifecycle lock while this runs: with 16 tabs, 15 of them frozen, the refresh finishes within
    its budget (it used to take ~0.4-0.7 s PER unresponsive tab, i.e. 7-10 s per Chrome handoff)."""
    import time

    fake_adb = FakeCdpAdb()
    tabs = _many_tabs(16)
    active_ws = FakeWebSocket("tab_9", is_visible=True)

    def fake_connect(url, *args, **kwargs):
        return active_ws if "tab_9" in url else _HangingConnect()

    with (
        patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: json.dumps(tabs).encode())),
        patch("websockets.connect", side_effect=fake_connect),
    ):
        started = time.monotonic()
        ok = await refresh_browser_layout_inplace(fake_adb, "SERIAL_123", "chrome_devtools_remote")
        elapsed = time.monotonic() - started

    assert ok is True
    assert elapsed < 3.0, f"frozen tabs held the refresh for {elapsed:.1f}s"
    assert "Runtime.evaluate" in [m.get("method") for m in active_ws.sent_messages]   # the visible tab was found and nudged


@pytest.mark.asyncio
async def test_active_tab_is_found_even_when_earlier_tabs_do_not_answer():
    from app.windows.cdp_refresher import _find_active_page_target

    tabs = _many_tabs(6)
    visible_ws = FakeWebSocket("tab_4", is_visible=True)
    hidden_ws = FakeWebSocket("hidden", is_visible=False)

    def fake_connect(url, *args, **kwargs):
        if "tab_4" in url:
            return visible_ws
        return hidden_ws if "tab_5" in url else _HangingConnect()

    with patch("websockets.connect", side_effect=fake_connect):
        found = await _find_active_page_target(9222, tabs, timeout_s=0.5)
    assert found["id"] == "tab_4"


@pytest.mark.asyncio
async def test_a_page_watches_for_its_cross_origin_frames_and_a_frame_gets_the_pages_identity():
    """A cross-origin frame (a Cloudflare check, an ad, a player) is a target of its own: it is given the SAME user agent / client hints as its page
    (the check saw the browser's real model next to the page's empty one) — but no scale: Chrome refuses it on a frame target."""
    events = [
        {"id": 1, "result": {}},
        {"id": 2, "result": {"targetInfos": []}},
        {"method": "Target.attachedToTarget", "params": {
            "sessionId": "S_PAGE", "waitingForDebugger": True, "targetInfo": {"targetId": "T1", "type": "page", "url": ""}}},
        {"method": "Target.attachedToTarget", "params": {
            "sessionId": "S_FRAME", "waitingForDebugger": True, "targetInfo": {"targetId": "T2", "type": "iframe", "url": "https://challenges.cloudflare.com/x"}}},
    ]
    fake_ws, _ = await _run_watcher(events)
    try:
        page = [m for m in fake_ws.sent_messages if m.get("sessionId") == "S_PAGE"]
        assert page[0]["method"] == "Target.setAutoAttach" and page[0]["params"]["flatten"] is True
        frame = _session_methods(fake_ws, "S_FRAME")
        assert frame == ["Emulation.setUserAgentOverride", "Runtime.runIfWaitingForDebugger"]
        ua = next(m for m in fake_ws.sent_messages if m.get("sessionId") == "S_FRAME" and m["method"] == "Emulation.setUserAgentOverride")["params"]
        brands = {b["brand"] for b in ua["userAgentMetadata"]["brands"]}
        assert "Not(A:Brand" in brands            # the entry every real Chrome has; a list without it gives a hand-made object away
    finally:
        stop_browser_auto_attach_watcher("chrome-pkg")


def test_the_phones_client_hints_carry_its_real_model_and_android_release():
    meta = cr._mobile_ua_metadata("Chrome/155.0.8059.81", "2412DPC0AG", "16")
    assert meta["model"] == "2412DPC0AG" and meta["platformVersion"] == "16.0.0" and meta["mobile"] is True
    assert {b["brand"] for b in meta["brands"]} == {"Not(A:Brand", "Chromium", "Google Chrome"}
    assert meta["fullVersionList"][1]["version"] == "155.0.8059.81"
    assert cr._mobile_ua_metadata("Chrome/155.0.8059.81")["platformVersion"] == ""       # unknown stays unknown, never invented
    desk = cr._desktop_ua("Chrome/155.0.8059.81")
    assert desk["platform"] == "Linux x86_64" and desk["userAgentMetadata"]["mobile"] is False


class _AnsweringWebSocket(FakeBrowserWatcherWebSocket):
    """After the scripted events, answers the watcher's page questions by what they ask (the ids depend on how many commands came before)."""

    def __init__(self, target_events, answers):
        super().__init__(target_events)
        self._answers = answers          # [(substring of the expression, the page's answer)]
        self._done: set[int] = set()

    async def recv(self) -> str:
        if self.target_events:
            return json.dumps(self.target_events.pop(0))
        for _ in range(300):
            for msg in self.sent_messages:
                expr = (msg.get("params") or {}).get("expression", "")
                if msg.get("method") != "Runtime.evaluate" or msg["id"] in self._done:
                    continue
                for needle, answer in self._answers:
                    if needle in expr:
                        self._done.add(msg["id"])
                        return json.dumps({"id": msg["id"], "result": {"result": {"value": json.dumps(answer)}}})
            await asyncio.sleep(0.02)
        await asyncio.sleep(10.0)
        return json.dumps({})


_FP = {"s": 200, "h": "a.example", "u": "/r", "vp": "width=device-width", "tags": {"div": 100, "img": 20}, "words": {"a": 5}, "res": ["x.js"], "n": 5000}


async def _run_same_page_tab(state: dict, now: dict):
    """A desktop-site tab in front that answers 'the same page under both identities': the watcher keeps it, then asks how it is sized now."""
    events = [
        {"id": 1, "result": {}},
        {"id": 2, "result": {"targetInfos": [{"targetId": "TAB_A", "type": "page", "url": "https://a.example/r"}]}},
        {"method": "Target.attachedToTarget", "params": {
            "sessionId": "S_A", "waitingForDebugger": False, "targetInfo": {"targetId": "TAB_A", "type": "page", "url": "https://a.example/r"}}},
        {"id": 4, "result": {"result": {"value": json.dumps(state)}}},   # 3 is the attach of the tab open at the start
    ]
    fake_ws = _AnsweringWebSocket(events, [
        ("odxFingerprint()", {"fp": _FP, "lay": {"iw": 380, "sw": 380}}),
        (cr._STALE_WIDTH_PROBE_JS, now),
    ])
    with (
        patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: _VERSION.encode())),
        patch("websockets.connect", return_value=fake_ws),
    ):
        watcher = start_browser_auto_attach_watcher(FakeCdpAdb(), "SERIAL_123", "chrome_devtools_remote", "chrome-pkg", NATIVE)
        try:
            assert await watcher.wait_ready()
            await asyncio.sleep(1.4)               # the watcher waits 0.7 s for the new scale to settle before it looks again
        finally:
            stop_browser_auto_attach_watcher("chrome-pkg")
    return fake_ws


_FRONT = {"mobile": False, "visible": True, "t": None, "playing": False, "y": 29000, "url": "https://a.example/r", "host": "a.example",
          "vw": 800, "a": {"p": "div:nth-of-type(78)", "f": 0.75}, "dirty": False, "fp": _FP, "since": 60000, "c": []}


@pytest.mark.asyncio
async def test_a_kept_tab_that_is_still_sized_for_the_old_width_is_reloaded_to_where_it_was():
    """The same page under both identities is not reloaded for its identity — but a page that measured itself in script at the window's old
    width (a reader's fixed min-height per page) keeps gaps at the phone's width: it is reloaded, to its content point."""
    fake_ws = await _run_same_page_tab(_FRONT, {"vw": 380, "c": {"vw": 380, "gaps": 2, "over": 0}})
    methods = _session_methods(fake_ws, "S_A")
    assert "Page.reload" in methods, [(m.get("method"), m.get("sessionId"), (m.get("params") or {}).get("expression", "")[:40]) for m in fake_ws.sent_messages]


@pytest.mark.asyncio
@pytest.mark.parametrize("state, now", [
    (_FRONT, {"vw": 380, "c": {"vw": 380, "gaps": 0, "over": 0}}),                      # a responsive page: no symptom
    (_FRONT, {"vw": 700, "c": {"vw": 700, "gaps": 2, "over": 0}}),                      # the width did not really change
    ({**_FRONT, "playing": True}, {"vw": 380, "c": {"vw": 380, "gaps": 2, "over": 0}}),  # a playing video is never cut
    ({**_FRONT, "dirty": True}, {"vw": 380, "c": {"vw": 380, "gaps": 2, "over": 0}}),    # typed text would be lost
])
async def test_a_kept_tab_is_not_reloaded_without_the_symptom_a_real_change_or_when_it_would_lose_something(state, now):
    fake_ws = await _run_same_page_tab(state, now)
    assert "Page.reload" not in _session_methods(fake_ws, "S_A")
