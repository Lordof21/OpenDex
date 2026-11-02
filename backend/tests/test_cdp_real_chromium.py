"""The page-side scripts of cdp_refresher in a REAL Chromium (headless Chrome driven over CDP, the way the backend drives the phone's Chrome).

What the mock-socket tests cannot say: whether the user's place (the locator, cdp_locator.py) survives another window width AND another
site variant — a desktop and a mobile page with different markup — whether a page that sized itself in script is recognised, whether text
typed into a page is seen, and whether a page that asks for smooth scrolling is put back instantly.
Skipped where no Chrome / Edge is installed."""
from __future__ import annotations

import asyncio
import base64
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import pytest
import websockets

from app.windows import cdp_refresher as cr

_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
_BROWSER = next((p for p in _CANDIDATES if os.path.exists(p)), None) or shutil.which("chromium") or shutil.which("google-chrome")

pytestmark = pytest.mark.skipif(_BROWSER is None, reason="no Chrome / Edge / Chromium installed")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Tab:
    """One headless tab: load a page, set the window width, run a script."""

    def __init__(self, ws, site_port: int):
        self._ws = ws
        self._n = 0
        self.site = f"http://127.0.0.1:{site_port}"

    async def call(self, method: str, params: dict | None = None):
        self._n += 1
        await self._ws.send(json.dumps({"id": self._n, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await asyncio.wait_for(self._ws.recv(), 15))
            if msg.get("id") == self._n:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg["result"]

    async def width(self, w: int, h: int = 700):
        await self.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": False})
        await asyncio.sleep(0.25)

    async def load(self, html: str):
        url = "data:text/html;base64," + base64.b64encode(html.encode()).decode()
        await self.call("Page.navigate", {"url": url})
        await asyncio.sleep(0.5)

    async def goto(self, path: str):
        """A page of the test site, with its pictures decoded (their size is what the layout depends on)."""
        await self.call("Page.navigate", {"url": self.site + path})
        for _ in range(60):
            if await self.run("document.readyState") == "complete":
                break
            await asyncio.sleep(0.1)
        await self.run("Promise.all([...document.images].map((i) => i.decode().catch(() => 0))).then(() => true)", await_promise=True)
        await asyncio.sleep(0.2)

    async def run(self, expression: str, *, await_promise: bool = False):
        res = await self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": await_promise})
        if "exceptionDetails" in res:
            raise RuntimeError(str(res["exceptionDetails"])[:400])
        return res["result"].get("value")

    async def lib(self, body: str, *, await_promise: bool = False):
        """Runs `body` (an expression using the odx* helpers) with the page-side library in front of it."""
        wrap = "async " if await_promise else ""
        return await self.run(f"(({wrap}() => {{ {cr._SCROLL_LIB_JS} return {body}; }})())", await_promise=await_promise)

    async def locator(self) -> dict:
        return json.loads(await self.lib("JSON.stringify(odxLocator())"))

    async def apply(self, locator: dict) -> dict | None:
        return json.loads(await self.lib(f"JSON.stringify(odxApplyLocator({json.dumps(locator)}))"))


class _Site(http.server.ThreadingHTTPServer):
    daemon_threads = True


@pytest.fixture
def routes():
    """path -> (content type, bytes): what the test site serves."""
    return {}


@pytest.fixture
async def tab(routes):
    served = routes

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            path, _, query = self.path.partition("?")
            delay = next((float(v[2:]) for v in query.split("&") if v.startswith("d=")), 0)
            if delay:
                time.sleep(delay / 1000)                         # a picture that arrives late
            kind, body = served.get(path, ("text/plain", b"not found"))
            self.send_response(200 if path in served else 404)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_a):
            pass

    site = _Site(("127.0.0.1", 0), Handler)
    threading.Thread(target=site.serve_forever, daemon=True).start()
    port = _free_port()
    profile = tempfile.mkdtemp(prefix="odx-chrome-")
    proc = subprocess.Popen(
        [_BROWSER, "--headless=new", f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "--no-first-run",
         "--no-default-browser-check", "--disable-gpu", "--window-size=1000,800", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        target = None
        for _ in range(60):
            try:
                targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=1))
                target = next((t for t in targets if t.get("type") == "page"), None)
                if target:
                    break
            except Exception:
                pass
            await asyncio.sleep(0.25)
        assert target, "Chrome did not start"
        async with websockets.connect(target["webSocketDebuggerUrl"], max_size=None) as ws:
            yield Tab(ws, site.server_address[1])
    finally:
        site.shutdown()
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)   # the whole tree: no orphan Chrome
        else:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


