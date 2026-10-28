"""In-Place Web Layout & Font Refresher via Chrome DevTools Protocol (CDP).

Forces Blink / Chromium to re-evaluate CSS ComputedStyle, TextAutosizer, and
devicePixelRatio without restarting the activity, reloading the tab, or killing
the process.

Achieves TRUE ZERO-STATE-LOSS for browsers (Chrome, Edge, Brave, Opera, etc.):
- Video/audio continues playing
- Form inputs and scroll positions are retained
- Top-left (0,0) reference anchor is strictly preserved: eliminates cumulative downward drift
- Stale 201 DPI text layout is cleanly refreshed to 513 DPI in ~25 milliseconds.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
import urllib.request
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from typing import TYPE_CHECKING, Any

import websockets

if TYPE_CHECKING:
    from ..device.adb import Adb

log = logging.getLogger(__name__)

# One browser tab may never answer (frozen / discarded renderer): every tab-level websocket gets a short open timeout
# (websockets' default is 10 s) and background work an overall budget, so the in-place refresh stays bounded.
_TAB_OPEN_TIMEOUT_S = 0.4
_BACKGROUND_TABS_BUDGET_S = 1.0
_BACKGROUND_TABS_PARALLEL = 4

# A tab loaded as the other site (a desktop-site tab carried to the phone, a mobile tab carried into a window) is reloaded — unless
# the page itself shows that a reload would change nothing: the same address fetched under the old and under the new user agent
# comes back as the same page (see _variants_differ), and the layout fits the new viewport. Anything uncertain reloads (a wrong page is
# worse than a redundant reload). False: every such tab is reloaded, as before the measurement existed.
_SKIP_REDUNDANT_RELOAD = True
_PROBE_TIMEOUT_S = 2.0        # no answer to the measurement in this time: reload (the handoff waits 4 s for the watcher to settle)
# Calibrated on ~25 real sites (2026-10-21, same UA twice = noise, mobile vs desktop UA = signal): big responsive sites (github, bbc, cnn, reddit,
# mdn) serve the SAME page whatever the identity; real variants (trendyol, hepsiburada, twitch, linkedin, youtube, wikipedia) differ in tags,
# in the list of loaded scripts / styles (noise there: 0%) and in text. A wrong "same" shows the wrong site, a wrong "differs" is one reload —
# so the thresholds sit just above the measured noise.
_STRUCT_DIFF_THRESHOLD = 0.015    # share of tags that differ between the two fetches (noise <= 0.2%)
_TEXT_DIFF_THRESHOLD = 0.03       # share of visible words that differ (scripts / styles / comments removed; noise <= 2.6% outside YouTube)
_RESOURCE_DIFF_THRESHOLD = 0.05   # share of loaded script / stylesheet addresses (query removed) that differ (noise 0%)
_SIZE_DIFF_THRESHOLD = 0.15       # relative difference in response size
_OVERFLOW_PX = 8              # horizontal overflow (scrollWidth - innerWidth) that counts as "does not fit the phone"
_RESUME_WINDOW_S = 25.0       # a tab re-created this soon after a watcher started is the app's rebuild of the page the user was on
_FRESH_LOAD_MS = 8000        # a document younger than this was just (re)loaded: its own restore owns the scroll
_FRONT_WAIT_MS = 1500         # how long a hidden tab may wait to become visible: the app comes up on a window a second or so after its task moved

# What Chrome multiplies a device-scale override by on top (measured on the phone, Chrome 155: a desktop-mode tab — `mobile: false` — shows
# dpr 1.2 x the override, a mobile one 1.0 x). Learned from the page's own devicePixelRatio after each override, per phone and mode, so the
# override can be divided by it and the page ends up at the scale the window really has. Never assumed: 1.0 until measured.
_dpr_gain: dict[tuple[str, bool], float] = {}

_cdp_locks: dict[str, asyncio.Lock] = {}


def _get_cdp_lock(serial: str) -> asyncio.Lock:
    if serial not in _cdp_locks:
        _cdp_locks[serial] = asyncio.Lock()
    return _cdp_locks[serial]


@contextlib.asynccontextmanager
async def open_cdp_session(
    adb: "Adb",
    serial: str,
    socket_name: str,
    *,
    timeout_s: float = 2.0,
):
    """Allocates an isolated, ephemeral localhost port forwarded to the device abstract socket.

    Guarantees:
    1. Zero port collisions across concurrent tasks or multiple apps.
    2. Strict async lock sequence per device serial.
    3. Unconditional forward removal in finally block.
    """
    clean_socket = socket_name.lstrip("@")
    port = await adb.forward(0, f"localabstract:{clean_socket}", serial=serial)
    if not port or port <= 0:
        port = 9224
        await adb.forward(port, f"localabstract:{clean_socket}", serial=serial)
    try:
        yield port
    finally:
        await _remove_forward_safe(adb, serial, port)


# Page-side helpers shared by every script below (an expression prefix: plain `const`s, no braces to escape here). Where a page
# SCROLLS: many apps (chat UIs, mail, feeds) scroll an inner container and leave `window` at 0 — `window.scrollY` alone saves nothing for
# them, and a reload then lands where the container itself starts (measured on claude.ai: 30% -> bottom). So the biggest scrollable
# containers are captured by their position as a RATIO (it survives a different viewport and a re-rendered list) and put back by it.
_SCROLL_LIB_JS = r"""
const odxPath = (el) => {
  const parts = [];
  for (let n = el, d = 0; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement, d++) {
    if (d > 12) return null;
    if (n.id && !/\d{4,}/.test(n.id)) { parts.unshift(n.tagName.toLowerCase() + '#' + CSS.escape(n.id)); break; }
    let nth = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) nth++;
    parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + nth + ')');
  }
  return parts.join(' > ');
};
const odxByPath = (p) => {
  try { const el = document.querySelector(p); return el && el.scrollHeight > el.clientHeight ? el : null; } catch (e) { return null; }
};
const odxScrollers = () => {
  const found = [];
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.nextNode(), i = 0; el && i < 30000; el = walker.nextNode(), i++) {
    if (el === document.body || el.clientHeight <= 80 || el.scrollHeight <= el.clientHeight + 40) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') found.push(el);
  }
  found.sort((a, b) => b.scrollHeight - a.scrollHeight);
  return found.slice(0, 3);
};
const odxCapture = () => odxScrollers().map((el) => ({
  p: odxPath(el), r: +(el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)).toFixed(4),
  t: Math.round(el.scrollTop), h: el.scrollHeight, c: el.clientHeight,
}));
const odxApplyOnce = (saved) => {
  const list = (saved && saved.c) || [];
  const sc = odxScrollers();
  let applied = 0;
  list.forEach((s, i) => {
    const el = (s.p && odxByPath(s.p)) || sc[i];
    if (!el) return;
    const range = el.scrollHeight - el.clientHeight;
    if (range < 40) return;
    el.scrollTop = s.r * range;
    applied++;
  });
  return applied;
};
const odxRestoreAll = async (saved) => {
  const want = (saved.c || []).length;
  let touched = false;
  const stop = () => { touched = true; };
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  events.forEach((e) => addEventListener(e, stop, { capture: true, passive: true }));
  let stable = 0, last = '';
  try {
    for (let i = 0; i < 40 && !touched; i++) {
      const applied = odxApplyOnce(saved);
      if (saved.y && Math.abs(window.scrollY - saved.y) > 4) window.scrollTo(0, saved.y);
      if (!want && !saved.y) break;
      const sig = odxScrollers().map((el) => el.scrollHeight).join(',') + '|' + document.documentElement.scrollHeight;
      stable = (applied >= want && sig === last) ? stable + 1 : 0;
      last = sig;
      if (i >= 6 && stable >= 4) break;
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    events.forEach((e) => removeEventListener(e, stop, true));
  }
  return touched ? 'user' : 'ok';
};
const odxFingerprint = async () => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1200);
  try {
    const r = await fetch(location.href, { cache: 'no-store', credentials: 'same-origin', redirect: 'follow', signal: ctl.signal });
    const body = await r.text();
    const tags = {};
    (body.slice(0, 400000).match(/<([a-zA-Z][a-zA-Z0-9-]*)/g) || []).forEach((m) => { const k = m.slice(1).toLowerCase(); tags[k] = (tags[k] || 0) + 1; });
    // The VISIBLE words too (scripts, styles, comments removed: a bot-detection script injected for one identity is not another page): two
    // variants can carry the same tags and different text. The 300 most frequent are enough to tell pages apart.
    const slice = body.slice(0, 400000);
    const visible = slice.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<!--[\s\S]*?-->/gi, ' ');
    const counts = {};
    (visible.replace(/<[^>]*>/g, ' ').toLowerCase().match(/[a-zçğıöşü]{3,24}/g) || []).forEach((w) => { counts[w] = (counts[w] || 0) + 1; });
    const words = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 300));
    // The scripts and stylesheets the page loads (query removed): the two variants of a site almost always load different bundles.
    const res = [...new Set((slice.match(/<(?:script[^>]+src|link[^>]+href)=["'][^"']+/gi) || []).map((m) => m.replace(/^[\s\S]*=["']/, '').replace(/[?#].*$/, '')))].sort().slice(0, 120);
    const vp = (body.match(/<meta[^>]+name=["']viewport["'][^>]*>/i) || [''])[0].replace(/\s+/g, ' ').slice(0, 160);
    const u = new URL(r.url);
    return { s: r.status, h: u.host, u: u.pathname, v: r.headers.get('vary') || '', n: body.length, vp, tags, words, res };
  } finally {
    clearTimeout(timer);
  }
};
"""


def _variants_differ(a: Any, b: Any) -> tuple[bool | None, str]:
    """Do two fingerprints (``odxFingerprint``: the same address fetched under two user agents) describe different pages?
    True: they differ (reload is needed); False: the same page; None: cannot tell (reload). ``Vary: User-Agent`` alone says nothing —
    claude.ai sends it and serves one page (measured: 0.22% apart, a bot-detection script) — so the structure is compared."""
    if not isinstance(a, dict) or not isinstance(b, dict):
        return None, "ölçüm yok"
    if a.get("s") != 200 or b.get("s") != 200:
        return None, f"yanıt kodu {a.get('s')}/{b.get('s')}"
    if a.get("h") != b.get("h") or a.get("u") != b.get("u"):
        return True, f"farklı adrese yönlendi ({a.get('h')}{a.get('u')} -> {b.get('h')}{b.get('u')})"
    if a.get("vp") != b.get("vp"):
        return True, "viewport etiketi farklı"
    structure = _histogram_distance(a.get("tags"), b.get("tags"))
    if structure is None:
        return None, "gövde okunamadı"
    words = _histogram_distance(a.get("words"), b.get("words"))        # absent on either side: not compared
    resources = _set_distance(a.get("res"), b.get("res"))              # absent / too few: not compared
    na, nb = a.get("n") or 0, b.get("n") or 0
    size = abs(na - nb) / max(na, nb, 1)
    summary = (f"yapı farkı %{structure * 100:.1f}, metin farkı %{(words or 0) * 100:.1f}, kaynak farkı %{(resources or 0) * 100:.1f}, "
               f"boyut farkı %{size * 100:.1f}")
    if (structure >= _STRUCT_DIFF_THRESHOLD or (words or 0) >= _TEXT_DIFF_THRESHOLD
            or (resources or 0) >= _RESOURCE_DIFF_THRESHOLD or size >= _SIZE_DIFF_THRESHOLD):
        return True, summary
    return False, summary


def _histogram_distance(a: Any, b: Any) -> float | None:
    """Share of two count histograms that differs (0 = identical, 1 = nothing in common); None when there is nothing to compare."""
    if not isinstance(a, dict) or not isinstance(b, dict):
        return None
    names = set(a) | set(b)
    total = sum(max(_count(a.get(k)), _count(b.get(k))) for k in names)
    if not total:
        return None
    return sum(abs(_count(a.get(k)) - _count(b.get(k))) for k in names) / total


def _set_distance(a: Any, b: Any) -> float | None:
    """Share of two address lists that is not in both (0 = the same set); None when there are too few addresses to say anything."""
    if not isinstance(a, list) or not isinstance(b, list):
        return None
    left, right = {x for x in a if isinstance(x, str)}, {x for x in b if isinstance(x, str)}
    union = left | right
    if len(union) < 3:
        return None
    return 1 - len(left & right) / len(union)


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _probe_verdict(baseline: Any, probe: Any, *, check_layout: bool) -> tuple[bool, str]:
    """The measurement taken after the user agent changed against the one before it. True: reload (different page, a page that does not
    fit the viewport, or anything that could not be measured); False: the reload would change nothing."""
    if not isinstance(probe, dict):
        return True, "ölçüm yanıtı yok"
    if probe.get("err") and not isinstance(probe.get("fp"), dict):
        return True, f"ölçüm alınamadı ({probe['err']})"
    differs, why = _variants_differ(baseline, probe.get("fp"))
    if differs is None or differs:
        return True, why
    lay = probe.get("lay") or {}
    inner, scroll = lay.get("iw"), lay.get("sw")
    if check_layout and isinstance(inner, (int, float)) and isinstance(scroll, (int, float)) and scroll > inner + _OVERFLOW_PX:
        return True, f"yatay taşma ({scroll:.0f} > {inner:.0f})"
    return False, why


def _tab_state_js(want_mobile: bool, *, wait_ms: int = 0, with_fp: bool = False) -> str:
    """What a tab says about itself before it is switched: the site it was loaded as (mobile / desktop), whether it is the tab the
    user sees, and what must survive a reload — the video's second and play state, where the page scrolls (window AND inner
    containers), the address. ``wait_ms``: a hidden tab may wait that long for its visibility (the browser lags a moment after the app's
    task moved). ``with_fp``: the visible tab that is the other site also fetches its own address once, BEFORE the user agent changes
    (the baseline the reload decision compares with)."""
    return "(async () => {" + _SCROLL_LIB_JS + f"""
  const vis = () => document.visibilityState === 'visible';
  if ({int(wait_ms)} > 0 && !vis()) await new Promise((r) => {{
    const t = setTimeout(r, {int(wait_ms)});
    document.addEventListener('visibilitychange', () => {{ if (vis()) {{ clearTimeout(t); r(); }} }});
  }});
  const v = [...document.querySelectorAll('video')].find((x) => x.duration > 0 && isFinite(x.duration));
  const mobile = navigator.userAgentData ? navigator.userAgentData.mobile : /Mobi/.test(navigator.userAgent);
  const out = {{
    mobile, visible: vis(), t: v ? v.currentTime : null, playing: v ? (!v.paused && !v.ended) : null, since: Math.round(performance.now()),
    y: window.scrollY, url: location.href, host: location.hostname, c: odxCapture(),
  }};
  if ({'true' if with_fp else 'false'} && vis() && mobile !== {'true' if want_mobile else 'false'} && /^https?:$/.test(location.protocol)) {{
    try {{ out.fp = await odxFingerprint(); }} catch (e) {{}}
  }}
  return JSON.stringify(out);
}})()"""


def _probe_js(want_mobile: bool) -> str:
    """Run after the user agent (and scale) changed: the same address again under the NEW identity, plus whether the page fits.
    A user-agent override reaches the page a moment after its command was sent, and a fetch made before that still goes out under the OLD
    identity (two identical answers, "same page" — measured). So the page first waits until it itself reports the new identity; if it never
    does, there is no fingerprint and the tab is reloaded."""
    return "(async () => {" + _SCROLL_LIB_JS + f"""
  const now = () => navigator.userAgentData ? navigator.userAgentData.mobile : /Mobi/.test(navigator.userAgent);
  for (let i = 0; i < 24 && now() !== {'true' if want_mobile else 'false'}; i++) await new Promise((r) => setTimeout(r, 25));
  if (now() !== {'true' if want_mobile else 'false'}) return JSON.stringify({{ err: 'identity-not-applied' }});
  const out = {{ lay: {{ iw: innerWidth, sw: document.documentElement.scrollWidth }} }};
  try {{ out.fp = await odxFingerprint(); }} catch (e) {{ out.err = String(e).slice(0, 80); }}
  return JSON.stringify(out);
}})()"""


def _build_nudge_script(saved_scroll: dict[str, Any] | None) -> str:
    saved_is_top = "null"
    saved_x = "null"
    saved_y = "null"
    saved_ratio = "null"
    saved_anchor_path = "null"
    saved_containers = "[]"
    if saved_scroll and isinstance(saved_scroll, dict):
        containers = saved_scroll.get("containers")
        if isinstance(containers, list):
            saved_containers = json.dumps([c for c in containers if isinstance(c, dict)][:3])
        if "isTop" in saved_scroll:
            saved_is_top = "true" if saved_scroll["isTop"] else "false"
        if "scrollX" in saved_scroll and isinstance(saved_scroll["scrollX"], (int, float)):
            saved_x = str(saved_scroll["scrollX"])
        if "scrollY" in saved_scroll and isinstance(saved_scroll["scrollY"], (int, float)):
            saved_y = str(saved_scroll["scrollY"])
        if "ratio" in saved_scroll and isinstance(saved_scroll["ratio"], (int, float)):
            saved_ratio = str(saved_scroll["ratio"])
        if "anchorPath" in saved_scroll and isinstance(saved_scroll["anchorPath"], str):
            saved_anchor_path = json.dumps(saved_scroll["anchorPath"])

    lib = _SCROLL_LIB_JS      # interpolated, not part of the f-string source: its braces need no escaping
    return f"""
    (() => {{
        {lib}
        const savedIsTop = {saved_is_top};
        const savedX = {saved_x};
        const savedY = {saved_y};
        const targetRatio = {saved_ratio};
        const anchorPath = {saved_anchor_path};
        const savedContainers = {saved_containers};
        // A document that was just (re)loaded has its scroll put back by the reload's own restore (one writer): this nudge leaves the
        // scroll alone there. It still tells the page its viewport changed at EVERY phase below — Android settles a display / density
        // change a few hundred ms late, and a page (a YouTube player, a left-aligned layout with a gap on the right) lays itself out
        // from the LAST resize it hears.
        const fresh = performance.now() < {_FRESH_LOAD_MS};

        const isTop = (savedIsTop !== null) ? savedIsTop : (window.scrollY <= 2);
        const targetX = (savedX !== null) ? savedX : window.scrollX;
        const targetY = (savedY !== null) ? savedY : window.scrollY;

        const root = document.documentElement;
        const body = document.body;

        // 1. Inhibit Blink scroll anchoring and reset text size adjust while the layout settles (the page's scale is the
        //    watcher's business: a session-scoped device-scale override, never a style written into the page)
        const prevRootAnchor = root ? root.style.overflowAnchor : '';
        const prevBodyAnchor = body ? body.style.overflowAnchor : '';

        if (root) {{
            root.style.overflowAnchor = 'none';
            root.style.webkitTextSizeAdjust = '100%';
            // Residue of the old inline-zoom compensation (a tab it touched keeps it until reload)
            if (root.style.zoom) root.style.zoom = '';
        }}
        if (body) {{
            body.style.overflowAnchor = 'none';
            body.style.webkitTextSizeAdjust = '100%';
        }}

        // 1b. Dismiss stale active input focus to release soft keyboard (IME) ghost layers
        if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') {{
            try {{ document.activeElement.blur(); }} catch (e) {{}}
        }}

        // 2. Re-anchor strictly to document origin (0, 0) if at top, or exact reading anchor
        const lockScroll = () => {{
            if (fresh) {{
                window.dispatchEvent(new Event('resize'));
                window.dispatchEvent(new Event('orientationchange'));
                return;
            }}
            if (isTop) {{
                window.scrollTo({{ left: 0, top: 0, behavior: 'instant' }});
            }} else if (anchorPath) {{
                try {{
                    const el = document.querySelector(anchorPath);
                    if (el) {{
                        el.scrollIntoView({{ behavior: 'instant', block: 'start' }});
                    }} else if (targetRatio !== null) {{
                        const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
                        window.scrollTo({{ left: targetX || 0, top: targetRatio * maxScroll, behavior: 'instant' }});
                    }} else {{
                        window.scrollTo({{ left: targetX, top: targetY, behavior: 'instant' }});
                    }}
                }} catch (e) {{
                    window.scrollTo({{ left: targetX, top: targetY, behavior: 'instant' }});
                }}
            }} else if (targetRatio !== null) {{
                const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
                window.scrollTo({{ left: targetX || 0, top: targetRatio * maxScroll, behavior: 'instant' }});
            }} else {{
                window.scrollTo({{ left: targetX, top: targetY, behavior: 'instant' }});
            }}
            if (savedContainers.length) odxApplyOnce({{ c: savedContainers }});
            window.dispatchEvent(new Event('resize'));
            window.dispatchEvent(new Event('orientationchange'));
        }};

        lockScroll();

        // 3. Multi-phase transition enforcement across Android configuration settle window
        setTimeout(lockScroll, 80);
        setTimeout(lockScroll, 250);
        setTimeout(() => {{
            lockScroll();
            if (root) root.style.overflowAnchor = prevRootAnchor;
            if (body) body.style.overflowAnchor = prevBodyAnchor;
        }}, 600);

        return "OK";
    }})()
    """


async def _send_cdp(
    ws: Any,
    method: str,
    params: dict[str, Any] | None = None,
    *,
    req_id: int = 1,
    timeout_s: float = 1.0,
) -> dict[str, Any] | None:
    """Sends a CDP command and waits for the matching response id, demuxing async notifications."""
    payload: dict[str, Any] = {"id": req_id, "method": method}
    if params is not None:
        payload["params"] = params
    await ws.send(json.dumps(payload))
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    while loop.time() < deadline:
        try:
            remaining = max(0.05, deadline - loop.time())
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            msg = json.loads(raw)
            if msg.get("id") == req_id:
                return msg
        except (asyncio.TimeoutError, Exception):
            break
    return None




async def _probe_tab_state(port: int, page: dict[str, Any]) -> bool | None:
    """Is the page's document visible right now? True / False when the tab answered, None when it did not (frozen, discarded,
    no socket). One short websocket, never raises."""
    ws_url_raw = page.get("webSocketDebuggerUrl")
    if not ws_url_raw:
        return None
    ws_url = re.sub(r"ws://[^/]+/", f"ws://127.0.0.1:{port}/", ws_url_raw)
    try:
        async with websockets.connect(ws_url, open_timeout=_TAB_OPEN_TIMEOUT_S, close_timeout=0.1) as ws:
            check_js = "JSON.stringify({visible: document.visibilityState === 'visible', focus: document.hasFocus ? document.hasFocus() : false})"
            res = await _send_cdp(ws, "Runtime.evaluate", {"expression": check_js}, req_id=1, timeout_s=0.25)
            val_str = (res or {}).get("result", {}).get("result", {}).get("value")
            if not val_str:
                return None
            return bool(json.loads(val_str).get("visible"))
    except Exception:
        return None


async def _probe_tab_visible(port: int, page: dict[str, Any]) -> dict[str, Any] | None:
    """The page if its document is visible and focused-capable right now, else None. One short websocket, never raises."""
    return page if await _probe_tab_state(port, page) else None


async def _web_pages(port: int) -> list[dict[str, Any]]:
    """The open http(s) page tabs of the browser behind the forwarded DevTools ``port`` (raises on a dead socket)."""
    loop = asyncio.get_running_loop()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/json/list")
    raw_list = await loop.run_in_executor(None, lambda: urllib.request.urlopen(req, timeout=0.5).read().decode())
    return [
        t for t in json.loads(raw_list)
        if t.get("type") == "page" and t.get("url", "").startswith(("http://", "https://")) and t.get("webSocketDebuggerUrl")
    ]


async def _find_active_page_target(port: int, valid_pages: list[dict[str, Any]], timeout_s: float = 0.5) -> dict[str, Any]:
    """Finds the foreground active/visible page tab among all open browser targets.

    With many tabs open (a browser can hold 16+, most of them frozen or discarded and never answering) the tabs are
    probed IN PARALLEL under one overall budget: the old one-by-one probe cost up to ~0.4 s per unresponsive tab, i.e.
    several seconds of a handoff that holds the window lifecycle lock. The first visible tab (in browser order) wins;
    no answer in time falls back to the first page."""
    if len(valid_pages) <= 1:
        return valid_pages[0] if valid_pages else {}

    loop = asyncio.get_running_loop()
    deadline = loop.time() + max(timeout_s, 0.3)
    candidates = list(valid_pages)
    # The browser lags a moment behind an app's task move: right after it, every tab can still say "hidden". Tabs that ANSWERED hidden are
    # asked again a couple of times inside the same budget (frozen tabs, which never answer, are not waited for again).
    for round_no in range(3):
        probes = [asyncio.ensure_future(_probe_tab_state(port, page)) for page in candidates]
        try:
            await asyncio.wait(probes, timeout=max(0.05, deadline - loop.time()))
            answered_hidden: list[dict[str, Any]] = []
            for page, probe in zip(candidates, probes):
                if not probe.done() or probe.cancelled() or probe.exception() is not None:
                    continue
                if probe.result():
                    return page
                if probe.result() is False:
                    answered_hidden.append(page)
        finally:
            for probe in probes:
                if not probe.done():
                    probe.cancel()
            await asyncio.gather(*probes, return_exceptions=True)
        if round_no == 2 or not answered_hidden or loop.time() + 0.1 >= deadline:
            break
        candidates = answered_hidden
        await asyncio.sleep(0.08)

    # Fallback to the first page (the browser lists the most recently active tab first) if none explicitly reported visible
    return valid_pages[0]


async def capture_browser_scroll_state(
    adb: "Adb",
    serial: str,
    socket_name: str,
    *,
    timeout_s: float = 0.8,
) -> dict[str, Any] | None:
    """Captures the current active browser tab's scroll position, element anchor, and media state.

    Thread-safe and process-isolated via dynamic ephemeral port forwarding.
    Scans all open tabs to target the active visible tab. Never raises.
    """
    async with _get_cdp_lock(serial):
        try:
            async with open_cdp_session(adb, serial, socket_name, timeout_s=timeout_s) as port:
                pages = await _web_pages(port)
                if not pages:
                    return None

                target_page = await _find_active_page_target(port, pages, timeout_s=0.4)
                target_ws_raw = target_page.get("webSocketDebuggerUrl")
                if not target_ws_raw:
                    return None

                ws_url = re.sub(r"ws://[^/]+/", f"ws://127.0.0.1:{port}/", target_ws_raw)
                async with websockets.connect(ws_url, close_timeout=0.3) as ws:
                    capture_js = (
                        "(() => {"
                        "  const scrollY = window.scrollY;"
                        "  const scrollX = window.scrollX;"
                        "  const isTop = (scrollY <= 2);"
                        "  const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);"
                        "  const ratio = scrollY / maxScroll;"
                        "  let anchorPath = null;"
                        "  const getCssPath = (el) => {"
                        "    if (!(el instanceof Element)) return null;"
                        "    const path = [];"
                        "    while (el && el.nodeType === Node.ELEMENT_NODE) {"
                        "      let selector = el.nodeName.toLowerCase();"
                        "      if (el.id) {"
                        "        selector += '#' + el.id;"
                        "        path.unshift(selector);"
                        "        break;"
                        "      } else {"
                        "        let sib = el, nth = 1;"
                        "        while (sib = sib.previousElementSibling) {"
                        "          if (sib.nodeName.toLowerCase() === selector) nth++;"
                        "        }"
                        "        if (nth !== 1) selector += ':nth-of-type(' + nth + ')';"
                        "      }"
                        "      path.unshift(selector);"
                        "      el = el.parentNode;"
                        "      if (!el || el === document.body) break;"
                        "    }"
                        "    return path.join(' > ');"
                        "  };"
                        "  const midEl = document.elementFromPoint(window.innerWidth / 2, Math.min(200, window.innerHeight / 3));"
                        "  if (midEl) {"
                        "    anchorPath = getCssPath(midEl);"
                        "  }"
                        "  const vid = Array.from(document.querySelectorAll('video')).find(x => x.duration > 0 && isFinite(x.duration));"
                        "  return JSON.stringify({"
                        "    t: vid ? vid.currentTime : null, "
                        "    playing: vid ? (!vid.paused && !vid.ended) : null, "
                        "    targetId: " + json.dumps(target_page.get("id", "")) + ", "
                        "    url: window.location.href, "
                        "    scrollX: scrollX, "
                        "    scrollY: scrollY, "
                        "    isTop: isTop, "
                        "    ratio: ratio, "
                        "    anchorPath: anchorPath, "
                        "    containers: odxCapture(), "
                        "    hasMedia: Array.from(document.querySelectorAll('video, audio')).some(el => !el.paused && !el.ended && el.readyState > 2)"
                        "  });"
                        "})()"
                    )
                    # Where the page really scrolls (an inner container for chat UIs / feeds), not only window.scrollY
                    capture_js = capture_js.replace("(() => {", "(() => {" + _SCROLL_LIB_JS, 1)
                    res = await _send_cdp(ws, "Runtime.evaluate", {"expression": capture_js}, req_id=1, timeout_s=timeout_s)
                    if not res:
                        return None
                    val = json.loads(res.get("result", {}).get("result", {}).get("value", "{}"))
                    if isinstance(val, dict):
                        val["captured_at"] = time.time()     # a playing video has moved on by the time it is put back
                        return val
        except Exception as exc:
            log.debug("[CDP_REFRESH] Scroll durumu okunamadı: %s", exc)
            return None
    return None


async def refresh_browser_layout_inplace(
    adb: "Adb",
    serial: str,
    socket_name: str,
    *,
    saved_scroll: dict[str, Any] | None = None,
    timeout_s: float = 2.5,
) -> bool:
    """Connects to the browser's CDP abstract socket, flushes stale cache, and triggers layout re-evaluation.

    Thread-safe and process-isolated via dynamic ephemeral port forwarding.
    Dynamically identifies the active foreground tab across multi-tab sessions,
    instantly enforces scale factor 1.0 (eliminates 1.55x zoom oscillation), clears cache,
    and stabilizes scroll position across the entire transition window.

    Returns True if successfully delivered to the active page tab, False otherwise.
    Never raises; cleans up adb port forward unconditionally.
    """
    async with _get_cdp_lock(serial):
        try:
            async with open_cdp_session(adb, serial, socket_name, timeout_s=timeout_s) as port:
                loop = asyncio.get_running_loop()
                deadline = loop.time() + timeout_s

                pages = await _web_pages(port)
                if not pages:
                    log.debug("[CDP_REFRESH] Açık aktif web sayfası bulunamadı")
                    return False

                # Dynamically resolve the active visible page target
                target_page = await _find_active_page_target(port, pages, timeout_s=0.4)
                target_ws_raw = target_page.get("webSocketDebuggerUrl")
                if not target_ws_raw:
                    return False

                # Normalize ws URL to ephemeral localhost port
                ws_url = re.sub(r"ws://[^/]+/", f"ws://127.0.0.1:{port}/", target_ws_raw)
                nudge_script = _build_nudge_script(saved_scroll)

                # Connect via WebSocket to the active visible tab
                remaining = max(0.5, deadline - loop.time())
                async with websockets.connect(ws_url, open_timeout=_TAB_OPEN_TIMEOUT_S, close_timeout=0.4) as ws:
                    # 0. Ensure foreground page tab activation in Blink
                    with contextlib.suppress(Exception):
                        await _send_cdp(ws, "Page.bringToFront", req_id=85, timeout_s=0.2)

                    # 1. Instantly enforce scale factor 1.0 and reset page scale (clears 1.55x zoom immediately)
                    with contextlib.suppress(Exception):
                        await _send_cdp(ws, "Emulation.setPageScaleFactor", {"pageScaleFactor": 1.0}, req_id=86, timeout_s=0.2)
                        await _send_cdp(ws, "Emulation.resetPageScaleFactor", req_id=87, timeout_s=0.2)

                    # (Page.addScriptToEvaluateOnNewDocument is NOT registered here: it lives only as long as the DevTools
                    # session that added it, and this one closes at the end of the block — only the watcher's persistent
                    # session keeps such a script, see BrowserTabAutoAttachWatcher.)

                    # 3. Evaluate multi-phase layout reflow & scroll anchor script
                    with contextlib.suppress(Exception):
                        await _send_cdp(
                            ws,
                            "Runtime.evaluate",
                            {"expression": nudge_script},
                            req_id=95,
                            timeout_s=remaining,
                        )

                    # 3b. The page may have been reloaded by the APP (Samsung Internet rebuilds its activity on a density change and
                    # reloads every page — back at the top, the video at 0). The nudge leaves such a page alone (it expects its own
                    # restore, see `_FRESH_LOAD_MS`); when none ran, what was read before the change goes back now.
                    resume = _resume_state(saved_scroll)
                    if resume is not None:
                        with contextlib.suppress(Exception):
                            probe = await _send_cdp(ws, "Runtime.evaluate", {"expression": _ADOPT_PROBE_JS, "returnByValue": True},
                                                    req_id=96, timeout_s=0.4)
                            if ((probe or {}).get("result") or {}).get("result", {}).get("value") == "fresh":
                                # The app may have rebuilt the tab from an OLDER address (a page the user reached without a page load: home -> a
                                # video, a video -> the next). The page is then taken back to the address it was on; the restore follows its load.
                                landed_url = str(target_page.get("url", ""))
                                back_to = _retime_url(resume["url"], resume.get("t")) or resume["url"]
                                navigated = False
                                if _landed_on_stale_page(resume["url"], landed_url):
                                    await _send_cdp(ws, "Page.enable", req_id=88, timeout_s=0.3)
                                    nav = await _send_cdp(ws, "Page.navigate", {"url": back_to}, req_id=89, timeout_s=1.0)
                                    navigated = bool(nav) and "error" not in nav
                                    if navigated:
                                        log.info("↩️ [CDP_REFRESH] Uygulama sekmeyi eski adresten kurdu (%s) — kaldığı adrese (%s) dönülüyor",
                                                 landed_url[:80], str(resume["url"])[:80])
                                        await _restore_after_load(ws, resume, timeout_s=4.0, user_gesture=True)
                                if not navigated:
                                    await _send_cdp(ws, "Runtime.evaluate", {"expression": _restore_script(resume), "userGesture": True},
                                                    req_id=97, timeout_s=0.5)
                                log.info("♻️ [CDP_REFRESH] Uygulama sayfayı kendisi yeniden yükledi — video (%s sn) ve kaydırma geri konuyor",
                                         resume.get("t"))

                # 4. Scale factor 1.0 on the background tabs: best effort, in parallel, under one overall budget — a frozen tab
                # must never hold the caller (a handoff, under the window lifecycle lock) for seconds.
                background = [
                    page for page in pages
                    if page.get("id") != target_page.get("id") and page.get("webSocketDebuggerUrl")
                ]
                await _reset_scale_on_background_tabs(port, background)

                log.info(
                    "⚡ [CDP_REFRESH: BAŞARILI] Aktif sekme ('%s') web layout, scale 1.0 ve (0,0) scroll çıpası korundu (0 state kaybı, 0 sapma, 0 zoom salınımı)",
                    target_page.get("title", "")[:40],
                )
                return True
        except Exception as exc:
            log.debug("[CDP_REFRESH] In-place layout dürtmesi atlandı/hata: %s", exc)
            return False


async def _capture_scroll_over(ws: Any) -> dict[str, Any] | None:
    """Where the page scrolls right now (window AND inner containers), asked over an open tab socket. None: nothing worth putting back."""
    with contextlib.suppress(Exception):
        js = "(() => {" + _SCROLL_LIB_JS + "return JSON.stringify({ y: window.scrollY, url: location.href, c: odxCapture() });})()"
        res = await _send_cdp(ws, "Runtime.evaluate", {"expression": js}, req_id=30, timeout_s=0.8)
        raw = ((res or {}).get("result") or {}).get("result", {}).get("value")
        state = json.loads(raw) if isinstance(raw, str) else None
        if isinstance(state, dict) and (state.get("c") or state.get("y")):
            return state
    return None


async def _restore_after_load(ws: Any, state: dict[str, Any], *, timeout_s: float = 5.0, user_gesture: bool = False) -> None:
    """The reload was sent over ``ws`` (Page domain enabled): once the page has loaded, its scroll goes back — the same single-writer
    restore the tab watcher uses. ``user_gesture``: the restore may start a video (the page was loaded by us, nobody touched it). Never raises."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    with contextlib.suppress(Exception):
        while loop.time() < deadline:
            msg = json.loads(await asyncio.wait_for(ws.recv(), max(0.05, deadline - loop.time())))
            if msg.get("method") == "Page.loadEventFired":
                params: dict[str, Any] = {"expression": _restore_script(state)}
                if user_gesture:
                    params["userGesture"] = True
                await _send_cdp(ws, "Runtime.evaluate", params, req_id=33, timeout_s=0.5)
                return


