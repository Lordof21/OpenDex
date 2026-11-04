"""A page sized in script at the old window width is reloaded after a handoff that changes the width — and goes back to its content point."""
from __future__ import annotations

import json

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


class Cdp:
    """A tab that reports one width after another and what the layout check finds."""

    def __init__(self, widths, check):
        self.widths = list(widths)
        self.check = check
        self.sent: list[str] = []

    async def send(self, ws, method, params=None, *, req_id, timeout_s):
        expr = (params or {}).get("expression", "")
        self.sent.append(expr)
        if expr == "innerWidth":
            value = self.widths.pop(0) if len(self.widths) > 1 else self.widths[0]
        else:
            value = json.dumps(self.check)
        return {"result": {"result": {"value": value}}}


@pytest.fixture
def cdp(monkeypatch):
    def make(widths, check):
        fake = Cdp(widths, check)
        monkeypatch.setattr(cr, "_send_cdp", fake.send)
        return fake
    return make


@pytest.mark.asyncio
async def test_a_page_with_stale_sizes_after_a_narrower_window_is_reloaded(cdp):
    cdp([800, 380, 380], {"vw": 380, "gaps": 3, "over": 0})
    reason = await cr._stale_width_reason(object(), {"vw": 800, "url": "https://x.test/a"})
    assert reason and "800" in reason and "380" in reason


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "saved",
    [
        {"vw": 800, "hasMedia": True},          # a playing video is never cut by a reload
        {"vw": 800, "dirty": True},             # text typed into the page would be lost
        {"vw": None},
        {},
    ],
)
async def test_a_page_that_must_not_be_reloaded_is_left_alone(cdp, saved):
    cdp([380], {"vw": 380, "gaps": 3, "over": 0})
    assert await cr._stale_width_reason(object(), saved) is None


@pytest.mark.asyncio
async def test_the_same_width_costs_no_layout_read(cdp):
    fake = cdp([800], {"vw": 800, "gaps": 3, "over": 0})
    assert await cr._stale_width_reason(object(), {"vw": 800}) is None
    assert cr._STALE_LAYOUT_JS not in fake.sent


@pytest.mark.asyncio
async def test_a_responsive_page_is_not_reloaded_for_a_new_width(cdp):
    cdp([380, 380], {"vw": 380, "gaps": 0, "over": 0})
    assert await cr._stale_width_reason(object(), {"vw": 800}) is None


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
