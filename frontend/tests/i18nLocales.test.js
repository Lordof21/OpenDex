// Dil dosyaları: her dil kaynakla (tr.json) aynı anahtar ve {{yer tutucu}} kümesine sahip olmalı; kodda kullanılan her t('anahtar')
// tr.json'da bulunmalı. (Çevrilmemiş = Türkçe kalmış metin hata değildir: eksik anahtar yedek olarak Türkçeye düşer.)
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { auditLanguage, placeholdersOf } from '../src/i18n/audit.js';
import { activeLocale, languageCodes, matchLanguage, t } from '../src/i18n/index.js';
import source from '../src/locales/tr.json';

const LOCALE = /^[a-z]{2,3}-([A-Z]{2}|[0-9]{3})$/;

const files = import.meta.glob(['../src/locales/*.json', '!../src/locales/tr.json'], { eager: true, import: 'default' });

describe('dil dosyaları', () => {
  it('kaynak dilin kendi adı ve yerel adı vardır', () => {
    expect(source['@dil.ad']).toBeTruthy();
    expect(source['@dil.yerel']).toMatch(LOCALE);
  });

  it.each(Object.entries(files))('%s kaynakla aynı anahtar ve yer tutucu kümesine sahip', (file, lang) => {
    const report = auditLanguage(source, lang);
    expect({ missing: report.missing, extra: report.extra, placeholders: report.placeholders }).toEqual({ missing: [], extra: [], placeholders: [] });
    expect(lang['@dil.ad']).toBeTruthy();
    expect(lang['@dil.yerel']).toMatch(LOCALE);
    expect(() => new Intl.Locale(lang['@dil.yerel'])).not.toThrow();
  });

  it('kodda kullanılan her t("anahtar") tr.json içinde vardır', () => {
    const root = path.join(__dirname, '..', 'src');
    const used = new Map();
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.jsx?$/.test(name) && !/\.test\./.test(name)) {
          const text = fs.readFileSync(full, 'utf8');
          for (const m of text.matchAll(/\btt?\(\s*'([a-z0-9_]+\.[a-z0-9_.]+)'/g)) used.set(m[1], path.relative(root, full));
        }
      }
    };
    walk(root);
    const unknown = [...used].filter(([key]) => !(key in source)).map(([key, file]) => `${key} (${file})`);
    expect(used.size).toBeGreaterThan(500);
    expect(unknown).toEqual([]);
  });

  it('t() yer tutucuları doldurur; bilinmeyen anahtar kendini döndürür', () => {
    expect(t('taskbar.count_pencere_daha', { count: 3 })).toContain('3');
    expect(t('yok.boyle.bir.anahtar')).toBe('yok.boyle.bir.anahtar');
  });

  it('yer tutucu çıkarımı sıralı ve tekrarsızdır', () => {
    expect(placeholdersOf('{{b}} ve {{a}} ve {{b}}')).toEqual(['a', 'b']);
  });

  it('tarayıcı dil etiketleri doğru dosyaya eşlenir', () => {
    const codes = ['tr', 'de', 'en', 'es', 'ku', 'pt-BR', 'zh-CN', 'zh-TW'];
    const m = (tag) => matchLanguage(tag, codes);
    expect(m('en-GB')).toBe('en');
    expect(m('es-MX')).toBe('es');
    expect(m('pt-PT')).toBe('pt-BR');
    expect(m('pt')).toBe('pt-BR');
    expect(m('zh')).toBe('zh-CN');
    expect(m('zh-Hans-CN')).toBe('zh-CN');
    expect(m('zh-HK')).toBe('zh-TW');
    expect(m('zh-Hant')).toBe('zh-TW');
    expect(m('ZH-tw')).toBe('zh-TW');
    expect(m('ku')).toBe('ku');
    expect(m('ckb')).toBeNull(); // Soranî sağdan sola yazılır: RTL desteği gelene dek Kurmancî'ye düşürülmez
    expect(m('fr')).toBeNull();
    expect(m('')).toBeNull();
  });

  it('etkin yerel ad, dil dosyasından gelir', () => {
    expect(languageCodes()[0]).toBe('tr');
    expect(activeLocale()).toBe('tr-TR');
  });
});
