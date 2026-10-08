"""allocate_fps() budget distribution + is_fully_occluded() intersection tests."""
from app.config import Settings
from app.schemas import DeviceProfile, WindowState
from app.windows.resource_budget import (
    FROZEN,
    allocate_fps,
    is_fully_occluded,
    smooth_fps_transition,
)


def _win(wid: str, *, x=0, y=0, w=800, h=600, z=1, minimized=False,
         mode="windowed", focused=False) -> WindowState:
    return WindowState(
        window_id=wid, package=f"com.app.{wid}", x=x, y=y, width=w, height=h,
        z_index=z, minimized=minimized, display_mode=mode, focused=focused,
    )


def _profile(limit: int) -> DeviceProfile:
    return DeviceProfile(android_id="test", encoder_limit=limit, android_api=34)


SETTINGS = Settings(ENABLE_FPS_TIERS=False, ENABLE_OCCLUSION_FREEZE=True)


class TestOcclusion:
    def test_maximized_window_on_top_occludes(self):
        below = _win("a", z=1)
        top = _win("b", z=2, mode="maximized")
        assert is_fully_occluded(below, [below, top]) is True

    def test_higher_windowed_fully_covering_occludes(self):
        below = _win("a", x=100, y=100, w=200, h=200, z=1)
        top = _win("b", x=50, y=50, w=400, h=400, z=2)
        assert is_fully_occluded(below, [below, top]) is True

    def test_partial_overlap_is_not_occlusion(self):
        below = _win("a", x=0, y=0, w=300, h=300, z=1)
        top = _win("b", x=150, y=150, w=300, h=300, z=2)
        assert is_fully_occluded(below, [below, top]) is False

    def test_lower_z_never_occludes(self):
        top = _win("a", z=5)
        below = _win("b", z=1, mode="maximized")
        assert is_fully_occluded(top, [top, below]) is False

    def test_minimized_cover_does_not_occlude(self):
        below = _win("a", z=1)
        top = _win("b", z=2, mode="maximized", minimized=True)
        assert is_fully_occluded(below, [below, top]) is False


class TestAllocateFps:
    def test_minimized_windows_are_frozen_and_release_sessions(self):
        windows = [_win("a", minimized=True), _win("b", z=2, focused=True)]
        alloc = allocate_fps(windows, _profile(1), SETTINGS)
        assert alloc["a"] == FROZEN
        assert alloc["b"] > 0  # minimize freed the only encoder session

    def test_budget_exhaustion_freezes_lowest_priority(self):
        # Non-overlapping windows: only the session budget decides, not occlusion.
        windows = [
            _win("focused", x=0, z=3, focused=True),
            _win("recent", x=900, z=2),
            _win("old", x=1800, z=1),
        ]
        alloc = allocate_fps(windows, _profile(2), SETTINGS)
        assert alloc["focused"] > 0
        assert alloc["recent"] > 0
        assert alloc["old"] == FROZEN

    def test_focused_window_always_wins_over_higher_z(self):
        windows = [_win("focused", x=0, z=1, focused=True), _win("other", x=900, z=9)]
        alloc = allocate_fps(windows, _profile(1), SETTINGS)
        assert alloc["focused"] > 0
        assert alloc["other"] == FROZEN

    def test_occluded_window_frozen_like_minimized(self):
        below = _win("below", z=1)
        top = _win("top", z=2, mode="maximized", focused=True)
        alloc = allocate_fps([below, top], _profile(2), SETTINGS)
        assert alloc["below"] == FROZEN
        assert alloc["top"] > 0

    def test_single_tier_mode_never_emits_intermediate_fps(self):
        """Plan "Açık Teknik Risk": until measured, only full fps or frozen."""
        windows = [_win(f"w{i}", z=i, focused=(i == 3)) for i in range(1, 4)]
        alloc = allocate_fps(windows, _profile(3), SETTINGS)
        assert set(alloc.values()) <= {60, FROZEN}


def test_smooth_fps_transition_ends_exactly_at_target():
    steps = list(smooth_fps_transition(60, 5, steps=4))
    assert steps[-1] == 5
    assert all(earlier >= later for earlier, later in zip(steps, steps[1:]))
