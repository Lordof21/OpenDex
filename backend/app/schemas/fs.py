"""Request bodies of the file system API (api/v1/endpoints/fs.py). Responses are plain JSON documented in the plan."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

MAX_PATH = 4096


class FsLocation(BaseModel):
    provider: Literal["pc", "phone"]
    path: str = Field(min_length=1, max_length=MAX_PATH)
    device: str | None = Field(default=None, max_length=128)


class MkdirRequest(BaseModel):
    parent: FsLocation
    name: str = Field(min_length=1, max_length=512)


class RenameRequest(BaseModel):
    location: FsLocation
    name: str = Field(min_length=1, max_length=512)


class DeleteRequest(BaseModel):
    items: list[FsLocation] = Field(min_length=1, max_length=500)
    permanent: bool = False


class TransferRequest(BaseModel):
    op: Literal["copy", "move"]
    sources: list[FsLocation] = Field(min_length=1, max_length=5000)
    dest: FsLocation
    policy: Literal["ask", "replace", "skip", "keep_both", "replace_if_newer"] = "ask"
    verify: bool = False


class ResolveRequest(BaseModel):
    resolution: Literal["replace", "skip", "keep_both"]
    apply_to_all: bool = False


class FolderRequest(BaseModel):
    path: str = Field(min_length=1, max_length=MAX_PATH)


class FavoriteRequest(BaseModel):
    location: FsLocation
    name: str = Field(min_length=1, max_length=256)


class TrashRestoreRequest(BaseModel):
    device: str | None = None
    ids: list[str] = Field(min_length=1, max_length=500)


class TrashDeleteRequest(BaseModel):
    device: str | None = None
    ids: list[str] | None = Field(default=None, max_length=500)     # None: empty the whole bin


class GrantRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=200)


class OpenRequest(BaseModel):
    location: FsLocation