async def soft_reload_active_tab(
    adb: "Adb",
    serial: str,
    socket_name: str,
    *,
    timeout_s: float = 2.5,
) -> dict[str, Any] | None:
    """The USER's "reload this page": a normal reload (``Page.reload``, HTTP cache honoured — not a hard reload) of the
    foreground tab, so the page lays itself out again under the window's CURRENT size and density.

    This is deliberately NOT part of any automatic path: the in-place nudge above runs once per handoff, but a reload
    after every resize would reload a page the user is reading (lost form input, restarted media, one more render on the
    phone's CPU per resize). It is a button the user presses when a page came out wrong after a resize.

    Returns ``{"title", "url"}`` of the tab that was reloaded, None when there was nothing to reload or the tab never
    answered. Never raises; the port forward is removed unconditionally."""
    async with _get_cdp_lock(serial):
        try:
            async with open_cdp_session(adb, serial, socket_name, timeout_s=timeout_s) as port:
                pages = await _web_pages(port)
                if not pages:
                    return None
                target = await _find_active_page_target(port, pages, timeout_s=0.4)
                ws_raw = target.get("webSocketDebuggerUrl")
                if not ws_raw:
                    return None
                ws_url = re.sub(r"ws://[^/]+/", f"ws://127.0.0.1:{port}/", ws_raw)
                async with websockets.connect(ws_url, open_timeout=_TAB_OPEN_TIMEOUT_S, close_timeout=0.3) as ws:
                    # A reload sends a page back to where its app starts (a chat to its newest message): where it scrolled is read first
                    # and, once the page has loaded, put back.
                    scroll = await _capture_scroll_over(ws)
                    if scroll:
                        with contextlib.suppress(Exception):
                            await _send_cdp(ws, "Page.enable", req_id=29, timeout_s=0.3)
                    res = await _send_cdp(ws, "Page.reload", {"ignoreCache": False}, req_id=31, timeout_s=1.0)
                    if scroll and res and "error" not in res:
                        await _restore_after_load(ws, scroll)
                if not res or "error" in res:
                    log.debug("[CDP_RELOAD] Page.reload reddedildi/yanıtsız: %s", res)
                    return None
                log.info("🔄 [CDP_RELOAD] Aktif sekme yumuşak yenilendi ('%s')", target.get("title", "")[:40])
                return {"title": target.get("title", ""), "url": target.get("url", "")}
        except Exception as exc:
            log.debug("[CDP_RELOAD] Yumuşak yenileme atlandı/hata: %s", exc)
            return None


