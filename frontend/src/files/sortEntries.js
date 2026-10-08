// Sıralama ve süzme. 50 000 girdilik bir klasörde bile ana iş parçacığını uzun süre bloklamaz:
//   * doğal sıralama anahtarı (sayı dizileri sıfırla doldurulur) girdi gelirken BİR kez hesaplanır (`prepare`),
//   * karşılaştırma tek bir tr Collator'dır (büyük/küçük harf duyarsız, aksan duyarlı: ç ≠ c, ı ≠ i),
//   * akıştan gelen sayfalar sıralanıp mevcut sıralı diziyle BİRLEŞTİRİLİR (`mergeSorted`, O(n)) — her sayfada tüm liste
//     yeniden sıralanmaz.
import { typeSortKey } from './fileTypes.js';

export const SORT_KEYS = Object.freeze(['name', 'modified', 'size', 'type']);
export const SORT_LABELS = Object.freeze({ name: 'Ad', modified: 'Değiştirme tarihi', size: 'Boyut', type: 'Tür' });

const collator = new Intl.Collator('tr', { sensitivity: 'accent', usage: 'sort' });
const PAD = 12;

/** 'IMG_9.jpg' < 'IMG_10.jpg': her sayı dizisi 12 haneye sıfırla tamamlanır. */
export function naturalKey(name) {
  return name.replace(/\d+/g, (digits) => (digits.length >= PAD ? digits : '0'.repeat(PAD - digits.length) + digits));
}

/** Girdiye sıralama anahtarlarını ekler (JSON'dan gelen düz nesneyi DEĞİŞTİRİR, aynısını döner). */
export function prepare(entry) {
  if (entry._nk === undefined) {
    entry._nk = naturalKey(entry.name);
    entry._tk = typeSortKey(entry);
  }
  return entry;
}

export function prepareAll(entries) {
  for (const entry of entries) prepare(entry);
  return entries;
}

function byName(a, b) {
  return collator.compare(a._nk, b._nk) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

const BY_KEY = {
  name: byName,
  modified: (a, b) => a.mtime - b.mtime || byName(a, b),
  size: (a, b) => a.size - b.size || byName(a, b),
  type: (a, b) => collator.compare(a._tk, b._tk) || byName(a, b),
};

/** Karşılaştırıcı. `foldersFirst`: klasörler (sıralama yönünden bağımsız) hep önce — Gezgin davranışı. */
export function makeComparator({ key = 'name', dir = 'asc', foldersFirst = true } = {}) {
  const base = BY_KEY[key] || BY_KEY.name;
  const sign = dir === 'desc' ? -1 : 1;
  return (a, b) => {
    if (foldersFirst) {
      const ad = a.kind === 'dir';
      if (ad !== (b.kind === 'dir')) return ad ? -1 : 1;
      // Klasörlerde boyut anlamsızdır (hepsi 0): boyuta göre sıralarken klasörler ada göre dizilir.
      if (ad && key === 'size') return sign * byName(a, b);
    }
    return sign * base(a, b);
  };
}

export function sortEntries(entries, options) {
  return prepareAll(entries.slice()).sort(makeComparator(options));
}

/** İki SIRALI diziyi (aynı karşılaştırıcıyla) tek sıralı dizide birleştirir; kararlı. O(a + b). */
export function mergeSorted(a, b, compare) {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a.slice();
  const out = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = compare(b[j], a[i]) < 0 ? b[j++] : a[i++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/** Gizli dosyaları ve (varsa) ad süzgecini uygular. */
export function filterEntries(entries, { showHidden = false, query = '' } = {}) {
  const needle = query.trim().toLocaleLowerCase('tr');
  if (showHidden && !needle) return entries;
  return entries.filter((e) => (showHidden || !e.hidden) && (!needle || e.name.toLocaleLowerCase('tr').includes(needle)));
}

/**
 * "Yazarak bul": tampondaki öneke uyan ilk girdinin dizini (`from`'dan sonra başlar, sona gelince başa sarar). Tek harf
 * tekrarı ('a','a') bir sonraki 'a…' girdisine geçer — Gezgin gibi. Yoksa -1.
 */
export function typeAheadIndex(entries, buffer, from = -1) {
  if (!buffer) return -1;
  const needle = buffer.toLocaleLowerCase('tr');
  const repeated = needle.length > 1 && [...needle].every((c) => c === needle[0]);
  const probe = repeated ? needle[0] : needle;
  const n = entries.length;
  for (let step = 1; step <= n; step += 1) {
    const idx = (from + step + n) % n;
    if (entries[idx].name.toLocaleLowerCase('tr').startsWith(probe)) return idx;
  }
  return -1;
}
