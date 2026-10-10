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