async def _reset_scale_on_tab(port: int, page: dict[str, Any], gate: asyncio.Semaphore) -> None:
    ws_url = re.sub(r"ws://[^/]+/", f"ws://127.0.0.1:{port}/", page["webSocketDebuggerUrl"])
    async with gate:
        try:
            async with websockets.connect(ws_url, open_timeout=_TAB_OPEN_TIMEOUT_S, close_timeout=0.1) as ws:
                await _send_cdp(ws, "Emulation.setPageScaleFactor", {"pageScaleFactor": 1.0}, req_id=98, timeout_s=0.2)
                await _send_cdp(ws, "Emulation.resetPageScaleFactor", req_id=99, timeout_s=0.2)
        except Exception:
            pass


async def _reset_scale_on_background_tabs(port: int, pages: list[dict[str, Any]]) -> None:
    if not pages:
        return
    gate = asyncio.Semaphore(_BACKGROUND_TABS_PARALLEL)
    jobs = [asyncio.ensure_future(_reset_scale_on_tab(port, page, gate)) for page in pages]
    try:
        await asyncio.wait(jobs, timeout=_BACKGROUND_TABS_BUDGET_S)
    finally:
        for job in jobs:
            if not job.done():
                job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)


async def _remove_forward_safe(adb: "Adb", serial: str, port: int) -> None:
    try:
        if hasattr(adb, "forward_remove"):
            await adb.forward_remove(port, serial=serial)
        else:
            await adb._run_cmd(["forward", "--remove", f"tcp:{port}"], serial=serial, timeout_s=1.0)
    except Exception:
        pass


