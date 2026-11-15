// IME güvenliği: bileşim (composition) sırasında basılan Enter/Esc, sayfanın değil IME'nin tuşudur (dönüşüm adayını onaylar /
// bileşimi iptal eder). Kök neden: React'in SyntheticKeyboardEvent'i `isComposing` taşımaz → React işleyicisi nativeEvent'e bakmalı.
import fs from 'fs';
import path from 'path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { isImeKey } from '../src/lib/ime.js';
import { pushEscapeHandler } from '../src/lib/escapeStack.js';
import InlineRename from '../src/files/InlineRename.jsx';

afterEach(cleanup);

describe('isImeKey', () => {
  it('yerel olayda isComposing, React olayında nativeEvent.isComposing, WebKit için keyCode 229', () => {
    expect(isImeKey({ isComposing: true })).toBe(true);
    expect(isImeKey({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeKey({})).toBe(false);
    expect(isImeKey(null)).toBe(false);
  });
});

describe('InlineRename: Enter bileşim sırasında uygulamaz', () => {
  const entry = { name: 'belge.txt', kind: 'file' };

  it('isComposing=true ya da keyCode 229 ile Enter onCommit çağırmaz; gerçek Enter çağırır', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined);
    render(<InlineRename entry={entry} onCommit={onCommit} onCancel={vi.fn()} />);
    const input = screen.getByRole('textbox');

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('Esc bileşim sırasında vazgeçmez', () => {
    const onCancel = vi.fn();
    render(<InlineRename entry={entry} onCommit={vi.fn()} onCancel={onCancel} />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('escapeStack', () => {
  it('bileşim sırasındaki Esc üstteki katmanı kapatmaz', () => {
    const close = vi.fn();
    const off = pushEscapeHandler(close);
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
    off();
  });
});

// Kilit (tokenLock'un yanına): Enter'a bağlı bir işleyici içeren her .jsx dosyası isImeKey'i içe aktarır — yoksa yeni bir metin alanı
// Japonca/Korece/Çince yazan kullanıcıda yarım metni onaylar. Metin alanı OLMAYAN Enter kullanımları aşağıda gerekçesiyle sayılır.
const SRC = path.resolve(__dirname, '../src');
const NOT_TEXT_FIELDS = {
  'telemetry/TimeChart.jsx': 'grafik: Enter seçili anı sabitler (metin girilmez)',
  'notifications/NotificationCard.jsx': 'kart: Enter/Boşluk kartı açar (metin girilmez)',
  'desktop/Desktop.jsx': 'genel kısayol (Enter simgeyi açar); kendi yeniden adlandırma kutusu isImeKey kullanır',
};
function jsxFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return jsxFiles(p);
    return d.name.endsWith('.jsx') ? [p] : [];
  });
}
describe('IME kilidi', () => {
  it('Enter işleyicisi olan her .jsx dosyası isImeKey kullanır (ya da gerekçeli istisnadır)', () => {
    const offenders = [];
    for (const file of jsxFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      const text = fs.readFileSync(file, 'utf8');
      if (!/key === 'Enter'/.test(text)) continue;
      if (text.includes('isImeKey')) continue;
      if (NOT_TEXT_FIELDS[rel]) continue;
      offenders.push(rel);
    }
    expect(offenders, `isImeKey eksik: ${offenders.join(', ')}`).toEqual([]);
  });
});
