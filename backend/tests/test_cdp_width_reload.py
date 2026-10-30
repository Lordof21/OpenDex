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


def test_the_content_point_at_the_top_goes_with_the_state_into_the_restore():
    saved = {"url": "https://x.test/a", "scrollY": 29157, "containers": [], "anchor": {"p": "div:nth-of-type(3)", "f": 0.4}, "vw": 800}
    resume = cr._resume_state(saved)
    assert resume["a"] == {"p": "div:nth-of-type(3)", "f": 0.4} and resume["vw"] == 800
    script = cr._restore_script(resume)
    assert '"a": {"p": "div:nth-of-type(3)", "f": 0.4}' in script
    # a state without an anchor puts back by pixels as before
    assert '"a": null' in cr._restore_script({**resume, "a": None})
    assert '"a": null' in cr._restore_script({**resume, "a": {"f": 0.4}})   # no path: not usable


def test_the_page_side_restore_prefers_the_content_point_over_pixels():
    lib = cr._SCROLL_LIB_JS
    assert "const odxAnchor" in lib and "const odxApplyAnchor" in lib
    # fixed / sticky bars are not what the viewport top shows; the pixel offset stays the fallback
    assert "'fixed'" in lib and "'sticky'" in lib
    assert "saved.a && odxApplyAnchor(saved.a)" in lib and "window.scrollTo(0, saved.y)" in lib
