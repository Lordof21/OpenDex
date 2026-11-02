"""Where the user was on a page, in a form that survives another layout: the page-side locator.

A pixel offset says "1 500 px down". On another site variant (desktop vs mobile), another window width, another font size or a page
that re-rendered, 1 500 px is somewhere else. What a reader means is "at this paragraph, at this picture". So the position is saved as
a LOCATOR: a few probe points in the viewport, each described by what is under it —

    { v: 1, prog: 0..1,                                   # how far down the document the page was (the last resort)
      probes: [ { y: 0.33,                                # where in the viewport the point sat (a fraction of its height)
                  f: 0.62,                                # how far into the element it was (a fraction of the element's height)
                  p: "div#a > p:nth-of-type(3)",          # the element's structural path
                  t: "the first 64 characters of the text", # …what it SAYS (text probes), or
                  i: "001" } ] }                          # …what picture it IS (image key: the file name without extension / size)

and put back by resolving each probe to an element in the NEW page, in this order of trust:

    1. its path — but only when it still shows the same text / picture (a re-rendered list can put other content on the same path);
    2. its picture (the file name survives a mobile / desktop switch; lazy-loaded pictures carry it in `data-src`);
    3. its text (found among the page's text nodes; of several equal ones the one nearest to where the page was in the document).

The resolved probes must then AGREE on the order of the page (each below the one before, by about what it was on screen — content scales
and reflows, so about = a factor of ten): a probe that resolved to the far end of the document is left out; the largest agreeing set
wins and places the page by its first probe, so what was at the top of the screen stays at the top. Nothing resolvable: the
document-progress fraction; no fraction: the caller keeps its pixel offset. Pure page-side code (it runs in the tab over CDP): the Python side only builds it into the library string and checks
the shape of what comes back (`clean_locator`)."""
from __future__ import annotations

from typing import Any

PROBE_COUNT_MAX = 3

