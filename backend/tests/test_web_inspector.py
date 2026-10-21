import pytest
from app.windows.web_inspector import _resolve_cdp_socket, AppRuntimeProfile
from app.windows.cdp_refresher import _build_nudge_script

UNIX_TABLE_WITH_CHROME = """
0000000000000000: 00000002 00000000 00010000 0001 01 266953 @chrome_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 77293 @stetho_com.google.android.apps.messaging_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 88888 @com.brave.browser_devtools_remote
"""

def test_resolve_cdp_socket_matches_chrome_for_chrome_packages():
    assert _resolve_cdp_socket(UNIX_TABLE_WITH_CHROME, "com.android.chrome") == "chrome_devtools_remote"
    assert _resolve_cdp_socket(UNIX_TABLE_WITH_CHROME, "org.chromium.chrome") == "chrome_devtools_remote"
    assert _resolve_cdp_socket(UNIX_TABLE_WITH_CHROME, "com.chrome.canary") == "chrome_devtools_remote"

def test_resolve_cdp_socket_matches_browser_by_package_name():
    assert _resolve_cdp_socket(UNIX_TABLE_WITH_CHROME, "com.brave.browser") == "com.brave.browser_devtools_remote"

def test_resolve_cdp_socket_never_matches_pure_native_apps():
    # Critical guarantee: Gallery, WhatsApp, Settings, etc., must NEVER be given chrome_devtools_remote
    assert _resolve_cdp_socket(UNIX_TABLE_WITH_CHROME, "com.miui.gallery") is None
    assert _resolve_cdp_socket(UNIX_TABLE_WITH_CHROME, "com.whatsapp") is None
    assert _resolve_cdp_socket(UNIX_TABLE_WITH_CHROME, "com.android.settings") is None
    assert _resolve_cdp_socket(UNIX_TABLE_WITH_CHROME, "com.android.vending") is None

def test_build_nudge_script_top_left_anchor_locking():
    # Test when user is at top (0, 0)
    script_top = _build_nudge_script({"isTop": True, "scrollX": 0, "scrollY": 0})
    assert "savedIsTop = true" in script_top
    assert "overflowAnchor = 'none'" in script_top
    assert "window.scrollTo({ left: 0, top: 0" in script_top

    # Test when user is scrolled
    script_scrolled = _build_nudge_script({"isTop": False, "scrollX": 0, "scrollY": 1420.5})
    assert "savedIsTop = false" in script_scrolled
    assert "savedY = 1420.5" in script_scrolled
    assert "window.scrollTo({ left: targetX, top: targetY" in script_scrolled


# ------------------------------------------------------------------ a browser's DevTools socket is found by asking it, not by its name
import asyncio  # noqa: E402

import pytest  # noqa: E402

from app.windows import web_inspector  # noqa: E402
from app.windows.web_inspector import _candidate_cdp_sockets, inspect_app_runtime  # noqa: E402

# The phone of 2026-10-21: Chrome (chrome_devtools_remote), Samsung Internet 30 (Terrace_devtools_remote), a WebView app, stetho.
_PHONE_TABLE = """\
0000000000000000: 00000003 00000000 00000000 0001 03 24985757 @chrome_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 24828425 @Terrace_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 20950154 @stetho_com.google.android.apps.messaging_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 30001111 @webview_devtools_remote_4242
0000000000000000: 00000002 00000000 00010000 0001 01 30002222 @com.brave.browser_devtools_remote
0000000000000000: 00000002 00000000 00010000 0001 01 30003333 @something_unrelated
"""


