"""web_reload.py + cdp_refresher.soft_reload_active_tab — the user's explicit "Sayfayı yenile" for a Chromium-based window.

Contract: a NORMAL reload (cache honoured) of the FOREGROUND tab only; never part of an automatic path; whether a window has
a page to reload is asked of the phone, not answered from a list of browser names.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.windows import web_reload
from app.windows.cdp_refresher import soft_reload_active_tab
from app.windows.web_inspector import AppRuntimeProfile

from test_cdp_layout_integration import FakeCdpAdb, FakeWebSocket

TABS = json.dumps([
    {"id": "bg", "title": "Arka", "type": "page", "url": "https://python.org",
     "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/bg"},
    {"id": "fg", "title": "Ön", "type": "page", "url": "https://news.ycombinator.com",
     "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/fg"},
    {"id": "ntp", "title": "Yeni sekme", "type": "page", "url": "chrome://newtab",
     "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/ntp"},
])


def _connect(sockets):
    return lambda url, *a, **kw: sockets[url.rsplit("/", 1)[-1]]


@pytest.mark.asyncio
async def test_soft_reload_reloads_only_the_foreground_tab_with_the_cache_honoured():
    fg, bg = FakeWebSocket("fg", is_visible=True), FakeWebSocket("bg", is_visible=False)
    adb = FakeCdpAdb()

    with (
        patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: TABS.encode())),
        patch("websockets.connect", side_effect=_connect({"fg": fg, "bg": bg})),
    ):
        reloaded = await soft_reload_active_tab(adb, "SER", "chrome_devtools_remote")

    assert reloaded == {"title": "Ön", "url": "https://news.ycombinator.com"}
    reloads = [m for m in fg.sent_messages if m.get("method") == "Page.reload"]
    assert len(reloads) == 1 and reloads[0]["params"] == {"ignoreCache": False}  # a normal reload, not a hard one
    assert all(m.get("method") != "Page.reload" for m in bg.sent_messages)        # the other tab is left alone
    assert adb.removed_forwards == [9222]                                         # the port forward is always removed


@pytest.mark.asyncio
async def test_soft_reload_with_no_web_page_open_returns_none():
    only_newtab = json.dumps([{"id": "ntp", "type": "page", "url": "chrome://newtab",
                               "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/ntp"}])
    adb = FakeCdpAdb()

    with patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: only_newtab.encode())):
        assert await soft_reload_active_tab(adb, "SER", "chrome_devtools_remote") is None

    assert adb.removed_forwards == [9222]


@pytest.mark.asyncio
async def test_soft_reload_never_raises_when_the_devtools_socket_is_gone():
    adb = FakeCdpAdb()

    with patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
        assert await soft_reload_active_tab(adb, "SER", "chrome_devtools_remote") is None

    assert adb.removed_forwards == [9222]


def _profile(browser: bool, socket: str | None = "chrome_devtools_remote") -> AppRuntimeProfile:
    return AppRuntimeProfile(package="x", is_browser_cdp=browser, cdp_socket=socket if browser else None, webview_count=0)


@pytest.mark.asyncio
async def test_reload_page_outcomes():
    with (
        patch("app.windows.web_reload.inspect_app_runtime", AsyncMock(return_value=_profile(True))),
        patch("app.windows.web_reload.soft_reload_active_tab", AsyncMock(return_value={"title": "t", "url": "https://a.b"})),
    ):
        out = await web_reload.reload_page(object(), "SER", "com.brave.browser")
    assert out.ok and out.action == web_reload.RELOADED and out.detail == "https://a.b"

    with (
        patch("app.windows.web_reload.inspect_app_runtime", AsyncMock(return_value=_profile(True))),
        patch("app.windows.web_reload.soft_reload_active_tab", AsyncMock(return_value=None)),
    ):
        assert (await web_reload.reload_page(object(), "SER", "com.brave.browser")).action == web_reload.NO_PAGE

    with patch("app.windows.web_reload.inspect_app_runtime", AsyncMock(return_value=_profile(False))):
        assert (await web_reload.reload_page(object(), "SER", "com.example.native")).action == web_reload.NOT_WEB

    assert (await web_reload.reload_page(object(), None, "com.brave.browser")).action == web_reload.NO_DEVICE


@pytest.mark.asyncio
async def test_pseudo_windows_have_no_page_and_are_never_probed():
    probe = AsyncMock()
    with patch("app.windows.web_reload.inspect_app_runtime", probe):
        assert (await web_reload.reload_page(object(), "SER", "com.opendex.workspace")).action == web_reload.NOT_RELOADABLE
        assert await web_reload.can_reload(object(), "SER", "com.opendex.workspace") is False
    probe.assert_not_called()


@pytest.mark.asyncio
async def test_can_reload_follows_the_phones_answer_not_a_package_list():
    with patch("app.windows.web_reload.inspect_app_runtime", AsyncMock(return_value=_profile(True))):
        assert await web_reload.can_reload(object(), "SER", "com.some.unlisted.chromium.fork") is True
    with patch("app.windows.web_reload.inspect_app_runtime", AsyncMock(return_value=_profile(False))):
        assert await web_reload.can_reload(object(), "SER", "com.android.chrome") is False
    with patch("app.windows.web_reload.inspect_app_runtime", AsyncMock(side_effect=RuntimeError("adb gone"))):
        assert await web_reload.can_reload(object(), "SER", "com.android.chrome") is False
