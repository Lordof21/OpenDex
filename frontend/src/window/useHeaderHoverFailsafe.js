// A header that slid down on hover (or on a fast edge hit) closes when the cursor leaves it — normally by `mouseleave`. But when the WINDOW moves
// under a still cursor (a layout picked from the maximize menu, a window handed back from the phone, a resize), the browser sends no
// `mouseleave`, and the header stayed open for good. This checks, a few times a second, whether the cursor really is over the header
// (`:hover`, which counts its descendants — the layout menu hangs below it) and closes it when it is not, after a short while.
//
// It never cuts short the minimum time a header stays open after a fast edge hit (REVEAL_HOLD_MS: the cursor is still on its way down).

import { useEffect, useRef } from 'react';
import { REVEAL_HOLD_MS } from './pip/useFastEdgeReveal.js';

export const FAILSAFE_TICK_MS = 250;
export const FAILSAFE_MIN_OPEN_MS = REVEAL_HOLD_MS + 300;
export const FAILSAFE_MISSES = 2;          // consecutive checks without the cursor on the header before it closes (~0,5 s)

/**
 * @param active      the header is open by hover
 * @param elementRef  the header's container
 * @param onClose     close it (the same state change `mouseleave` makes)
 */
export function useHeaderHoverFailsafe({ active, elementRef, onClose }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return undefined;
    const openedAt = performance.now();
    let misses = 0;
    const timer = setInterval(() => {
      if (performance.now() - openedAt < FAILSAFE_MIN_OPEN_MS) return;
      const element = elementRef.current;
      misses = element && element.matches(':hover') ? 0 : misses + 1;
      if (misses >= FAILSAFE_MISSES) closeRef.current();
    }, FAILSAFE_TICK_MS);
    return () => clearInterval(timer);
  }, [active, elementRef]);
}
