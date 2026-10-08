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


class AppLayoutEntry(BaseModel):
    package: str
    position: int
    hidden: bool = False
