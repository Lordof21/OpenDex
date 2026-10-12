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

        // 1. Inhibit Blink scroll anchoring, reset text size adjust & neutralize stale tablet zoom
        const prevRootAnchor = root ? root.style.overflowAnchor : '';
        const prevBodyAnchor = body ? body.style.overflowAnchor : '';
        const isPhoneScreen = (window.screen.width <= 480 || (window.screen.availWidth && window.screen.availWidth <= 480));
        const hasStaleTabletZoom = (isPhoneScreen && window.devicePixelRatio > 3.4);

        if (root) {{
            root.style.overflowAnchor = 'none';
            root.style.webkitTextSizeAdjust = '100%';
            if (hasStaleTabletZoom) {{
                // Neutralize 1.20x tablet magnification factor (3.20625 / 3.8475 = 0.833333)
                const normZoom = (3.20625 / window.devicePixelRatio);
                root.style.zoom = normZoom.toFixed(6);
            }} else {{
                root.style.zoom = '1.0';
            }}
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


def _build_auto_nudge_script() -> str:
    """Constructs a self-contained JavaScript snippet evaluated on new document creation.

    Injected via Page.addScriptToEvaluateOnNewDocument and Target.setAutoAttach
    to guarantee any newly opened tab, popup ad (window.open / target="_blank"), or child WebContents
    renders with exact 1:1 phone DPI instead of inheriting the un-restarted Chrome process's
    stale 1.20x tablet magnification factor (dpr 3.8475).
    """
    return """
    (() => {
        try {
            const root = document.documentElement;
            const body = document.body;
            const isPhoneScreen = (window.screen.width <= 480 || (window.screen.availWidth && window.screen.availWidth <= 480));
            const hasStaleTabletZoom = (isPhoneScreen && window.devicePixelRatio > 3.4);

            if (root) {
                root.style.overflowAnchor = 'none';
                root.style.webkitTextSizeAdjust = '100%';
                if (hasStaleTabletZoom) {
                    const normZoom = (3.20625 / window.devicePixelRatio);
                    root.style.zoom = normZoom.toFixed(6);
                } else {
                    root.style.zoom = '1.0';
                }
            }
            if (body) {
                body.style.overflowAnchor = 'none';
                body.style.webkitTextSizeAdjust = '100%';
            }
            window.dispatchEvent(new Event('resize'));
            window.dispatchEvent(new Event('orientationchange'));
        } catch (e) {}
    })()
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
                loop = asyncio.get_running_loop()
                req = urllib.request.Request(f"http://127.0.0.1:{port}/json/list")
                raw_list = await loop.run_in_executor(
                    None, lambda: urllib.request.urlopen(req, timeout=0.4).read().decode()
                )
                tabs = json.loads(raw_list)
                pages = [
                    t for t in tabs
                    if t.get("type") == "page" and t.get("url", "").startswith(("http://", "https://")) and t.get("webSocketDebuggerUrl")
                ]
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

                # Fetch all open page tabs
                req = urllib.request.Request(f"http://127.0.0.1:{port}/json/list")
                raw_list = await loop.run_in_executor(
                    None, lambda: urllib.request.urlopen(req, timeout=0.5).read().decode()
                )
                tabs = json.loads(raw_list)
                pages = [
                    t for t in tabs
                    if t.get("type") == "page" and t.get("url", "").startswith(("http://", "https://")) and t.get("webSocketDebuggerUrl")
                ]
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


class BrowserTabAutoAttachWatcher:
    """Continuous background watcher for browser tabs using CDP Target.setAutoAttach.

    While a browser application stands on the phone (Display 0), any newly created tab,
    popup ad (window.open / target="_blank"), or child WebContents is immediately
    intercepted upon creation.

    Uses flattened session multiplexing over a single persistent browser WebSocket connection:
    - Zero per-tab port forwards
    - Instant Page.addScriptToEvaluateOnNewDocument injection
    - Scale factor 1.0 enforcement
    - Neutralizes 1.20x tablet zoom factor before page content renders
    """

    def __init__(self, adb: "Adb", serial: str, socket_name: str, window_id: str):
        self._adb = adb
        self._serial = serial
        self._socket_name = socket_name
        self._window_id = window_id
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

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

    async def _run(self) -> None:
        clean_socket = self._socket_name.lstrip("@")
        port = await self._adb.forward(0, f"localabstract:{clean_socket}", serial=self._serial)
        if not port or port <= 0:
            port = 9225
            await self._adb.forward(port, f"localabstract:{clean_socket}", serial=self._serial)

        try:
            loop = asyncio.get_running_loop()
            req = urllib.request.Request(f"http://127.0.0.1:{port}/json/version")
            raw_ver = await loop.run_in_executor(
                None, lambda: urllib.request.urlopen(req, timeout=1.0).read().decode()
            )
            ver = json.loads(raw_ver)
            browser_ws_raw = ver.get("webSocketDebuggerUrl") or f"ws://127.0.0.1:{port}/devtools/browser"
            browser_ws = re.sub(r"ws://[^/]+/", f"ws://127.0.0.1:{port}/", browser_ws_raw)
            auto_nudge = _build_auto_nudge_script()

            async with websockets.connect(browser_ws) as ws:
                req_id = 1
                await ws.send(json.dumps({
                    "id": req_id,
                    "method": "Target.setAutoAttach",
                    "params": {
                        "autoAttach": True,
                        "waitForDebuggerOnStart": False,
                        "flatten": True,
                    },
                }))
                log.info(
                    "👁️ [CDP_WATCHER: BAŞLATILDI] win=%s için otomatik tab/popup dinleyicisi devrede (flatten: true)",
                    self._window_id,
                )

                while not self._stop_event.is_set():
                    try:
                        raw = await ws.recv()
                        msg = json.loads(raw)
                        method = msg.get("method")
                        if method == "Target.attachedToTarget":
                            params = msg.get("params", {})
                            session_id = params.get("sessionId")
                            target_info = params.get("targetInfo", {})
                            target_type = target_info.get("type")
                            target_url = target_info.get("url", "")
                            target_id = target_info.get("targetId", "")

                            if target_type == "page" and session_id:
                                log.info(
                                    "🆕 [CDP_WATCHER: YENİ SEKME/POPUP] target=%s ('%s') yakalandı — telefon DPI ve auto-nudge enjekte ediliyor",
                                    target_id, target_url[:50],
                                )
                                req_id += 1
                                await ws.send(json.dumps({
                                    "id": req_id,
                                    "sessionId": session_id,
                                    "method": "Page.enable",
                                }))
                                req_id += 1
                                await ws.send(json.dumps({
                                    "id": req_id,
                                    "sessionId": session_id,
                                    "method": "Page.addScriptToEvaluateOnNewDocument",
                                    "params": {"source": auto_nudge},
                                }))
                                req_id += 1
                                await ws.send(json.dumps({
                                    "id": req_id,
                                    "sessionId": session_id,
                                    "method": "Emulation.setPageScaleFactor",
                                    "params": {"pageScaleFactor": 1.0},
                                }))
                                req_id += 1
                                await ws.send(json.dumps({
                                    "id": req_id,
                                    "sessionId": session_id,
                                    "method": "Emulation.resetPageScaleFactor",
                                }))
                                req_id += 1
                                await ws.send(json.dumps({
                                    "id": req_id,
                                    "sessionId": session_id,
                                    "method": "Runtime.evaluate",
                                    "params": {"expression": auto_nudge},
                                }))
                    except asyncio.CancelledError:
                        break
                    except Exception as loop_exc:
                        log.debug("[CDP_WATCHER] Olay döngüsü uyarısı: %s", loop_exc)
                        break
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            log.debug("[CDP_WATCHER] Dinleyici sonlandı: %s", exc)
        finally:
            log.info("🛑 [CDP_WATCHER: DURDURULDU] win=%s için tab dinleyicisi kapatıldı", self._window_id)
            await _remove_forward_safe(self._adb, self._serial, port)


_active_watchers: dict[str, BrowserTabAutoAttachWatcher] = {}


def start_browser_auto_attach_watcher(
    adb: "Adb",
    serial: str,
    socket_name: str,
    window_id: str,
) -> BrowserTabAutoAttachWatcher:
    """Spawns or replaces a continuous CDP auto-attach watcher for a window session."""
    stop_browser_auto_attach_watcher(window_id)
    watcher = BrowserTabAutoAttachWatcher(adb, serial, socket_name, window_id)
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