LOCATOR_JS = r"""
// ---- locator: see backend/app/windows/cdp_locator.py -------------------------------------------------------------------------------
const odxNorm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
// What picture an element is: its file name without extension and size suffix (the file name is what a desktop and a mobile variant of a
// site share; the host and path usually differ). A lazy-loaded picture is not in `src` yet: its data attribute carries it.
const odxImageKey = (el) => {
  if (!el || el.nodeType !== 1) return null;
  let raw = null;
  if (el.tagName === 'IMG') raw = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.currentSrc || el.getAttribute('src');
  else {
    const m = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?([^"')]+)/);
    raw = m ? m[1] : null;
  }
  if (!raw || /^data:/.test(raw)) return null;
  try {
    const last = new URL(raw, location.href).pathname.split('/').pop().toLowerCase();
    return last.replace(/\.[a-z0-9]{2,5}$/, '').replace(/[-_]\d{2,4}x\d{2,4}$/, '').replace(/[-_]\d{2,4}w$/, '') || null;
  } catch (e) { return null; }
};
// The block a line of text belongs to (an inline run reflows with the width: its box is not a stable thing to measure into).
const odxBlockOf = (el) => {
  let b = el;
  while (b && b.parentElement && /^inline/.test(getComputedStyle(b).display)) b = b.parentElement;
  return b;
};
// The text node under a point (not the nearest one when the point is over a picture or empty space) and its first 64 characters.
const odxTextAt = (x, y) => {
  let node = null;
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); node = p && p.offsetNode; }
  else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); node = r && r.startContainer; }
  if (!node || node.nodeType !== 3) return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  if (![...range.getClientRects()].some((r) => y >= r.top - 4 && y <= r.bottom + 4)) return null;
  const t = odxNorm(node.data).slice(0, 64);
  return t.length >= 10 ? { node, t } : null;
};
// The picture that covers a point of the screen, by its box — not by a hit test: sites that do not want their pictures saved set
// `pointer-events: none` on them, and a hit test then names only the wrappers (measured: a 200 000 px div, never the picture).
// The smallest one wins (a picture inside another); icons and avatars are not pictures a reader reads.
const odxPictureAt = (x, y) => {
  let best = null, bestHeight = Infinity;
  for (const im of document.images) {
    const r = im.getBoundingClientRect();
    if (r.width < 120 || r.height < 60 || x < r.left || x > r.right || y < r.top || y > r.bottom || r.height >= bestHeight) continue;
    const cs = getComputedStyle(im);
    if (cs.position === 'fixed' || cs.position === 'sticky' || cs.visibility === 'hidden') continue;
    best = im;
    bestHeight = r.height;
  }
  return best;
};
const odxProbe = (yv) => {
  const x = Math.round(innerWidth / 2), py = Math.max(2, Math.round(innerHeight * yv));
  const picture = odxPictureAt(x, py);
  for (const el of (picture ? [picture] : document.elementsFromPoint(x, py))) {
    if (el === document.documentElement || el === document.body) continue;
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'sticky') continue;
    const image = odxImageKey(el);
    const text = image ? null : odxTextAt(x, py);
    const anchor = text && el.contains(text.node) ? odxBlockOf(text.node.parentElement) : el;
    const r = anchor.getBoundingClientRect();
    // A thin strip anchors nothing; neither does a TEXT wrapper of many screens (its fraction means little once the text reflows). A PICTURE
    // is anchored however tall it is: it scales uniformly, so how far into it the reader is — a fraction — is exact (a webtoon chapter is
    // one picture of 23 screens: refusing it left the whole page with no locator at all).
    if (r.height < 14 || (r.height > innerHeight * 6 && !(image || anchor.tagName === 'IMG'))) continue;
    const p = odxPath(anchor);                                            // null on a theme nested deeper than the path allows
    const text_ = text && el.contains(text.node) ? text.t : null;
    if (!p && !image && !text_) continue;                                  // nothing to find it by
    return { y: +yv.toFixed(3), f: +Math.max(0, Math.min(1, (py - r.top) / r.height)).toFixed(4), p, i: image, t: text_ };
  }
  return null;
};
const odxLocator = () => {
  try {
    const probes = [0, 1 / 3, 2 / 3].map(odxProbe).filter(Boolean);
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    return probes.length ? { v: 1, prog: +Math.min(1, scrollY / max).toFixed(4), probes } : null;
  } catch (e) { return null; }
};
// One probe → an element of the page as it is NOW, and how it was found.
const odxResolve = (pr, expectedTop) => {
  const nearest = (els) => {        // of several equal candidates: the one whose place in the document is closest to where the page was
    let best = null, bd = Infinity;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.height < 1) continue;
      const d = Math.abs(scrollY + r.top - expectedTop);
      if (d < bd) { bd = d; best = el; }
    }
    return best;
  };
  let el = null;
  try { el = pr.p ? document.querySelector(pr.p) : null; } catch (e) {}
  if (el && (pr.i ? odxImageKey(el) === pr.i : pr.t ? odxNorm(el.textContent).includes(pr.t.slice(0, 32)) : true)) return { el, how: 'path' };
  if (pr.i) {
    el = nearest([...document.images].filter((im) => odxImageKey(im) === pr.i));
    if (el) return { el, how: 'image' };
  }
  if (pr.t) {
    const needle = pr.t.slice(0, 32), found = new Set();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(), i = 0; n && i < 40000; n = walker.nextNode(), i++) {
      if (n.data.length >= 10 && odxNorm(n.data).includes(needle) && n.parentElement) found.add(odxBlockOf(n.parentElement));
    }
    el = nearest(found);
    if (el) return { el, how: 'text' };
  }
  return null;
};
// Scrolls the window so the page is where the locator says. Returns { how, votes, of } or null (nothing to go by: the caller falls back).
// The resolved probes must AGREE on the order of the page: probe k+1 lies below probe k, by about what it did on screen — content scales
// with the width (pictures) and reflows (text), so "about" is a factor of ten either way, but a probe that resolved to the other end of the
// document (a path that now shows other content, a text that appears twice) is far outside that and is left out. The largest agreeing set
// wins (the one that starts nearest the top of the screen on a tie) and the page is placed by its first probe.
const odxApplyLocator = (l) => {
  if (!l || l.v !== 1 || !Array.isArray(l.probes)) return null;
  const maxScroll = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  const expectedTop = (l.prog || 0) * maxScroll;
  const found = [];
  l.probes.forEach((pr) => {
    const hit = odxResolve(pr, expectedTop);
    if (!hit) return;
    const r = hit.el.getBoundingClientRect();
    if (r.height < 1) return;
    found.push({ pr, how: hit.how, docY: scrollY + r.top + pr.f * r.height });
  });
  const agree = (a, b) => {
    const gap = b.docY - a.docY, onScreen = (b.pr.y - a.pr.y) * innerHeight;
    return gap > 0 && gap >= onScreen * 0.1 && gap <= onScreen * 10 + 4;
  };
  let best = [];
  for (let mask = 1; mask < (1 << found.length); mask++) {
    const set = found.filter((_, k) => mask & (1 << k));
    if (set.length < best.length || !set.every((a, i) => set.slice(i + 1).every((b) => agree(a, b)))) continue;
    if (set.length > best.length || (set.length === best.length && found.indexOf(set[0]) < found.indexOf(best[0]))) best = set;
  }
  let to = null, how = 'ratio';
  if (best.length) {
    to = best[0].docY - best[0].pr.y * innerHeight;
    how = best[0].how;
  } else if (typeof l.prog === 'number') {
    to = expectedTop;
  }
  if (to === null) return null;
  to = Math.max(0, Math.min(maxScroll, to));
  if (Math.abs(scrollY - to) > 2) window.scrollTo({ left: scrollX, top: to, behavior: 'instant' });
  return { how, votes: best.length, of: l.probes.length };
};
"""


def clean_locator(value: Any) -> dict[str, Any] | None:
    """The locator as the page produced it, when it has the shape the page-side code expects — else None (a malformed or foreign value is
    never handed back to a page as if it were a position)."""
    if not isinstance(value, dict) or value.get("v") != 1 or not isinstance(value.get("probes"), list):
        return None
    probes: list[dict[str, Any]] = []
    for raw in value["probes"][:PROBE_COUNT_MAX]:
        if not isinstance(raw, dict):
            continue
        y, f = raw.get("y"), raw.get("f")
        if not all(isinstance(n, (int, float)) and not isinstance(n, bool) for n in (y, f)):
            continue
        probe: dict[str, Any] = {"y": float(y), "f": float(f)}
        for key, limit in (("p", 600), ("i", 96), ("t", 96)):             # the path, the picture, the words: at least one finds the place
            if isinstance(raw.get(key), str) and raw[key]:
                probe[key] = raw[key][:limit]
        if len(probe) > 2:
            probes.append(probe)
    if not probes:
        return None
    prog = value.get("prog")
    return {"v": 1, "prog": float(prog) if isinstance(prog, (int, float)) and not isinstance(prog, bool) else None, "probes": probes}
