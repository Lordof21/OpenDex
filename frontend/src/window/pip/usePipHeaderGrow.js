// A PiP's header going from hover (over the picture) to pinned (a row of its own) or back must not squeeze or stretch the PICTURE: the OS
// window grows upward by the header's height (pushed down instead when it is against the top of the screen) and shrinks back, smoothly
// (usePipOsWindow.growForHeader). Without it the pinned header took 32 px out of the picture and the stream was asked again for a
// smaller size.

import { useEffect, useRef } from 'react';
import { PIP_HEADER_H_PX } from '../windowMath.js';

/**
 * @param os      usePipOsWindow()
 * @param hidden  the header's state by its MODE (not by full screen): true = over the picture, false = a row of its own; null while the
 *                settings it depends on are not known yet (the first known value is the baseline, never a change)
 */
export function usePipHeaderGrow(os, hidden) {
  const before = useRef(null);
  const osRef = useRef(os);
  osRef.current = os;
  useEffect(() => {
    if (hidden === null || hidden === undefined) return;
    const was = before.current;
    before.current = hidden;
    if (was === null || was === hidden) return;
    osRef.current.growForHeader(hidden ? -PIP_HEADER_H_PX : PIP_HEADER_H_PX);
  }, [hidden]);
}
