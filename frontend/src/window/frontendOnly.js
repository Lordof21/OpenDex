// "Yalnızca ön yüz" pencereler: arka uçta oturumu, sanal ekranı ve akışı OLMAYAN pencereler (DeX-içi kırpma, Dosyalar).
// Kapat / küçült / geri yükle / odakla / kip değiştir gibi arka uca giden her çağrı bu pencerelerde atlanır — TEK karar noktası.
import { isCropWindow } from './cropWindow.js';
import { isFilesWindow } from './filesWindow.js';

export const isFrontendOnlyWindow = (win) => isCropWindow(win) || isFilesWindow(win);
