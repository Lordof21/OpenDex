"""A page sized in script at the old window width is reloaded after a handoff that changes the width — and goes back to its content point."""
from __future__ import annotations

import pytest

from app.windows import cdp_refresher as cr


def test_the_verdict_needs_a_real_width_change_and_a_symptom():
    gaps = {"vw": 380, "gaps": 2, "over": 0}
    assert cr._width_reload_verdict(800, 380, gaps) is not None
    assert cr._width_reload_verdict(380, 800, {"vw": 800, "gaps": 0, "over": 3}) is not None
    assert cr._width_reload_verdict(800, 700, gaps) is None                       # under the ratio: a resize the page handles
    assert cr._width_reload_verdict(800, 380, {"vw": 380, "gaps": 0, "over": 0}) is None   # responsive: no symptom, no reload
    assert cr._width_reload_verdict(None, 380, gaps) is None
    assert cr._width_reload_verdict(800, 380, None) is None


# ------------------------------------------------------------------ the small gaps: only against the read of before the change
_FULL = {"vw": 380, "gaps": 0, "over": 0, "slack": []}                       # every px-sized box is filled by its content


def test_boxes_left_at_the_old_height_after_the_window_got_narrower_are_seen_however_small_the_gap():
    """Measured on the phone (2026-11-10): a reader keeps the tallest height a page ever had as its min-height; 380 -> 325 css px leaves
    102 px under each drawn page (610 of 713 filled). Under the coarse rule's ratio and its 120 px: never seen."""
    after = {"vw": 325, "gaps": 0, "over": 0, "slack": [0.856, 0.856, 0.855]}
    assert cr._width_reload_verdict(380, 325, after) is None
    reason = cr._narrowed_verdict(380, 325, after, _FULL)
    assert reason and "3 kutu" in reason and "380" in reason and "325" in reason


def test_a_gap_the_page_had_before_the_change_is_its_design():
    before = {"vw": 380, "gaps": 0, "over": 0, "slack": [0.86, 0.86]}
    after = {"vw": 325, "gaps": 0, "over": 0, "slack": [0.86, 0.86]}
    assert cr._narrowed_verdict(380, 325, after, before) is None
    assert cr._narrowed_verdict(380, 325, {**after, "slack": [0.86, 0.86, 0.86, 0.86]}, before) is not None     # two more than there were


def test_a_box_emptier_than_the_narrowing_explains_is_something_else():
    """Content scales with the width: 325 / 380 = 86% filled. A box a quarter filled did not get there by the window getting narrower."""
    assert cr._narrowed_verdict(380, 325, {"vw": 325, "gaps": 0, "over": 0, "slack": [0.25]}, _FULL) is None
    assert cr._narrowed_verdict(1067, 380, {"vw": 380, "gaps": 0, "over": 0, "slack": [0.475, 0.475]}, _FULL) is not None    # 1500 -> 713 px: the same reader, from a DeX window


@pytest.mark.parametrize("before_vw, now_vw", [(325, 380), (380, 380), (380, 376)])
def test_a_window_that_got_wider_or_kept_its_width_is_never_reloaded_for_small_gaps(before_vw, now_vw):
    """Wider: content grows past a minimum height, no trace is left — a gap that appears then is the page's own layout (text that wraps less)."""
    assert cr._narrowed_verdict(before_vw, now_vw, {"vw": now_vw, "gaps": 0, "over": 0, "slack": [0.86, 0.86]}, _FULL) is None


def test_without_the_read_of_before_nothing_is_concluded_from_small_gaps():
    after = {"vw": 325, "gaps": 0, "over": 0, "slack": [0.86]}
    assert cr._narrowed_verdict(380, 325, after, None) is None
    assert cr._narrowed_verdict(None, 325, after, _FULL) is None
    assert cr._narrowed_verdict(380, 325, None, _FULL) is None
    assert cr._narrowed_verdict(380, 325, {"vw": 325, "slack": "many"}, _FULL) is None


def test_an_element_newly_off_the_screen_counts_too():
    after = {"vw": 325, "gaps": 0, "over": 2, "slack": []}
    assert cr._narrowed_verdict(380, 325, after, {**_FULL, "over": 2}) is None
    assert "1 öğe" in cr._narrowed_verdict(380, 325, after, {**_FULL, "over": 1})


def test_the_capture_carries_what_the_boxes_were_like_and_what_a_reload_would_cost():
    saved = {"url": "https://x.test/a", "vw": 380, "scrollY": 900, "stale": _FULL, "dirty": True, "hasMedia": False}
    resume = cr._resume_state(saved)
    assert resume["stale"] == _FULL and resume["dirty"] is True and resume["media"] is False
    assert "stale: odxStale()" in __import__("inspect").getsource(cr.capture_browser_scroll_state)


