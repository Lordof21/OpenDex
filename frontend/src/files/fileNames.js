// İstemci tarafı ad kuralları — backend/app/fs/names.py'nin AYNASI. Backend her zaman son sözü söyler; bu dosya yalnızca
// "yanlış adı yazarken anında uyar, sunucuya gitme" içindir ve aynı test tablosuyla (tests/files/fileNames.test.js)
// doğrulanır.
const WINDOWS_INVALID = /[<>:"/\\|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
const COMPOUND = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst'];

const utf8Length = (s) => new TextEncoder().encode(s).length;

/** Geçerliyse null, değilse kullanıcıya gösterilecek Türkçe neden. */
export function validateName(name, { windows }) {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return 'Ad boş olamaz.';
  if (name.includes('\u0000') || name.includes('/')) return "Ad '/' ya da boş karakter içeremez.";
  if (BIDI.test(name)) return 'Ad görünmez yön denetim karakterleri içeremez.';
  if (windows) {
    const bad = [...new Set([...name].filter((c) => WINDOWS_INVALID.test(c)))];
    if (bad.length) return `Ad şu karakterleri içeremez: ${bad.map((c) => (c.charCodeAt(0) < 32 ? '↯' : c)).join(' ')}`;
    if (/[ .]$/.test(name)) return 'Ad nokta ya da boşlukla bitemez.';
    if (WINDOWS_RESERVED.has(name.split('.')[0].replace(/ +$/, '').toUpperCase())) return "Bu ad Windows'ta ayrılmış bir aygıt adıdır.";
    if (name.length > 255) return 'Ad çok uzun (en fazla 255 karakter).';
  } else if (utf8Length(name) > 255) {
    return 'Ad çok uzun (en fazla 255 bayt).';
  }
  return null;
}

/** ['arsiv', '.tar.gz'] · ['foto', '.jpg'] · ['.bashrc', ''] */
export function splitExtension(name) {
  const lower = name.toLowerCase();
  for (const c of COMPOUND) if (lower.endsWith(c) && name.length > c.length) return [name.slice(0, -c.length), name.slice(-c.length)];
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? [name, ''] : [name.slice(0, dot), name.slice(dot)];
}

const COPY_SUFFIX = /^(.*) \((\d{1,6})\)$/;

/** 'Yeni klasör' → 'Yeni klasör (2)' → … ilk boş olan. `taken`: karşılaştırma anahtarları (küçük harf) kümesi. */
export function uniqueName(name, taken, { casefold = true } = {}) {
  const key = (s) => (casefold ? s.normalize('NFC').toLowerCase() : s);
  if (!taken.has(key(name))) return name;
  const [stem, ext] = splitExtension(name);
  const m = COPY_SUFFIX.exec(stem);
  const base = m ? m[1] : stem;
  for (let n = m ? Number(m[2]) + 1 : 2; n < 100_000; n += 1) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(key(candidate))) return candidate;
  }
  return name;
}

/** Yeniden adlandırırken seçilecek aralık: uzantı HARİÇ (Gezgin gibi). Klasörde tüm ad. */
export function renameSelection(name, isDir) {
  if (isDir) return [0, name.length];
  const [stem] = splitExtension(name);
  return [0, stem.length || name.length];
}
