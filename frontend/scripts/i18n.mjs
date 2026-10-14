// Dil dosyası araçları (kod değişikliği gerektirmeden dil eklemek için).
//   npm run i18n:add -- es "Español" es-ES   src/locales/es.json oluşturur (değerler Türkçe; çevrilecek TEK dosya)
//   npm run i18n:status                      her dilde eksik / fazla / çevrilmemiş anahtarları özetler
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');
const { auditLanguage } = await import(pathToFileURL(path.join(dir, '..', 'i18n', 'audit.js')).href);
const read = (code) => JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8'));
const codes = () => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));

const [cmd, code, name, locale] = process.argv.slice(2);

if (cmd === 'add') {
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(code || '') || !name || !locale) {
    console.error('Kullanım: npm run i18n:add -- <kod> "<Dilin kendi adı>" <yerel>   örn: npm run i18n:add -- pt-BR "Português (Brasil)" pt-BR');
    process.exit(1);
  }
  const target = path.join(dir, `${code}.json`);
  if (fs.existsSync(target)) {
    console.error(`${code}.json zaten var.`);
    process.exit(1);
  }
  const source = read('tr');
  fs.writeFileSync(target, JSON.stringify({ ...source, '@dil.ad': name, '@dil.yerel': locale }, null, 2) + '\n');
  console.log(`src/locales/${code}.json oluşturuldu (${Object.keys(source).length - 2} metin, hepsi henüz Türkçe).`);
  console.log('Metinleri çevirin; yer tutucuları ({{ad}}) olduğu gibi bırakın. Dil, taskbar > Gizli simgeler panelinde görünür.');
} else if (cmd === 'status') {
  const source = read('tr');
  const total = Object.keys(source).filter((k) => !k.startsWith('@')).length;
  console.log(`tr (kaynak): ${total} metin`);
  let bad = false;
  for (const lang of codes().filter((c) => c !== 'tr')) {
    const r = auditLanguage(source, read(lang));
    const done = total - r.missing.length - r.untranslated.length;
    console.log(`${lang}: çevrilmiş ~${done}/${total} · eksik ${r.missing.length} · çevrilmemiş ${r.untranslated.length} · fazla ${r.extra.length} · yer tutucu hatası ${r.placeholders.length}`);
    for (const [label, list] of [['EKSİK', r.missing], ['FAZLA', r.extra], ['YER TUTUCU', r.placeholders]]) {
      if (list.length) console.log(`  ${label}: ${list.slice(0, 8).join(', ')}${list.length > 8 ? ` … (+${list.length - 8})` : ''}`);
    }
    if (r.missing.length || r.extra.length || r.placeholders.length) bad = true;
  }
  process.exit(bad ? 1 : 0);
} else {
  console.error('Komutlar: add | status');
  process.exit(1);
}
