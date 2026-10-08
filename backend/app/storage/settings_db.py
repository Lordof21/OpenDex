"""Single-file SQLite persistence: project settings (global) plus
per-device rows keyed by ANDROID_ID (encoder profile, layout).
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import aiosqlite
from pydantic import ValidationError

from ..schemas import (
    AppAudioPref,
    AppLayoutEntry,
    AppLayoutRecord,
    DeviceProfile,
    DeviceProfileRecord,
    KnownDevice,
    KnownDeviceRecord,
    ProjectSettings,
    ProjectSettingsRecord,
)

log = logging.getLogger(__name__)

_db_path: Path | None = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS device_profiles (
    android_id TEXT PRIMARY KEY,
    data       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_layouts (
    android_id TEXT PRIMARY KEY,
    data       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_settings (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS known_devices (
    android_id TEXT PRIMARY KEY,
    data       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_audio_prefs (
    package TEXT PRIMARY KEY,
    data    TEXT NOT NULL
);
-- File system. `device` is '' for the PC so it can sit in a primary key.
CREATE TABLE IF NOT EXISTS fs_roots (
    path  TEXT PRIMARY KEY,
    added REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS fs_favorites (
    id       TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    device   TEXT NOT NULL DEFAULT '',
    path     TEXT NOT NULL,
    name     TEXT NOT NULL,
    position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fs_transfers (
    id       TEXT PRIMARY KEY,
    finished REAL NOT NULL,
    data     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fs_partials (
    provider TEXT NOT NULL,
    device   TEXT NOT NULL DEFAULT '',
    path     TEXT NOT NULL,
    job_id   TEXT NOT NULL,
    created  REAL NOT NULL,
    PRIMARY KEY (provider, device, path)
);
CREATE TABLE IF NOT EXISTS fs_trash (
    id         TEXT PRIMARY KEY,
    device     TEXT NOT NULL,
    original   TEXT NOT NULL,
    trash_path TEXT NOT NULL,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    is_dir     INTEGER NOT NULL,
    deleted    REAL NOT NULL
);
"""

# Columns each table must expose for this code to work. `CREATE TABLE IF NOT
# EXISTS` never touches an existing table, so a ~/.opendex/settings.db left
# behind by an earlier experiment with a different schema would otherwise fail
# at query time with "no such column".
_EXPECTED_COLUMNS: dict[str, set[str]] = {
    "device_profiles": {"android_id", "data"},
    "app_layouts": {"android_id", "data"},
    "project_settings": {"id", "data"},
    "known_devices": {"android_id", "data"},
    "app_audio_prefs": {"package", "data"},
    "fs_roots": {"path", "added"},
    "fs_favorites": {"id", "provider", "device", "path", "name", "position"},
    "fs_transfers": {"id", "finished", "data"},
    "fs_partials": {"provider", "device", "path", "job_id", "created"},
    "fs_trash": {"id", "device", "original", "trash_path", "name", "size", "is_dir", "deleted"},
}


async def _schema_is_compatible(db: aiosqlite.Connection) -> bool:
    for table, required in _EXPECTED_COLUMNS.items():
        cur = await db.execute(f"PRAGMA table_info({table})")
        rows = await cur.fetchall()
        if not rows:
            continue  # table absent — the schema script will create it
        columns = {row[1] for row in rows}
        if not required <= columns:
            return False
    return True


async def init(db_path: Path) -> None:
    global _db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    _db_path = db_path
    if db_path.exists():
        async with aiosqlite.connect(db_path) as db:
            compatible = await _schema_is_compatible(db)
        if not compatible:
            # Never destroy unknown data: move the incompatible file aside and
            # start fresh. Restoring the backup is a manual, deliberate act.
            backup = db_path.with_name(
                f"{db_path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
            )
            db_path.rename(backup)
            log.warning(
                "settings db had an incompatible schema; backed up to %s and recreated",
                backup,
            )
    async with aiosqlite.connect(_db_path) as db:
        await db.executescript(_SCHEMA)
        await db.commit()
    log.info("settings db ready at %s", db_path)


def _require_path() -> Path:
    if _db_path is None:
        raise RuntimeError("settings_db.init() has not been called")
    return _db_path


def connect() -> aiosqlite.Connection:
    """A connection to the settings database, for the modules that own their own tables (app/fs/store.py)."""
    return aiosqlite.connect(_require_path())


async def get_device_profile(android_id: str) -> DeviceProfile | None:
    async with aiosqlite.connect(_require_path()) as db:
        cur = await db.execute(
            "SELECT android_id, data FROM device_profiles WHERE android_id = ?", (android_id,)
        )
        row = await cur.fetchone()
    if not row:
        return None
    record = DeviceProfileRecord.from_row(row)
    return DeviceProfile.model_validate_json(record.data)


async def save_device_profile(android_id: str, profile: DeviceProfile) -> None:
    record = DeviceProfileRecord(android_id=android_id, data=profile.model_dump_json())
    async with aiosqlite.connect(_require_path()) as db:
        await db.execute(
            "INSERT INTO device_profiles (android_id, data) VALUES (?, ?) "
            "ON CONFLICT(android_id) DO UPDATE SET data = excluded.data",
            (record.android_id, record.data),
        )
        await db.commit()


