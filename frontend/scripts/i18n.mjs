// Dil dosyası araçları (kod değişikliği gerektirmeden dil eklemek için).
//   npm run i18n:add -- es "Español" es-ES   src/locales/es.json oluşturur (değerler Türkçe; çevrilecek TEK dosya)
//   npm run i18n:status                      her dilde eksik / fazla / çevrilmemiş anahtarları özetler
//   npm run i18n:addkeys -- <sozluk.json>    YENİ anahtarlar: { "grup.anahtar": ["Türkçe", "English"] } → tr'ye Türkçe, diğer dillere İngilizce yer tutucu (çeviri sonra: todo/apply)
//   npm run i18n:todo                        ÇEVİRİ BEKLEYEN anahtarlar (diller ingilizce yer tutucuda kalmış) → i18n-todo.json
//   npm run i18n:apply -- <dil> <dosya.json> { anahtar: çeviri } dosyasını o dile işler (yer tutucuları denetler, çevrilmişlere dokunmaz)
//   Akış ve ucuz model (Haiku) komutu: docs/CEVIRI_MEMORY.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');
const { auditLanguage } = await import(pathToFileURL(path.join(dir, '..', 'i18n', 'audit.js')).href);
const read = (code) => JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8'));
const codes = () => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));

const [cmd, code, name, locale] = process.argv.slice(2);
// Her dilde bilerek aynı kalan metinler (teknik terim): çeviri beklemiyor sayılır.
const IDENTICAL_OK = new Set(['taskbar.dinamik_fix', 'taskbar.wpa2_3_kurumsal', 'taskbar.wpa2_kisisel', 'taskbar.wpa3_kisisel', 'taskbar.wpa3_kurumsal']);
const TARGETS = () => codes().filter((c) => c !== 'tr' && c !== 'en');
const placeholders = (text) => (String(text).match(/\{\{\w+\}\}/g) || []).sort().join(',');

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
} else if (cmd === 'addkeys') {
  const file = code;
  if (!file || !fs.existsSync(file)) {
    console.error('Kullanım: npm run i18n:addkeys -- <sozluk.json>   (dosya: { "grup.anahtar": ["Türkçe", "English"] })');
    process.exit(1);
  }
  const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
  const groupOf = (k) => k.split('.')[0];
  for (const lang of codes()) {
    const full = path.join(dir, `${lang}.json`);
    const raw = fs.readFileSync(full, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const out = JSON.parse(raw);
    for (const [key, [trText, enText]] of Object.entries(dict)) {
      if (key in out) continue;
      const value = lang === 'tr' ? trText : enText;
      const names = Object.keys(out);
      const last = names.reduce((acc, k, i) => (groupOf(k) === groupOf(key) ? i : acc), -1);
      const rebuilt = {};
      names.forEach((k, i) => {
        rebuilt[k] = out[k];
        if (i === last) rebuilt[key] = value;
      });
      if (last === -1) rebuilt[key] = value;
      for (const k of names) delete out[k];
      Object.assign(out, rebuilt);
    }
    fs.writeFileSync(full, JSON.stringify(out, null, 2).replace(/\n/g, eol) + (raw.endsWith(eol) ? eol : ''));
  }
  console.log(`${Object.keys(dict).length} anahtar eklendi (tr: Türkçe, diğer diller: İngilizce yer tutucu). Çeviri için: npm run i18n:todo`);
} else if (cmd === 'todo') {
  // `addkeys` yeni anahtarı tr'ye Türkçe, diğer dillere İNGİLİZCE yer tutucu olarak yazar (status bunu "çevrilmiş" sayar). Bekleyen = çoğu dilde
  // değeri ingilizceyle birebir aynı olan anahtar; birkaç dilde aynı çıkması (Computer, Standard…) meşru benzerliktir, sayılmaz.
  const tr = read('tr');
  const en = read('en');
  const langs = TARGETS();
  const data = Object.fromEntries(langs.map((l) => [l, read(l)]));
  const threshold = Math.ceil(langs.length / 2);
  const pending = Object.keys(tr).filter((k) => !k.startsWith('@') && en[k] !== undefined && tr[k] !== en[k] && /[A-Za-z]{3,}/.test(en[k].replace(/\{\{\w+\}\}/g, '')) && !IDENTICAL_OK.has(k)
    && langs.filter((l) => data[l][k] === en[k]).length >= threshold);
  fs.writeFileSync(path.join(dir, '..', '..', 'i18n-todo.json'), JSON.stringify(pending.map((key) => ({ key, tr: tr[key], en: en[key] })), null, 2) + '\n');
  console.log(pending.length ? `${pending.length} anahtar çeviri bekliyor → frontend/i18n-todo.json` : 'Bekleyen çeviri yok.');
  for (const k of pending.slice(0, 40)) console.log(`  ${k}  |  ${en[k].slice(0, 70)}`);
  if (pending.length > 40) console.log(`  … (+${pending.length - 40})`);
} else if (cmd === 'apply') {
  const file = name;
  if (!TARGETS().includes(code) || !file || !fs.existsSync(file)) {
    console.error('Kullanım: npm run i18n:apply -- <dil> <çeviri.json>   (dosya: { "anahtar": "çeviri" })');
    process.exit(1);
  }
  const en = read('en');
  const incoming = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rawTarget = fs.readFileSync(path.join(dir, `${code}.json`), 'utf8');
  const eol = rawTarget.includes('\r\n') ? '\r\n' : '\n';
  const target = JSON.parse(rawTarget);
  let applied = 0;
  const problems = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (en[key] === undefined) problems.push(`${key}: bilinmeyen anahtar`);
    else if (typeof value !== 'string' || !value.trim()) problems.push(`${key}: boş çeviri`);
    else if (placeholders(value) !== placeholders(en[key])) problems.push(`${key}: yer tutucular uyuşmuyor`);
    else if (target[key] !== en[key]) problems.push(`${key}: zaten çevrilmiş, dokunulmadı`);
    else {
      target[key] = value;
      applied += 1;
    }
  }
  // Dosyanın satır sonu korunur (CRLF çalışma kopyasında tüm dosyayı değiştirmesin); hiçbir şey işlenmediyse dosyaya dokunulmaz.
  if (applied) fs.writeFileSync(path.join(dir, `${code}.json`), JSON.stringify(target, null, 2).replace(/\n/g, eol) + eol);
  console.log(`${code}: ${applied} çeviri işlendi${problems.length ? `, ${problems.length} atlandı` : ''}.`);
  for (const p of problems.slice(0, 12)) console.log(`  ! ${p}`);
} else {
  console.error('Komutlar: add | addkeys | status | todo | apply');
  process.exit(1);
}
