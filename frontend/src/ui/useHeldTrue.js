import { useEffect, useState } from 'react';

/**
 * `value`, but a `true` that turns `false` is held for `holdMs` first (turning `true` is immediate). A flag that blinks off
 * for a moment — e.g. the connection state while a failing bind attempt flips "disconnected" → "connected" → "disconnected"
 * within milliseconds — must not unmount what it guards (the QR pairing panel restarts its network listener on mount).
 */
export function useHeldTrue(value, holdMs) {
  const [held, setHeld] = useState(Boolean(value));
  useEffect(() => {
    if (value) {
      setHeld(true);
      return undefined;
    }
    const timer = setTimeout(() => setHeld(false), holdMs);
    return () => clearTimeout(timer);
  }, [value, holdMs]);
  return Boolean(value) || held;
}
