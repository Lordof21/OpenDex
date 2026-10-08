"""SQL schema definitions and row/entity dataclasses for SQLite persistence."""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any


@dataclass
class DeviceProfileRecord:
    """Row representation for `device_profiles` table."""

    android_id: str
    data: str

    @classmethod
    def from_row(cls, row: tuple[str, str]) -> DeviceProfileRecord:
        return cls(android_id=row[0], data=row[1])

    def to_dict(self) -> dict[str, Any]:
        return json.loads(self.data)


@dataclass
class KnownDeviceRecord:
    """Row representation for `known_devices` table."""

    android_id: str
    data: str

    @classmethod
    def from_row(cls, row: tuple[str, str]) -> KnownDeviceRecord:
        return cls(android_id=row[0], data=row[1])

    def to_dict(self) -> dict[str, Any]:
        return json.loads(self.data)


@dataclass
class AppLayoutRecord:
    """Row representation for `app_layouts` table."""

    android_id: str
    data: str

    @classmethod
    def from_row(cls, row: tuple[str, str]) -> AppLayoutRecord:
        return cls(android_id=row[0], data=row[1])

    def to_list(self) -> list[dict[str, Any]]:
        return json.loads(self.data)


@dataclass
class ProjectSettingsRecord:
    """Row representation for `project_settings` table."""

    id: int
    data: str

    @classmethod
    def from_row(cls, row: tuple[int, str]) -> ProjectSettingsRecord:
        return cls(id=row[0], data=row[1])

    def to_dict(self) -> dict[str, Any]:
        return json.loads(self.data)


@dataclass(frozen=True)
class SqlTableMeta:
    """Metadata for SQL schema validation and table creation."""

    name: str
    create_sql: str
    required_columns: frozenset[str]
