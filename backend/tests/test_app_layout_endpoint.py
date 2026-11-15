"""GET/PUT /layout: the desktop's saved layout (apps AND the user's folders) survives a restart and is never answered with "empty" for
a phone that is simply not bound yet."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints import settings as ep
from app.schemas import AppLayoutEntry
from app.schemas.apps import CustomDesktopItem
from app.storage import settings_db


@pytest.fixture
async def db(tmp_path):
    await settings_db.init(tmp_path / "settings.db")


def _ctx(android_id="abc123"):
    return SimpleNamespace(android_id=android_id)


async def test_no_device_yet_is_a_conflict_not_an_empty_layout():
    with pytest.raises(HTTPException) as err:
        await ep.get_layout(_ctx(None))
    assert err.value.status_code == 409


async def test_put_without_a_device_is_a_conflict_too():
    with pytest.raises(HTTPException) as err:
        await ep.put_layout([AppLayoutEntry(package="a", position=0)], _ctx(None))
    assert err.value.status_code == 409


def test_old_entries_without_a_custom_item_still_load():
    entry = AppLayoutEntry.model_validate({"package": "com.android.chrome", "position": 3, "hidden": False})
    assert entry.custom is None


def test_a_folder_entry_keeps_its_name_and_apps():
    entry = AppLayoutEntry(
        package="custom-17", position=5,
        custom=CustomDesktopItem(name="Oyunlar", type="folder", app_ids=["com.a", "com.b"]),
    )
    again = AppLayoutEntry.model_validate(entry.model_dump())
    assert again.custom.name == "Oyunlar"
    assert again.custom.app_ids == ["com.a", "com.b"]


async def test_layout_with_a_folder_round_trips_through_sqlite(db):
    layout = [
        AppLayoutEntry(package="com.android.chrome", position=0),
        AppLayoutEntry(package="custom-17", position=5, custom=CustomDesktopItem(name="Oyunlar", app_ids=["com.a", "com.b"])),
        AppLayoutEntry(package="com.hidden", position=999, hidden=True),
    ]
    await ep.put_layout(layout, _ctx())

    saved = await ep.get_layout(_ctx())
    assert [e.package for e in saved] == ["com.android.chrome", "custom-17", "com.hidden"]
    assert saved[1].custom.name == "Oyunlar"
    assert saved[1].custom.app_ids == ["com.a", "com.b"]
    assert saved[0].custom is None


async def test_a_second_phone_has_its_own_layout(db):
    await ep.put_layout([AppLayoutEntry(package="a", position=1)], _ctx("phone-1"))
    assert await ep.get_layout(_ctx("phone-2")) == []
    assert [e.package for e in await ep.get_layout(_ctx("phone-1"))] == ["a"]
