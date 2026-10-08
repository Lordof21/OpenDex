"""Event payloads and telemetry shapes."""
from __future__ import annotations

from enum import StrEnum


class ThermalLevel(StrEnum):
    NONE = "none"
    LIGHT = "light"
    MODERATE = "moderate"
    SEVERE = "severe"
    CRITICAL = "critical"
