"""Chrome handoff / reclaim: does the tab in front need a reload at all, and does its scroll survive one?

Measured on a phone (2026-10-21, Chrome 155): claude.ai scrolls an INNER container (window.scrollY is 0), so a plain reload sent it from 30% to
the bottom; the same address fetched under a mobile and a desktop user agent came back as the same page (a responsive site needs no reload);
YouTube (m. / www) is a real variant and keeps its video second and play state across the reload. These tests pin the decision and the
page-side scripts the cdp_refresher builds.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from unittest.mock import MagicMock, patch

import pytest

from app.windows import cdp_refresher as cr
from app.windows.cdp_refresher import (
    _build_nudge_script,
    _find_active_page_target,
    _probe_js,
    _probe_verdict,
    _restore_script,
    _retime_url,
    _tab_state_js,
    _variants_differ,
    capture_browser_scroll_state,
    soft_reload_active_tab,
    start_browser_auto_attach_watcher,
    stop_browser_auto_attach_watcher,
)

from test_cdp_layout_integration import FakeCdpAdb, FakeWebSocket

NATIVE = 513 / 160
KEY = "reload-decision-pkg"


@pytest.fixture(autouse=True)
def _forget_the_learned_scale_gain():
    cr._dpr_gain.clear()
    yield
    cr._dpr_gain.clear()


# --------------------------------------------------------------------------------------------------------------- fingerprints


def _fp(**over):
    base = {
        "s": 200, "h": "a.example", "u": "/watch", "v": "User-Agent", "n": 50_000,
        "vp": '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "tags": {"div": 300, "a": 120, "script": 10, "p": 40, "span": 90},
        "words": {"video": 30, "home": 12, "search": 9, "subscribe": 7, "channel": 6},
    }
    base.update(over)
    return base


def test_the_same_page_under_both_identities_is_not_a_variant():
    # claude.ai: one extra injected <script> and 1% more bytes, Vary: User-Agent — still the same page
    other = _fp(tags={"div": 300, "a": 120, "script": 11, "p": 40, "span": 90}, n=50_500)
    differs, why = _variants_differ(_fp(), other)
    assert differs is False and "yapı farkı" in why


@pytest.mark.parametrize("name, other", [
    ("a different structure", _fp(tags={"div": 90, "a": 20, "script": 4, "p": 10, "span": 15}, n=21_000)),
    ("a redirect to the other host", _fp(h="m.a.example")),
    ("a redirect to another path", _fp(u="/m/watch")),
    ("another viewport tag", _fp(vp='<meta name="viewport" content="width=1024">')),
    ("the same tags and other text", _fp(words={"mobile": 30, "menu": 12, "open": 9, "app": 7, "install": 6})),
])
def test_what_really_differs_between_identities_is_a_variant(name, other):
    differs, _ = _variants_differ(_fp(), other)
    assert differs is True, name


def test_the_list_of_loaded_scripts_and_styles_tells_two_variants_apart():
    """Measured on trendyol / hepsiburada / twitch / wikipedia: the two variants of a site load different bundles (noise there: 0%)."""
    bundles = ["/a.js", "/b.js", "/c.js", "/d.css", "/e.css"]
    assert _variants_differ(_fp(res=bundles), _fp(res=bundles))[0] is False
    differs, why = _variants_differ(_fp(res=bundles), _fp(res=["/m-a.js", "/m-b.js", "/c.js", "/m.css", "/e.css"]))
    assert differs is True and "kaynak farkı" in why
    # fewer than three addresses say nothing (a bare page): the other measurements decide
    assert _variants_differ(_fp(res=["/a.js"]), _fp(res=["/b.js"]))[0] is False
    assert _variants_differ(_fp(), _fp(res=bundles))[0] is False                       # absent on one side: not compared


@pytest.mark.parametrize("a, b", [
    (None, _fp()), (_fp(), None), (_fp(s=403), _fp()), (_fp(), _fp(s=500)), (_fp(tags={}), _fp(tags={})),
])
def test_a_measurement_that_cannot_be_trusted_says_cannot_tell(a, b):
    assert _variants_differ(a, b)[0] is None


def test_the_verdict_reloads_unless_the_page_is_proven_the_same_and_fits():
    same = {"fp": _fp(), "lay": {"iw": 380, "sw": 380}}
    assert _probe_verdict(_fp(), same, check_layout=True) == (False, _variants_differ(_fp(), _fp())[1])
    assert _probe_verdict(_fp(), {**same, "lay": {"iw": 380, "sw": 900}}, check_layout=True)[0] is True       # does not fit the phone
    assert _probe_verdict(_fp(), {**same, "lay": {"iw": 380, "sw": 900}}, check_layout=False)[0] is False     # a window does not check
    assert _probe_verdict(_fp(), {"err": "identity-not-applied"}, check_layout=True)[0] is True
    assert _probe_verdict(_fp(), None, check_layout=True)[0] is True
    assert _probe_verdict(None, same, check_layout=True)[0] is True


# --------------------------------------------------------------------------------------------------------------- page-side scripts


def _node():
    return shutil.which("node")


@pytest.mark.skipif(_node() is None, reason="node is needed to compile the generated page scripts")
def test_every_generated_page_script_compiles():
    """The scripts are built in Python strings (f-strings, escaped braces) and only run on the phone: a typo fails silently there."""
    scripts = {
        "state": _tab_state_js(True, with_fp=True),
        "state_waiting": _tab_state_js(False, wait_ms=350, with_fp=True),
        "probe_phone": _probe_js(True),
        "probe_window": _probe_js(False),
        "nudge": _build_nudge_script({"isTop": False, "scrollX": 0, "scrollY": 5, "ratio": 0.3, "anchorPath": "div#a > p",
                                      "containers": [{"p": "main > div:nth-of-type(2)", "r": 0.3}]}),
        "nudge_empty": _build_nudge_script(None),
        "restore": _restore_script({"t": 12.5, "playing": True, "y": 3, "url": "https://a.example/watch?v=1", "c": [{"p": None, "r": 0.3}]}),
    }
    check = "const vm=require('vm');const s=JSON.parse(require('fs').readFileSync(0,'utf8'));for(const v of Object.values(s)){new vm.Script(v);}"
    done = subprocess.run([_node(), "-e", check], input=json.dumps(scripts), capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stderr


def test_the_nudge_leaves_a_freshly_loaded_page_alone_and_relocks_containers_on_an_old_one():
    script = _build_nudge_script({"isTop": False, "scrollX": 0, "scrollY": 0, "containers": [{"p": "main", "r": 0.3}]})
    assert "const fresh = performance.now() < 8000;" in script
    assert "if (fresh) {" in script and "freshCalls" not in script
    assert 'const savedContainers = [{"p": "main", "r": 0.3}];' in script
    assert "odxApplyOnce({ c: savedContainers })" in script
    assert "const savedContainers = [];" in _build_nudge_script(None)


def test_the_restore_after_a_reload_has_one_writer_and_does_not_wait_for_a_video_that_never_comes():
    script = _restore_script({"t": None, "playing": None, "y": 0, "url": "https://a.example/chat/1", "c": [{"p": "main", "r": 0.3}]})
    assert "odxRestoreAll(saved)" in script and "Promise.all([video(),scroll()])" in script
    assert "if(!v&&i>=12&&saved.t==null)return;" in script                      # no video after ~3 s AND none before: stop looking
    # a page that HAD a video keeps waiting for it (a slow YouTube on a busy phone brings its player up late)
    assert "if(!v&&i>=12)return;" not in script
    assert '"c": [{"p": "main", "r": 0.3}]' in script
    assert "if(saved.y)window.scrollTo(0,saved.y);" not in script               # the container-aware restore owns the window scroll too


@pytest.mark.asyncio
async def test_the_scroll_capture_reads_inner_containers_too():
    fake_adb = FakeCdpAdb()
    tabs_json = json.dumps([{"id": "t", "title": "Chat", "type": "page", "url": "https://claude.ai/chat/1",
                             "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/t"}])
    ws = FakeWebSocket("t", is_visible=True, custom_eval_response=json.dumps({"scrollY": 0, "isTop": True, "containers": [{"r": 0.3}]}))
    with patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: tabs_json.encode())), patch("websockets.connect", return_value=ws):
        state = await capture_browser_scroll_state(fake_adb, "SER", "chrome_devtools_remote")
    assert state["containers"] == [{"r": 0.3}]
    sent = [m["params"]["expression"] for m in ws.sent_messages if m.get("method") == "Runtime.evaluate"][-1]
    assert "containers: odxCapture()" in sent and "const odxScrollers" in sent


# --------------------------------------------------------------------------------------------------------------- front tab


class _BlinkingWebSocket(FakeWebSocket):
    """Reports hidden for its first `hidden_for` answers, then visible (the browser lags a moment behind an app's task move)."""

    def __init__(self, tab_id, hidden_for):
        super().__init__(tab_id, is_visible=False)
        self.hidden_for = hidden_for
        self.asked = 0

    async def recv(self):
        if self.sent_messages and "document.visibilityState" in self.sent_messages[-1].get("params", {}).get("expression", ""):
            self.asked += 1
            self.is_visible = self.asked > self.hidden_for
        return await super().recv()


def _pages(count):
    return [{"id": f"tab_{i}", "title": f"T{i}", "type": "page", "url": f"https://s{i}.example/",
             "webSocketDebuggerUrl": f"ws://127.0.0.1:9222/devtools/page/tab_{i}"} for i in range(count)]


@pytest.mark.asyncio
async def test_a_tab_that_turns_visible_a_moment_late_is_still_found_as_the_one_in_front():
    sockets = {"tab_0": FakeWebSocket("tab_0", is_visible=False), "tab_1": _BlinkingWebSocket("tab_1", hidden_for=1)}
    with patch("websockets.connect", side_effect=lambda url, *a, **kw: sockets[url.rsplit("/", 1)[-1]]):
        found = await _find_active_page_target(9222, _pages(2), timeout_s=0.8)
    assert found["id"] == "tab_1"                                              # not the first-in-list fallback


# --------------------------------------------------------------------------------------------------------------- soft reload


class _ReloadingWebSocket:
    """A tab that answers the scroll capture and, after Page.reload, announces its load event."""

    def __init__(self, capture):
        self.capture = capture
        self.sent_messages: list[dict] = []
        self.queue: asyncio.Queue = asyncio.Queue()

    async def send(self, data):
        msg = json.loads(data)
        self.sent_messages.append(msg)
        expression = msg.get("params", {}).get("expression", "")
        if msg["method"] == "Runtime.evaluate" and "JSON.stringify({ y:" in expression:
            self.queue.put_nowait({"id": msg["id"], "result": {"result": {"value": json.dumps(self.capture)}}})
        else:
            self.queue.put_nowait({"id": msg["id"], "result": {}})
        if msg["method"] == "Page.reload":
            self.queue.put_nowait({"method": "Page.loadEventFired", "params": {}})

    async def recv(self):
        return json.dumps(await self.queue.get())

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.mark.asyncio
async def test_the_users_reload_button_puts_the_scroll_back_where_it_was():
    capture = {"y": 0, "url": "https://claude.ai/chat/1", "c": [{"p": "main > div", "r": 0.3, "t": 8000, "h": 27000, "c": 685}]}
    tabs = json.dumps([{"id": "fg", "title": "Claude", "type": "page", "url": "https://claude.ai/chat/1",
                        "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/fg"}])
    ws = _ReloadingWebSocket(capture)
    with patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: tabs.encode())), patch("websockets.connect", return_value=ws):
        reloaded = await soft_reload_active_tab(FakeCdpAdb(), "SER", "chrome_devtools_remote")
    assert reloaded == {"title": "Claude", "url": "https://claude.ai/chat/1"}
    methods = [m.get("method") for m in ws.sent_messages]
    assert methods.index("Page.enable") < methods.index("Page.reload")
    restore = [m for m in ws.sent_messages if m.get("method") == "Runtime.evaluate" and "odxRestoreAll(saved)" in m["params"].get("expression", "")]
    assert len(restore) == 1 and '"r": 0.3' in restore[0]["params"]["expression"]


