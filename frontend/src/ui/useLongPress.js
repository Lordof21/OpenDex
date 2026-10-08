// "Basılı tut" (and right-click / the keyboard's menu key) for a button that also has a plain click.
//
//   const press = useLongPress({ onLongPress: (el) => openMenu(el), onClick: toggle });
//   <button {...press} />
//
// A press held for `delayMs` calls `onLongPress(button)` once — and the click that follows the release is swallowed, so
// holding never also triggers the click action. Moving the pointer away (or scrolling a touch) cancels it. `contextmenu`
// (right-click, long-press on touch, the menu key) is the same gesture: it calls `onLongPress` at once.

import { useCallback, useEffect, useRef } from 'react';

export const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 8;

export function useLongPress({ onLongPress, onClick, delayMs = LONG_PRESS_MS, disabled = false }) {
  const timer = useRef(null);
  const origin = useRef(null);
  const fired = useRef(false);
  const latest = useRef({ onLongPress, onClick });
  latest.current = { onLongPress, onClick };

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback((event) => {
    if (disabled || (event.button !== undefined && event.button !== 0)) return;
    fired.current = false;
    const element = event.currentTarget;
    origin.current = { x: event.clientX, y: event.clientY };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      fired.current = true;
      latest.current.onLongPress?.(element);
    }, delayMs);
  }, [delayMs, disabled]);

  const onPointerMove = useCallback((event) => {
    const start = origin.current;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel();
  }, [cancel]);

  const onClickCapture = useCallback((event) => {
    if (!fired.current) return;
    fired.current = false;
    event.preventDefault();
    event.stopPropagation();                      // the release of a long press is not a click
  }, []);

  const onClickHandler = useCallback((event) => {
    if (!disabled) latest.current.onClick?.(event);
  }, [disabled]);

  const onContextMenu = useCallback((event) => {
    if (disabled) return;
    event.preventDefault();
    cancel();
    fired.current = false;
    latest.current.onLongPress?.(event.currentTarget);
  }, [cancel, disabled]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onClickCapture,
    onClick: onClickHandler,
    onContextMenu,
  };
}

export default useLongPress;
