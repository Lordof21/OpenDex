// The Settings page's view of the graphics-card choice (lib/gpuPreference.js ⟷ src-tauri/src/gpu.rs): what is saved, what this run
// uses, which card the engine really renders with, and whether saving failed. The choice applies at the next start, so `saved` and
// `active` differ right after a change and the page shows "restart to apply".

import { useCallback, useEffect, useState } from 'react';
import { activeRenderer, readGpuPreference, restartApp, saveGpuPreference } from '../lib/gpuPreference.js';

// `restartFailed`: false | 'failed' | 'dev_session' (a `tauri dev` build never relaunches itself: its dev server would die with it).
const INITIAL = { ready: false, supported: false, saved: 'auto', active: 'auto', renderer: '', failed: false, restarting: false, restartFailed: false };

export function useGpuPreference() {
  const [state, setState] = useState(INITIAL);

  const load = useCallback(async () => {
    const pref = await readGpuPreference();
    setState((now) => ({
      ...now,
      ready: true,
      supported: Boolean(pref?.supported),
      saved: pref?.saved ?? 'auto',
      active: pref?.active ?? 'auto',
      renderer: pref?.supported ? activeRenderer() : '',
    }));
  }, []);

  useEffect(() => {
    let alive = true;
    load().catch(() => alive && setState((now) => ({ ...now, ready: true })));
    return () => {
      alive = false;
    };
  }, [load]);

  const choose = useCallback(async (mode) => {
    setState((now) => ({ ...now, saved: mode, failed: false }));     // the card flips at once; the file follows
    try {
      await saveGpuPreference(mode);
    } catch {
      setState((now) => ({ ...now, failed: true }));
      await load();                                                  // show what is really saved
    }
  }, [load]);

  const restart = useCallback(async () => {
    setState((now) => ({ ...now, restarting: true, restartFailed: false }));
    try {
      await restartApp();                                            // when it works the window is gone before this returns
    } catch (err) {
      const dev = String(err?.message ?? err).includes('dev_session');
      setState((now) => ({ ...now, restarting: false, restartFailed: dev ? 'dev_session' : 'failed' }));
    }
  }, []);

  return { ...state, choose, restart };
}
