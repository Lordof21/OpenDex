// Tek UI sistemi kilidi: bileşenler yalnız semantik token kullanır (Smooth Resize Studio tasarımı).
// TailAdmin kalıntısı (dark: çiftleri, gray/slate/brand…, shadow-theme-*, hex renk) ya da Tailwind v3'te CSS
// üretmeyen tw-animate sınıfları (animate-in, fade-in, zoom-in-*) geri gelirse bu test kırmızı olur.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../src');

function jsxFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return jsxFiles(p);
    return d.name.endsWith('.jsx') ? [p] : [];
  });
}

const PALETTE = 'gray|slate|zinc|neutral|stone|brand|surface|red|rose|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink';
const RULES = [
  { name: 'dark: öneki (tema token\'larla değişir)', re: /(^|[\s"'`])dark:[\w[\]/.-]+/ },
  { name: 'Tailwind renk paleti', re: new RegExp(`(^|[\\s"'\`:])(?:[a-z-]+:)*(?:bg|text|border|ring|from|via|to|shadow|fill|stroke|outline|divide|placeholder|decoration|accent|caret)-(?:${PALETTE})-\\d{2,3}\\b`) },
  { name: 'TailAdmin gölgesi', re: /shadow-theme-(xs|sm|md|lg)/ },
  { name: 'TailAdmin accent ölçeği', re: /\baccent-[3-6]00\b/ },
  { name: 'tw-animate sınıfı (v3\'te CSS yok)', re: /(^|[\s"'`])(animate-in|animate-out|fade-in|fade-out|zoom-in-\d+|zoom-out-\d+)(?=[\s"'`])/ },
  { name: 'hex renk', re: /#[0-9a-fA-F]{6}\b/ },
];

// Bilinçli istisnalar: konsol log renkleri (%c) ve QR kütüphanesinin renk parametresi. (HeadsUpToast artık token'lı.)
const ALLOW_LINE = [/%c/, /'color: #[0-9a-fA-F]{6}/, /color: \{ dark: '#000000', light: '#ffffff' \}/];
const ALLOW_FILES = new Set();

describe('tek UI sistemi — semantik token kilidi', () => {
  it('src/**/*.jsx TailAdmin/ham renk ya da v3\'te çalışmayan sınıf içermez', () => {
    const offenders = [];
    for (const file of jsxFiles(SRC)) {
      const relFile = path.relative(SRC, file);
      if (ALLOW_FILES.has(relFile)) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.trim().startsWith('//') || ALLOW_LINE.some((re) => re.test(line))) return;
        for (const rule of RULES) {
          if (rule.re.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1} [${rule.name}] ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
