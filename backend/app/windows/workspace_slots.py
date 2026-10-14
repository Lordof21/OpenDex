"""Where an app's Workspace window was the last time — the Workspace is a space of its own.

An app that comes into the Workspace (sent from its own virtual-display window, taken in from the phone, or opened for the
first time in a later session) used to arrive at the size it had WHERE IT WAS: a phone-shaped box from the VD window, the
phone's whole screen from the phone. The Workspace has its own geometry (a fixed 1920×1080 canvas with freeform boxes in
it), so the app returns to ITS place there: the box and the density the user left it with. An app the Workspace has never
seen gets the Workspace's own default box, not its size from somewhere else.

The ledger lives in memory and is mirrored to the settings database (`workspace_slots`); a database that is not there (tests,
a store that failed) costs the memory of a previous RUN, never the move.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

TaskBounds = tuple[int, int, int, int]

MIN_W = 120
MIN_H = 90
DENSITY_MODES = ("auto", "manual")


@dataclass(frozen=True)
class WorkspaceSlot:
    bounds: TaskBounds
    density: int | None = None
    density_mode: str = "auto"

    def to_dict(self) -> dict[str, Any]:
        return {"bounds": list(self.bounds), "density": self.density, "density_mode": self.density_mode}

    @staticmethod
    def from_dict(raw: Any) -> "WorkspaceSlot | None":
        """A stored slot, or None when it does not hold a usable box (a hand-edited or old record never breaks a move)."""
        if not isinstance(raw, dict):
            return None
        box = raw.get("bounds")
        if not (isinstance(box, (list, tuple)) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
            return None
        left, top, right, bottom = (int(v) for v in box)
        if right - left < MIN_W or bottom - top < MIN_H:
            return None
        density = raw.get("density")
        mode = raw.get("density_mode")
        return WorkspaceSlot(
            bounds=(left, top, right, bottom),
            density=int(density) if isinstance(density, (int, float)) and density > 0 else None,
            density_mode=mode if mode in DENSITY_MODES else "auto",
        )


def fit_to_canvas(bounds: TaskBounds, canvas_w: int, canvas_h: int) -> TaskBounds:
    """The box moved (never resized beyond the canvas) so it lies inside the Workspace canvas: the canvas can be a different
    size than when the slot was stored."""
    left, top, right, bottom = bounds
    width = min(max(MIN_W, right - left), canvas_w)
    height = min(max(MIN_H, bottom - top), canvas_h)
    left = max(0, min(left, canvas_w - width))
    top = max(0, min(top, canvas_h - height))
    return (left, top, left + width, top + height)


class WorkspaceSlots:
    def __init__(
        self,
        load: Callable[[str], Awaitable[dict | None]] | None = None,
        save: Callable[[str, dict], Awaitable[None]] | None = None,
    ) -> None:
        self._load = load
        self._save = save
        self._memory: dict[str, WorkspaceSlot] = {}

    async def recall(self, package: str) -> WorkspaceSlot | None:
        """The app's last Workspace placement: this run's, else the stored one; None when it has never been placed."""
        if package in self._memory:
            return self._memory[package]
        if self._load is None:
            return None
        try:
            slot = WorkspaceSlot.from_dict(await self._load(package))
        except Exception as exc:  # noqa: BLE001 — no store, or a store that failed: the app simply has no memory
            log.debug("[WorkspaceSlots] %s okunamadı: %s", package, exc)
            return None
        if slot is not None:
            self._memory[package] = slot
        return slot

    async def remember(
        self, package: str, bounds: TaskBounds, density: int | None = None, density_mode: str | None = None,
    ) -> None:
        """Called where the USER's placement settles (a resize/density commit, the moment a task leaves the Workspace). The
        store write is AWAITED here (a few ms), not left to a background task: a write that outlives its caller's event
        loop leaves a database thread behind."""
        candidate = WorkspaceSlot.from_dict({"bounds": list(bounds), "density": density, "density_mode": density_mode})
        if candidate is None:
            return
        previous = self._memory.get(package)
        if previous is not None:
            # A write that carries no density keeps the one known (a pop-out reports the box only).
            candidate = WorkspaceSlot(
                candidate.bounds,
                candidate.density if candidate.density is not None else previous.density,
                candidate.density_mode if density_mode in DENSITY_MODES else previous.density_mode,
            )
            if candidate == previous:
                return
        self._memory[package] = candidate
        if self._save is None:
            return
        try:
            await self._save(package, candidate.to_dict())
        except Exception as exc:  # noqa: BLE001 — no store: the memory of THIS run is all there is
            log.debug("[WorkspaceSlots] %s yazılamadı: %s", package, exc)

