"""The Workspace is a space of its own: an app comes into it at ITS last place, not at the size it had where it came from."""
from __future__ import annotations

import pytest

from app.config import Settings
from app.windows.eco_workspace import EcoWorkspaceManager, WorkspaceTask
from app.windows.workspace_slots import MIN_H, MIN_W, WorkspaceSlot, WorkspaceSlots, fit_to_canvas


class _Store:
    def __init__(self, rows=None, *, fail=False):
        self.rows = dict(rows or {})
        self.writes: list[tuple[str, dict]] = []
        self.fail = fail

    async def load(self, package):
        if self.fail:
            raise RuntimeError("settings_db.init() has not been called")
        return self.rows.get(package)

    async def save(self, package, slot):
        if self.fail:
            raise RuntimeError("settings_db.init() has not been called")
        self.writes.append((package, slot))
        self.rows[package] = slot


def _slots(store):
    return WorkspaceSlots(store.load, store.save)


# ---------------------------------------------------------------- the record


def test_a_stored_record_must_hold_a_usable_box():
    ok = WorkspaceSlot.from_dict({"bounds": [10, 20, 500, 400], "density": 260, "density_mode": "manual"})
    assert ok == WorkspaceSlot((10, 20, 500, 400), 260, "manual")
    assert WorkspaceSlot.from_dict({"bounds": [0, 0, MIN_W - 1, 400]}) is None        # narrower than a window can be
    assert WorkspaceSlot.from_dict({"bounds": [0, 0, 400, MIN_H - 1]}) is None
    assert WorkspaceSlot.from_dict({"bounds": "x"}) is None and WorkspaceSlot.from_dict(None) is None
    assert WorkspaceSlot.from_dict({"bounds": [0, 0, 400, 400], "density": -5, "density_mode": "weird"}) == WorkspaceSlot(
        (0, 0, 400, 400), None, "auto",
    )


def test_a_box_is_moved_inside_the_canvas_never_outside_it():
    assert fit_to_canvas((1700, 900, 2300, 1300), 1920, 1080) == (1320, 680, 1920, 1080)   # moved left/up, size kept
    assert fit_to_canvas((-50, -20, 400, 300), 1920, 1080) == (0, 0, 450, 320)
    assert fit_to_canvas((0, 0, 3000, 2000), 1920, 1080) == (0, 0, 1920, 1080)             # too big: the canvas itself


# ---------------------------------------------------------------- the memory


@pytest.mark.asyncio
async def test_an_app_remembers_where_it_was_and_the_store_keeps_it_for_the_next_run():
    store = _Store()
    slots = _slots(store)
    assert await slots.recall("com.app.a") is None

    await slots.remember("com.app.a", (100, 80, 900, 700), 260, "manual")

    assert await slots.recall("com.app.a") == WorkspaceSlot((100, 80, 900, 700), 260, "manual")
    assert store.writes == [("com.app.a", {"bounds": [100, 80, 900, 700], "density": 260, "density_mode": "manual"})]
    fresh = _slots(store)                                      # another run: memory is empty, the store answers
    assert await fresh.recall("com.app.a") == WorkspaceSlot((100, 80, 900, 700), 260, "manual")


@pytest.mark.asyncio
async def test_a_write_that_changes_nothing_is_not_written_and_a_missing_density_keeps_the_known_one():
    store = _Store()
    slots = _slots(store)
    await slots.remember("com.app.a", (100, 80, 900, 700), 260, "manual")
    await slots.remember("com.app.a", (100, 80, 900, 700), 260, "manual")
    assert len(store.writes) == 1

    await slots.remember("com.app.a", (200, 90, 1000, 800))   # a pop-out reports the box only
    assert await slots.recall("com.app.a") == WorkspaceSlot((200, 90, 1000, 800), 260, "manual")


@pytest.mark.asyncio
async def test_a_store_that_fails_costs_the_memory_of_a_previous_run_never_the_move():
    slots = _slots(_Store(fail=True))
    assert await slots.recall("com.app.a") is None
    await slots.remember("com.app.a", (100, 80, 900, 700), 260, "auto")      # does not raise
    assert await slots.recall("com.app.a") == WorkspaceSlot((100, 80, 900, 700), 260, "auto")   # this run still knows


# ---------------------------------------------------------------- where an app enters the Workspace


def _manager(store):
    mgr = EcoWorkspaceManager(
        None, settings=Settings(), events=None, sessions={}, serial_getter=lambda: None, profile_getter=lambda: None,
        start_video_pump=lambda session: None,
    )
    mgr._slots = _slots(store)
    return mgr


@pytest.mark.asyncio
async def test_an_app_the_workspace_never_saw_gets_the_workspaces_default_box_not_the_size_it_came_with():
    mgr = _manager(_Store())
    bounds, density, mode = await mgr._placement("com.app.a", None, None, None)
    assert bounds == EcoWorkspaceManager.DEFAULT_BOUNDS and density is None and mode is None


@pytest.mark.asyncio
async def test_an_app_returns_to_its_last_place_and_density_in_the_workspace():
    store = _Store({"com.app.a": {"bounds": [300, 100, 1100, 800], "density": 240, "density_mode": "manual"}})
    mgr = _manager(store)
    assert await mgr._placement("com.app.a", None, None, None) == ((300, 100, 1100, 800), 240, "manual")


@pytest.mark.asyncio
async def test_what_the_caller_asked_for_beats_the_memory_and_a_stale_box_is_moved_inside_the_canvas():
    store = _Store({"com.app.a": {"bounds": [1700, 900, 2300, 1300], "density": 240, "density_mode": "auto"}})
    mgr = _manager(store)
    assert (await mgr._placement("com.app.a", (10, 10, 500, 400), None, None))[0] == (10, 10, 500, 400)
    assert (await mgr._placement("com.app.a", None, None, None))[0] == (1320, 680, 1920, 1080)
    assert (await mgr._placement("com.app.a", None, 300, "manual"))[1:] == (300, "manual")


@pytest.mark.asyncio
async def test_the_place_is_remembered_when_a_task_leaves_the_workspace_or_is_resized():
    store = _Store()
    mgr = _manager(store)
    task = WorkspaceTask(
        window_id="w", package="com.app.a", task_id="1", bounds=(50, 60, 850, 760), density=220, density_mode="manual",
    )
    await mgr._remember_placement(task)
    assert await mgr.slots.recall("com.app.a") == WorkspaceSlot((50, 60, 850, 760), 220, "manual")
