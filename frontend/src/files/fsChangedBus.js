// "Bir klasörün içeriği değişti" yayını için ince kuyruk. filesStore yüklenince kendini kaydeder; olay akışı (App) bu modülü
// içe aktarır — ağır dosya yöneticisi kodunu (ikonlar, bileşenler) açılışta YÜKLEMEDEN. Dosyalar hiç açılmadıysa
// kaydolan yoktur ve olay sessizce düşer (yenilenecek bölme de yoktur).
let handler = null;

export const setFsChangedHandler = (fn) => { handler = fn; };
export const emitFsChanged = (payload) => handler?.(payload);
