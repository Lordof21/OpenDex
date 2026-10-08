// Görev çubuğu için görsel harness: GERÇEK Taskbar + WindowPreview, sahte backend (fetch taklidi) ve sahte "canlı video" tuvalleri.
// URL: ?w=1280&h=420&theme=light|dark&wins=3&workspace=1
//   wins      — açık VD pencere sayısı (ilki telefon dikey, diğerleri yatay)
//   workspace — Çalışma Alanı kabını da ekler (ve içinde 2 görev)
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import Taskbar from './src/taskbar/Taskbar.jsx';
import { ThemeProvider } from './src/state/ThemeContext.jsx';
import { useWindowStore } from './src/window/windowStore.js';
import { setApiToken } from './src/lib/apiToken.js';
import { setWindowThumbnail } from './src/state/windowThumbnailCache.js';
import TitleBar from './src/window/TitleBar.jsx';
import WorkspaceTaskFrame from './src/window/WorkspaceTaskFrame.jsx';
import AltTabSwitcher from './src/window/AltTabSwitcher.jsx';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') || 1280);
const H = Number(q.get('h') || 420);
setApiToken('t');

const APPS = [
  { package: 'com.google.android.youtube', name: 'YouTube', hue: 0, portrait: true },
  { package: 'com.android.chrome', name: 'Chrome', hue: 210 },
  { package: 'com.whatsapp', name: 'WhatsApp', hue: 140 },
  { package: 'com.spotify.music', name: 'Spotify', hue: 120 },
];
const svg = (hue, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 72% 60%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 70% 40%)"/></linearGradient></defs><rect width="96" height="96" rx="20" fill="url(#g)"/><text x="48" y="64" font-size="46" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${label}</text></svg>`;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const realFetch = window.fetch.bind(window);
window.__calls = [];
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const p = url.pathname;
  if (p.startsWith('/api/apps/icon-v2/')) {
    const pkg = decodeURIComponent(p.split('/').pop());
    const app = APPS.find((a) => a.package === pkg);
    if (!app) return new Response('', { status: 404 }); // gerçek backend de bilinmeyen paket için 404 verir → harf yedeği
    return new Response(svg(app.hue, app.name.charAt(0)), { headers: { 'Content-Type': 'image/svg+xml' } });
  }
  if (p.startsWith('/api/windows/') && init?.method === 'POST') { window.__calls.push([p, init.body]); return json({ ok: true }); }
  if (p === '/api/apps') return json(APPS.map((a) => ({ package: a.package, display_name: a.name })));
  if (!p.startsWith('/api/') && url.port !== '8710') return realFetch(input, init);
  return json({});
};

// Her pencere için sahte "canlı video" tuvali: gerçek VideoCanvas'ın yaptığı gibi data-window-id taşır; gerçek kare boyutu (dikey/yatay) vardır.
function paintFrame(canvas, { w, h, hue, title }) {
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, `hsl(${hue} 70% 22%)`); sky.addColorStop(1, `hsl(${(hue + 40) % 360} 75% 55%)`);
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,.92)'; g.fillRect(0, 0, w, h * 0.07); // durum çubuğu
  g.fillStyle = '#111'; g.font = `${Math.round(h * 0.035)}px sans-serif`; g.fillText('12:30', w * 0.04, h * 0.05);
  for (let i = 0; i < 6; i += 1) { // içerik kartları
    g.fillStyle = `hsla(${hue + i * 20} 60% 92% / .9)`;
    g.fillRect(w * 0.06, h * (0.12 + i * 0.14), w * 0.88, h * 0.11);
    g.fillStyle = '#334'; g.fillRect(w * 0.09, h * (0.14 + i * 0.14), w * 0.4, h * 0.012);
  }
  g.fillStyle = '#fff'; g.font = `bold ${Math.round(h * 0.05)}px sans-serif`; g.fillText(title, w * 0.06, h * 0.97); // alt kenar: tam kare görünüyor mu?
  g.strokeStyle = '#f0f'; g.lineWidth = Math.max(w, h) / 60; g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth); // kenar çerçevesi: önizlemede de görünür kalacak kalınlık
}