def _mobile_ua_metadata(browser: str) -> dict[str, Any]:
    """Client-hints metadata for the phone's own mobile user agent (``browser``: "Chrome/155.0.8059.39")."""
    full = browser.split("/", 1)[-1]
    major = full.split(".", 1)[0]
    return {
        "brands": [{"brand": "Chromium", "version": major}, {"brand": "Google Chrome", "version": major}],
        "fullVersion": full, "platform": "Android", "platformVersion": "", "architecture": "", "model": "", "mobile": True,
    }


def _desktop_ua(browser: str) -> dict[str, Any]:
    """The user agent + client hints Chrome sends for "Desktop site" (``browser``: "Chrome/155.0.8059.39")."""
    full = browser.split("/", 1)[-1]
    major = full.split(".", 1)[0]
    return {
        "userAgent": f"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36",
        "userAgentMetadata": {
            "brands": [{"brand": "Chromium", "version": major}, {"brand": "Google Chrome", "version": major}],
            "fullVersion": full, "platform": "Linux", "platformVersion": "", "architecture": "x86", "model": "", "mobile": False,
        },
    }


_MOBILE_HOSTS = ("m.", "mobile.", "touch.")


def _mobile_site_url(url: str) -> str | None:
    """The address a tab must be sent to so a MOBILE user agent gets the mobile site, or None when a plain reload does it.
    A site's own "desktop" flag in the address (YouTube: ``app=desktop``, which Chrome's Desktop-site menu leaves there) wins over the
    user agent: reloading it keeps the desktop layout, which is the half-desktop page the phone showed."""
    parts = urlsplit(url)
    query = parse_qsl(parts.query, keep_blank_values=True)
    kept = [(k, v) for k, v in query if not (k == "app" and v == "desktop")]
    if len(kept) == len(query):
        return None
    return urlunsplit(parts._replace(query=urlencode(kept)))