# --------------------------------------------------------------------------------------------------------------- the watcher's decision


class _ReactiveBrowser:
    """A browser that answers like the real one: tabs, their state questions (the first, and the second that waits for visibility) and the
    measurement. `probe=None`: the measurement never answers."""

    def __init__(self, tabs, probe=None, dpr_factor=None):
        self.tabs = tabs                  # targetId -> {"session", "url", "state", "state2"?}
        self.probe = probe
        self.dpr_factor = dpr_factor      # what Chrome multiplies a device-scale override by (None: the page does not answer the dpr question)
        self.last_scale: dict[str, float] = {}
        self.sent: list[dict] = []
        self.queue: asyncio.Queue = asyncio.Queue()

    def _answer(self, message_id, value=None):
        result = {} if value is None else {"result": {"value": json.dumps(value)}}
        self.queue.put_nowait({"id": message_id, "result": result})

    def _answer_number(self, message_id, number):
        self.queue.put_nowait({"id": message_id, "result": {"result": {"value": number}}})

    async def send(self, data):
        msg = json.loads(data)
        self.sent.append(msg)
        mid, method, sid, params = msg.get("id"), msg.get("method"), msg.get("sessionId"), msg.get("params", {})
        if method == "Emulation.setDeviceMetricsOverride" and sid:
            self.last_scale[sid] = params["deviceScaleFactor"]
        if method == "Target.getTargets":
            self.queue.put_nowait({"id": mid, "result": {"targetInfos": [
                {"targetId": t, "type": "page", "url": tab["url"]} for t, tab in self.tabs.items()]}})
        elif method == "Target.attachToTarget":
            tab = self.tabs[params["targetId"]]
            self.queue.put_nowait({"id": mid, "result": {}})
            self.queue.put_nowait({"method": "Target.attachedToTarget", "params": {
                "sessionId": tab["session"], "waitingForDebugger": False,
                "targetInfo": {"targetId": params["targetId"], "type": "page", "url": tab["url"]}}})
        elif method == "Runtime.evaluate" and sid:
            expression = params.get("expression", "")
            tab = next(t for t in self.tabs.values() if t["session"] == sid)
            if "window.devicePixelRatio" in expression:
                if self.dpr_factor is not None:
                    self._answer_number(mid, self.last_scale.get(sid, 1.0) * self.dpr_factor)
            elif "identity-not-applied" in expression:
                if self.probe is not None:
                    self._answer(mid, self.probe)
            elif "const vis = " in expression:
                state = tab.get("state2") if f"setTimeout(r, {cr._FRONT_WAIT_MS})" in expression else tab["state"]
                if state is not None:
                    self._answer(mid, state)
        else:
            self.queue.put_nowait({"id": mid, "result": {}})

    async def recv(self):
        return json.dumps(await self.queue.get())

    async def close(self):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def methods(self, session):
        return [m["method"] for m in self.sent if m.get("sessionId") == session]

    def evaluates(self, session, needle):
        return [m for m in self.sent if m.get("sessionId") == session and m.get("method") == "Runtime.evaluate"
                and needle in m["params"].get("expression", "")]