def _page(body: str, head: str = "") -> tuple[str, bytes]:
    return "text/html", f"<!doctype html><html><head><meta name=viewport content=\"width=device-width\">{head}</head>{body}</html>".encode()


# ------------------------------------------------------------------------------------------------ pictures, same markup, another width

# A long page of pictures whose height follows the window width (as a manga reader's does).
_PICTURES = """<!doctype html><html><head><meta name=viewport content="width=device-width">
<style>body{margin:0} .p{display:block;width:100%;aspect-ratio:3/4;box-sizing:border-box;border-bottom:2px solid #fff}
.p:nth-child(odd){background:linear-gradient(#e33,#33e)} .p:nth-child(even){background:linear-gradient(#3e3,#ee3)}</style></head>
<body>""" + "".join(f'<div class="p" data-i="{i}"></div>' for i in range(12)) + "</body></html>"

# What is at the top edge of the window: which picture and how far into it (0..1) — what a reader would call "where I am".
_WHERE = """(() => { const el = document.elementsFromPoint(Math.round(innerWidth / 2), 2).find((e) => e.dataset && e.dataset.i !== undefined);
  const r = el.getBoundingClientRect(); return JSON.stringify({ i: +el.dataset.i, f: +((2 - r.top) / r.height).toFixed(3) }); })()"""


async def _where(tab: Tab) -> dict:
    return json.loads(await tab.run(_WHERE))


async def _scroll_into_picture(tab: Tab, index: int, fraction: float):
    await tab.run(f"(() => {{ const r = document.querySelector('[data-i=\"{index}\"]'); window.scrollTo(0, r.offsetTop + r.offsetHeight * {fraction} - 2); }})()")
    await asyncio.sleep(0.2)


async def test_the_place_survives_another_width_of_the_same_page(tab):
    await tab.width(800)
    await tab.load(_PICTURES)
    await _scroll_into_picture(tab, 5, 0.5)
    assert (await _where(tab))["i"] == 5
    locator = await tab.locator()
    y_before = await tab.run("window.scrollY")

    await tab.width(380)                                      # the pictures are now less than half as tall: the same pixel offset is elsewhere
    await tab.run(f"window.scrollTo(0, {y_before})")
    assert (await _where(tab))["i"] != 5                      # the pixel offset lands several pictures further down

    result = await tab.apply(locator)
    after = await _where(tab)
    assert after["i"] == 5 and abs(after["f"] - 0.5) < 0.03, (after, result)
    assert result["votes"] == len(locator["probes"])          # every probe says the same


async def test_a_fixed_bar_is_not_a_probe_and_a_missing_element_resolves_to_nothing(tab):
    await tab.width(800)
    await tab.load(_PICTURES.replace("</body>", '<div id="bar" style="position:fixed;top:0;left:0;right:0;height:40px;background:#000"></div></body>'))
    await _scroll_into_picture(tab, 3, 0.25)
    locator = await tab.locator()
    assert all("bar" not in probe["p"] for probe in locator["probes"])    # the fixed bar sits on top at the first probe: skipped
    assert await tab.apply({"v": 1, "prog": None, "probes": [{"y": 0.0, "f": 0.5, "p": "div:nth-of-type(99)"}]}) is None


# ------------------------------------------------------------------------------------------------ another site variant: a different DOM

_WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split()


