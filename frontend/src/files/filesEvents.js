// Backend olay akışı → dosya yöneticisi. `eventStream.js`'e DOKUNMAZ: onun dinleyici API'sine (subscribeToBackendEvents) bağlanır.
//   fs_transfer   → aktarım işi anlık görüntüsü (ilerleme, çakışma, bitiş)
//   fs_changed    → bir klasörün içeriği değişti: açık bölmeler kısa gecikmeyle yenilenir
//   __stream_open → (yeniden) bağlandı: kaçan olaylar için iş listesi baştan okunur
import { subscribeToBackendEvents } from '../events/eventStream.js';
import { emitFsChanged } from './fsChangedBus.js';
import { useTransferStore } from './transferStore.js';

let off = null;

export function handleFilesEvent(event) {
  switch (event?.type) {
    case 'fs_transfer':
      if (event.payload?.id) useTransferStore.getState().applyJob(event.payload);
      break;
    case 'fs_changed':
      if (event.payload?.provider) emitFsChanged(event.payload);
      break;
    case '__stream_open':
      useTransferStore.getState().load().catch(() => {});         // dosya yöneticisi kapalıysa (404) sessiz
      break;
    default:
  }
}

/** Uygulama açılışında BİR kez. Tekrar çağrı aynı aboneliği korur (test/HMR güvenli). */
export function installFilesEvents() {
  if (!off) off = subscribeToBackendEvents(handleFilesEvent);
  return off;
}

export function uninstallFilesEvents() {
  off?.();
  off = null;
}
