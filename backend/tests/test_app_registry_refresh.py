"""AppRegistry.refresh_registry ("Yenile"): it drops uninstalled PHONE apps from the saved layout, and nothing else.

OpenDeX's own desktop items (Settings, Files, the mirror) and the user's folders are never in the phone's launcher list; the refresh used
to take them for uninstalled apps and delete them from the saved layout.
"""
from types import SimpleNamespace

import pytest

from app.apps.app_registry import AppRegistry, is_desktop_only_item
from app.schemas import AppInfo, AppLayoutEntry
from app.schemas.apps import CustomDesktopItem
from app.storage import settings_db


@pytest.fixture
async def db(tmp_path):
    await settings_db.init(tmp_path / "settings.db")


class _Registry(AppRegistry):
    def __init__(self, installed):
        super().__init__(adb=None, settings=SimpleNamespace())
        self._installed = installed

    async def list_launcher_apps(self, serial, force=False):
        return [AppInfo(package="com.opendex.screen_mirror", display_name="Mirror")] + [AppInfo(package=p, display_name=p) for p in self._installed]


def test_which_items_live_only_on_the_desktop():
    assert is_desktop_only_item("com.opendex.settings")
    assert is_desktop_only_item("com.opendex.files")
    assert is_desktop_only_item("custom-17")
    assert not is_desktop_only_item("com.android.chrome")


async def test_refresh_keeps_builtin_items_and_folders_and_drops_only_uninstalled_phone_apps(db):
    await settings_db.save_app_layout("dev", [
        AppLayoutEntry(package="com.opendex.settings", position=0),
        AppLayoutEntry(package="com.opendex.files", position=34),
        AppLayoutEntry(package="custom-17", position=5, custom=CustomDesktopItem(name="Oyunlar", app_ids=["com.game"])),
        AppLayoutEntry(package="com.android.chrome", position=3),
        AppLayoutEntry(package="com.gone", position=4),
    ])

    diff = await _Registry(["com.android.chrome"]).refresh_registry("serial", "dev")

    assert diff.removed == ["com.gone"]
    saved = {e.package: e for e in await settings_db.get_app_layout("dev")}
    assert set(saved) == {"com.opendex.settings", "com.opendex.files", "custom-17", "com.android.chrome", "com.opendex.screen_mirror"}   # + the new item
    assert "com.gone" not in saved   # stays gone although the same refresh also added an item
    assert saved["com.opendex.files"].position == 34
    assert saved["custom-17"].custom.name == "Oyunlar"


async def test_refresh_with_nothing_uninstalled_leaves_the_layout_alone(db):
    layout = [AppLayoutEntry(package="com.opendex.settings", position=0), AppLayoutEntry(package="com.android.chrome", position=3)]
    await settings_db.save_app_layout("dev", layout)

    diff = await _Registry(["com.android.chrome"]).refresh_registry("serial", "dev")

    assert diff.removed == []
    assert [e.package for e in await settings_db.get_app_layout("dev")][:2] == ["com.opendex.settings", "com.android.chrome"]
