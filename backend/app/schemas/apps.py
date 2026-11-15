"""Application and launcher domain models."""
from __future__ import annotations

from pydantic import BaseModel, Field


class AppInfo(BaseModel):
    package: str
    display_name: str


class RegistryDiff(BaseModel):
    added: list[AppInfo] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)
    all_apps: list[AppInfo] = Field(default_factory=list)


class CustomDesktopItem(BaseModel):
    """A desktop item that is not an Android app (a folder): what the UI needs to draw it again after a restart."""

    name: str = Field(default="", max_length=120)
    type: str = Field(default="folder", max_length=24)
    app_ids: list[str] = Field(default_factory=list, max_length=300)


class AppLayoutEntry(BaseModel):
    """One desktop cell. `package` is an Android package, or a `custom-…` id whose content is in `custom`."""

    package: str
    position: int
    hidden: bool = False
    custom: CustomDesktopItem | None = None