_VERSION = json.dumps({
    "Browser": "Chrome/155.0.8059.39",
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser",
})
_STATE = {"mobile": False, "visible": True, "t": None, "playing": None, "y": 0, "url": "https://a.example/watch", "host": "a.example",
          "c": [{"p": "main", "r": 0.3, "t": 800, "h": 3000, "c": 700}], "fp": _fp()}
_SAME = {"lay": {"iw": 380, "sw": 380}, "fp": _fp()}


async def _watch(browser, *, settle_s=2.0, mode="mobile", phone_dpr=NATIVE, window_dpr=None, place="phone"):
    with patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: _VERSION.encode())), patch("websockets.connect", return_value=browser):
        watcher = start_browser_auto_attach_watcher(
            FakeCdpAdb(), "SERIAL_123", "chrome_devtools_remote", KEY, phone_dpr if mode == "mobile" and place == "phone" else window_dpr, mode, place,
        )
        assert await watcher.wait_ready()
        settled = await watcher.wait_settled(settle_s)
        await asyncio.sleep(0.05)
    return watcher, settled


async def _stop():
    """Stops the watcher and lets its clean-up finish before the test's event loop goes away."""
    stop_browser_auto_attach_watcher(KEY)
    await asyncio.sleep(0.3)


def _tab(state=None, **kw):
    return {"session": "S_A", "url": "https://a.example/watch", "state": {**_STATE, **(state or {})}, **kw}


