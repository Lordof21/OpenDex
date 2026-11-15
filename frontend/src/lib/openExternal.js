// Opens an https link in the user's own browser. In the desktop app that is Tauri's shell plugin (the `shell:default` permission
// allows http(s) links only); in a plain browser (npm run dev) it is a new tab. Anything but https is refused.
const inTauri = () =>
  typeof window !== 'undefined' && Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__);

/** @returns {Promise<boolean>} whether a browser was asked to open it */
export async function openExternal(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
  if (inTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('plugin:shell|open', { path: url });
      return true;
    } catch { /* fall through to the browser way */ }
  }
  try {
    return Boolean(window.open(url, '_blank', 'noopener,noreferrer'));
  } catch {
    return false;
  }
}
