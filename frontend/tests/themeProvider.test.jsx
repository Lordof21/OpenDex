// Tema: kayıtlı tercih İLK render'da bilinir (açılışta açık→koyu geçişi yok), .dark sınıfı <html>'e uygulanır, color-scheme CSS'te var.
import fs from 'fs';
import path from 'path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../src/state/ThemeContext.jsx';

function Probe() {
  const { theme, toggleTheme } = useTheme();
  return <button onClick={toggleTheme}>{theme}</button>;
}

beforeEach(() => { window.localStorage.clear(); document.documentElement.classList.remove('dark'); });
afterEach(cleanup);

describe('ThemeProvider', () => {
  it('kayıtlı koyu tema ilk render\'da koyudur ve <html>.dark uygulanır', () => {
    window.localStorage.setItem('theme', 'dark');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByRole('button')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('kayıt yoksa açıktır; değiştirince sınıf ve depolama güncellenir', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByRole('button')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    act(() => screen.getByRole('button').click());
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem('theme')).toBe('dark');
  });
});

describe('açılış sayfası ve CSS', () => {
  const root = path.resolve(__dirname, '..');
  it('index.html tema betiğini (render-engelleyen, harici) ve color-scheme meta etiketini içerir', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    expect(html).toMatch(/<meta name="color-scheme" content="light dark"/);
    expect(html).toMatch(/<script src="\/theme-init\.js"><\/script>/);               // type="module" DEĞİL: ertelenmez
  });
  it('theme-init.js ThemeContext ile aynı anahtarı okur', () => {
    const js = fs.readFileSync(path.join(root, 'public/theme-init.js'), 'utf8');
    expect(js).toContain("getItem('theme')");
    expect(js).toContain("'dark'");
  });
  it('index.css :root açık, .dark koyu color-scheme bildirir', () => {
    const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');
    expect(css).toMatch(/:root\s*\{\s*color-scheme:\s*light;/);
    expect(css).toMatch(/\.dark\s*\{\s*color-scheme:\s*dark;/);
  });
});
