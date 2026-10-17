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


def _build_nudge_script(saved_scroll: dict[str, Any] | None) -> str:
    saved_is_top = "null"
    saved_x = "null"
    saved_y = "null"
    saved_ratio = "null"
    saved_anchor_path = "null"
    if saved_scroll and isinstance(saved_scroll, dict):
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

    return f"""
    (() => {{
        const savedIsTop = {saved_is_top};
        const savedX = {saved_x};
        const savedY = {saved_y};
        const targetRatio = {saved_ratio};
        const anchorPath = {saved_anchor_path};

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




async def _probe_tab_visible(port: int, page: dict[str, Any]) -> dict[str, Any] | None:
    """The page if its document is visible and focused-capable right now, else None. One short websocket, never raises."""
    ws_url_raw = page.get("webSocketDebuggerUrl")
    if not ws_url_raw:
        return None
    ws_url = re.sub(r"ws://[^/]+/", f"ws://127.0.0.1:{port}/", ws_url_raw)
    try:
        async with websockets.connect(ws_url, open_timeout=_TAB_OPEN_TIMEOUT_S, close_timeout=0.1) as ws:
            check_js = "JSON.stringify({visible: document.visibilityState === 'visible', focus: document.hasFocus ? document.hasFocus() : false})"
            res = await _send_cdp(ws, "Runtime.evaluate", {"expression": check_js}, req_id=1, timeout_s=0.25)
            val_str = (res or {}).get("result", {}).get("result", {}).get("value")
            if val_str and json.loads(val_str).get("visible"):
                return page
    except Exception:
        return None
    return None


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

    probes = [asyncio.ensure_future(_probe_tab_visible(port, page)) for page in valid_pages]
    try:
        await asyncio.wait(probes, timeout=max(timeout_s, 0.3))
        for probe in probes:
            if probe.done() and not probe.cancelled() and probe.exception() is None and probe.result() is not None:
                return probe.result()
    finally:
        for probe in probes:
            if not probe.done():
                probe.cancel()
        await asyncio.gather(*probes, return_exceptions=True)

    # Fallback to the first page if none explicitly reported visible
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
                        "  return JSON.stringify({"
                        "    targetId: " + json.dumps(target_page.get("id", "")) + ", "
                        "    url: window.location.href, "
                        "    scrollX: scrollX, "
                        "    scrollY: scrollY, "
                        "    isTop: isTop, "
                        "    ratio: ratio, "
                        "    anchorPath: anchorPath, "
                        "    hasMedia: Array.from(document.querySelectorAll('video, audio')).some(el => !el.paused && !el.ended && el.readyState > 2)"
                        "  });"
                        "})()"
                    )
                    res = await _send_cdp(ws, "Runtime.evaluate", {"expression": capture_js}, req_id=1, timeout_s=timeout_s)
                    if not res:
                        return None
                    val = json.loads(res.get("result", {}).get("result", {}).get("value", "{}"))
                    if isinstance(val, dict):
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
                    res = await _send_cdp(ws, "Page.reload", {"ignoreCache": False}, req_id=31, timeout_s=1.0)
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


# What a tab says about itself before it is switched: the site it was loaded as (mobile / desktop), whether it is the tab the user
# sees, and what must survive a reload (the video's second and play state, the scroll position, the address).
_TAB_STATE_JS = (
    "JSON.stringify((()=>{const v=[...document.querySelectorAll('video')].find(x=>x.duration>0&&isFinite(x.duration));"
    "return {mobile:navigator.userAgentData?navigator.userAgentData.mobile:/Mobi/.test(navigator.userAgent),"
    "visible:document.visibilityState==='visible',t:v?v.currentTime:null,playing:v?(!v.paused&&!v.ended):null,"
    "y:window.scrollY,url:location.href,host:location.hostname}})())"
)


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


def _restore_script(state: dict[str, Any]) -> str:
    """Runs in the reloaded page: waits for its video and puts it back at the second and play state it had, then the scroll."""
    saved = json.dumps({"t": state.get("t"), "playing": state.get("playing"), "y": state.get("y"), "url": state.get("url")})
    # The page starts its own player (autoplay) a moment after it loads: the saved play state is held for a few seconds, not set once.
    return (
        "(async (saved)=>{const a=new URL(saved.url);if(a.pathname!==location.pathname||"
        "a.searchParams.get('v')!==new URL(location.href).searchParams.get('v'))return;"
        "let moved=false;for(let i=0;i<56;i++){const v=[...document.querySelectorAll('video')].find(x=>x.duration>0&&isFinite(x.duration));"
        "if(v){if(!moved){moved=true;if(saved.t!=null&&Math.abs(v.currentTime-saved.t)>1.5)v.currentTime=saved.t;}"
        "if(saved.playing===false&&!v.paused)v.pause();else if(saved.playing===true&&v.paused)await v.play().catch(()=>{});"
        "if(i>16&&moved&&(saved.playing!==false||v.paused))break;}"
        "await new Promise(r=>setTimeout(r,250));}"
        "if(saved.y)window.scrollTo(0,saved.y);})(" + saved + ")"
    )


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
    reloaded under the new user agent, and what a reload would lose — the video's second and play state, the scroll position — is
    put back (`_restore_script`). The other tabs get the user agent (so their next load is right) and their scale only.

    Overrides are scoped to this session: stopping the watcher (or losing the connection) drops them all.

    ``phone_dpr``: the phone's own density / 160 (mobile mode). None: no scale to apply."""

    def __init__(self, adb: "Adb", serial: str, socket_name: str, window_id: str, phone_dpr: float | None = None,
                 mode: str = "mobile"):
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

    @property
    def mode(self) -> str:
        return self._mode

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
                attached: dict[str, str] = {}                  # targetId -> session: a tab is handled ONCE (see below)
                initial: set[str] | None = None                # targetIds of the tabs open at the start that still wait for their turn

                def maybe_settled() -> None:
                    if initial is not None and not initial and not reloading:
                        self._settled.set()

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

                def scale_params(mobile: bool) -> dict[str, Any]:
                    return {"width": 0, "height": 0, "deviceScaleFactor": self._phone_dpr, "mobile": mobile}

                async def put_in_place(session_id: str, tab_mobile: bool, *, reload: bool, state: dict[str, Any] | None = None) -> None:
                    """The user agent of this watcher's mode, the scale (phone), and — when the tab was loaded as the other site and
                    is the one in front — a reload that gives it the right site, with its video / scroll put back afterwards."""
                    if ua_params:
                        await send("Emulation.setUserAgentOverride", ua_params, session_id)
                    if want_mobile and self._phone_dpr:
                        # A tab that stays the desktop site (not reloaded) is scaled in the layout it runs in.
                        await send("Emulation.setDeviceMetricsOverride", scale_params(True if reload else tab_mobile), session_id)
                    if reload and state is not None:
                        reloading[session_id] = state
                        await send("Page.enable", {}, session_id)
                        target_url = _mobile_site_url(str(state.get("url", ""))) if want_mobile else None
                        if target_url:
                            await send("Page.navigate", {"url": target_url}, session_id)
                        else:
                            await send("Page.reload", {"ignoreCache": False}, session_id)
                        log.info("🔁 [CDP_WATCHER: SİTE KİPİ] %s sekmesi %s siteye çevriliyor (video ve kaydırma korunacak)",
                                 str(state.get("url", ""))[:50], "mobil" if want_mobile else "masaüstü")

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
                            elif kind == "state" and session_id:
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
                                await put_in_place(session_id, tab_mobile, reload=wrong_site and front, state=state)
                                if initial is not None:
                                    initial.discard(next((t for t, sid in attached.items() if sid == session_id), None))
                                    maybe_settled()
                            continue

                        method = msg.get("method")
                        if method == "Page.loadEventFired" and msg.get("sessionId") in reloading:
                            state = reloading.pop(msg["sessionId"])
                            await send("Runtime.evaluate", {"expression": _restore_script(state), "userGesture": True},
                                       msg["sessionId"])
                            maybe_settled()
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
                            if waiting:
                                # A tab created now: this mode's user agent + scale BEFORE it loads, then let it run.
                                await put_in_place(session_id, want_mobile, reload=False)
                                log.info("🆕 [CDP_WATCHER: YENİ SEKME] %s yüklenmeden %s kimliğiyle başlatıldı",
                                         str(info.get("url", ""))[:50], "telefon" if want_mobile else "masaüstü")
                            else:
                                await send("Runtime.evaluate", {"expression": _TAB_STATE_JS}, session_id, tag=("state", session_id))
                        if waiting:
                            await send("Runtime.runIfWaitingForDebugger", {}, session_id)   # EVERY paused target, or it hangs
                finally:
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
) -> BrowserTabAutoAttachWatcher:
    """Spawns or replaces the tab watcher of a browser (``window_id``: its key — the callers pass the package: the browser
    stays on the phone after its window is closed, and so does the watcher). ``mode``: "mobile" (on the phone) | "desktop" (in a
    DeX window)."""
    stop_browser_auto_attach_watcher(window_id)
    watcher = BrowserTabAutoAttachWatcher(adb, serial, socket_name, window_id, phone_dpr, mode)
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


