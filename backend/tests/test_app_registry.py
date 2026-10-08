"""App list parsing: scrcpy list_apps format (real labels) + pm --brief fallback.
Regression for the field bug where verbose query output produced names like
'null icon 0x7f...'."""
from app.apps.app_registry import (
    parse_brief_query,
    parse_scrcpy_app_list,
    prettify_package,
)

SCRCPY_OUTPUT = """
[server] INFO: List of apps:
 - Chrome                             [com.android.chrome]
 * Ayarlar                            [com.android.settings]
 - WhatsApp                           [com.whatsapp]
 - Some App [beta]                    [com.example.beta]
"""

BRIEF_OUTPUT = """
4 activities found:
  com.android.chrome/com.google.android.apps.chrome.Main
  com.android.settings/.Settings
  com.whatsapp/.Main
  com.whatsapp/.Main
"""


class TestScrcpyListParsing:
    def test_real_labels_and_packages(self):
        apps = {a.package: a.display_name for a in parse_scrcpy_app_list(SCRCPY_OUTPUT)}
        assert apps["com.android.chrome"] == "Chrome"
        assert apps["com.android.settings"] == "Ayarlar"  # localized, system app (*)
        assert apps["com.whatsapp"] == "WhatsApp"

    def test_label_containing_brackets_keeps_last_bracket_as_package(self):
        apps = {a.package: a.display_name for a in parse_scrcpy_app_list(SCRCPY_OUTPUT)}
        assert apps["com.example.beta"] == "Some App [beta]"

    def test_no_null_icon_garbage_ever(self):
        for app in parse_scrcpy_app_list(SCRCPY_OUTPUT):
            assert "null" not in app.display_name
            assert "icon" not in app.display_name

    def test_noise_lines_ignored(self):
        assert parse_scrcpy_app_list("[server] INFO: nothing\nrandom text") == []


class TestBriefFallback:
    def test_packages_deduplicated_and_prettified(self):
        apps = parse_brief_query(BRIEF_OUTPUT)
        packages = [a.package for a in apps]
        assert packages == sorted(set(packages))  # dedupe + stable order
        by_pkg = {a.package: a.display_name for a in apps}
        assert by_pkg["com.whatsapp"] == "Whatsapp"
        assert by_pkg["com.android.chrome"] == "Chrome"

    def test_header_lines_ignored(self):
        assert parse_brief_query("4 activities found:\n") == []


def test_prettify_package_uses_tail():
    assert prettify_package("com.google.android.youtube") == "Youtube"