def test_the_one_shot_nudge_no_longer_judges_stale_sizes_itself():
    """One place decides (the tab watcher, over several looks, against the read of before): the nudge's own single look is gone."""
    import inspect

    source = inspect.getsource(cr.refresh_browser_layout_inplace)
    assert "_narrowed_verdict(" not in source and "_width_reload_verdict(" not in source and "Page.reload" not in source
    assert not hasattr(cr, "_stale_width_reason") and not hasattr(cr, "_reload_and_restore")


_LOCATOR = {"v": 1, "prog": 0.4, "probes": [
    {"y": 0.0, "f": 0.4, "p": "div:nth-of-type(3)", "t": "the first words of a paragraph"},
    {"y": 0.333, "f": 0.1, "p": "div:nth-of-type(4)", "i": "004"},
]}


def test_the_locator_goes_with_the_state_into_the_restore():
    saved = {"url": "https://x.test/a", "scrollY": 29157, "containers": [], "locator": _LOCATOR, "vw": 800}
    resume = cr._resume_state(saved)
    assert resume["l"] == _LOCATOR and resume["vw"] == 800
    script = cr._restore_script(resume)
    assert '"l": {"v": 1, "prog": 0.4, "probes": [' in script
    # a state without a (usable) locator puts back by pixels
    assert '"l": null' in cr._restore_script({**resume, "l": None})
    assert '"l": null' in cr._restore_script({**resume, "l": {"v": 1, "probes": [{"f": 0.4}]}})   # a probe without a path: not usable


def test_the_page_side_restore_prefers_the_locator_over_pixels():
    lib = cr._SCROLL_LIB_JS
    assert "const odxLocator" in lib and "const odxApplyLocator" in lib
    assert "'fixed'" in lib and "'sticky'" in lib                  # a fixed bar is not what the screen shows at that point
    assert "saved.l ? odxApplyLocator(saved.l) : null" in lib and "if (saved.y && !placed" in lib and "top: saved.y, behavior: 'instant'" in lib
    assert "odxAnchor" not in lib and "odxApplyAnchor" not in lib   # one mechanism, not two


def test_a_reload_that_the_app_did_itself_gets_the_locator_of_before_the_move_too():
    """The page that reloaded itself reports the top: what was read BEFORE (y, containers, locator) is the truth for the same page."""
    import inspect

    assert '("t", "playing", "y", "c", "l")' in inspect.getsource(cr.BrowserTabAutoAttachWatcher)


def test_the_nudge_carries_a_locator_and_drops_one_that_is_malformed():
    script = cr._build_nudge_script({"isTop": False, "scrollY": 900, "locator": _LOCATOR})
    assert '"p": "div:nth-of-type(3)"' in script and '"i": "004"' in script
    assert "odxApplyLocator(savedLocator)" in script
    for bad in ({"v": 1, "probes": [{"y": 0.1, "f": "half", "p": "div"}]}, {"v": 2, "probes": []}, {"probes": [{"y": 0, "f": 0, "p": "p"}]}, "div", None):
        assert "const savedLocator = null;" in cr._build_nudge_script({"locator": bad})


def test_clean_locator_keeps_only_what_the_page_side_code_can_use():
    from app.windows.cdp_locator import clean_locator

    assert clean_locator(_LOCATOR) == {**_LOCATOR, "probes": [
        {"y": 0.0, "f": 0.4, "p": "div:nth-of-type(3)", "t": "the first words of a paragraph"},
        {"y": 0.333, "f": 0.1, "p": "div:nth-of-type(4)", "i": "004"},
    ]}
    many = {"v": 1, "probes": [{"y": 0.1 * i, "f": 0.5, "p": f"div:nth-of-type({i + 1})"} for i in range(9)]}
    assert len(clean_locator(many)["probes"]) == 3 and clean_locator(many)["prog"] is None     # at most three probes; no progress is not an error
    assert clean_locator({"v": 1, "probes": [{"y": True, "f": 0.5, "p": "div"}]}) is None      # a bool is not a number
    assert clean_locator({"v": 1, "probes": []}) is None and clean_locator([]) is None


def test_a_picture_page_is_placed_after_its_pictures_have_landed_within_a_short_cap():
    lib = cr._SCROLL_LIB_JS
    assert "const odxWaitForPictures" in lib and "await odxWaitForPictures(700, () => touched)" in lib   # ≤ 0.7 s, and the user's touch ends it
    assert "odxPictureHeavy(saved)" in lib


def test_one_new_box_or_boxes_filled_differently_are_a_layout_of_the_new_width_not_a_stale_one():
    """Measured on the phone (2026-11-10): a home page's mobile layout had one px-sized box its desktop layout had not — 'stale', reloaded."""
    assert cr._narrowed_verdict(1067, 380, {"vw": 380, "gaps": 0, "over": 0, "slack": [0.62]}, _FULL) is None
    assert cr._narrowed_verdict(1067, 380, {"vw": 380, "gaps": 0, "over": 0, "slack": [0.41, 0.62, 0.9]}, _FULL) is None
    assert cr._narrowed_verdict(1067, 380, {"vw": 380, "gaps": 0, "over": 0, "slack": [0.41, 0.62, 0.63]}, _FULL) is not None