def _paragraph(i: int) -> str:
    body = " ".join(_WORDS[(i + k) % len(_WORDS)] for k in range(60))
    return f"Paragraph {i:02d}: {body}."


_DESKTOP_ARTICLE = _page(
    "<body style='margin:0;font:16px/24px sans-serif'><div class=layout style='display:flex'>"
    "<aside style='width:260px;flex:none'>" + "".join(f"<div>menu item {i}</div>" for i in range(30)) + "</aside>"
    "<main style='flex:1'><article>" + "".join(f"<p style='margin:0 0 16px'>{_paragraph(i)}</p>" for i in range(60)) + "</article></main>"
    "</div></body>")
_MOBILE_ARTICLE = _page(
    "<body style='margin:0;font:16px/24px sans-serif'><header style='height:56px'>m.site</header><section class=feed>"
    + "".join(f"<div class=card style='padding:8px 12px'><div class=body><span>{_paragraph(i)}</span></div></div>" for i in range(60))
    + "</section></body>")


# The paragraph under a point of the screen: "Paragraph NN" is its first words.
_PARAGRAPH_AT = """((yv) => { const r = document.caretRangeFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight * yv));
  const m = r && r.startContainer.data && r.startContainer.data.match(/Paragraph (\\d+)/); return m ? +m[1] : null; })"""


async def _paragraph_at(tab: Tab, yv: float):
    return await tab.run(f"{_PARAGRAPH_AT}({yv})")


async def _scroll_to_paragraph(tab: Tab, index: int, fraction: float):
    await tab.run(f"""(() => {{ const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) if (n.data.startsWith('Paragraph {index:02d}')) break;
      const r = n.parentElement.getBoundingClientRect(); window.scrollBy(0, r.top + r.height * {fraction}); }})()""")
    await asyncio.sleep(0.2)


async def test_the_place_goes_from_the_desktop_site_to_the_mobile_site_by_what_it_says(routes, tab):
    """Different markup, different width, different heights: no path and no pixel offset means anything. What the reader was looking at —
    paragraph 31, half way down it — is found by its words."""
    routes["/desktop"], routes["/mobile"] = _DESKTOP_ARTICLE, _MOBILE_ARTICLE
    await tab.width(1000)
    await tab.goto("/desktop")
    await _scroll_to_paragraph(tab, 31, 0.5)
    assert await _paragraph_at(tab, 0.02) == 31
    locator = await tab.locator()
    assert any(p.get("t", "").startswith("paragraph 31") for p in locator["probes"])
    pixels = await tab.run("window.scrollY")

    await tab.width(400)
    await tab.goto("/mobile")
    await tab.run(f"window.scrollTo(0, {pixels})")
    assert await _paragraph_at(tab, 0.02) != 31               # the pixel offset is nowhere near

    result = await tab.apply(locator)
    assert result["how"] == "text" and result["votes"] >= 2, result
    assert await _paragraph_at(tab, 0.02) == 31               # the paragraph the reader was in
    for yv in (0.34, 0.67):                                   # … and the page reads on from there
        assert await _paragraph_at(tab, yv) in (31, 32, 33)


def _gallery_images(base: str):
    svg = lambda w, h: f"<svg xmlns='http://www.w3.org/2000/svg' width='{w}' height='{h}'><rect width='100%' height='100%' fill='#789'/></svg>".encode()  # noqa: E731
    return {f"{base.format(n=f'{i:03d}')}": ("image/svg+xml", svg(800, 1200)) for i in range(20)}


