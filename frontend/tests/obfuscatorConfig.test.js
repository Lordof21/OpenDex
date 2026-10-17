// Üretim paketinin karartma ayarı: `transformObjectKeys` AÇIK olamaz. Açıkken obfuscator nesne değişmezlerinin alanlarını ifadenin
// dışına taşır ve `cond ? <Icon pkg={win.package}/> : …` gibi koşullu JSX'te alan okuması koşula bakılmadan çalışır:
// "Cannot read properties of undefined (reading 'package')" ile DeX Ayarları çöktü (yalnız paketlenmiş uygulamada, geliştirmede değil).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import JavaScriptObfuscator from 'javascript-obfuscator';

const SOURCE = `
function render(win) { return Boolean(win) ? React.createElement(Icon, { pkg: win.package, size: 14 }) : null; }
globalThis.__out = (() => { try { return String(render(undefined)); } catch (e) { return 'CRASH: ' + e.message; } })();
`;

function runObfuscated(options) {
  const code = JavaScriptObfuscator.obfuscate(SOURCE, { compact: true, renameGlobals: false, ...options }).getObfuscatedCode();
  globalThis.React = { createElement: () => 'el' };
  globalThis.Icon = () => 0;
  new Function(code)();
  const out = globalThis.__out;
  delete globalThis.__out;
  return out;
}

describe('release obfuscation settings', () => {
  it('vite.config.js keeps transformObjectKeys off', () => {
    const config = fs.readFileSync(path.resolve(__dirname, '../vite.config.js'), 'utf8');
    expect(config).toMatch(/transformObjectKeys:\s*false/);
    expect(config).not.toMatch(/transformObjectKeys:\s*true/);
  });

  it('with it off, a guarded property read stays guarded (the reason it is off)', () => {
    expect(runObfuscated({ transformObjectKeys: false })).toBe('null');
  });

});