@pytest.mark.asyncio
async def test_a_page_that_is_the_same_under_both_identities_is_not_reloaded():
    browser = _ReactiveBrowser({"TAB_A": _tab()}, probe=_SAME)
    try:
        _, settled = await _watch(browser)
        methods = browser.methods("S_A")
        assert settled is True
        assert "Page.reload" not in methods and "Page.navigate" not in methods
        assert len(browser.evaluates("S_A", "identity-not-applied")) == 1       # it was measured, once
        by_method = {m["method"]: m["params"] for m in browser.sent if m.get("sessionId") == "S_A"}
        assert by_method["Emulation.setDeviceMetricsOverride"]["mobile"] is True      # identity and scale are set all the same
        assert "Emulation.setUserAgentOverride" in methods
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_a_page_that_differs_under_the_new_identity_is_reloaded_and_its_scroll_sent_back():
    different = {"lay": {"iw": 380, "sw": 380}, "fp": _fp(tags={"div": 90, "a": 20, "script": 4, "p": 10, "span": 15}, n=21_000)}
    browser = _ReactiveBrowser({"TAB_A": _tab()}, probe=different)
    try:
        await _watch(browser, settle_s=0.3)
        assert "Page.reload" in browser.methods("S_A")
        # once it has loaded, the container position goes back (the state the tab reported before the reload)
        browser.queue.put_nowait({"method": "Page.loadEventFired", "sessionId": "S_A", "params": {}})
        await asyncio.sleep(0.1)
        restore = browser.evaluates("S_A", "odxRestoreAll(saved)")
        assert len(restore) == 1 and '"r": 0.3' in restore[0]["params"]["expression"]
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_a_page_that_does_not_fit_the_phone_is_reloaded_even_if_it_is_the_same_page():
    browser = _ReactiveBrowser({"TAB_A": _tab()}, probe={"lay": {"iw": 380, "sw": 980}, "fp": _fp()})
    try:
        await _watch(browser, settle_s=0.3)
        assert "Page.reload" in browser.methods("S_A")
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_a_measurement_that_never_answers_ends_in_a_reload(monkeypatch):
    monkeypatch.setattr(cr, "_PROBE_TIMEOUT_S", 0.15)
    browser = _ReactiveBrowser({"TAB_A": _tab()}, probe=None)
    try:
        await _watch(browser, settle_s=0.05)
        assert "Page.reload" not in browser.methods("S_A")                      # still waiting
        await asyncio.sleep(0.3)
        assert "Page.reload" in browser.methods("S_A")
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_a_tab_without_a_baseline_is_reloaded_at_once_like_before():
    browser = _ReactiveBrowser({"TAB_A": _tab({"fp": None})}, probe=_SAME)
    try:
        await _watch(browser, settle_s=0.3)
        assert "Page.reload" in browser.methods("S_A")
        assert browser.evaluates("S_A", "identity-not-applied") == []
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_with_the_measurement_switched_off_every_wrong_site_tab_is_reloaded(monkeypatch):
    monkeypatch.setattr(cr, "_SKIP_REDUNDANT_RELOAD", False)
    browser = _ReactiveBrowser({"TAB_A": _tab()}, probe=_SAME)
    try:
        await _watch(browser, settle_s=0.3)
        assert "Page.reload" in browser.methods("S_A")
        assert browser.evaluates("S_A", "identity-not-applied") == []
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_a_certain_reason_reloads_without_asking_the_page():
    """The mobile host in a window, or the desktop flag in the address (YouTube app=desktop): no measurement is needed or trusted."""
    browser = _ReactiveBrowser({"TAB_A": _tab({"mobile": True, "host": "m.a.example", "url": "https://m.a.example/watch"})}, probe=_SAME)
    try:
        await _watch(browser, settle_s=0.3, mode="desktop")
        assert "Page.reload" in browser.methods("S_A") and browser.evaluates("S_A", "identity-not-applied") == []
    finally:
        await _stop()

    flagged = "https://www.youtube.com/watch?app=desktop&v=1"
    browser = _ReactiveBrowser({"TAB_A": _tab({"url": flagged, "host": "www.youtube.com"})}, probe=_SAME)
    try:
        await _watch(browser, settle_s=0.3)
        nav = [m for m in browser.sent if m.get("sessionId") == "S_A" and m.get("method") == "Page.navigate"]
        assert [m["params"]["url"] for m in nav] == ["https://www.youtube.com/watch?v=1"]
        assert "Page.reload" not in browser.methods("S_A") and browser.evaluates("S_A", "identity-not-applied") == []
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_a_tab_that_says_hidden_is_asked_again_and_treated_as_the_front_tab_once_it_turns_visible():
    """Right after the app's task moved, the browser can still call its front tab hidden: the second question lets the page wait for its
    visibility instead of leaving the tab on the wrong site."""
    tab = _tab({"visible": False}, state2={**_STATE, "visible": True})
    browser = _ReactiveBrowser({"TAB_A": tab}, probe={"lay": {"iw": 380, "sw": 380}, "fp": _fp(h="m.a.example")})
    try:
        await _watch(browser, settle_s=0.3)
        assert len(browser.evaluates("S_A", f"setTimeout(r, {cr._FRONT_WAIT_MS})")) == 1
        assert "Page.reload" in browser.methods("S_A")
        metrics = [m["params"] for m in browser.sent if m.get("method") == "Emulation.setDeviceMetricsOverride"]
        assert metrics[0]["mobile"] is False and metrics[-1]["mobile"] is True       # hidden: as it was; in front: as the phone's site
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_hidden_tabs_stop_holding_the_settle_once_the_front_tab_is_known():
    hidden = {"session": "S_H", "url": "https://h.example/", "state": {**_STATE, "visible": False}}      # never answers its second question
    front = {"session": "S_F", "url": "https://f.example/", "state": {**_STATE, "mobile": True, "visible": True, "fp": None}}
    browser = _ReactiveBrowser({"TAB_H": hidden, "TAB_F": front}, probe=_SAME)
    try:
        _, settled = await _watch(browser, settle_s=1.0)
        assert settled is True
        assert "Page.reload" not in browser.methods("S_H") and "Page.reload" not in browser.methods("S_F")
    finally:
        await _stop()