async def test_the_place_goes_between_two_picture_readers_by_the_picture(routes, tab):
    """A manga reader's desktop and mobile variants: different markup, different file locations — the same file NAME."""
    routes.update(_gallery_images("/img/large/{n}.svg"))
    routes.update(_gallery_images("/m/{n}-640x960.svg"))
    routes["/desktop"] = _page(
        "<body style='margin:0'><div class=reader style='width:900px;margin:0 auto'>"
        + "".join(f"<div class=page><img src='/img/large/{i:03d}.svg' style='width:100%;display:block'></div>" for i in range(20))
        + "</div></body>")
    routes["/mobile"] = _page(
        "<body style='margin:0'><ul style='list-style:none;margin:0;padding:0'>"
        + "".join(f"<li><figure style='margin:0'><img data-src='/m/{i:03d}-640x960.svg' src='/m/{i:03d}-640x960.svg' style='width:100%;display:block'></figure></li>"
                  for i in range(20)) + "</ul></body>")
    await tab.width(1000)
    await tab.goto("/desktop")
    await tab.run("(() => { const im = document.images[7]; window.scrollTo(0, im.offsetTop + im.offsetHeight * 0.5 - 2); })()")
    await asyncio.sleep(0.2)
    locator = await tab.locator()
    assert any(p.get("i") == "007" for p in locator["probes"])

    await tab.width(400)
    await tab.goto("/mobile")
    result = await tab.apply(locator)
    assert result["how"] == "image", result
    top = json.loads(await tab.run("""(() => { const el = document.elementsFromPoint(200, 2).find((e) => e.tagName === 'IMG');
      const r = el.getBoundingClientRect(); return JSON.stringify({ n: [...document.images].indexOf(el), f: +((2 - r.top) / r.height).toFixed(2) }); })()"""))
    assert top["n"] == 7 and abs(top["f"] - 0.5) < 0.05, top


async def test_a_path_that_now_shows_other_content_is_not_trusted(routes, tab):
    """A feed re-rendered with new items on top: the SAME path leads to a different item. The words say where the reader was."""
    def feed(first_new: int):
        items = [f"Item {i:02d} of the feed: " + " ".join(_WORDS[(i + k) % len(_WORDS)] for k in range(30)) for i in range(30)]
        items = [f"Breaking {n}: something that was not there before " + "x" * 80 for n in range(first_new)] + items
        return _page("<body style='margin:0;font:16px/24px sans-serif'><ul style='margin:0;padding:0 8px'>"
                     + "".join(f"<li style='margin-bottom:12px'>{t}</li>" for t in items) + "</ul></body>")

    routes["/before"], routes["/after"] = feed(0), feed(6)
    await tab.width(600)
    await tab.goto("/before")
    await tab.run("""(() => { const li = [...document.querySelectorAll('li')].find((e) => e.textContent.startsWith('Item 15'));
      window.scrollBy(0, li.getBoundingClientRect().top + li.offsetHeight * 0.3); })()""")
    await asyncio.sleep(0.2)
    locator = await tab.locator()

    await tab.goto("/after")
    result = await tab.apply(locator)
    assert result["how"] in ("text", "path") and result["votes"] >= 1
    top = await tab.run("(() => { const r = document.caretRangeFromPoint(300, 4); return r.startContainer.data.slice(0, 7); })()")
    assert top == "Item 15", top                              # not "Item 09": what the old path points at now


async def test_one_probe_that_disagrees_is_outvoted(routes, tab):
    routes["/desktop"] = _DESKTOP_ARTICLE
    await tab.width(1000)
    await tab.goto("/desktop")
    await _scroll_to_paragraph(tab, 40, 0.2)
    locator = await tab.locator()
    assert len(locator["probes"]) == 3
    wrong = dict(locator["probes"][0], p="article > p:nth-of-type(3)")      # points at a paragraph far away, and cannot be checked (no words)
    wrong.pop("t", None), wrong.pop("i", None)
    voted = {**locator, "probes": [wrong, *locator["probes"][1:]]}
    await tab.run("window.scrollTo(0, 0)")
    result = await tab.apply(voted)
    assert result["votes"] == 2 and result["of"] == 3, result
    assert await _paragraph_at(tab, 0.02) == 40


