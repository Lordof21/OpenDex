// Tek canlı ayar kaynağı. Eskiden her bileşen kendi `getSettings().then(set) + subscribeSettings(set)` ikilisini
// ve alan başına useState kopyasını tutuyordu (App ×2, WindowFrame, VideoCanvas, SettingsPanel, DexSettings,
// QuickSettings). Şimdi hepsi aynı anlık görüntüyü okur:
//   görüntü = son bilinen sunucu ayarı + henüz kaydedilmemiş (sıradaki) iyimser yamalar
// - updateSettings(patch): değişiklik ANINDA görünür (tıklama gecikmesiz), kayıt settingsApi sırasına girer.
// - Kayıt başarısızsa yama geri alınır ve sunucudan taze durum okunur (UI asla kaydedilmemiş değeri göstermez).
// - Aynı anda açık panellerin hepsi aynı değeri gösterir (DeX paneli ⟷ Ayarlar penceresi).
import { useEffect, useSyncExternalStore } from 'react';
import { getSettings, saveSettings, subscribeSettings } from './settingsApi.js';

let server = null; // son bilinen sunucu ayarı
let pending = []; // [{ patch }] kayıt sırasındaki iyimser yamalar (sıralı)
let snapshot = null;
let inflight = null;
let bridged = false;
const subscribers = new Set();

const isSettingsObject = (s) => Boolean(s) && typeof s === 'object' && Object.keys(s).length > 0;

function publish() {
  snapshot = server || pending.length ? Object.assign({}, server, ...pending.map((p) => p.patch)) : null;
  subscribers.forEach((fn) => fn());
}

// settingsApi.saveSettings başka yerden (ör. store) çağrılsa da kaydedilen sonuç buraya yansır.
function bridge() {
  if (bridged) return;
  bridged = true;
  subscribeSettings((saved) => {
    if (!isSettingsObject(saved)) return;
    server = saved;
    publish();
  });
}

export function refreshSettings() {
  bridge();
  if (!inflight) {
    inflight = getSettings()
      .then((s) => {
        if (isSettingsObject(s)) {
          server = s;
          publish();
        }
        return snapshot;
      })
      .catch(() => snapshot)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function updateSettings(patch) {
  bridge();
  const entry = { patch };
  pending.push(entry);
  publish();
  return saveSettings(patch).then(
    (saved) => {
      pending = pending.filter((p) => p !== entry);
      server = isSettingsObject(saved) ? saved : { ...server, ...patch };
      publish();
      return saved;
    },
    (err) => {
      pending = pending.filter((p) => p !== entry);
      publish();
      refreshSettings();
      throw err;
    },
  );
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Son bilinen canlı ayar (eşzamanlı okuma; henüz yüklenmediyse null) — bir `await` istemeyen karar yolları için. */
export function getLiveSettings() {
  return snapshot;
}

/**
 * Canlı ayar nesnesi (ilk yükleme bitene kadar null). Her bağlanışta — ve `refetchKey` değişince — sunucudan
 * tazelenir (eşzamanlı istekler tek GET'e iner); o sırada son bilinen değer gösterilmeye devam eder.
 */
export function useLiveSettings(refetchKey) {
  const settings = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  useEffect(() => {
    refreshSettings();
  }, [refetchKey]);
  return settings;
}

/** Yalnız testler: modül durumunu sıfırlar. */
export function resetLiveSettingsForTests() {
  server = null;
  pending = [];
  snapshot = null;
  inflight = null;
  subscribers.forEach((fn) => fn());
}