# --------------------------------------------------------------------------------------------------------------- the video's second


@pytest.mark.parametrize("url, seconds, expected", [
    ("https://m.youtube.com/watch?v=X&t=21s&pp=1", 62.4, "https://m.youtube.com/watch?v=X&t=62s&pp=1"),
    ("https://a.example/v?start=10", 62, "https://a.example/v?start=62"),
    ("https://a.example/v?time_continue=5", 7.9, "https://a.example/v?time_continue=7"),
    ("https://a.example/v?t=1m2s", 130, "https://a.example/v?t=130s"),
    ("https://a.example/v?t=90", 12, "https://a.example/v?t=12"),
    ("https://a.example/v?v=1", 62, None),                    # no start-time parameter: nothing to rewrite
    ("https://a.example/v?v=1&t=62s", 62.9, None),           # already that second
    ("https://a.example/v?t=21s", None, None),
    ("https://a.example/v?t=21s", -3, None),
    ("https://a.example/v?t=21s", True, None),
])
def test_the_start_time_of_an_address_is_set_to_the_second_the_video_is_at(url, seconds, expected):
    assert _retime_url(url, seconds) == expected


@pytest.mark.asyncio
async def test_a_reload_starts_the_video_at_its_current_second_not_at_the_one_in_the_address():
    """Measured on YouTube: the restore put the video at 62 s, then the site applied the address' t=21s and sent it back."""
    state = {"mobile": True, "host": "m.youtube.com", "url": "https://m.youtube.com/watch?v=1&t=21s", "t": 62.4}
    browser = _ReactiveBrowser({"TAB_A": _tab(state)}, probe=_SAME)
    try:
        await _watch(browser, settle_s=0.3, mode="desktop")
        nav = [m for m in browser.sent if m.get("sessionId") == "S_A" and m.get("method") == "Page.navigate"]
        assert [m["params"]["url"] for m in nav] == ["https://m.youtube.com/watch?v=1&t=62s"]
        assert "Page.reload" not in browser.methods("S_A")
    finally:
        await _stop()

    flagged = {"url": "https://www.youtube.com/watch?app=desktop&v=1&t=21s", "host": "www.youtube.com", "t": 62.4}
    browser = _ReactiveBrowser({"TAB_A": _tab(flagged)}, probe=_SAME)
    try:
        await _watch(browser, settle_s=0.3)
        nav = [m for m in browser.sent if m.get("sessionId") == "S_A" and m.get("method") == "Page.navigate"]
        assert [m["params"]["url"] for m in nav] == ["https://www.youtube.com/watch?v=1&t=62s"]       # the flag is dropped AND the second set
    finally:
        await _stop()


