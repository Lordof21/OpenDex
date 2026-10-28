// Two small motion helpers for the Telefon Yükü panel, in the NotificationCard ExpandableText manner: sizes are written
// to the DOM directly (no React render per frame) and "reduce motion" makes them instant.

import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { useReducedMotion } from 'framer-motion';
import { cn } from '../lib/utils.js';

const EASE = 'cubic-bezier(0.3, 0, 0.15, 1)'; // notificationMotion EASE_SLIDE (a large area moving)

/**
 * The box follows its content's height, sliding instead of jumping, whenever `changeKey` changes (a list opened or
 * closed): it is locked at the old height, slides to the new one and is released to `auto`. Growth goes DOWNWARD —
 * the scroll container keeps its scrollTop, so what the user is looking at stays put and the scrollbar simply grows.
 * Live updates that do not change `changeKey` resize instantly (a ticking table must not wobble).
 */
export const SmoothHeight = forwardRef(function SmoothHeight({ changeKey, ms = 300, className, children }, ref) {
  const reduce = useReducedMotion();
  const outerRef = useRef(null);
  const lastHeight = useRef(null);
  const timer = useRef(null);
  const first = useRef(true);
  const heldAfterCollapse = useRef(false);

  useImperativeHandle(ref, () => ({
    /**
     * Closing a list: the box slides up to where its `count`-th `selector` item ends WHILE the extra rows are still
     * there (they slip out under the edge), and only then `done()` removes them — the box is already exactly that tall,
     * so nothing jumps. (Removing first and sliding the empty space looked instant.)
     */
    collapseTo(selector, count, done) {
      const el = outerRef.current;
      const items = el ? el.querySelectorAll(selector) : [];
      if (!el || reduce || items.length <= count) {
        done();
        return;
      }
      const top = el.getBoundingClientRect().top;
      const from = el.getBoundingClientRect().height;
      const to = Math.max(0, items[Math.max(0, count - 1)].getBoundingClientRect().bottom - top);
      clearTimeout(timer.current);
      Object.assign(el.style, { transition: 'none', overflow: 'hidden', height: `${from}px` });
      void el.offsetHeight;
      Object.assign(el.style, { transition: `height ${ms}ms ${EASE}`, height: `${to}px` });
      timer.current = setTimeout(() => {
        heldAfterCollapse.current = true; // keep the height locked until the shorter content has rendered
        lastHeight.current = to;
        done();
      }, ms);
    },
  }), [ms, reduce]);

  useLayoutEffect(() => {
    const el = outerRef.current;
    if (first.current) {
      first.current = false;
      return undefined;
    }
    if (el && heldAfterCollapse.current) {
      // The rows a collapse slid out are gone now and the content is exactly the locked height: let go of it.
      heldAfterCollapse.current = false;
      Object.assign(el.style, { height: '', transition: '', overflow: '' });
      return undefined;
    }
    if (!el || reduce || lastHeight.current == null) return undefined;
    const from = lastHeight.current;
    Object.assign(el.style, { transition: 'none', height: '' });
    const to = el.getBoundingClientRect().height;
    if (Math.abs(from - to) < 1) return undefined;
    clearTimeout(timer.current);
    Object.assign(el.style, { overflow: 'hidden', height: `${from}px` });
    void el.offsetHeight; // apply the start height, then start the slide
    Object.assign(el.style, { transition: `height ${ms}ms ${EASE}`, height: `${to}px` });
    timer.current = setTimeout(() => Object.assign(el.style, { height: '', transition: '', overflow: '' }), ms + 60);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeKey]);

  // The height before the next change (measured after every commit, mid-slide included: a reversal starts from there).
  useLayoutEffect(() => {
    if (outerRef.current) lastHeight.current = outerRef.current.getBoundingClientRect().height;
  });
  useLayoutEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div ref={outerRef} className={className}>
      {children}
    </div>
  );
});

/**
 * One line of text that never widens its container: cut with "…", and on hover it glides sideways to show the rest
 * (then glides back). Replaces a horizontal scrollbar in a table whose names can be long.
 */
export function MarqueeText({ text, className }) {
  const reduce = useReducedMotion();
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const timer = useRef(null);
  useLayoutEffect(() => () => clearTimeout(timer.current), []);
  const slide = (on) => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    clearTimeout(timer.current);
    const delta = inner.scrollWidth - outer.clientWidth; // the cut-off part (scrollWidth counts the overflow)
    if (on && delta > 1 && !reduce) {
      // Uncut, then glide left to the end; the speed is constant, so a long name takes longer, a short one is quick.
      Object.assign(inner.style, { overflow: 'visible', textOverflow: 'clip', width: 'max-content' });
      void inner.offsetWidth;
      const seconds = Math.max(0.6, delta / 45);
      Object.assign(inner.style, { transition: `transform ${seconds}s linear 0.25s`, transform: `translateX(${-delta}px)` });
    } else if (!on) {
      Object.assign(inner.style, { transition: 'transform 220ms ease-out', transform: '' });
      timer.current = setTimeout(() => Object.assign(inner.style, { overflow: '', textOverflow: '', width: '', transition: '' }), 240);
    }
  };
  return (
    <span
      ref={outerRef}
      className={cn('block min-w-0 overflow-hidden', className)}
      title={text}
      onPointerEnter={() => slide(true)}
      onPointerLeave={() => slide(false)}
    >
      <span ref={innerRef} className="block truncate will-change-transform">
        {text}
      </span>
    </span>
  );
}
