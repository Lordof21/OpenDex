"""Schema compatibility: a leftover settings.db with a foreign schema must be
backed up and rebuilt, never queried into 'no such column' errors (field bug)."""
import sqlite3

from app.schemas import KnownDevice, ProjectSettings
from app.storage import settings_db


async def test_init_migrates_incompatible_legacy_db(tmp_path):
    db_path = tmp_path / "settings.db"
    # Legacy file from an earlier experiment: same table name, different columns.
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE project_settings (key TEXT PRIMARY KEY, value TEXT)")
    conn.execute("INSERT INTO project_settings VALUES ('theme', 'dark')")
    conn.commit()
    conn.close()

    await settings_db.init(db_path)

    # Old file preserved as a backup, not destroyed.
    backups = list(tmp_path.glob("settings.db.bak-*"))
    assert len(backups) == 1

    # New schema fully functional end-to-end.
    settings = await settings_db.get_project_settings()
    assert settings == ProjectSettings()
    await settings_db.save_project_settings(
        ProjectSettings(dynamic_resolution_enabled=True)
    )
    assert (await settings_db.get_project_settings()).dynamic_resolution_enabled is True


async def test_init_keeps_compatible_db_and_its_data(tmp_path):
    db_path = tmp_path / "settings.db"
    await settings_db.init(db_path)
    await settings_db.save_project_settings(ProjectSettings(max_fps=30))

    await settings_db.init(db_path)  # re-init (app restart)

    assert list(tmp_path.glob("*.bak-*")) == []  # no false-positive migration
    assert (await settings_db.get_project_settings()).max_fps == 30


async def test_known_devices_crud(tmp_path):
    await settings_db.init(tmp_path / "settings.db")

    assert await settings_db.get_known_devices() == []
    assert await settings_db.get_known_device("abc123") is None

    older = KnownDevice(android_id="abc123", model="Pixel 8", last_seen_at=100.0, last_transport="usb")
    newer = KnownDevice(android_id="def456", model="Galaxy S24", last_seen_at=200.0, last_transport="wireless", last_known_ip="192.168.1.50")
    await settings_db.upsert_known_device(older)
    await settings_db.upsert_known_device(newer)

    devices = await settings_db.get_known_devices()
    assert [d.android_id for d in devices] == ["def456", "abc123"]  # most recently seen first

    fetched = await settings_db.get_known_device("abc123")
    assert fetched == older

    # Upsert overwrites the existing row for the same android_id.
    updated = older.model_copy(update={"last_seen_at": 300.0, "wireless_debugging_paired": True})
    await settings_db.upsert_known_device(updated)
    devices = await settings_db.get_known_devices()
    assert [d.android_id for d in devices] == ["abc123", "def456"]
    assert (await settings_db.get_known_device("abc123")).wireless_debugging_paired is True

    await settings_db.delete_known_device("abc123")
    assert await settings_db.get_known_device("abc123") is None
    assert [d.android_id for d in await settings_db.get_known_devices()] == ["def456"]


def test_audio_output_mode_speaks_the_route_words_and_reads_the_old_names():
    """Ses çıkışı ayarı rotalarla aynı sözlükte (pc = DeX, both = İkisi); eski kayıtlardaki "laptop"/"dual" okunurken çevrilir."""
    assert ProjectSettings().audio_output_mode == "pc"
    assert settings_db.load_project_settings('{"audio_output_mode": "laptop"}').audio_output_mode == "pc"
    assert settings_db.load_project_settings('{"audio_output_mode": "dual"}').audio_output_mode == "both"
    assert settings_db.load_project_settings('{"audio_output_mode": "phone"}').audio_output_mode == "phone"
    assert ProjectSettings(audio_output_mode="both").model_dump()["audio_output_mode"] == "both"      # saved in the new words
    # an unknown value still falls back to the default instead of failing every request that reads settings
    assert settings_db.load_project_settings('{"audio_output_mode": "speaker"}').audio_output_mode == "pc"


def test_the_default_route_of_an_app_follows_the_output_setting():
    from app.schemas.audio import default_route_for

    assert [default_route_for(m) for m in ("pc", "both", "phone")] == ["pc", "both", "phone"]
    assert default_route_for("both", enable_audio=False) == "phone"          # audio off: nothing to route
    assert default_route_for("whatever") == "pc"
