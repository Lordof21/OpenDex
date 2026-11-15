// adb on this computer (backend: app/device/adb_setup.py, routes /api/adb*). The boot screen's calls — the app does not bundle adb.
import { api } from '../lib/api.js';

export const adbApi = {
  /** {state: checking|ok|missing, path, version, source, install: {phase, received, total, error, version}, can_install, install_dir, approx_mb, download_page} */
  get: () => api.get('/api/adb'),
  /** Looks again ("Tekrar ara"). */
  recheck: () => api.post('/api/adb/recheck'),
  /** Starts Google's platform-tools install; returns at once — poll `get()` for `install.phase`. */
  install: () => api.post('/api/adb/install'),
  cancelInstall: () => api.post('/api/adb/install/cancel'),
  /** Uses an adb the user picked. Rejects with `detail` = not_found | not_adb | broken (HTTP 422). */
  locate: (path) => api.post('/api/adb/locate', { path }),
};