_TIME_PARAMS = ("t", "start", "time_continue")


def _retime_url(url: str, seconds: Any) -> str | None:
    """The address with its start-time parameter (YouTube's ``t=21s``, also ``start=`` / ``time_continue=``) set to ``seconds``, so the
    site itself starts at the second the video was at. None: the address has no such parameter, the second is unknown, or it already is that.
    Left alone, a reload starts the video at the address' OLD second (measured: our restore put it at 62 s, YouTube sent it back to 21 s)."""
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or seconds < 0:
        return None
    parts = urlsplit(url)
    whole = int(seconds)
    changed = False
    query: list[tuple[str, str]] = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key in _TIME_PARAMS:
            new = f"{whole}s" if re.search(r"[hms]", value) else str(whole)
            changed = changed or new != value
            value = new
        query.append((key, value))
    return urlunsplit(parts._replace(query=urlencode(query))) if changed else None


def _resume_state(saved: dict[str, Any] | None) -> dict[str, Any] | None:
    """What ``capture_browser_scroll_state`` read BEFORE the density change, as the state ``_restore_script`` puts back. A playing video
    has moved on since the capture, so its second is advanced by the time that passed. None: nothing was captured."""
    if not isinstance(saved, dict) or not saved.get("url"):
        return None
    t = saved.get("t")
    stamp = saved.get("captured_at")
    if isinstance(t, (int, float)) and not isinstance(t, bool) and saved.get("playing") is True and isinstance(stamp, (int, float)):
        t = t + max(0.0, time.time() - stamp)
    containers = saved.get("containers")
    return {"t": t, "playing": saved.get("playing"), "y": saved.get("scrollY"), "url": saved["url"],
            "c": containers if isinstance(containers, list) else []}


def _same_page(a: str, b: str) -> bool:
    """The same document address apart from the host variant (m. / www.) and the start-time parameters: path and the video id (``v``)."""
    pa, pb = urlsplit(a), urlsplit(b)
    return pa.path == pb.path and dict(parse_qsl(pa.query)).get("v") == dict(parse_qsl(pb.query)).get("v")


def _site_key(url: str) -> str:
    """The site an address belongs to, host variants (www. / m. / mobile. / touch.) folded together."""
    host = (urlsplit(url).hostname or "").lower()
    for prefix in _MOBILE_HOSTS + ("www.",):
        if host.startswith(prefix):
            return host[len(prefix):]
    return host


def _landed_on_stale_page(saved_url: str, landed_url: str) -> bool:
    """The browser rebuilt the tab (the app recreates its activity on a density change) from an OLDER address than the one the user was on.
    Measured on Samsung Internet (2026-10-26): on a site that moves between pages without a page load (YouTube: home -> a video, a video -> the
    next) the address read from the live page was right (``saved_url``) but the tab came back on the address of its last real load
    (``landed_url``) — the home page, the previous video.

    True only when both are web addresses of the SAME site and not the same page (path / video id differ). A different site is never "put back":
    the tab in front may then be another tab, and a page is never overwritten on a guess. Nothing here is site specific."""
    a, b = urlsplit(saved_url), urlsplit(landed_url)
    if a.scheme not in ("http", "https") or b.scheme not in ("http", "https"):
        return False
    if not a.hostname or _site_key(saved_url) != _site_key(landed_url):
        return False
    return not _same_page(saved_url, landed_url)


# Is this document one the APP reloaded by itself (a browser that rebuilds its activity on a density change reloads its pages) and that
# nobody has put back yet? `__odxRestored` is set by `_restore_script`, so a reload this module made itself is never restored twice.
_ADOPT_PROBE_JS = f"window.__odxRestored ? 'owned' : (performance.now() < {_FRESH_LOAD_MS} ? 'fresh' : 'settled')"


def _restore_script(state: dict[str, Any]) -> str:
    """Runs in the reloaded page: puts back where it scrolled (window and inner containers) and, if it had one, its video at the second
    and play state it had. The two run side by side — a page with no video no longer waits for one — and this is the ONLY writer of
    the scroll after a reload (the layout nudge leaves a fresh page alone). It gives up the moment the user touches the page."""
    containers = state.get("c")
    saved = json.dumps({
        "t": state.get("t"), "playing": state.get("playing"), "y": state.get("y"), "url": state.get("url"),
        "c": containers if isinstance(containers, list) else [],
    })
    # The page starts its own player (autoplay) a moment after it loads: the saved play state is held for a few seconds, not set once.
    # The video is put at its second once, the play state is held for ~4 s, and for 12 s the video is watched: a site that starts at the
    # `t=` of its own address AFTER our seek (YouTube applies it when its player finishes loading) sends it back to that second — it is put
    # where it should be by now. (The address' own `t=` is also rewritten before the reload, see _retime_url; this is the safety net.)
    video = (
        "const video=async()=>{const a=new URL(saved.url);if(a.pathname!==location.pathname||"
        "a.searchParams.get('v')!==new URL(location.href).searchParams.get('v'))return;"
        "let moved=0;for(let i=0;i<64;i++){const v=[...document.querySelectorAll('video')].find(x=>x.duration>0&&isFinite(x.duration));"
        "if(!v&&i>=12&&saved.t==null)return;"
        "if(v){const now=Date.now();"
        "if(!moved){moved=now;if(saved.t!=null&&Math.abs(v.currentTime-saved.t)>1.5)v.currentTime=saved.t;}"
        "else if(saved.t!=null&&v.currentTime<saved.t-2)v.currentTime=saved.t+(saved.playing===false?0:(now-moved)/1000);"
        "if(now-moved<4500){if(saved.playing===false&&!v.paused)v.pause();else if(saved.playing===true&&v.paused)await v.play().catch(()=>{});}"
        "if(now-moved>12000)break;}"
        "await new Promise(r=>setTimeout(r,250));}};"
    )
    scroll = (
        "const scroll=async()=>{if(new URL(saved.url).pathname!==location.pathname)return;await odxRestoreAll(saved);};"
    )
    return "(async (saved)=>{window.__odxRestored=true;" + _SCROLL_LIB_JS + video + scroll + "await Promise.all([video(),scroll()]);})(" + saved + ")"


