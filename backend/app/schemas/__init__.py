"""OpenDeX Unified Schemas and Dataclasses Package.

Provides 100% backward-compatible re-exports for all domain schemas,
along with SQL entity dataclasses for database persistence.
"""
from __future__ import annotations

from .apps import AppInfo, AppLayoutEntry, RegistryDiff
from .audio import AUDIO_ROUTES, AppAudioPatch, AppAudioPref, AudioRoute, AudioSyncReport, default_route_for
from .devices import (
    DeviceInfo,
    DeviceProfile,
    DeviceState,
    EncoderStressTestResult,
    KnownDevice,
    KnownDeviceInfo,
)
from .events import ThermalLevel
from .notifications import (
    NotificationAction,
    NotificationCategory,
    NotificationImportance,
    RichNotificationItem,
)
from .identifiers import MEDIA_ACTIONS, PACKAGE_PATTERN, PACKAGE_RE, HostName, MediaAction, PackageName, is_package_name, require_package
from .settings import ProjectSettings
from .sql import (
    AppLayoutRecord,
    DeviceProfileRecord,
    KnownDeviceRecord,
    ProjectSettingsRecord,
    SqlTableMeta,
)
from .windows import VisibilityState, WindowHandle, WindowState

__all__ = [
    # Devices
    "DeviceState",
    "DeviceInfo",
    "DeviceProfile",
    "EncoderStressTestResult",
    "KnownDevice",
    "KnownDeviceInfo",
    # Apps
    "AppInfo",
    "RegistryDiff",
    "AppLayoutEntry",
    # Windows
    "VisibilityState",
    "WindowState",
    "WindowHandle",
    # Notifications
    "NotificationCategory",
    "NotificationImportance",
    "NotificationAction",
    "RichNotificationItem",
    # Settings
    "ProjectSettings",
    # Identifiers (validated before they reach a shell or the daemon protocol)
    "MEDIA_ACTIONS",
    "PACKAGE_PATTERN",
    "PACKAGE_RE",
    "HostName",
    "MediaAction",
    "PackageName",
    "is_package_name",
    "require_package",
    # Audio
    "AUDIO_ROUTES",
    "AppAudioPatch",
    "AppAudioPref",
    "AudioRoute",
    "AudioSyncReport",
    "default_route_for",
    # Events
    "ThermalLevel",
    # SQL Dataclasses
    "DeviceProfileRecord",
    "KnownDeviceRecord",
    "AppLayoutRecord",
    "ProjectSettingsRecord",
    "SqlTableMeta",
]