def test_the_restore_keeps_watching_the_video_and_puts_it_back_when_the_site_sends_it_back():
    script = _restore_script({"t": 62.4, "playing": True, "y": 0, "url": "https://m.youtube.com/watch?v=1&t=21s", "c": []})
    assert "v.currentTime<saved.t-2" in script                                   # the safety net against a site's own start time
    assert "if(moved&&" not in script or "now-moved>12000" in script
    assert "if(now-moved>12000)break;" in script and "now-moved<4500" in script  # watched for 12 s, play state held for ~4 s


_NUDGE_HARNESS = r"""
const vm = require('vm');
const { script } = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const run = (now) => {
  const events = []; const timers = []; let scrolls = 0;
  const win = { dispatchEvent: (e) => events.push(e.type), scrollTo: () => { scrolls++; }, scrollX: 0, scrollY: 0, innerHeight: 600 };
  const doc = { documentElement: { style: {}, scrollHeight: 1000 }, body: { style: {} }, activeElement: null,
                querySelector: () => null, createTreeWalker: () => ({ nextNode: () => null }) };
  const ctx = { window: win, document: doc, performance: { now: () => now }, setTimeout: (f) => { timers.push(f); return 0; },
                Event: class { constructor(t) { this.type = t; } }, NodeFilter: { SHOW_ELEMENT: 1 }, getComputedStyle: () => ({ overflowY: 'visible' }),
                CSS: { escape: (s) => s } };
  vm.runInNewContext(script, ctx);
  timers.forEach((f) => f());
  return { events, scrolls };
};
console.log(JSON.stringify({ fresh: run(120), old: run(60000) }));
"""


