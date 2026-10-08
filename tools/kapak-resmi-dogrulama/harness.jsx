// Kapak resmi için görsel harness: App.jsx'in kabuk yapısı (kapak katmanı + masaüstü + görev çubuğu) GERÇEK bileşenlerle, sahte backend ile.
// URL: ?w=1280&h=760&theme=light|dark&apps=18&prefs=<json>&contact=1
//   prefs   — açılışta localStorage'a yazılacak kapak tercihleri (harness.html yazar; yoksa varsayılan)
//   contact — masaüstü yerine tüm hazır kapakların açık/koyu "kontak sayfası" (ölçüm ve göz kontrolü için)
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import Desktop from './src/desktop/Desktop.jsx';
import WallpaperLayer from './src/desktop/wallpaper/WallpaperLayer.jsx';
import { useWallpaper, useWallpaperSlideshow } from './src/desktop/wallpaper/useWallpaper.js';
import { useWallpaperStore } from './src/desktop/wallpaper/wallpaperStore.js';
import { BUILTIN_WALLPAPERS } from './src/desktop/wallpaper/catalog.js';
import { artStyle } from './src/desktop/wallpaper/layerStyle.js';
import { resolveWallpaper } from './src/desktop/wallpaper/prefs.js';
import { ThemeProvider } from './src/state/ThemeContext.jsx';
import { setApiToken } from './src/lib/apiToken.js';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') || 1280);
const H = Number(q.get('h') || 760);
const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
// theme / prefs localStorage'a harness.html'deki satır içi betikte, modüllerden önce yazılır.
setApiToken('t');

const NAMES = ['Chrome', 'Galeri', 'Kamera', 'Ayarlar', 'YouTube', 'WhatsApp', 'Telegram', 'Spotify', 'Hesap Makinesi', 'Takvim', 'Saat', 'Notlar', 'Harita', 'Gmail', 'Çağrı', 'Rehber', 'Mesajlar', 'Dosyalarım'];
const COUNT = Math.min(Number(q.get('apps') || 18), NAMES.length);
const REMOTE = Array.from({ length: COUNT }, (_, i) => ({ package: `com.example.app${i}`, display_name: NAMES[i] }));
const svg = (hue, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 72% 60%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 70% 40%)"/></linearGradient></defs><rect width="96" height="96" rx="20" fill="url(#g)"/><text x="48" y="62" font-size="42" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${label}</text></svg>`;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const p = url.pathname;
  if (p.startsWith('/api/apps/icon-v2/')) {
    const pkg = decodeURIComponent(p.split('/').pop());
    const hue = [...pkg].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    return new Response(svg(hue, (REMOTE.find((a) => a.package === pkg)?.display_name || '?').charAt(0)), { headers: { 'Content-Type': 'image/svg+xml' } });
  }
  if (p === '/api/apps') return json(REMOTE);
  if (p === '/api/apps/refresh') return json({ all_apps: REMOTE });
  if (/app-layout|layout/.test(p)) return json([]);
  if (!p.startsWith('/api/') && url.port !== '8710') return realFetch(input, init);
  return json({});
};

window.__wp = useWallpaperStore;

function Shell() {
  const wallpaper = useWallpaper();
  useWallpaperSlideshow();
  return (
    <div data-wallpaper-tone={wallpaper.tone} className="desktop-wallpaper relative flex h-full w-full flex-col overflow-hidden select-none">
      <WallpaperLayer wallpaper={wallpaper} />
      <div className="relative min-h-0 w-full flex-1 overflow-hidden"><Desktop /></div>
      <div className="relative z-10 h-[50px] w-full shrink-0 border-t border-taskbar-border bg-taskbar shadow-taskbar backdrop-blur-2xl" aria-label="görev çubuğu" />
    </div>
  );
}

function Contact() {
  const dark = theme === 'dark';
  return (
    <div style={{ padding: 8, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, background: '#888' }}>
      {BUILTIN_WALLPAPERS.map((item) => {
        const wp = resolveWallpaper({ mode: 'builtin', id: item.id }, { isDark: dark });
        return (
          <figure key={item.id} data-contact={item.id} style={{ margin: 0 }}>
            <div data-art style={{ ...artStyle(wp), aspectRatio: '16 / 9', borderRadius: 8 }} />
            <figcaption style={{ font: '11px sans-serif', color: '#fff' }}>{item.name} · {wp.variant} · luma {wp.luma}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}

const box = document.createElement('div');
box.style.cssText = q.get('contact') ? 'width:1280px' : `width:${W}px;height:${H}px;position:relative;overflow:hidden;border:1px solid #888`;
document.getElementById('root').appendChild(box);
createRoot(box).render(<ThemeProvider>{q.get('contact') ? <Contact /> : <Shell />}</ThemeProvider>);
