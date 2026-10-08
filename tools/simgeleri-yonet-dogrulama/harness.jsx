// "Simgeleri yönet" için görsel harness: GERÇEK Desktop.jsx, sahte bir backend (fetch taklidi) ile.
// URL: ?w=1280&h=760&theme=light|dark&apps=60&layout=default|full|empty
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import Desktop from './src/desktop/Desktop.jsx';
import { ThemeProvider } from './src/state/ThemeContext.jsx';
import { setApiToken } from './src/lib/apiToken.js';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') || 1280);
const H = Number(q.get('h') || 760);
const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
try { localStorage.setItem('theme', theme); } catch {}
setApiToken('t');

const NAMES = ['Chrome', 'Galeri', 'Kamera', 'Ayarlar', 'YouTube', 'WhatsApp', 'Telegram', 'Spotify', 'Hesap Makinesi', 'Takvim', 'Saat', 'Notlar', 'Harita', 'Gmail',
  'Çağrı', 'Rehber', 'Mesajlar', 'Dosyalarım', 'Play Store', 'Netflix', 'Instagram', 'X', 'LinkedIn', 'Zoom', 'Teams', 'Drive', 'Fotoğraflar', 'Müzik', 'Radyo', 'Hava Durumu',
  'İş Bankası', 'Ziraat Mobil', 'e-Devlet', 'Getir', 'Yemeksepeti', 'Trendyol', 'Hepsiburada', 'Sahibinden', 'BiP', 'Şifre Yöneticisi', 'Ses Kaydedici', 'Güvenlik', '2048',
  'Satranç', 'Okey', 'Sudoku', 'Çeviri', 'Sözlük', 'Kitaplık', 'Pusula'];
const COUNT = Math.min(Number(q.get('apps') || 60), NAMES.length + 10);
const REMOTE = Array.from({ length: COUNT }, (_, i) => {
  const name = NAMES[i] ?? `Uygulama ${i + 1}`;
  const slug = name.toLocaleLowerCase('tr-TR').replace(/[^a-z0-9ğüşıöç]+/g, '');
  return { package: `com.example.${slug || 'app' + i}${i}`, display_name: name };
});
const svg = (hue, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 72% 60%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 70% 40%)"/></linearGradient></defs><rect width="96" height="96" rx="20" fill="url(#g)"/><text x="48" y="62" font-size="42" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${label}</text></svg>`;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const realFetch = window.fetch.bind(window);
let saved = null;
window.__layoutSaved = () => saved;
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const p = url.pathname;
  if (p.startsWith('/api/apps/icon-v2/')) {
    const pkg = decodeURIComponent(p.split('/').pop());
    const app = REMOTE.find((a) => a.package === pkg);
    const hue = [...pkg].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    return new Response(svg(hue, (app?.display_name || '?').charAt(0)), { headers: { 'Content-Type': 'image/svg+xml' } });
  }
  if (p === '/api/apps') return json(REMOTE);
  if (p === '/api/apps/refresh') return json({ all_apps: REMOTE });
  if (/app-layout|layout/.test(p) && (init?.method || 'GET') === 'PUT') { try { saved = JSON.parse(init.body); } catch {} return json({ ok: true }); }
  if (/app-layout|layout/.test(p)) return json(saved ?? []);
  if (!p.startsWith('/api/') && url.port !== '8710') return realFetch(input, init);
  return json({});
};

const box = document.createElement('div');
box.style.cssText = `width:${W}px;height:${H}px;position:relative;overflow:hidden;border:1px solid #888`;
document.getElementById('root').appendChild(box);
createRoot(box).render(<ThemeProvider><Desktop /></ThemeProvider>);