@pytest.mark.skipif(_node() is None, reason="node is needed to run the generated nudge")
def test_the_nudge_tells_a_fresh_page_about_every_viewport_phase_but_never_moves_its_scroll():
    """Android settles a display / density change a few hundred ms late and a page lays out from the LAST resize it hears (a left-aligned
    layout with a gap on the right, a YouTube player of the wrong size). A page that was just reloaded still gets all four phases — only its
    scroll is left to the reload's own restore. A page that has been open for a while also gets its scroll locked."""
    script = _build_nudge_script({"isTop": False, "scrollX": 0, "scrollY": 500, "ratio": 0.4, "anchorPath": None})
    done = subprocess.run([_node(), "-e", _NUDGE_HARNESS], input=json.dumps({"script": script}), capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stderr
    result = json.loads(done.stdout)
    four_phases = ["resize", "orientationchange"] * 4                    # now, 80 ms, 250 ms, 600 ms
    assert result["fresh"] == {"events": four_phases, "scrolls": 0}
    assert result["old"]["events"] == four_phases and result["old"]["scrolls"] >= 4


# --------------------------------------------------------------------------------------------------------------- the window's real scale


def _metrics(browser, session):
    return [m["params"] for m in browser.sent if m.get("sessionId") == session and m.get("method") == "Emulation.setDeviceMetricsOverride"]


@pytest.mark.asyncio
async def test_a_window_runs_its_tabs_at_the_windows_real_scale_not_at_chromes_x1_2():
    """Measured: a 1920 px window at 160 dpi laid out at 1600 css px (dpr 1.2) because the Chrome process was in tablet mode."""
    browser = _ReactiveBrowser({"TAB_A": _tab({"mobile": True})}, probe=_SAME)
    try:
        await _watch(browser, settle_s=0.3, mode="desktop", window_dpr=1.0, place="window")
        assert _metrics(browser, "S_A")[-1] == {"width": 0, "height": 0, "deviceScaleFactor": 1.0, "mobile": False}
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_without_a_window_density_a_window_tab_gets_no_scale():
    browser = _ReactiveBrowser({"TAB_A": _tab({"mobile": True})}, probe=_SAME)
    try:
        await _watch(browser, settle_s=0.3, mode="desktop", window_dpr=None)
        assert _metrics(browser, "S_A") == []
    finally:
        await _stop()


@pytest.mark.parametrize("width, height, dpi, expected", [
    (1920, 1080, 160, ("desktop", 1.0)),                    # DeX window: 1920 dp wide
    (1280, 800, 160, ("desktop", 1.0)),                     # tablet: 1280 dp
    (1220, 2712, 513, ("mobile", 513 / 160)),               # phone size: 380 dp
    (1080, 2400, 420, ("mobile", 420 / 160)),
    (700, 1200, 186, ("desktop", 186 / 160)),               # 602 dp wide: just desktop
    (400, 1500, 160, ("mobile", 1.0)),                      # a narrow, TALL window is a phone page however tall it is
    (360, 3000, 160, ("mobile", 1.0)),
    (1920, 300, 160, ("desktop", 1.0)),                     # a wide, SHORT strip is a desktop page (the page lays out 1920 dp wide)
    (1200, 400, 160, ("desktop", 1.0)),
    (None, 1080, 160, ("desktop", None)), (1920, 1080, None, ("desktop", None)),
])
def test_the_site_a_window_gets_follows_its_width_in_dp(width, height, dpi, expected):
    assert cr.window_place(width, height, dpi) == expected


def test_a_window_dragged_across_600_dp_does_not_flap():
    assert cr.window_place(620, 2000, 160, "mobile")[0] == "mobile"       # 620 dp: still the mobile site (it leaves from 640)
    assert cr.window_place(650, 2000, 160, "mobile")[0] == "desktop"
    assert cr.window_place(580, 2000, 160, "desktop")[0] == "desktop"     # 580 dp: still the desktop site (it leaves below 560)
    assert cr.window_place(540, 2000, 160, "desktop")[0] == "mobile"


def _with_browser(browser):
    return (patch("urllib.request.urlopen", return_value=MagicMock(read=lambda: _VERSION.encode())), patch("websockets.connect", return_value=browser))


@pytest.mark.asyncio
async def test_a_window_that_keeps_its_size_class_only_hands_the_new_scale_to_its_tabs():
    browser = _ReactiveBrowser({"TAB_A": _tab({"mobile": True})}, probe=_SAME)
    try:
        watcher, _ = await _watch(browser, settle_s=0.3, mode="desktop", window_dpr=1.0, place="window")
        urlopen, connect = _with_browser(browser)
        with urlopen, connect:
            cr.update_window_place(KEY, 1920, 1080, 186)                           # still 929 dp: the same watcher, the new scale
            await asyncio.sleep(0.1)
            assert cr.get_browser_auto_attach_watcher(KEY) is watcher
            assert _metrics(browser, "S_A")[-1] == {"width": 0, "height": 0, "deviceScaleFactor": 186 / 160, "mobile": False}
            before = len(_metrics(browser, "S_A"))
            cr.update_window_place(KEY, 1920, 1080, 186)                           # unchanged: nothing is sent again
            cr.update_window_place("another-pkg", 800, 800, 320)                   # no watcher for it: ignored
            cr.update_window_place(KEY, None, 1080, 186)
            await asyncio.sleep(0.1)
            assert len(_metrics(browser, "S_A")) == before
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_a_window_that_becomes_phone_sized_gets_the_mobile_site_and_one_that_grows_the_desktop_site():
    browser = _ReactiveBrowser({"TAB_A": _tab({"mobile": False})}, probe={"lay": {"iw": 380, "sw": 380}, "fp": _fp(h="m.a.example")})
    try:
        watcher, _ = await _watch(browser, settle_s=0.3, mode="desktop", window_dpr=1.0, place="window")
        urlopen, connect = _with_browser(browser)
        with urlopen, connect:
            cr.update_window_place(KEY, 1220, 2712, 513)                           # DeX window -> phone-sized window
            await asyncio.sleep(0.4)
            now = cr.get_browser_auto_attach_watcher(KEY)
            assert now is not watcher and now.mode == "mobile" and now.place == "window"
            assert _metrics(browser, "S_A")[-1] == {"width": 0, "height": 0, "deviceScaleFactor": 513 / 160, "mobile": True}
            ua = [m["params"]["userAgent"] for m in browser.sent if m.get("method") == "Emulation.setUserAgentOverride"][-1]
            assert ua.endswith("Mobile Safari/537.36")                              # the phone's own mobile identity
            cr.update_window_place(KEY, 1920, 1080, 160)                           # ... and grown back
            await asyncio.sleep(0.4)
            assert cr.get_browser_auto_attach_watcher(KEY).mode == "desktop"
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_the_phones_own_watcher_is_not_touched_by_a_window_resize():
    browser = _ReactiveBrowser({"TAB_A": _tab({"mobile": True})}, probe=_SAME)
    try:
        watcher, _ = await _watch(browser, settle_s=0.3, mode="mobile")
        urlopen, connect = _with_browser(browser)
        with urlopen, connect:
            cr.update_window_place(KEY, 1920, 1080, 160)
            await asyncio.sleep(0.1)
        assert cr.get_browser_auto_attach_watcher(KEY) is watcher and watcher._phone_dpr == NATIVE
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_the_scale_chrome_stacks_on_a_desktop_override_is_measured_learned_and_divided_out():
    """Measured: a 1920 px window at 160 dpi, override 1.0, showed dpr 1.2 (iw 1600): Chrome multiplies a desktop-mode override by 1.2."""
    browser = _ReactiveBrowser({"TAB_A": _tab({"mobile": True})}, probe=_SAME, dpr_factor=1.2)
    try:
        await _watch(browser, settle_s=0.3, mode="desktop", window_dpr=1.0, place="window")
        await asyncio.sleep(0.4)
        scales = [m["deviceScaleFactor"] for m in _metrics(browser, "S_A")]
        assert scales[0] == 1.0 and scales[-1] == pytest.approx(1.0 / 1.2)            # first as asked, then corrected by what was measured
        assert cr._dpr_gain[("SERIAL_123", False)] == pytest.approx(1.2)
        assert len(scales) == 2                                                          # corrected once, no loop
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_a_page_that_already_has_the_scale_is_not_corrected():
    browser = _ReactiveBrowser({"TAB_A": _tab({"mobile": True})}, probe=_SAME, dpr_factor=1.0)
    try:
        await _watch(browser, settle_s=0.3, mode="mobile")
        await asyncio.sleep(0.4)
        assert [m["deviceScaleFactor"] for m in _metrics(browser, "S_A")] == [NATIVE]
        assert cr._dpr_gain == {}
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_a_learned_gain_is_applied_at_once_to_the_next_watcher_and_to_a_resize():
    cr._dpr_gain[("SERIAL_123", False)] = 1.2
    browser = _ReactiveBrowser({"TAB_A": _tab({"mobile": True})}, probe=_SAME, dpr_factor=1.2)
    try:
        await _watch(browser, settle_s=0.3, mode="desktop", window_dpr=1.0, place="window")
        await asyncio.sleep(0.3)
        assert [m["deviceScaleFactor"] for m in _metrics(browser, "S_A")] == [pytest.approx(1.0 / 1.2)]   # right the first time
        urlopen, connect = _with_browser(browser)
        with urlopen, connect:
            cr.update_window_place(KEY, 1920, 1080, 186)
            await asyncio.sleep(0.2)
        assert _metrics(browser, "S_A")[-1]["deviceScaleFactor"] == pytest.approx((186 / 160) / 1.2)
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_frozen_background_tabs_do_not_hold_the_settle_once_the_tab_in_front_is_handled():
    """A browser can hold a dozen tabs, most frozen and never answering (measured on Samsung Internet and Chrome): the handoff waited the whole
    settle timeout for them although the tab the user looks at was done in a fraction of a second."""
    frozen = {f"TAB_Z{i}": {"session": f"S_Z{i}", "url": f"https://z{i}.example/", "state": None} for i in range(4)}     # never answer
    front = {"TAB_F": {"session": "S_F", "url": "https://f.example/", "state": {**_STATE, "mobile": True, "visible": True, "fp": None}}}
    browser = _ReactiveBrowser({**frozen, **front}, probe=_SAME)
    try:
        started = asyncio.get_running_loop().time()
        _, settled = await _watch(browser, settle_s=3.0)
        assert settled is True
        assert asyncio.get_running_loop().time() - started < 1.5          # not the 3 s timeout
    finally:
        await _stop()


@pytest.mark.asyncio
async def test_with_no_tab_in_front_the_settle_still_waits_for_every_open_tab():
    only_hidden = {"TAB_H": {"session": "S_H", "url": "https://h.example/", "state": {**_STATE, "visible": False}, "state2": None}}
    browser = _ReactiveBrowser(only_hidden, probe=_SAME)
    try:
        _, settled = await _watch(browser, settle_s=0.4)
        assert settled is False                                           # nobody is known to be in front: as before
    finally:
        await _stop()
