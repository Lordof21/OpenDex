// Arayüz dili. Bir dil = TEK dosya: src/locales/<kod>.json (düz anahtar → metin). Kaynak dil Türkçe (tr.json).
//
// Yeni dil eklemek kod değişikliği gerektirmez:
//   npm run i18n:add -- es "Español" es-ES   → src/locales/es.json (değerler Türkçe kalır; çevrilecek tek dosya)
//   npm run i18n:status                      → hangi dilde neyin eksik / çevrilmemiş olduğunu söyler
// Dil, taskbar'daki "Gizli simgeler" panelindeki listede kendiliğinden görünür.
//
// Kullanım (bileşen içi ve dışı aynı): `t('common.kapat')`, `t('taskbar.count_pencere_daha', { count })` — metinde `{{count}}`.
// Dil seçimi yalnızca bu cihazın tarayıcı deposunda (localStorage) durur; backend'e gitmez. Dil DEĞİŞİNCE sayfa yeniden
// yüklenir (modül düzeyindeki sabitler dahil her metin yeni dilde baştan kurulur) — bkz. changeLanguage.
//
// Önyükleme: main.jsx uygulamayı `initLanguage()` BİTTİKTEN SONRA yükler; böylece modül düzeyindeki `t()` çağrıları da doğru dili görür.
import i18n from 'i18next';

import localeMeta from 'virtual:locale-meta';

import source from '../locales/tr.json';

export const SOURCE_LANGUAGE = 'tr';
const STORAGE_KEY = 'opendex.language';

// Vite derleme zamanında bulur: dosya eklemek bu modüle dokunmayı gerektirmez.
const files = import.meta.glob(['../locales/*.json', '!../locales/tr.json']);
const codeOf = (path) => path.split('/').pop().replace(/\.json$/, '');

/** Mevcut dil kodları: kaynak dil başta. */
export const languageCodes = () => [SOURCE_LANGUAGE, ...Object.keys(files).map(codeOf).sort()];

const isAvailable = (code) => languageCodes().includes(code);

// Eşzamanlı başlatma: ilk çizimde ve testlerde Türkçe hazır. Anahtarlar düz ("a.b" tek anahtardır).
i18n.init({
  lng: SOURCE_LANGUAGE,
  fallbackLng: SOURCE_LANGUAGE,
  resources: { [SOURCE_LANGUAGE]: { translation: source } },
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false }, // React zaten kaçırır
  returnNull: false,
});

const readStored = () => {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

// Tarayıcı etiketi → dil dosyası. Önce birebir ('zh-CN'), sonra yazı/bölge takma adları (Geleneksel Çince), sonra aynı dil ailesinden ilk dosya
// ('pt-PT' → 'pt-BR', 'es-MX' → 'es', 'zh' → 'zh-CN'). Büyük/küçük harf önemsizdir.
const TAG_ALIASES = { 'zh-hant': 'zh-tw', 'zh-hk': 'zh-tw', 'zh-mo': 'zh-tw', 'zh-hans': 'zh-cn', 'zh-sg': 'zh-cn', ku: 'ku', ckb: null };
export function matchLanguage(tag, codes = languageCodes()) {
  const wanted = String(tag || '').toLowerCase().replace(/_/g, '-');
  if (!wanted) return null;
  const byLower = new Map(codes.map((c) => [c.toLowerCase(), c]));
  const aliased = TAG_ALIASES[wanted] === null ? null : (TAG_ALIASES[wanted] ?? wanted);
  if (aliased && byLower.has(aliased)) return byLower.get(aliased);
  if (aliased === null) return null;
  const base = wanted.split('-')[0];
  if (byLower.has(base)) return byLower.get(base);
  return codes.find((c) => c.toLowerCase().startsWith(`${base}-`)) || null;
}

/** İşletim sistemi / tarayıcı dil tercihlerinden (sırayla) dil dosyası olan ilki; yoksa null. */
export function systemLanguage() {
  const preferred = typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : [];
  for (const tag of preferred) {
    const found = matchLanguage(tag);
    if (found) return found;
  }
  return null;
}

/** Kayıtlı seçim → işletim sistemi dili → İngilizce (varsa) → Türkçe. */
export function resolveInitialLanguage() {
  const stored = readStored();
  if (stored && isAvailable(stored)) return stored;
  return systemLanguage() || (isAvailable('en') ? 'en' : SOURCE_LANGUAGE);
}

async function load(code) {
  if (code === SOURCE_LANGUAGE || i18n.hasResourceBundle(code, 'translation')) return;
  const entry = Object.entries(files).find(([path]) => codeOf(path) === code);
  if (!entry) return;
  const mod = await entry[1]();
  i18n.addResourceBundle(code, 'translation', mod.default ?? mod, true, true);
}

/** Uygulama açılışında bir kez (main.jsx): kayıtlı ya da işletim sistemi dili yüklenir ve etkinleşir. */
export async function initLanguage() {
  const code = resolveInitialLanguage();
  await load(code);
  await i18n.changeLanguage(code);
  if (typeof document !== 'undefined') document.documentElement.lang = code;
  return code;
}

/** Dili kaydeder ve sayfayı yeniden yükler (her metin yeni dilde baştan kurulur). */
export function changeLanguage(code, { reload = () => window.location.reload() } = {}) {
  if (!isAvailable(code) || code === currentLanguage()) return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    return false; // depolama kapalı: seçim kalıcı olamaz, yeniden yükleme eskisini geri getirirdi
  }
  reload();
  return true;
}

export const currentLanguage = () => i18n.language || SOURCE_LANGUAGE;

/** Dil listesi için [{ code, name }] — eşzamanlı: adlar derleme zamanında dil dosyalarından okunur (vite.config.js localeMeta),
 *  seçici açılırken tek bir dil paketi yüklenmez/ayrıştırılmaz. */
export function describeLanguages() {
  const names = new Map(localeMeta.map(({ code, name }) => [code, name]));
  names.set(SOURCE_LANGUAGE, source['@dil.ad']);
  return languageCodes().map((code) => ({ code, name: names.get(code) || code }));
}

// Sıcak döngülerde (50 000 dosya girdisini sıralamak/süzmek) her çağrıda i18next araması pahalıdır: parametresiz metinler ve yerel ad
// dil başına bir kez çözülür. Dil açılışta ayarlanır (sonra sayfa yeniden yüklenir); yine de değişince önbellek boşaltılır.
const plain = new Map();
let localeCache = null;
i18n.on('languageChanged', () => {
  plain.clear();
  localeCache = null;
});

/** Etkin dilin BCP-47 yerel adı (`Intl`, `toLocale…`): 'tr-TR', 'en-US'… Sabit 'tr-TR' yazılmaz. */
export function activeLocale() {
  if (localeCache === null) localeCache = i18n.getResource(currentLanguage(), 'translation', '@dil.yerel') || source['@dil.yerel'] || 'tr-TR';
  return localeCache;
}

/** Metin: `t('anahtar')`, `t('anahtar', { ad })` (metinde `{{ad}}`). Anahtar yoksa Türkçe kaynağa, o da yoksa anahtara düşer. */
export function t(key, options) {
  if (options) return i18n.t(key, options);
  let text = plain.get(key);
  if (text === undefined) {
    text = i18n.t(key);
    plain.set(key, text);
  }
  return text;
}

export default i18n;
