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

A probe that resolves into content the page keeps folded away (`hidden="until-found"` — mobile Wikipedia folds every section of an article —
or a closed <details>) has no place on screen: that section is opened the way the browser's find-in-page opens it (`beforematch`, then the
attribute removed) and then measured. Measured on the phone (2026-11-04): a desktop article read in DeX came back on the phone in the right
section only once its folded section was opened; before that the page fell back to the document fraction and showed another section.

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
// Pinned to the screen: the element, or a container it is in, is `fixed` / `sticky` — it does not move with the page, so it says nothing
// about where the reader is. A full-screen layer over a reader (measured 2026-11-04: an ad container, `position: fixed`, z-index 2147483647,
// with a `relative` child covering the screen) took all three probes, and the page fell back to the document fraction — 12 pages off.
// A fixed container that scrolls its OWN content (an app that scrolls in a full-screen box) is not pinned: what is in it moves with it.
const odxPinned = (el) => {
  for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    // a box that scrolls what is in it carries it along, even when the box itself is fixed (asked first: the app's box is both)
    if (n !== el && /(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 40) return false;
    if (cs.position === 'fixed' || cs.position === 'sticky') return true;
  }
  return false;
};
const odxPictureAt = (x, y) => {
  let best = null, bestHeight = Infinity;
  for (const im of document.images) {
    const r = im.getBoundingClientRect();
    if (r.width < 120 || r.height < 60 || x < r.left || x > r.right || y < r.top || y > r.bottom || r.height >= bestHeight) continue;
    if (getComputedStyle(im).visibility === 'hidden' || odxPinned(im)) continue;
    best = im;
    bestHeight = r.height;
  }
  return best;
};
// The first item of the row an element sits in, when it is one of several items laid side by side (a grid of covers, a flex row of cards);
// null when it is not in such a row. A grid keeps its reading order across widths, not its rows: the 4th of 6 covers in a DeX row is the
// 2nd of a 2-cover phone row one row further down — anchoring the cover in the middle of the screen skipped the start of the reader's row.
// The FIRST item of the row is where the reader's row begins on any width.
const odxRowStart = (el) => {
  for (let a = el, depth = 0; a && a.parentElement && a !== document.body && depth < 6; a = a.parentElement, depth++) {
    const r = a.getBoundingClientRect();
    if (r.width >= innerWidth * 0.8 || r.height < 1) continue;            // a full-width block is not an item of a row
    // Items of one row are alike — the same kind of element, about the same width (a grid's cells). A side menu next to the article is
    // side by side too, but it is not an item of the article's row: it is never taken for the start of the row.
    const alike = (b, br) => b.tagName === a.tagName && Math.abs(br.width - r.width) <= r.width * 0.25;
    let first = null, prev = a.previousElementSibling;
    for (let n = 0; prev && n < 60; prev = prev.previousElementSibling, n++) {
      const pr = prev.getBoundingClientRect();
      if (pr.height < 1) continue;
      if (Math.abs(pr.top - r.top) <= 4 && pr.right <= r.left + 2 && alike(prev, pr)) first = prev;
      else if (pr.bottom <= r.top + 2) break;                              // the row above: the row starts after it
      else if (!first) break;                                              // something else beside it: not a row of items
    }
    if (first) return first;
    const next = a.nextElementSibling, nr = next && next.getBoundingClientRect();
    if (nr && nr.height >= 1 && Math.abs(nr.top - r.top) <= 4 && nr.left >= r.right - 2 && alike(next, nr)) return null;   // already the first of its row
  }
  return null;
};
// A stable name the element carries and no other element on the page has: its id, or an attribute a site puts on the items of a list
// (`data-page`, `aria-label="Sayfa 50"`, …). It survives what a path does not: another variant of the page with one more wrapper or one ad
// box more before it shifts every `nth-of-type`. Measured 2026-11-04: a manga reader whose pictures sit in CLOSED shadow roots (no picture,
// no words to find a page by) came back 50 pages off by its path after the reload on the phone; its pages carry `aria-label="Sayfa N"`.
const ODX_KEY_ATTRS = ['data-page', 'data-index', 'data-id', 'data-key', 'aria-label', 'name'];
const odxKey = (el) => {
  if (!el || el.nodeType !== 1) return null;
  const tag = el.tagName.toLowerCase(), tries = [];
  if (el.id && !/\d{4,}/.test(el.id)) tries.push('#' + CSS.escape(el.id));
  for (const a of ODX_KEY_ATTRS) {
    const v = el.getAttribute(a);
    if (v && v.length <= 60) tries.push(tag + '[' + a + '="' + v.replace(/["\\]/g, '\\$&') + '"]');
  }
  for (const sel of tries) { try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {} }
  return null;
};
// A probe that describes an item by what the next page can find it by: its first picture, else its first words.
const odxDescribe = (item, py, yv) => {
  const pictures = item.tagName === 'IMG' ? [item] : [...item.querySelectorAll('img')];
  for (const im of pictures) {
    const key = odxImageKey(im), r = im.getBoundingClientRect();
    if (key && r.height >= 14) return { y: +yv.toFixed(3), f: +Math.max(0, Math.min(1, (py - r.top) / r.height)).toFixed(4), p: odxPath(im), i: key, t: null, k: odxKey(im) };
  }
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = odxNorm(n.data).slice(0, 64);
    if (t.length < 10 || !n.parentElement) continue;
    const block = odxBlockOf(n.parentElement), r = block.getBoundingClientRect();
    if (r.height < 14) continue;
    return { y: +yv.toFixed(3), f: +Math.max(0, Math.min(1, (py - r.top) / r.height)).toFixed(4), p: odxPath(block), i: null, t, k: odxKey(block) };
  }
  const p = odxPath(item), r = item.getBoundingClientRect();
  const k = odxKey(item);
  return (p || k) ? { y: +yv.toFixed(3), f: +Math.max(0, Math.min(1, (py - r.top) / r.height)).toFixed(4), p, i: null, t: null, k } : null;
};
// Where a probe looks across the line: the middle first (the article column), then outwards. The middle of a grid can be the GAP between two
// columns on every row (a 6-column DeX grid at 1336 css px: x = 668 falls between the 3rd and the 4th cover) — the line then had no probe at
// all and the page fell back to the document fraction (measured on the phone, 2026-11-04).
const ODX_ACROSS = [0.5, 0.42, 0.58, 0.32, 0.68, 0.2, 0.8];
const odxProbe = (yv) => {
  const py = Math.max(2, Math.round(innerHeight * yv));
  for (const fx of ODX_ACROSS) {
    const found = odxProbeAt(yv, Math.round(innerWidth * fx), py);
    if (found) return odxFromItem(found, yv);
  }
  // Nothing anywhere on the line: it runs between two rows (a grid's gap, the margin between paragraphs). What the reader sees there is the
  // item that starts just below it, in the container the line crosses.
  for (const el of document.elementsFromPoint(Math.round(innerWidth / 2), py)) {
    if (el === document.documentElement || el === document.body || el.childElementCount < 2 || odxPinned(el)) continue;
    const next = [...el.children].find((c) => { const cr = c.getBoundingClientRect(); return cr.height >= 1 && cr.bottom > py; });
    const described = next && odxDescribe(odxRowStart(next) || next, py, yv);
    if (described) return described;
  }
  return null;
};
// A probe that hit an item: moved to the first item of its row when the item is one of a row (see odxRowStart).
const odxFromItem = (found, yv) => {
  const start = odxRowStart(found.el);
  const moved = start && odxDescribe(start, found.py, yv);
  return moved || found.probe;
};
const odxProbeAt = (yv, x, py) => {
  const picture = odxPictureAt(x, py);
  for (const el of (picture ? [picture] : document.elementsFromPoint(x, py))) {
    if (el === document.documentElement || el === document.body || odxPinned(el)) continue;
    const image = odxImageKey(el);
    const text = image ? null : odxTextAt(x, py);
    const anchor = text && el.contains(text.node) ? odxBlockOf(text.node.parentElement) : el;
    const r = anchor.getBoundingClientRect();
    // A thin strip anchors nothing; neither does a TEXT wrapper of many screens (its fraction means little once the text reflows). A PICTURE
    // is anchored however tall it is: it scales uniformly, so how far into it the reader is — a fraction — is exact (a webtoon chapter is
    // one picture of 23 screens: refusing it left the whole page with no locator at all).
    if (r.height < 14 || (r.height > innerHeight * 6 && !(image || anchor.tagName === 'IMG'))) continue;
    // A container hit between its items (the point is in no child of it) is not what the reader sees: the line is tried elsewhere
    if (!image && !text && anchor.childElementCount >= 2) continue;
    const p = odxPath(anchor);                                            // null on a theme nested deeper than the path allows
    const text_ = text && el.contains(text.node) ? text.t : null;
    const k = odxKey(anchor);
    if (!p && !image && !text_ && !k) continue;                            // nothing to find it by
    return { el: anchor, py, probe: { y: +yv.toFixed(3), f: +Math.max(0, Math.min(1, (py - r.top) / r.height)).toFixed(4), p, i: image, t: text_, k } };
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
// Content the page keeps folded away: a section with `hidden="until-found"` (mobile Wikipedia folds every section of an article this way)
// or a closed <details> (outside its <summary>). It has no place on screen until it is opened, so a probe resolved into it cannot be measured.
const odxConcealer = (el) => {
  for (let e = el; e && e.nodeType === 1 && e !== document.body; e = e.parentElement) {
    if (e.getAttribute('hidden') === 'until-found') return e;
    if (e.tagName === 'DETAILS' && !e.open) {
      const summary = e.querySelector(':scope > summary');
      if (!(summary && summary.contains(el))) return e;
    }
  }
  return null;
};
// Opens what hides an element the way the browser's own find-in-page does (HTML: `beforematch` first, so the site updates its own toggle,
// then the attribute goes): the reader was in that section on the other variant of the page, so it is where they are taken back to.
const odxReveal = (el) => {
  let opened = 0;
  for (let c = odxConcealer(el); c && opened < 8; c = odxConcealer(el)) {
    if (c.tagName === 'DETAILS') c.open = true;
    else {
      try { c.dispatchEvent(new Event('beforematch', { bubbles: true })); } catch (e) {}
      c.removeAttribute('hidden');
    }
    opened++;
  }
  return opened;
};
// One probe → an element of the page as it is NOW, and how it was found.
const odxResolve = (pr, expectedTop) => {
  const nearest = (els) => {        // of several equal candidates: the one whose place in the document is closest to where the page was
    let best = null, bd = Infinity, folded = null;
    for (const el of els) {
      if (odxConcealer(el)) { folded = folded || el; continue; }      // no real place yet: only when nothing visible matches
      const r = el.getBoundingClientRect();
      if (r.height < 1) continue;
      const d = Math.abs(scrollY + r.top - expectedTop);
      if (d < bd) { bd = d; best = el; }
    }
    return best || folded;
  };
  let el = null;
  if (pr.k) {                                                             // its own name first: the most stable thing a page offers
    try {
      const named = document.querySelectorAll(pr.k);
      el = named.length === 1 ? named[0] : null;
    } catch (e) { el = null; }
    if (el && (pr.i ? odxImageKey(el) === pr.i : pr.t ? odxNorm(el.textContent).includes(pr.t.slice(0, 32)) : true)) return { el, how: 'key' };
    el = null;
  }
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
    odxReveal(hit.el);                                                   // a folded section is opened before it is measured
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
  // the page may have grown meanwhile (a folded section was opened above): clamp to the document as it is now
  to = Math.max(0, Math.min(Math.max(1, document.documentElement.scrollHeight - innerHeight), to));
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
        for key, limit in (("p", 600), ("i", 96), ("t", 96), ("k", 200)):  # the path, the picture, the words, the name: one finds the place
            if isinstance(raw.get(key), str) and raw[key]:
                probe[key] = raw[key][:limit]
        if len(probe) > 2:
            probes.append(probe)
    if not probes:
        return None
    prog = value.get("prog")
    return {"v": 1, "prog": float(prog) if isinstance(prog, (int, float)) and not isinstance(prog, bool) else None, "probes": probes}
