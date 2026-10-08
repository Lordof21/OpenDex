// "Pencereyi kapat" kullanıcı kararıdır ve arka uç meşgul / bağlantı bozukken de GEÇERLİ kalmalıdır.
//
// Eskiden: ✕ → pencere arayüzden hemen silinir, kapatma isteği bir kez gönderilir, hata YUTULURDU. İstek kilide takılıp
// düşerse arka uçtaki oturum yaşamaya devam eder, bir sonraki odak/yeniden bağlanma eşitlemesi (syncWindowsWithBackend) onu
// "arka uçta var, arayüzde yok" diye geri getirirdi: "çarpıya bastım, sayfayı yenileyince pencere orada".
//
// Şimdi her kapatma bir MEZAR TAŞI bırakır: kapatma onaylanana dek (ve arka ucun bir eşitleme turunda görünmez hale gelmesi
// için kısa bir süre sonrasına kadar) o kimlik eşitlemede geri getirilmez, istek artan beklemeyle YENİDEN denenir ve
// eşitleme hâlâ arka uçta gördüğü bir mezar taşını yeniden tetikler. Aynı kimlikle pencere yeniden AÇILIRSA (arka uç var olan
// oturumu geri verdi) mezar taşı kaldırılır — yeniden denemeler yeni pencereyi kapatmasın.

import { useSystemStore } from '../../state/systemStore.js';

export const CLOSE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
export const CLOSE_GRACE_MS = 60_000;

export function createCloseTracker({
  retryDelaysMs = CLOSE_RETRY_DELAYS_MS,
  graceMs = CLOSE_GRACE_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  onGiveUp = () => {},
} = {}) {
  /** id → { send, attempt, timer, running, closedAt } */
  const entries = new Map();

  function schedule(id, entry) {
    if (entry.attempt >= retryDelaysMs.length) {
      entry.timer = null; // vazgeçmedik: mezar taşı durur, eşitleme yeniden başlatır
      onGiveUp(id);
      return;
    }
    const delay = retryDelaysMs[entry.attempt];
    entry.attempt += 1;
    entry.timer = setTimer(() => {
      entry.timer = null;
      if (entries.get(id) === entry) drive(id);
    }, delay);
  }

  /** Bir deneme. true: arka uç pencerenin kapandığını (ya da zaten olmadığını) söyledi. */
  function drive(id) {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve(false);
    if (entry.running) return entry.running;
    entry.running = (async () => {
      try {
        await entry.send();
        entry.closedAt = now();
        return true;
      } catch (err) {
        if (err?.status === 404) { // arka uçta zaten yok
          entry.closedAt = now();
          return true;
        }
        if (entries.get(id) === entry) schedule(id, entry);
        return false;
      } finally {
        entry.running = null;
      }
    })();
    return entry.running;
  }

  return {
    /** Kapatmayı başlatır; ilk denemenin sonucunu döndürür (yeniden denemeler arka planda sürer). */
    begin(id, send) {
      const previous = entries.get(id);
      if (previous?.timer) clearTimer(previous.timer);
      entries.set(id, { send, attempt: 0, timer: null, running: null, closedAt: null });
      return drive(id);
    },

    /** Eşitlemede bu kimlik arka uçtan geri getirilmemeli mi? */
    isTombstoned(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      if (entry.closedAt !== null && now() - entry.closedAt >= graceMs) {
        entries.delete(id);
        return false;
      }
      return true;
    },

    /** Eşitleme arka uçta hâlâ gördüğü kapatılmış kimliği bildirir: onaylanmamışsa yeniden dene. */
    redrive(id) {
      const entry = entries.get(id);
      if (!entry || entry.closedAt !== null || entry.running || entry.timer) return;
      entry.attempt = 0;
      drive(id);
    },

    /** Aynı kimlikle pencere yeniden açıldı: bekleyen yeniden denemeler yeni pencereyi kapatmasın. */
    cancel(id) {
      const entry = entries.get(id);
      if (!entry) return;
      if (entry.timer) clearTimer(entry.timer);
      entries.delete(id);
    },

    /** Test / tanılama: onaylanmamış kapatmalar. */
    pending() {
      return [...entries].filter(([, e]) => e.closedAt === null).map(([id]) => id);
    },
  };
}

export const closeTracker = createCloseTracker({
  onGiveUp: () =>
    useSystemStore.getState().pushToast?.('Pencere kapatma isteği arka uca ulaşmadı — bağlantı gelince yeniden denenecek ⚠️'),
});
