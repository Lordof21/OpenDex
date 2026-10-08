// Hangi pencerenin sesi "odakta"? (diğer uygulamaların kısılması bunu izler — appAudioMixer.setFocused)
//   Workspace kapsayıcısı → odaktaki görevi · kırpma penceresi → kaynak görevi · Dosyalar → HİÇBİRİ (sesi yok: odak
//   alıp diğer uygulamaları kısmamalı) · diğerleri → kendisi.
import { isFilesWindow } from './filesWindow.js';

export function focusedAudioWindowId(windows) {
  const w = windows.find((x) => x.focused && !x.minimized);
  if (!w || isFilesWindow(w)) return null;
  return w.isEcoWorkspace ? w.focusedTaskId || null : w.sourceTaskId || w.id;
}