class BrowserTabAutoAttachWatcher:
    """A persistent browser-level DevTools session that keeps EVERY tab of a browser in the mode its place needs — the existing
    ones and the ones opened later — while it lives. ``mode``:

    "mobile" (the browser stands on the phone). Chrome decides its tablet mode per PROCESS (smallest width >= 600 dp): a process
    that lived in a wide DeX window carries a x1.2 page scale (dpr 3.8475 against the phone's 3.206) and the DESKTOP SITE onto the
    phone. Measured on the phone:
      * `Emulation.setDeviceMetricsOverride({width:0, height:0, deviceScaleFactor: native, mobile})` puts an open tab at the
        native scale at once (innerWidth 317 -> 380, dpr 3.206) with its JS state, timers, input text and scroll position
        intact — nothing is reloaded and no style is written into the page;
      * a NEW tab is paused at creation (`Target.setAutoAttach` with `waitForDebuggerOnStart`), given the browser's own mobile
        user agent plus the same scale override, and then resumed: it loads as the mobile site at the native scale from its
        first byte. (A paused target answers only once resumed, so the commands are sent without waiting for replies.)

    "desktop" (the browser stands in a DeX window): tabs the phone loaded as the MOBILE site get the desktop user agent, new tabs
    too (Chrome's tablet mode already does that for them, the override makes it certain and keeps it across navigations).

    A tab that is loaded as the other site than its place needs (a desktop-site tab carried to the phone, a mobile tab carried
    into a window) cannot be fixed by layout alone: the site itself differs (m. / www.). The tab the user is LOOKING at is therefore
    reloaded under the new user agent, and what a reload would lose — the video's second and play state, the scroll position (window
    AND inner containers, which is where chat UIs and feeds scroll) — is put back (`_restore_script`). The other tabs get the user
    agent (so their next load is right) and their scale only.

    A reload is not always needed: a responsive site (claude.ai) serves one page whatever the identity, and its layout already follows the
    size. So the tab in front fetches its own address once BEFORE the identity changes and once after; the pages are compared by
    structure and text (`_variants_differ`), and the reload is skipped only when they are the same and the page fits. Certain reasons
    (a `m.` host in a window, `app=desktop` in the address) reload at once; anything uncertain — no measurement, an answer that never
    comes, a different page — reloads, as it always did. A tab that says "hidden" right after the app's task moved is asked once more,
    letting the page wait for its visibility, so the tab in front is not left on the wrong site.

    Overrides are scoped to this session: stopping the watcher (or losing the connection) drops them all.

    ``phone_dpr``: the density / 160 the watcher's PLACE has — the phone's own (mobile mode) or the window's (desktop mode). It is applied
    to every tab as a device-scale override because a Chrome process that has lived in a wide window runs ALL its tabs at x1.2 of the
    real scale (measured on the phone: dpr 3.848 on a 3.206 display, a 1920 px window laid out at 1600 css px instead of 1920) — the
    page then renders 20% too large, and its layout is sized for a viewport that is not the one on screen. A window that changes size or
    density hands the new value to ``set_scale``. None: no scale to apply."""

    def __init__(self, adb: "Adb", serial: str, socket_name: str, window_id: str, phone_dpr: float | None = None,
                 mode: str = "mobile", place: str = "phone", resume: dict[str, Any] | None = None):
        self._started = time.monotonic()
        self._resume = resume                # what the front tab showed BEFORE the change that made the app reload it (`capture_browser_scroll_state`)
        self._place = "window" if place == "window" else "phone"      # whose size this watcher follows: the phone's display or a window's
        self._adb = adb
        self._serial = serial
        self._socket_name = socket_name
        self._window_id = window_id
        self._phone_dpr = phone_dpr
        self._mode = "desktop" if mode == "desktop" else "mobile"
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._sessions: set[str] = set()
        self._ready = asyncio.Event()
        self._settled = asyncio.Event()      # the tabs open when it started are in their mode (reloads loaded, video put back)
        self._front_seen = False             # a tab reported itself visible: the others cannot be the one in front
        self._front_done = False             # the tab in front has been handled (mode set, reload decided): settling no longer waits for hidden tabs
        self._page_sessions: set[str] = set()                         # sessions of page tabs only (a worker takes no scale)
        self._apply_scale: Any = None        # set by the running session: an async callable that re-sends the scale to every page tab

    def _resume_for(self, url: str) -> dict[str, Any] | None:
        """The state to put back into a tab created now at ``url`` — only within ``_RESUME_WINDOW_S`` of the watcher's start (the app's
        own rebuild follows the density change at once; a tab the user opens later is not one of its re-created ones)."""
        if self._resume is None or time.monotonic() - self._started > _RESUME_WINDOW_S:
            return None
        state = _resume_state(self._resume)
        return state if state is not None and _same_page(state["url"], url) else None

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def place(self) -> str:
        return self._place

    def set_scale(self, dpr: float | None) -> None:
        """The window this watcher serves changed density: its tabs follow at once (a window's watcher only — the phone's density is
        constant). Safe to call from any async context; a watcher that is not running yet simply starts with the new value."""
        if self._place != "window" or not dpr or dpr == self._phone_dpr:
            return
        self._phone_dpr = dpr
        apply = self._apply_scale
        if apply is not None:
            asyncio.get_running_loop().create_task(apply())

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(
            self._run(), name=f"cdp_tab_watcher_{self._window_id}"
        )

    def stop(self) -> None:
        self._stop_event.set()
        if self._task and not self._task.done():
            self._task.cancel()

    async def wait_ready(self, timeout_s: float = 2.0) -> bool:
        """True once the session is attached and listening (the handoff starts it BEFORE its layout nudge, so the scale is in
        place when the nudge anchors the scroll)."""
        try:
            await asyncio.wait_for(self._ready.wait(), timeout_s)
            return True
        except asyncio.TimeoutError:
            return False

    async def wait_settled(self, timeout_s: float = 4.0) -> bool:
        """True once every tab that was open at the start has been put in this watcher's mode — including the reload of the tab
        in front (loaded, its video and scroll sent back). The handoff waits for this before it anchors the scroll: a layout nudge
        into a page that is reloading is what left a half-desktop, half-phone page."""
        try:
            await asyncio.wait_for(self._settled.wait(), timeout_s)
            return True
        except asyncio.TimeoutError:
            return False

    async def _run(self) -> None:
        clean_socket = self._socket_name.lstrip("@")
        port = await self._adb.forward(0, f"localabstract:{clean_socket}", serial=self._serial)
        if not port or port <= 0:
            port = 9225
            await self._adb.forward(port, f"localabstract:{clean_socket}", serial=self._serial)

        want_mobile = self._mode == "mobile"
        try:
            loop = asyncio.get_running_loop()
            req = urllib.request.Request(f"http://127.0.0.1:{port}/json/version")
            raw_ver = await loop.run_in_executor(
                None, lambda: urllib.request.urlopen(req, timeout=1.0).read().decode()
            )
            ver = json.loads(raw_ver)
            browser_ws_raw = ver.get("webSocketDebuggerUrl") or f"ws://127.0.0.1:{port}/devtools/browser"
            browser_ws = re.sub(r"ws://[^/]+/", f"ws://127.0.0.1:{port}/", browser_ws_raw)
            user_agent = ver.get("User-Agent")
            browser = ver.get("Browser", "Chrome/0")
            if want_mobile:
                ua_params = {"userAgent": user_agent, "userAgentMetadata": _mobile_ua_metadata(browser)} if user_agent else None
            else:
                ua_params = _desktop_ua(browser)

            async with websockets.connect(browser_ws, max_size=None) as ws:
                req_id = 0
                pending: dict[int, tuple[str, str | None]] = {}
                reloading: dict[str, dict[str, Any]] = {}      # session -> the state to put back once its reload has loaded
                resume_on_load: dict[str, dict[str, Any]] = {}  # session -> the state to put back once a tab the APP re-created has loaded
                attached: dict[str, str] = {}                  # targetId -> session: a tab is handled ONCE (see below)
                initial: set[str] | None = None                # targetIds of the tabs open at the start that still wait for their turn
                probes: dict[str, dict[str, Any]] = {}         # session -> tab state, while the "does a reload change anything?" measurement runs
                watchdogs: dict[str, asyncio.Task] = {}        # session -> the timer that reloads when that measurement never answers
                awaiting_front: dict[str, str] = {}            # session -> targetId of a hidden tab asked a second time (it may be the front tab)

                front_sessions: set[str] = set()               # sessions of the tab(s) the user is looking at

                def maybe_settled() -> None:
                    # Settled = the tab in front is handled (and nothing is reloading). The other open tabs are behind it: a browser can hold
                    # a dozen, most of them frozen and never answering (Samsung Internet and Chrome alike) — waiting for them delayed every
                    # handoff by the whole settle timeout. They get their mode when they come to life (their state answer applies it).
                    if initial is not None and (not initial or self._front_done) and not reloading:
                        self._settled.set()

                def target_of(session_id: str) -> str | None:
                    return next((t for t, sid in attached.items() if sid == session_id), None)

                def finish(session_id: str) -> None:
                    """The tab is handled (its mode set, its reload decided): it no longer holds the watcher back from being settled."""
                    if initial is not None:
                        initial.discard(target_of(session_id))
                    if session_id in front_sessions:
                        self._front_done = True
                    maybe_settled()

                def drop_awaiting_front() -> None:
                    """The tab in front was found: hidden tabs still waiting for their visibility cannot be it."""
                    for target_id in awaiting_front.values():
                        if initial is not None:
                            initial.discard(target_id)
                    awaiting_front.clear()
                    maybe_settled()

                async def send(method: str, params: dict[str, Any] | None = None, session_id: str | None = None,
                               tag: tuple[str, str | None] | None = None) -> int:
                    nonlocal req_id
                    req_id += 1
                    msg: dict[str, Any] = {"id": req_id, "method": method, "params": params or {}}
                    if session_id:
                        msg["sessionId"] = session_id
                    if tag:
                        pending[req_id] = tag
                    await ws.send(json.dumps(msg))
                    return req_id

                dpr_checks: dict[str, tuple[bool, float]] = {}     # session -> (the mode's mobile flag, the dpr the page must end up with)

                def gain_of(mobile: bool) -> float:
                    return _dpr_gain.get((self._serial, mobile), 1.0)

                def scale_params(mobile: bool) -> dict[str, Any]:
                    return {"width": 0, "height": 0, "deviceScaleFactor": self._phone_dpr / gain_of(mobile), "mobile": mobile}

                async def verify_scale(session_id: str, mobile: bool) -> None:
                    """Reads the dpr the page really has after the override (Chrome stacks its own factor on a desktop-mode one) and, if it is not
                    the target, learns the factor and corrects the override once."""
                    dpr_checks[session_id] = (mobile, self._phone_dpr)
                    await send("Runtime.evaluate", {
                        "expression": "new Promise((r) => setTimeout(() => r(window.devicePixelRatio), 150))",
                        "awaitPromise": True, "returnByValue": True,
                    }, session_id, tag=("dpr", session_id))

                async def put_in_place(session_id: str, tab_mobile: bool, *, reload: bool, verify: bool = True) -> None:
                    """The user agent of this watcher's mode and the scale (phone or window). ``reload``: the tab is the one in front and was
                    loaded as the other site — it is scaled as THIS mode's site (the decision whether it must also be reloaded follows).
                    ``verify``: the page is asked for the dpr it really has (not for a tab that is paused at its creation)."""
                    if ua_params:
                        await send("Emulation.setUserAgentOverride", ua_params, session_id)
                    if self._phone_dpr:
                        # A tab that stays the other site (not reloaded) is scaled in the layout it runs in; a window's tab gets the REAL scale
                        # of its window, not the x1.2 Chrome's tablet mode puts on every tab of its process.
                        mobile_flag = (True if reload else tab_mobile) if want_mobile else False
                        await send("Emulation.setDeviceMetricsOverride", scale_params(mobile_flag), session_id)
                        if verify:
                            await verify_scale(session_id, mobile_flag)

                async def apply_scale() -> None:
                    """The window changed size / density (``set_scale``): every page tab gets the new scale."""
                    try:
                        for page_session in list(self._page_sessions):
                            await send("Emulation.setDeviceMetricsOverride", scale_params(want_mobile), page_session)
                    except Exception as exc:  # noqa: BLE001 — the socket may be gone; the watcher's own loop reports that
                        log.debug("[CDP_WATCHER] pencere ölçeği güncellenemedi: %s", exc)

                self._apply_scale = apply_scale

                async def start_reload(session_id: str, state: dict[str, Any], reason: str) -> None:
                    """Gives the tab in front the right site, with its video / scroll put back once it has loaded."""
                    url = str(state.get("url", ""))
                    # A page the APP just reloaded (Samsung Internet, on a density change) reports the video at 0 and the scroll at the top:
                    # that is not where the user was. What was read before the change is the truth for the same page.
                    resume = _resume_state(self._resume)
                    if resume is not None and isinstance(state.get("since"), (int, float)) and state["since"] < _FRESH_LOAD_MS \
                            and _same_page(resume["url"], url):
                        state = {**state, **{k: resume[k] for k in ("t", "playing", "y", "c")}}
                    reloading[session_id] = state
                    await send("Page.enable", {}, session_id)
                    target_url = _mobile_site_url(url) if want_mobile else None
                    # A site that starts at its address' own `t=` would send the video back to that second after the restore: the address
                    # gets the second the video is at (a different address, so a navigation, not a reload — the cache is not an issue)
                    resume_url = _retime_url(target_url or url, state.get("t"))
                    if resume_url or target_url:
                        await send("Page.navigate", {"url": resume_url or target_url}, session_id)
                    else:
                        await send("Page.reload", {"ignoreCache": False}, session_id)
                    log.info("🔁 [CDP_WATCHER: SİTE KİPİ] %s sekmesi %s siteye çevriliyor — karar=reload, sebep=%s (video ve kaydırma korunacak)",
                             str(state.get("url", ""))[:50], "mobil" if want_mobile else "masaüstü", reason)

                async def probe_watchdog(session_id: str) -> None:
                    """The measurement never answered (a page that blocks fetch, a frozen renderer): reload — the safe answer."""
                    try:
                        await asyncio.sleep(_PROBE_TIMEOUT_S)
                        state = probes.pop(session_id, None)
                        watchdogs.pop(session_id, None)
                        if state is None:
                            return
                        await start_reload(session_id, state, "ölçüm zaman aşımı")
                        finish(session_id)
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:  # noqa: BLE001 — the socket may be gone; the watcher's own loop reports that
                        log.debug("[CDP_WATCHER] ölçüm zamanlayıcısı: %s", exc)

                async def decide(session_id: str, state: dict[str, Any]) -> None:
                    """The tab in front was loaded as the other site. Certain reasons reload at once; otherwise the page is asked whether a
                    reload would change anything (it fetched its own address before the identity changed, it does so again now)."""
                    url, host = str(state.get("url", "")), str(state.get("host", ""))
                    if want_mobile and _mobile_site_url(url) is not None:
                        sure = "adreste masaüstü bayrağı var"
                    elif not want_mobile and host.startswith(_MOBILE_HOSTS):
                        sure = "mobil site (m.) pencerede"
                    else:
                        sure = None
                    if sure is None and _SKIP_REDUNDANT_RELOAD and isinstance(state.get("fp"), dict):
                        probes[session_id] = state
                        await send("Runtime.evaluate", {"expression": _probe_js(want_mobile), "awaitPromise": True, "returnByValue": True},
                                   session_id, tag=("probe", session_id))
                        watchdogs[session_id] = asyncio.create_task(probe_watchdog(session_id))
                        return
                    await start_reload(session_id, state, sure or ("ölçüm kapalı" if not _SKIP_REDUNDANT_RELOAD else "ölçüm alınamadı"))
                    finish(session_id)

                # New tabs are paused at creation; the tabs open now are attached one by one.
                await send("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True})
                await send("Target.getTargets", tag=("targets", None))
                log.info(
                    "👁️ [CDP_WATCHER: BAŞLATILDI] %s için sekme izleyicisi devrede (kip=%s, ölçek=%s, kimlik=%s)",
                    self._window_id, self._mode, self._phone_dpr, "ayarlı" if ua_params else "olduğu gibi",
                )
                self._ready.set()

                try:
                    while not self._stop_event.is_set():
                        msg = json.loads(await ws.recv())
                        if "id" in msg:
                            tag = pending.pop(msg["id"], None)
                            if tag is None:
                                continue
                            kind, session_id = tag
                            if kind == "targets":
                                initial = set()
                                for info in (msg.get("result") or {}).get("targetInfos", []):
                                    if info.get("type") == "page" and str(info.get("url", "")).startswith(("http://", "https://")):
                                        initial.add(info["targetId"])
                                        await send("Target.attachToTarget", {"targetId": info["targetId"], "flatten": True})
                                maybe_settled()
                            elif kind == "dpr" and session_id:
                                check = dpr_checks.pop(session_id, None)
                                observed = (msg.get("result") or {}).get("result", {}).get("value")
                                if check is None or isinstance(observed, bool) or not isinstance(observed, (int, float)) or observed <= 0:
                                    continue
                                mobile_flag, target = check
                                if target != self._phone_dpr or abs(observed - target) / target <= 0.02:
                                    continue                       # the window moved on meanwhile, or the page already has the scale it must
                                applied = target / gain_of(mobile_flag)
                                _dpr_gain[(self._serial, mobile_flag)] = observed / applied
                                log.info("📏 [CDP_WATCHER: ÖLÇEK] sayfa dpr=%.3f (hedef %.3f): Chrome override'ı %.2fx çarpıyor, düzeltiliyor",
                                         observed, target, observed / applied)
                                await send("Emulation.setDeviceMetricsOverride", scale_params(mobile_flag), session_id)
                            elif kind == "probe" and session_id:
                                state = probes.pop(session_id, None)
                                watchdog = watchdogs.pop(session_id, None)
                                if watchdog is not None:
                                    watchdog.cancel()
                                if state is None:
                                    continue                   # the timer already reloaded this tab
                                raw = (msg.get("result") or {}).get("result", {}).get("value")
                                try:
                                    answer = json.loads(raw) if isinstance(raw, str) else None
                                except ValueError:
                                    answer = None
                                must_reload, why = _probe_verdict(state.get("fp"), answer, check_layout=want_mobile)
                                if must_reload:
                                    await start_reload(session_id, state, why)
                                else:
                                    log.info("✅ [CDP_WATCHER: SİTE KİPİ] %s sekmesi iki kimlikle de aynı sayfa — karar=atla (%s); ölçek ve kimlik yeterli",
                                             str(state.get("url", ""))[:50], why)
                                finish(session_id)
                            elif kind in ("state", "state2") and session_id:
                                if kind == "state2" and session_id not in awaiting_front:
                                    continue                   # the tab in front was found meanwhile; this one is not it
                                awaiting_front.pop(session_id, None)
                                raw = (msg.get("result") or {}).get("result", {}).get("value")
                                try:
                                    state = json.loads(raw) if isinstance(raw, str) else {}
                                except ValueError:
                                    state = {}
                                # The site the tab was LOADED as: the user agent it reports now says what the browser would send,
                                # not what it sent — a page carried out of a wide window can be the m. site under a desktop agent.
                                tab_mobile = state.get("mobile") is not False or str(state.get("host", "")).startswith(_MOBILE_HOSTS)
                                wrong_site = bool(state) and tab_mobile != want_mobile
                                front = bool(state.get("visible")) and str(state.get("url", "")).startswith(("http://", "https://"))
                                if front:
                                    self._front_seen = True
                                    front_sessions.add(session_id)
                                    drop_awaiting_front()
                                if kind == "state" or (front and wrong_site):
                                    await put_in_place(session_id, tab_mobile, reload=wrong_site and front)
                                if kind == "state" and wrong_site and not front and not self._front_seen:
                                    # Hidden right now — but the browser lags a moment behind the app's task move, so this may still be the tab
                                    # in front. Ask once more and let the page itself wait for its visibility; until then it holds the settle.
                                    target_id = target_of(session_id)
                                    if target_id:
                                        awaiting_front[session_id] = target_id
                                        await send("Runtime.evaluate", {
                                            "expression": _tab_state_js(want_mobile, wait_ms=_FRONT_WAIT_MS, with_fp=_SKIP_REDUNDANT_RELOAD),
                                            "awaitPromise": True, "returnByValue": True,
                                        }, session_id, tag=("state2", session_id))
                                        continue
                                if wrong_site and front:
                                    await decide(session_id, state)
                                    if session_id in probes:
                                        continue               # the measurement is out; the tab is handled when it answers
                                finish(session_id)
                            continue

                        method = msg.get("method")
                        if method == "Page.loadEventFired" and msg.get("sessionId") in reloading:
                            state = reloading.pop(msg["sessionId"])
                            await send("Runtime.evaluate", {"expression": _restore_script(state), "userGesture": True},
                                       msg["sessionId"])
                            maybe_settled()
                            continue
                        if method == "Page.loadEventFired" and msg.get("sessionId") in resume_on_load:
                            await send("Runtime.evaluate", {"expression": _restore_script(resume_on_load.pop(msg["sessionId"])), "userGesture": True},
                                       msg["sessionId"])
                            continue
                        if method != "Target.attachedToTarget":
                            continue
                        params = msg.get("params", {})
                        session_id = params.get("sessionId")
                        info = params.get("targetInfo", {})
                        if not session_id:
                            continue
                        self._sessions.add(session_id)
                        waiting = bool(params.get("waitingForDebugger"))
                        target_id = info.get("targetId")
                        if target_id in attached and not waiting:
                            # The browser auto-attached this open tab (setAutoAttach) AND we attached it from the target list: two
                            # sessions for one tab made two reloads and two restores run against each other.
                            continue
                        if target_id:
                            attached[target_id] = session_id
                        if info.get("type") == "page":
                            self._page_sessions.add(session_id)
                            if waiting:
                                # A tab created now: this mode's user agent + scale BEFORE it loads, then let it run.
                                await put_in_place(session_id, want_mobile, reload=False, verify=False)
                                log.info("🆕 [CDP_WATCHER: YENİ SEKME] %s yüklenmeden %s kimliğiyle başlatıldı",
                                         str(info.get("url", ""))[:50], "telefon" if want_mobile else "masaüstü")
                                # A browser that rebuilds its activity on the density change re-creates its tabs (new targets at the old
                                # address, loaded from the top): the tab the user was looking at gets what it showed back once it has loaded.
                                resume = self._resume_for(str(info.get("url", "")))
                                if resume is not None:
                                    resume_on_load[session_id] = resume
                                    await send("Page.enable", {}, session_id)
                            else:
                                await send("Runtime.evaluate", {
                                    "expression": _tab_state_js(want_mobile, with_fp=_SKIP_REDUNDANT_RELOAD),
                                    "awaitPromise": True, "returnByValue": True,
                                }, session_id, tag=("state", session_id))
                        if waiting:
                            await send("Runtime.runIfWaitingForDebugger", {}, session_id)   # EVERY paused target, or it hangs
                finally:
                    self._apply_scale = None
                    for timer in watchdogs.values():
                        timer.cancel()
                    # The overrides die with the session anyway; clearing first makes the return to a DeX window immediate.
                    with contextlib.suppress(Exception):
                        for number, session_id in enumerate(list(self._sessions)):
                            await ws.send(json.dumps({
                                "id": 900000 + number, "method": "Emulation.clearDeviceMetricsOverride", "params": {},
                                "sessionId": session_id,
                            }))
                        await asyncio.sleep(0.2)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            log.debug("[CDP_WATCHER] Dinleyici sonlandı: %s", exc)
        finally:
            log.info("🛑 [CDP_WATCHER: DURDURULDU] %s için tab dinleyicisi kapatıldı", self._window_id)
            await _remove_forward_safe(self._adb, self._serial, port)


_active_watchers: dict[str, BrowserTabAutoAttachWatcher] = {}


def start_browser_auto_attach_watcher(
    adb: "Adb",
    serial: str,
    socket_name: str,
    window_id: str,
    phone_dpr: float | None = None,
    mode: str = "mobile",
    place: str = "phone",
    resume: dict[str, Any] | None = None,
) -> BrowserTabAutoAttachWatcher:
    """Spawns or replaces the tab watcher of a browser (``window_id``: its key — the callers pass the package: the browser
    stays on the phone after its window is closed, and so does the watcher). ``mode``: "mobile" | "desktop" — the identity (site) its
    tabs get. ``place``: "phone" (the phone's own display: always mobile) | "window" (a window, whose size decides the mode, see
    ``window_place``). ``resume``: the front tab's state read before the density change (``capture_browser_scroll_state``), for a
    browser that reloads its pages by itself when it changes."""
    stop_browser_auto_attach_watcher(window_id)
    watcher = BrowserTabAutoAttachWatcher(adb, serial, socket_name, window_id, phone_dpr, mode, place, resume)
    _active_watchers[window_id] = watcher
    watcher.start()
    return watcher


def stop_browser_auto_attach_watcher(window_id: str) -> None:
    """Cancels and cleans up the CDP auto-attach watcher for a window session."""
    watcher = _active_watchers.pop(window_id, None)
    if watcher:
        watcher.stop()


def get_browser_auto_attach_watcher(window_id: str) -> BrowserTabAutoAttachWatcher | None:
    return _active_watchers.get(window_id)


_TABLET_MIN_DP = 600       # a window at least this wide (in dp) gets the desktop site — the width the page lays out in, as CSS media queries see it
_TABLET_FROM_DP = 640      # a window that is on the mobile site goes to the desktop site from here ...
_PHONE_BELOW_DP = 560      # ... and goes back below here: no flapping while the user drags a window across 600 dp


def window_place(width: int | None, height: int | None, dpi: int | None, current: str | None = None) -> tuple[str, float | None]:
    """The identity a browser WINDOW of this size needs, and its real scale (``dpi`` / 160): the site follows the window's WIDTH in dp — a
    narrow window (however tall) gets the mobile site, a window as wide as a tablet or DeX one the desktop site. (Chrome decides per DISPLAY by its
    smallest side, because a display's orientation must not flip the site; a resizable window has no such thing, and what a page lays out in
    is its width: a 1920 x 300 strip is a desktop page, a 400 x 1500 column is a phone one.) ``current``: the mode the window's tabs are in
    now (hysteresis). Unknown size or density: the desktop site and no scale (the way windows always were)."""
    if not width or not height or not dpi:
        return "desktop", None
    dpr = dpi / 160
    width_dp = width / dpr
    if current == "mobile":
        mode = "desktop" if width_dp >= _TABLET_FROM_DP else "mobile"
    elif current == "desktop":
        mode = "mobile" if width_dp < _PHONE_BELOW_DP else "desktop"
    else:
        mode = "desktop" if width_dp >= _TABLET_MIN_DP else "mobile"
    return mode, dpr


def start_window_watcher(adb: "Adb", serial: str, socket_name: str, package: str,
                         width: int | None, height: int | None, dpi: int | None,
                         resume: dict[str, Any] | None = None) -> BrowserTabAutoAttachWatcher:
    """The tab watcher of a browser WINDOW: the identity and scale its size needs (``window_place``)."""
    mode, dpr = window_place(width, height, dpi)
    return start_browser_auto_attach_watcher(adb, serial, socket_name, package, dpr, mode, place="window", resume=resume)


def update_window_place(package: str, width: int | None, height: int | None, dpi: int | None) -> None:
    """A browser window changed size or density. Same size class: its tabs just follow the new scale. A different class (a phone-sized window
    grew into a tablet one, or the other way): the watcher starts again in the other mode — it reads the tabs while the old identity is still
    on them, so the ones that are now the wrong site are reloaded (their video and scroll put back). Never raises."""
    watcher = _active_watchers.get(package)
    if watcher is None or watcher.place != "window" or not width or not height or not dpi:
        return
    try:
        mode, dpr = window_place(width, height, dpi, watcher.mode)
        if mode == watcher.mode:
            watcher.set_scale(dpr)
            return
        log.info("📐 [CDP_WATCHER: PENCERE SINIFI] %s penceresi %dx%d @ %d dpi: %s siteye geçiyor", package, width, height, dpi,
                 "mobil" if mode == "mobile" else "masaüstü")
        start_browser_auto_attach_watcher(watcher._adb, watcher._serial, watcher._socket_name, package, dpr, mode, place="window")
    except Exception as exc:  # noqa: BLE001 — a nicety, never a reason to fail a resize
        log.debug("[CDP_WATCHER] pencere yeri güncellenemedi: %s", exc)