async def get_app_layout(android_id: str) -> list[AppLayoutEntry]:
    async with aiosqlite.connect(_require_path()) as db:
        cur = await db.execute(
            "SELECT android_id, data FROM app_layouts WHERE android_id = ?", (android_id,)
        )
        row = await cur.fetchone()
    if not row:
        return []
    record = AppLayoutRecord.from_row(row)
    return [AppLayoutEntry.model_validate(e) for e in record.to_list()]


async def save_app_layout(android_id: str, layout: list[AppLayoutEntry]) -> None:
    record = AppLayoutRecord(
        android_id=android_id, data=json.dumps([e.model_dump() for e in layout])
    )
    async with aiosqlite.connect(_require_path()) as db:
        await db.execute(
            "INSERT INTO app_layouts (android_id, data) VALUES (?, ?) "
            "ON CONFLICT(android_id) DO UPDATE SET data = excluded.data",
            (record.android_id, record.data),
        )
        await db.commit()


async def get_project_settings() -> ProjectSettings:
    async with aiosqlite.connect(_require_path()) as db:
        cur = await db.execute("SELECT id, data FROM project_settings WHERE id = 1")
        row = await cur.fetchone()
    if not row:
        return ProjectSettings()
    record = ProjectSettingsRecord.from_row(row)
    return load_project_settings(record.data)


def load_project_settings(data: str) -> ProjectSettings:
    """Stored settings that no longer validate (a field gained bounds, a value was hand-edited) fall back FIELD BY
    FIELD to the defaults instead of failing every request that reads settings."""
    try:
        return ProjectSettings.model_validate_json(data)
    except ValidationError as exc:
        try:
            raw = json.loads(data)
        except ValueError:
            raw = None
        if not isinstance(raw, dict):
            log.warning("[settings] stored settings unreadable — defaults used")
            return ProjectSettings()
        bad = {err["loc"][0] for err in exc.errors() if err.get("loc")}
        log.warning("[settings] stored values out of range, reset to defaults: %s", ", ".join(sorted(map(str, bad))))
        for key in bad:
            raw.pop(key, None)
        try:
            return ProjectSettings.model_validate(raw)
        except ValidationError:
            return ProjectSettings()


async def save_project_settings(settings: ProjectSettings) -> None:
    record = ProjectSettingsRecord(id=1, data=settings.model_dump_json())
    async with aiosqlite.connect(_require_path()) as db:
        await db.execute(
            "INSERT INTO project_settings (id, data) VALUES (?, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            (record.id, record.data),
        )
        await db.commit()


async def get_known_devices() -> list[KnownDevice]:
    """Returns remembered devices (Cihaz Geçiş Planı §3.4), most recently seen first."""
    async with aiosqlite.connect(_require_path()) as db:
        cur = await db.execute("SELECT android_id, data FROM known_devices")
        rows = await cur.fetchall()
    devices = [KnownDevice.model_validate_json(KnownDeviceRecord.from_row(row).data) for row in rows]
    devices.sort(key=lambda d: d.last_seen_at, reverse=True)
    return devices


async def get_known_device(android_id: str) -> KnownDevice | None:
    async with aiosqlite.connect(_require_path()) as db:
        cur = await db.execute(
            "SELECT android_id, data FROM known_devices WHERE android_id = ?", (android_id,)
        )
        row = await cur.fetchone()
    if not row:
        return None
    return KnownDevice.model_validate_json(KnownDeviceRecord.from_row(row).data)


async def upsert_known_device(device: KnownDevice) -> None:
    record = KnownDeviceRecord(android_id=device.android_id, data=device.model_dump_json())
    async with aiosqlite.connect(_require_path()) as db:
        await db.execute(
            "INSERT INTO known_devices (android_id, data) VALUES (?, ?) "
            "ON CONFLICT(android_id) DO UPDATE SET data = excluded.data",
            (record.android_id, record.data),
        )
        await db.commit()


async def delete_known_device(android_id: str) -> None:
    async with aiosqlite.connect(_require_path()) as db:
        await db.execute("DELETE FROM known_devices WHERE android_id = ?", (android_id,))
        await db.commit()


async def get_app_audio_pref(package: str) -> AppAudioPref | None:
    """The user's explicit audio choice for `package`, None when it follows the default."""
    async with aiosqlite.connect(_require_path()) as db:
        cur = await db.execute("SELECT data FROM app_audio_prefs WHERE package = ?", (package,))
        row = await cur.fetchone()
    return AppAudioPref.model_validate_json(row[0]) if row else None


async def upsert_app_audio_pref(pref: AppAudioPref) -> None:
    async with aiosqlite.connect(_require_path()) as db:
        await db.execute(
            "INSERT INTO app_audio_prefs (package, data) VALUES (?, ?) "
            "ON CONFLICT(package) DO UPDATE SET data = excluded.data",
            (pref.package, pref.model_dump_json()),
        )
        await db.commit()