async def test_nothing_resolvable_falls_back_to_how_far_down_the_page_was(routes, tab):
    routes["/desktop"] = _DESKTOP_ARTICLE
    await tab.width(1000)
    await tab.goto("/desktop")
    ghost = {"v": 1, "prog": 0.5, "probes": [{"y": 0.0, "f": 0.5, "p": "section > div:nth-of-type(9)", "t": "words that are nowhere on this page"}]}
    result = await tab.apply(ghost)
    assert result["how"] == "ratio" and result["votes"] == 0
    max_scroll = await tab.run("document.documentElement.scrollHeight - innerHeight")
    assert abs(await tab.run("window.scrollY") - max_scroll * 0.5) < 3
    assert await tab.apply({"v": 1, "prog": None, "probes": ghost["probes"]}) is None   # no fraction either: the caller keeps its pixels


# ------------------------------------------------------------------------------------------------ webtoons: ONE picture many screens tall


async def test_the_place_inside_one_enormous_picture_is_kept_across_widths(routes, tab):
    """A webtoon chapter is a few pictures of 800 x 14 000 px (measured: 16 537 px tall in a 1 431 px window — 23 screens). The first locator
    refused anything taller than six screens, read NOTHING on such a page and the restore fell back to pixels: wrong at every other width.
    A picture scales uniformly, so how far into it the reader is (a fraction) is exact however tall it is."""
    svg = "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='14000'><rect width='100%' height='100%' fill='#789'/></svg>".encode()
    routes["/w/chapter-01.svg"] = ("image/svg+xml", svg)
    routes["/w/chapter-02.svg"] = ("image/svg+xml", svg)
    # as on the real site (merlintoon.com): the pictures sit in wrapper divs and are `pointer-events: none` (against saving them), so a hit test
    # at a point of the screen names the 200 000 px wrapper and never the picture
    routes["/webtoon"] = _page("<style>img{pointer-events:none;display:block;width:100%}</style><body style='margin:0'><div class=body>"
                               "<img src='/w/chapter-01.svg'><img src='/w/chapter-02.svg'></div></body>")
    await tab.width(1000)
    await tab.goto("/webtoon")
    await tab.run("(() => { const im = document.images[1]; window.scrollTo(0, im.offsetTop + im.offsetHeight * 0.37 - 2); })()")
    await asyncio.sleep(0.2)
    locator = await tab.locator()
    assert locator is not None and locator["probes"][0]["i"] == "chapter-02"

    await tab.width(380)                                       # every picture is now a third of the height: pixels would be several chapters off
    await tab.run("window.scrollTo(0, 0)")
    result = await tab.apply(locator)
    assert result["how"] in ("path", "image"), result
    top = json.loads(await tab.run("""(() => { const el = [...document.images].find((i) => i.getBoundingClientRect().top <= 2 && i.getBoundingClientRect().bottom > 2);
      const r = el.getBoundingClientRect(); return JSON.stringify({ n: [...document.images].indexOf(el), f: +((2 - r.top) / r.height).toFixed(3) }); })()"""))
    assert top["n"] == 1 and abs(top["f"] - 0.37) < 0.005, top


async def test_a_picture_is_known_by_its_name_even_where_no_path_can_be_written(routes, tab):
    """A theme that nests its content more than twelve levels deep has no usable path (the path is capped): the picture's name carries it."""
    svg = "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='3000'><rect width='100%' height='100%' fill='#789'/></svg>".encode()
    routes.update({f"/w/page-{i:02d}.svg": ("image/svg+xml", svg) for i in range(6)})
    deep = "<div>" * 15 + "".join(f"<img src='/w/page-{i:02d}.svg'>" for i in range(6)) + "</div>" * 15
    routes["/deep"] = _page(f"<style>img{{display:block;width:100%}}</style><body style='margin:0'>{deep}</body>")
    await tab.width(900)
    await tab.goto("/deep")
    await tab.run("(() => { const im = document.images[3]; window.scrollTo(0, im.offsetTop + im.offsetHeight * 0.6 - 2); })()")
    await asyncio.sleep(0.2)
    locator = await tab.locator()
    assert locator is not None and all(p.get("p") is None and p["i"] for p in locator["probes"]), locator
    await tab.width(400)
    result = await tab.apply(locator)
    assert result["how"] == "image"
    n = await tab.run("[...document.images].findIndex((i) => i.getBoundingClientRect().top <= 2 && i.getBoundingClientRect().bottom > 2)")
    assert n == 3


