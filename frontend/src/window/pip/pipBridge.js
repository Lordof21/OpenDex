// Tauri'de PiP = AYRI bir WebviewWindow = ayrı bir JS dünyası (kendi store'u, kendi olay akışı). Masaüstündeki (ana) pencere ile PiP
// birbirinin store'unu göremez; ikisi arasındaki tek köprü Tauri olaylarıdır.
//
// Neden köprü: PiP'te "Telefona aktar" / "Workspace'e gönder" / "Kapat" eskiden PiP'in KENDİ store'unda çalışıyor, ardından PiP
// penceresi kapanıyordu — ana pencere haberdar olmuyor (aktarım ekranı, iyimser durum, kapanış hiç görünmüyor), DeX'tekinden farklı
// davranıyordu. Şimdi PiP bu eylemleri ana pencereye komut olarak yollar; ana pencere AYNI kodu DeX'teki tıklamayla aynı store'da çalıştırır.

import { logger } from '../../lib/logger.js';

export const PIP_COMMAND_EVENT = 'opendex:pip-command';

export const isTauriHost = () =>
  typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__);

/**
 * Birincil fare düğmesi şu an basılı mı? İşletim sistemi çerçevesiz pencereyi boyutlandırırken (`startResizeDragging`) kendi döngüsünü
 * çalıştırır: sayfa resize olayı alır ama İMLEÇ olayı almaz, yani düğmenin bırakıldığını kendisi göremez — kabuktan (src-tauri/src/pointer.rs)
 * sorar. Tauri dışında, komutu olmayan eski bir kabukta ya da hata olursa `false` (eski davranış: sakin kalınca hemen uygula).
 */
export async function isPrimaryButtonDown() {
  if (!isTauriHost()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return Boolean(await invoke('primary_button_down'));
  } catch {
    return false;
  }
}

/** Bu sayfa Tauri'nin açtığı PiP penceresi mi (`/?pip=<id>`)? */
export const isPipWebview = () =>
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('pip');

/**
 * PiP'te Hub'dan yapılan değişikliklerden ana pencerenin de bilmesi gerekenler: PiP kapanıp pencere masaüstüne dönünce eski
 * değerlerle çizilmesin (görüntü ölçeği, DP kipi, ekran kilidi, başlık kipi, hep üstte).
 */
export const PIP_SYNC_FIELDS = Object.freeze([
  'pinned',
  'videoFitMode',
  'dpiPolicy',
  'overrides',
  'headerMode',
  'resolutionLocked',
]);

export function pickPipState(win) {
  const state = {};
  if (win) for (const key of PIP_SYNC_FIELDS) if (key in win) state[key] = win[key];
  return state;
}

/** PiP → ana pencere. Gönderilemezse false (Tauri yok / olay yolu kapalı): çağıran yerel yola düşer. */
export async function sendPipCommand(command) {
  if (!isTauriHost()) return false;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(PIP_COMMAND_EVENT, command);
    return true;
  } catch (err) {
    logger.warn('oswindow', 'PiP komutu gönderilemedi', err);
    return false;
  }
}

/** Ana pencere: PiP'ten gelen komutları dinler. Dönen işlev dinlemeyi bırakır (kurulum bitmeden bırakılsa da güvenli). */
export function listenPipCommands(handler) {
  let off = null;
  let stopped = false;
  import('@tauri-apps/api/event')
    .then(({ listen }) => listen(PIP_COMMAND_EVENT, (event) => handler(event.payload)))
    .then((unlisten) => {
      if (stopped) unlisten();
      else off = unlisten;
    })
    .catch((err) => logger.warn('oswindow', 'PiP komutları dinlenemedi', err));
  return () => {
    stopped = true;
    if (off) off();
    off = null;
  };
}