def test_every_browser_style_devtools_socket_is_a_candidate_whatever_its_name():
    names = [n for n, _ in _candidate_cdp_sockets(_PHONE_TABLE, "com.sec.android.app.sbrowser")]
    assert names == ["chrome_devtools_remote", "Terrace_devtools_remote", "com.brave.browser_devtools_remote"]
    # a webview's per-process socket and stetho's are an app's, never a browser's
    assert not any(n.startswith(("webview_devtools_remote", "stetho_")) for n in names)
    # the package's own socket comes first
    assert _candidate_cdp_sockets(_PHONE_TABLE, "com.brave.browser")[0][0] == "com.brave.browser_devtools_remote"
    assert _candidate_cdp_sockets(_PHONE_TABLE, "com.sec.android.app.sbrowser")[1] == ("Terrace_devtools_remote", "24828425")


class _FakePhone:
    async def shell(self, command, serial=None, timeout_s=None):
        return _PHONE_TABLE if "/proc/net/unix" in command else ""


def _owners(monkeypatch, mapping):
    async def fake_owner(adb, serial, socket_name, inode, *, timeout_s=0.5):
        return mapping.get(socket_name)
    monkeypatch.setattr(web_inspector, "_socket_owner", fake_owner)


@pytest.mark.asyncio
async def test_samsung_internet_is_found_through_the_socket_that_says_it_is_samsung_internet(monkeypatch):
    _owners(monkeypatch, {"chrome_devtools_remote": "com.android.chrome", "Terrace_devtools_remote": "com.sec.android.app.sbrowser"})
    profile = await inspect_app_runtime(_FakePhone(), "SER", "com.sec.android.app.sbrowser")
    assert profile.is_browser_cdp is True and profile.cdp_socket == "Terrace_devtools_remote"
    chrome = await inspect_app_runtime(_FakePhone(), "SER", "com.android.chrome")
    assert chrome.is_browser_cdp is True and chrome.cdp_socket == "chrome_devtools_remote"


@pytest.mark.asyncio
async def test_an_app_that_owns_none_of_the_sockets_still_gets_none(monkeypatch):
    """Isolation: a gallery must never be given Chrome's or Samsung's socket just because it is the only DevTools socket around."""
    _owners(monkeypatch, {"chrome_devtools_remote": "com.android.chrome", "Terrace_devtools_remote": "com.sec.android.app.sbrowser"})
    for package in ("com.miui.gallery", "com.whatsapp", "com.android.settings"):
        profile = await inspect_app_runtime(_FakePhone(), "SER", package)
        assert profile.is_browser_cdp is False and profile.cdp_socket is None


@pytest.mark.asyncio
async def test_chrome_keeps_its_socket_when_the_phone_cannot_be_asked(monkeypatch):
    _owners(monkeypatch, {})                       # nobody answers /json/version
    chrome = await inspect_app_runtime(_FakePhone(), "SER", "com.android.chrome")
    assert chrome.cdp_socket == "chrome_devtools_remote"                       # the known-Chromium fallback, as before
    samsung = await inspect_app_runtime(_FakePhone(), "SER", "com.sec.android.app.sbrowser")
    assert samsung.is_browser_cdp is False                                     # unknown package: never guessed


@pytest.mark.asyncio
async def test_a_sockets_owner_is_asked_once_per_process(monkeypatch):
    calls = []

    class _Session:
        async def __aenter__(self_inner):
            calls.append(1)
            return 5555

        async def __aexit__(self_inner, *exc):
            return False

    class _Resp:
        def read(self):
            return b'{"Android-Package": "com.sec.android.app.sbrowser"}'

    web_inspector._owner_cache.clear()
    monkeypatch.setattr(web_inspector, "open_cdp_session", lambda *a, **k: _Session())
    monkeypatch.setattr(web_inspector.urllib.request, "urlopen", lambda *a, **k: _Resp())
    first = await web_inspector._socket_owner(object(), "SER", "Terrace_devtools_remote", "24828425")
    second = await web_inspector._socket_owner(object(), "SER", "Terrace_devtools_remote", "24828425")
    restarted = await web_inspector._socket_owner(object(), "SER", "Terrace_devtools_remote", "99999999")   # a new process: asked again
    assert first == second == restarted == "com.sec.android.app.sbrowser" and len(calls) == 2
    web_inspector._owner_cache.clear()
