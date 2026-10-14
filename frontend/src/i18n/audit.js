// Dil dosyası denetimi: kaynak (tr.json) ile bir dil dosyasını karşılaştırır. Hem `npm run i18n:status` hem vitest kullanır.
const isMeta = (key) => key.startsWith('@');

/** Metindeki `{{ad}}` yer tutucularının sıralı, tekrarsız listesi. */
export const placeholdersOf = (text) =>
  [...new Set([...String(text).matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1]))].sort();

/**
 * @returns {{ missing: string[], extra: string[], placeholders: string[], untranslated: string[] }}
 *  missing: kaynakta olup dilde olmayan · extra: dilde olup kaynakta olmayan (eski/yanlış anahtar)
 *  placeholders: `{{ad}}` kümesi kaynakla uyuşmayan (çeviri parametreyi düşürmüş/değiştirmiş)
 *  untranslated: değeri kaynakla birebir aynı (henüz çevrilmemiş; marka/sayı gibi meşru aynılar da buraya düşer)
 */
export function auditLanguage(source, lang) {
  const missing = [];
  const placeholders = [];
  const untranslated = [];
  for (const [key, text] of Object.entries(source)) {
    if (isMeta(key)) continue;
    if (!(key in lang)) {
      missing.push(key);
      continue;
    }
    if (placeholdersOf(text).join() !== placeholdersOf(lang[key]).join()) placeholders.push(key);
    if (lang[key] === text && /\p{L}{3,}/u.test(text.replace(/\{\{[^}]*\}\}/g, ''))) untranslated.push(key);
  }
  const extra = Object.keys(lang).filter((key) => !isMeta(key) && !(key in source));
  return { missing, extra, placeholders, untranslated };
}
