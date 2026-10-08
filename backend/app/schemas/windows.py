"""Window and multi-display management domain models."""
from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, computed_field

from ..windows.task_locus import TaskLocus, locus_of


class VisibilityState(StrEnum):
    VISIBLE = "visible"
    MINIMIZED = "minimized"
    OCCLUDED = "occluded"


class WindowState(BaseModel):
    window_id: str
    package: str
    x: int = 0
    y: int = 0
    width: int
    height: int
    z_index: int = 0
    minimized: bool = False
    display_mode: Literal["maximized", "windowed"] = "windowed"
    visibility: VisibilityState = VisibilityState.VISIBLE
    focused: bool = False
    fps: int = 0
    frozen: bool = False
    handoff_to_phone: bool = False
    ws_url: str | None = None
    display_id: str | None = None
    stealth_phase: bool = False
    # Hibrit Pencereleme (Karar: Faz 3)
    workspace_id: str | None = None      # "eco" ise bu pencere Eco Workspace üyesidir
    task_bounds: list[int] | None = None # [l, t, r, b] — paylaşımlı canvas içindeki konum
    # task_bounds'un yaşadığı VD koordinat uzayı — frontend'in çerçeve
    # ölçeği bunu referans alır (stream boyutunu DEĞİL).
    workspace_vd_w: int | None = None
    workspace_vd_h: int | None = None
    render_scale: list[float] = Field(default_factory=lambda: [1.0, 1.0])
    task_density: int | None = None
    # "auto" (OpenDeX hesaplar) | "manual" (kullanıcı sabitledi) — bkz. eco_workspace.WorkspaceTask.density_mode
    task_density_mode: Literal["auto", "manual"] | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def locus(self) -> TaskLocus:
        """Görevin şu an yaşadığı ekran (desktop/workspace/phone) — türetilmiş,
        saklanmaz; bkz. windows/task_locus.py."""
        return locus_of(self.workspace_id, self.handoff_to_phone)


class WindowHandle(BaseModel):
    window_id: str
    package: str
    ws_url: str
    display_w: int
    display_h: int
    stealth_phase: bool = False
    workspace_id: str | None = None
    task_bounds: list[int] | None = None
    render_scale: list[float] = Field(default_factory=lambda: [1.0, 1.0])
    task_density: int | None = None
    task_density_mode: Literal["auto", "manual"] | None = None
    # A resize request that a newer one for the same window overtook while it waited for its turn (windows/resize_gate.py):
    # nothing reached the phone; display_w/h are the window's CURRENT stream. Not an error — the newer request applies.
    superseded: bool = False
    # The window's video pump ended while this resize waited for its confirmation (server stopped/died): nothing was
    # applied now; the asked size and density become the target of the window's next encoder start. Not an error.
    deferred: bool = False
