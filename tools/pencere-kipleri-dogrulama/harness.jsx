// Pencere kipleri (normal / kapla / tam ekran / snap) için görsel harness: GERÇEK WindowFrame + TitleBar + HubPanel + Taskbar,
// App.jsx ile AYNI yerleşim (taşıyıcı: sahne `flex-1 overflow-hidden` + görev çubuğu 50 px), sahte backend ve sahte tuval.
// URL: ?latency=300&wins=1&dynamic=1   (görüntü alanı boyutunu tarayıcı belirler)
//   latency — yeniden boyutlandırmada "yeni boyutlu ilk kare"nin gelme süresi (ms)
//   dynamic — 0 → dynamic_resolution_enabled kapalı (yalnız görsel geçiş)
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import Taskbar from './src/taskbar/Taskbar.jsx';
import WindowFrame from './src/window/WindowFrame.jsx';
import { ThemeProvider } from './src/state/ThemeContext.jsx';
import { useWindowStore } from './src/window/windowStore.js';
import { setApiToken } from './src/lib/apiToken.js';

const q = new URLSearchParams(location.search);
const LATENCY = Number(q.get('latency') || 300);
const DYNAMIC = q.get('dynamic') !== '0';
setApiToken('t');

const SETTINGS = {
  dynamic_resolution_enabled: DYNAMIC, resolution_mode: 'dynamic_fit', video_fit_mode: 'contain', dp_lock_enabled: false,
  pixel_perfect_dpr: true, resize_instant_apply: false, header_mode: 'always', custom_dpi: 0, target_dp: 0,
};
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
window.__calls = [];
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const p = url.pathname;
  const method = init?.method || 'GET';
  if (p === '/api/settings') return json(SETTINGS);
  if (p === '/api/windows/resize' && method === 'POST') {
    const body = JSON.parse(init.body);
    window.__calls.push(['resize', body]);
    // Gerçek akış gibi: yanıt hemen, yeni boyutlu ilk kare LATENCY ms sonra.
    setTimeout(() => useWindowStore.getState().onNewResolutionFrameArrived(body.window_id, { width: body.w, height: body.h }), LATENCY);
    return json({ window_id: body.window_id, ws_url: '', display_w: body.w, display_h: body.h });
  }
  if (p.startsWith('/api/') && method === 'POST') { window.__calls.push([p, init?.body]); return json({ ok: true }); }
  if (p.startsWith('/api/')) return json({});
  return new Response('', { status: 404 });
};

const n = Number(q.get('wins') || 1);
const windows = Array.from({ length: n }, (_, i) => ({
  id: `win-${i + 1}`, package: `com.example.app${i + 1}`, title: `Uygulama ${i + 1}`,
  x: 80 + i * 40, y: 60 + i * 40, w: 640, h: 440, zIndex: i + 1,
  minimized: false, maximized: false, fullscreen: false, snapZone: null, focused: i === n - 1, wsUrl: '', deviceW: 640, deviceH: 400, dpi: 200,
}));
useWindowStore.setState({ windows, nextZ: 30 });
window.__ws = useWindowStore;

function Stage() {
  const wins = useWindowStore((s) => s.windows);
  return (
    <div className="desktop-wallpaper relative flex h-full w-full flex-col overflow-hidden select-none" style={{ background: 'linear-gradient(135deg,#a8c0ff,#3f2b96)' }}>
      <div className="relative min-h-0 flex-1 w-full overflow-hidden" data-testid="stage">
        {wins.map((win) => <WindowFrame key={win.id} win={win} settings={SETTINGS} />)}
      </div>
      <Taskbar />
    </div>
  );
}

const box = document.createElement('div');
// WindowFrame ekranı window.innerWidth/innerHeight'tan okur: kutu görüntü alanının TAMAMI (Playwright görüntü alanı = w×h).
box.style.cssText = 'position:fixed;inset:0;overflow:hidden';
document.getElementById('root').appendChild(box);
createRoot(box).render(<ThemeProvider><Stage /></ThemeProvider>);