# ------------------------------------------------------------------------------------------------ pictures that arrive AFTER the restore starts

# A reader that appends its pictures after the page has loaded, each arriving at its own moment and with no size until it has: every one
# that lands pushes everything below it down.
_LATE_PICTURES = """<!doctype html><html><head><meta name=viewport content="width=device-width"></head><body style="margin:0"><div id=r></div>
<script>addEventListener('load', () => { for (let i = 0; i < 14; i++) { const im = new Image(); im.style.cssText = 'display:block;width:100%'; im.dataset.i = i;
  im.src = '/g/' + String(i).padStart(3, '0') + '.svg?d=' + (60 + ((i * 53) % 400)); document.getElementById('r').appendChild(im); } });</script></body></html>"""


async def test_the_page_is_placed_once_the_pictures_have_landed_not_chased_while_they_arrive(routes, tab):
    """Placing the page while its pictures are still arriving puts it where the content WAS (the pictures above are 0 px tall) and each
    picture that lands pushes it away again: the reader would watch the page jump. On a picture page the first placement waits until
    nothing is loading and the height has been still for a moment (at most ~0.7 s); the corrections after it only catch the stragglers."""
    svg = "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='1200'><rect width='100%' height='100%' fill='#789'/></svg>".encode()
    routes.update({f"/g/{i:03d}.svg": ("image/svg+xml", svg) for i in range(14)})
    routes["/reader"] = ("text/html", _LATE_PICTURES.encode())
    await tab.width(400)
    await tab.goto("/reader")
    await tab.run("new Promise((r) => { const t = setInterval(() => { if ([...document.images].length === 14 && [...document.images].every((i) => i.complete)) { clearInterval(t); r(1); } }, 50); })", await_promise=True)
    await tab.run("(() => { const im = document.images[9]; window.scrollTo(0, im.offsetTop + im.offsetHeight * 0.5 - 2); })()")
    await asyncio.sleep(0.2)
    saved = {"y": await tab.run("window.scrollY"), "c": [], "l": await tab.locator()}

    await tab.call("Page.navigate", {"url": tab.site + "/reader"})                     # the same page again: its pictures arrive late
    for _ in range(100):
        if await tab.run("document.readyState") == "complete":
            break
        await asyncio.sleep(0.02)
    await tab.run("window.__jumps = 0; addEventListener('scroll', () => { window.__jumps++; });")
    await tab.lib(f"odxRestoreAll({json.dumps(saved)})", await_promise=True)
    await asyncio.sleep(0.3)

    top = json.loads(await tab.run("""(() => { const el = document.elementsFromPoint(200, 2).find((e) => e.tagName === 'IMG');
      const r = el.getBoundingClientRect(); return JSON.stringify({ n: [...document.images].indexOf(el), f: +((2 - r.top) / r.height).toFixed(2) }); })()"""))
    assert top["n"] == 9 and abs(top["f"] - 0.5) < 0.05, top
    assert await tab.run("window.__jumps") <= 2, await tab.run("window.__jumps")      # placed once (plus at most a straggler), not chased


# ------------------------------------------------------------------------------------------------ the rest of the page-side library


async def test_typed_text_is_seen_and_an_empty_page_is_not(tab):
    await tab.width(600)
    await tab.load("<!doctype html><body><input id=a><textarea id=b></textarea><div id=c contenteditable=true></div><input type=checkbox></body>")
    assert await tab.lib("odxTyped()") is False
    await tab.run("document.getElementById('b').value = 'a half-written message'")
    assert await tab.lib("odxTyped()") is True
    await tab.run("document.getElementById('b').value = ''; document.getElementById('c').textContent = 'draft'")
    assert await tab.lib("odxTyped()") is True
    await tab.run("document.getElementById('c').textContent = ''; document.querySelector('[type=checkbox]').checked = true")
    assert await tab.lib("odxTyped()") is False               # a ticked box is not text a reload would lose