function FakeVideos() {
  const windows = useWindowStore((s) => s.windows);
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: 2, height: 2, overflow: 'hidden', opacity: 0.01 }}>
      {windows.filter((w) => !w.minimized && w.fake).map((w) => (
        <canvas key={w.id} data-window-id={w.id} style={{ width: 120, height: 80 }} ref={(c) => { if (c && !c.__painted) { c.__painted = true; paintFrame(c, w.fake); setWindowThumbnail(w.id, c); /* VideoCanvas'ın 500 ms'lik yakalamasının yerine */ } }} />
      ))}
    </div>
  );
}

const n = Math.min(Number(q.get('wins') || 3), APPS.length);
const windows = APPS.slice(0, n).map((a, i) => ({
  id: `win-${i + 1}`, package: a.package, title: a.name, x: 40 + i * 30, y: 40 + i * 30, w: a.portrait ? 380 : 900, h: a.portrait ? 760 : 560, zIndex: i + 1,
  minimized: false, maximized: false, focused: i === n - 1, wsUrl: '', deviceW: a.portrait ? 1080 : 1920, deviceH: a.portrait ? 2400 : 1080,
  fake: a.portrait ? { w: 1080, h: 2400, hue: a.hue, title: a.name } : { w: 1920, h: 1080, hue: a.hue, title: a.name },
}));
if (q.get('workspace')) {
  windows.push({
    id: 'eco-workspace', isEcoWorkspace: true, package: null, title: 'Çalışma Alanı', x: 60, y: 60, w: 1280, h: 800, zIndex: 20, minimized: false, maximized: true, focused: false,
    focusedTaskId: null, vdW: 1920, vdH: 1080, tasks: [], fake: { w: 1920, h: 1080, hue: 260, title: 'Çalışma Alanı' },
  });
}
useWindowStore.setState({ windows, nextZ: 30 });
window.__ws = useWindowStore;

// ?scene=titlebars → gerçek TitleBar / WorkspaceTaskFrame başlıkları alt alta (ikon doğrulaması)
function TitleBars() {
  const ws = useWindowStore((st) => st.windows);
  const files = { id: 'files-1', kind: 'files', package: 'com.opendex.files', title: 'Dosyalar', focused: false };
  const mirror = { id: 'mirror', package: 'com.opendex.screen_mirror', title: 'Telefon Ekranı', focused: false };
  const task = { windowId: 'task-1', package: 'com.whatsapp', title: 'WhatsApp', bounds: [100, 100, 900, 700] };
  const props = { onDragStart: () => {}, frameRef: { current: null }, pipWindow: null, setPipWindow: () => {}, onToggleHub: () => {}, hubButtonRef: { current: null } };
  return (
    <div style={{ width: 640, background: 'var(--background)', padding: 8, display: 'grid', gap: 8 }}>
      {[...ws, files, mirror].map((w) => <div key={w.id} data-title={w.id}><TitleBar win={w} {...props} /></div>)}
      <div data-title="task" style={{ position: 'relative', height: 120 }}>
        <WorkspaceTaskFrame task={task} deviceW={1920} deviceH={1080} frameW={640} frameH={120} isFocused onFocus={() => {}} />
      </div>
    </div>
  );
}

const box = document.createElement('div');
box.style.cssText = `width:${W}px;height:${H}px;position:relative;overflow:hidden;border:1px solid #888;display:flex;flex-direction:column;justify-content:flex-end;background:linear-gradient(135deg,#a8c0ff,#3f2b96)`;
document.getElementById('root').appendChild(box);
createRoot(box).render(
  <ThemeProvider>
    {q.get('scene') === 'titlebars' ? <TitleBars /> : (<><FakeVideos /><Taskbar windowSize={{ width: W, height: H }} /><AltTabSwitcher /></>)}
  </ThemeProvider>,
);
