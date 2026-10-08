// Sürükle-bırak kuralı (SAF): hangi kaynaklar hangi klasöre bırakılabilir. Satırlar, bölme zemini, adres dilimleri ve kenar
// çubuğu yerleri aynı kuralı paylaşır.
import { isInside, parentOf, sameLoc } from './paths.js';

/** Kendi üstüne, kendi altına ve zaten içinde olduğu klasöre (Ctrl'suz — Ctrl kopya demektir) bırakılamaz. */
export function acceptsDrop(sources, mods, dest) {
  if (!dest || !sources?.length) return false;
  if (sources.some((s) => sameLoc(s, dest) || isInside(dest, s))) return false;
  if (!mods.ctrl && sources.every((s) => sameLoc(parentOf(s), dest))) return false;
  return true;
}