# A reader that sizes its page blocks in SCRIPT, once, at the width it loaded with (what made the gaps between the pictures on the phone).
_SIZED_IN_SCRIPT = """<!doctype html><html><body style="margin:0">
<div class=b><div class=c></div></div><div class=b><div class=c></div></div><div class=b><div class=c></div></div>
<style>.c{width:100%;aspect-ratio:2/1;background:#888}</style>
<script>document.querySelectorAll('.b').forEach((b) => { b.style.minHeight = Math.round(innerWidth / 2) + 'px'; });</script></body></html>"""
_RESPONSIVE = """<!doctype html><html><body style="margin:0"><style>.b{min-height:50vw}.c{width:100%;aspect-ratio:2/1;background:#888}</style>
<div class=b><div class=c></div></div><div class=b><div class=c></div></div><div class=b><div class=c></div></div></body></html>"""


async def test_a_page_sized_in_script_shows_the_symptom_at_another_width_and_a_responsive_one_does_not(tab):
    await tab.width(800)
    await tab.load(_SIZED_IN_SCRIPT)
    at_load = json.loads(await tab.run(cr._STALE_LAYOUT_JS))
    assert at_load["gaps"] == 0                               # at the width it was sized for there is nothing to see

    await tab.width(380)
    now = json.loads(await tab.run(cr._STALE_LAYOUT_JS))
    assert now["gaps"] == 3 and now["vw"] == 380, now
    assert cr._width_reload_verdict(800, 380, now) is not None

    await tab.width(800)
    await tab.load(_RESPONSIVE)
    await tab.width(380)
    responsive = json.loads(await tab.run(cr._STALE_LAYOUT_JS))
    assert responsive["gaps"] == 0                            # the page follows the width itself: never reloaded for it
    assert cr._width_reload_verdict(800, 380, responsive) is None


_SMOOTH = """<!doctype html><html style="scroll-behavior:smooth"><body style="margin:0">
<div id=box style="height:300px;overflow:auto;scroll-behavior:smooth"><div style="height:3000px"></div></div><div style="height:4000px"></div></body></html>"""


async def test_a_page_that_asks_for_smooth_scrolling_is_still_put_back_at_once(tab):
    """`scroll-behavior: smooth` turns every scrollTo / scrollTop write into an animation: the restore must not wait for one (the user
    would watch the page crawl back, and the next write of the loop would fight the animation)."""
    await tab.width(800)
    await tab.load(_SMOOTH)
    await tab.lib("odxApplyOnce({ c: [{ p: 'div#box', r: 0.5 }] })")      # an inner container, written by ratio
    assert await tab.run("document.getElementById('box').scrollTop") > 1000
    await tab.run("window.scrollTo(0, 0)")
    await asyncio.sleep(0.6)
    await tab.lib("odxRestoreAll({ y: 1500, c: [] })", await_promise=False)   # the window, by pixels (one pass of the loop)
    assert await tab.run("window.scrollY") > 1400


async def test_the_nudge_goes_back_to_the_place_not_to_the_top_of_the_picture(tab):
    """The in-place nudge (after a density / width change) used to put the captured element's TOP at the top edge: a reader half way down
    a tall picture jumped up by half a picture. It goes back by the locator."""
    await tab.width(800)
    await tab.load(_PICTURES)
    await _scroll_into_picture(tab, 5, 0.5)
    saved = {"isTop": False, "scrollY": await tab.run("window.scrollY"), "scrollX": 0, "locator": await tab.locator()}

    await tab.width(380)
    await tab.run("performance.now = () => 60000")            # an old document: the nudge is allowed to scroll
    await tab.run(cr._build_nudge_script(saved))
    await asyncio.sleep(0.9)                                  # its phases run at 0 / 80 / 250 / 600 ms
    after = await _where(tab)
    assert after["i"] == 5 and abs(after["f"] - 0.5) < 0.05, after
