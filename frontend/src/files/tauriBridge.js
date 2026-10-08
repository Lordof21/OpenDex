// Yerel kabuk (Tauri) köprüsü — dosya yöneticisinin "yalnız yerel UI'nın verebileceği" yetkileri:
//   * yerel klasör/dosya seçici (Rust: fs_pick_folder / fs_pick_files)
//   * Gezgin'den sürükle-bırak yolları (WebView'in onDragDropEvent'i)
//   * backend'e "kullanıcı bunu seçti/bıraktı" kanıtı olan KABUK JETONU (Rust: fs_shell_token → ~/.opendex/shell-token)
// Sayfa içindeki bir betik bu jetonu okuyamaz; backend /api/fs/grants ve /api/fs/folders onsuz 403 verir. Tarayıcıda
// (npm run dev) Tauri yoktur: işlevler `null`/boş döner ve arayüz "yalnız masaüstü uygulamasında" der.
import { fsApi } from './fsApi.js';

export const inTauri = () =>
  typeof window !== 'undefined' && Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__);

async function invoke(command, args) {
  const { invoke: call } = await import('@tauri-apps/api/core');
  return call(command, args);
}

let cachedToken = null;
export async function shellToken({ force = false } = {}) {
  if (!inTauri()) return null;
  if (!cachedToken || force) cachedToken = await invoke('fs_shell_token');
  return cachedToken;
}

/** Yerel klasör seçici. İptal → null. */
export async function pickFolder() {
  if (!inTauri()) return null;
  const path = await invoke('fs_pick_folder');
  return typeof path === 'string' && path ? path : null;
}

/** Yerel dosya seçici (çoklu). İptal → []. */
export async function pickFiles() {
  if (!inTauri()) return [];
  const paths = await invoke('fs_pick_files');
  return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
}

/** Kullanıcının bıraktığı/seçtiği yollar için izin ister; backend yalnız bu yolları açar (süreli, kök genişlemez). */
export async function grantPaths(paths) {
  const token = await shellToken();
  if (!token) throw Object.assign(new Error('Bu işlem yalnız masaüstü uygulamasında yapılabilir.'), { code: 'permission' });
  const { items } = await fsApi.grant(paths, token);
  return items;
}

/** Seçilen klasörü KALICI olarak yerler listesine ekler (kabuk jetonu gerekir). */
export async function addFolderViaShell(path) {
  const token = await shellToken();
  if (!token) throw Object.assign(new Error('Klasör eklemek yalnız masaüstü uygulamasında yapılabilir.'), { code: 'permission' });
  return fsApi.addFolder(path, token);
}

/**
 * WebView'e bırakılan dış dosyaları dinler. `handler({ type: 'over' | 'drop' | 'leave', x, y, paths })`; x/y CSS pikseli
 * (Tauri fiziksel piksel verir → devicePixelRatio'ya bölünür). Döner: dinlemeyi bırakan işlev.
 */
export async function listenExternalDrops(handler) {
  if (!inTauri()) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  const ratio = () => window.devicePixelRatio || 1;
  const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    const type = p.type === 'enter' ? 'over' : p.type;                // enter/over aynı işlenir
    handler({ type, x: (p.position?.x ?? 0) / ratio(), y: (p.position?.y ?? 0) / ratio(), paths: p.paths ?? [] });
  });
  return unlisten;
}
