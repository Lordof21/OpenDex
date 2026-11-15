// Form denetimlerinin erişilebilir adı: `placeholder` ad DEĞİLDİR (yazmaya başlayınca kaybolur, ekran okuyucu onu ad saymaz).
// Her <input>/<textarea>/<select> aria-label, aria-labelledby, id (bir <label for>) ya da saran/önceki <label> taşır.
// Kaynak taraması (uiTokenLock.test.js gibi): bileşen testleri adı olmayan alanı yakalamaz.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');
const jsxFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return jsxFiles(p);
  return d.name.endsWith('.jsx') ? [p] : [];
});

describe('form denetimi adları', () => {
  it('her <input>/<textarea>/<select> bir ad taşır', () => {
    const offenders = [];
    for (const file of jsxFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const m of text.matchAll(/<(input|textarea|select)\b/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        if (lines[line - 1].trim().startsWith('//') || lines[line - 1].trim().startsWith('*')) continue;
        const end = text.indexOf('/>', m.index);
        const tag = text.slice(m.index, end === -1 ? m.index + 900 : Math.min(end, m.index + 900));
        const before = lines.slice(Math.max(0, line - 8), line - 1).join('\n');
        if (/aria-label(ledby)?=/.test(tag) || /\bid=/.test(tag) || /<label\b/.test(before)) continue;
        offenders.push(`${path.relative(SRC, file)}:${line} <${m[1]}>`);
      }
    }
    expect(offenders, `adsız form denetimi: ${offenders.join(', ')}`).toEqual([]);
  });
});
