// Kenar çubuğu "yer"leri için ikon + ton (fileTypes'taki tonlarla aynı token'lar) ve kapasite çubuğu hesapları. SAF.
import {
  Camera, Download, FileText, FolderOpen, HardDrive, House, Image, Laptop, MemoryStick, Monitor, Music, Smartphone, Star, Trash2,
  Usb, Video, Folder, FolderCog,
} from 'lucide-react';

const PLACE = Object.freeze({
  // telefon
  internal: { icon: Smartphone, tone: 'folder' },
  sdcard: { icon: MemoryStick, tone: 'archive' },
  usb: { icon: Usb, tone: 'archive' },
  tmp: { icon: FolderCog, tone: 'generic' },
  // PC
  home: { icon: House, tone: 'folder' },
  desktop: { icon: Monitor, tone: 'folder' },
  documents: { icon: FileText, tone: 'doc' },
  downloads: { icon: Download, tone: 'folder' },
  pictures: { icon: Image, tone: 'image' },
  music: { icon: Music, tone: 'audio' },
  videos: { icon: Video, tone: 'video' },
  drive: { icon: HardDrive, tone: 'generic' },
  custom: { icon: FolderOpen, tone: 'folder' },
  // telefondaki bilinen klasörler (alt yer olarak)
  camera: { icon: Camera, tone: 'image' },
  favorite: { icon: Star, tone: 'folder' },
  trash: { icon: Trash2, tone: 'generic' },
  pc: { icon: Laptop, tone: 'generic' },
});

export const placeIcon = (place) => PLACE[place?.kind] || { icon: Folder, tone: 'folder' };
export const PLACE_KINDS = Object.freeze(Object.keys(PLACE));

/** Kapasite çubuğu: { used: 0..100, free, total } ya da null (bilgi yok). Sıfır/negatif toplam bilgi sayılmaz. */
export function capacityOf(place) {
  const { total, free } = place || {};
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0 || free < 0) return null;
  const used = Math.max(0, Math.min(100, Math.round(((total - Math.min(free, total)) / total) * 100)));
  return { used, free, total, low: free / total < 0.1 };
}

/** Konum hangi yerin içinde? (en uzun eşleşen kök) — kenar çubuğunda "şu an buradasınız" vurgusu için. */
export function activePlaceId(loc, places, isInside) {
  if (!loc) return null;
  let best = null;
  for (const p of places) {
    if (!isInside(loc, { provider: p.provider, path: p.path, device: p.device })) continue;
    if (!best || p.path.length > best.path.length) best = p;
  }
  return best?.id ?? null;
}
