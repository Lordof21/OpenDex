// Yalnız görsel doğrulama harness'ı: gerçek Taskbar (görev çubuğu kartı + medya merkezi) sahte bir backend (fetch taklidi) ile.
// Sahne = ?scene=… ; tema = ?theme=dark ; boyut = ?w=&h= . Üretim koduna girmez (run.sh geçici kopyalar).
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import Taskbar from './src/taskbar/Taskbar.jsx';
import { useNotificationStore } from './src/state/notificationStore.js';
import { useSystemStore } from './src/state/systemStore.js';
import { useAudioMixerStore } from './src/state/audioMixerStore.js';
import { setApiToken } from './src/lib/apiToken.js';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') || 1280);
const H = Number(q.get('h') || 720);
const scene = q.get('scene') || 'playing';
if (q.get('theme') === 'dark') document.documentElement.classList.add('dark');
setApiToken('t');

// ── Sahte kapaklar (SVG → data URI; gerçekte telefon JPEG gönderir) ───────────────────────────────────────────
const cover = (a, b, glyph) => `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/>${glyph}</svg>`)}`;
const ART = {
  sunset: cover('#ff7a45', '#7b2ff7', '<circle cx="360" cy="150" r="90" fill="#ffe8a3" opacity=".9"/><path d="M0 380 L140 250 L250 350 L340 280 L512 400 V512 H0Z" fill="#1b0a3a" opacity=".55"/>'),
  ocean: cover('#0aa3b8', '#0b3d91', '<circle cx="150" cy="170" r="70" fill="#bff6ff" opacity=".85"/><path d="M0 330 Q130 270 260 330 T512 330 V512 H0Z" fill="#03203f" opacity=".5"/>'),
  crimson: cover('#e11d48', '#4a0d1c', '<rect x="120" y="120" width="272" height="272" rx="36" fill="none" stroke="#ffd1da" stroke-width="14" opacity=".8"/><circle cx="256" cy="256" r="64" fill="#ffd1da" opacity=".8"/>'),
  mono: cover('#8a8a8a', '#2a2a2a', '<circle cx="256" cy="256" r="120" fill="#e8e8e8" opacity=".5"/>'),
  lime: cover('#a3e635', '#14532d', '<path d="M60 420 L256 90 L452 420Z" fill="#f7fee7" opacity=".7"/>'),
};

const YTM = 'com.google.android.apps.youtube.music';
const SPOTIFY = 'com.spotify.music';
const YT = 'com.google.android.youtube';
const PODCAST = 'au.com.shiftyjelly.pocketcasts';

const track = (pkg, extra) => ({ package: pkg, track_id: `${pkg}::1`, is_playing: true, position: 83_000, duration: 214_000, ...extra });
const SCENES = {
  playing: [track(YTM, { title: 'Gece Yarısı Şarkısı', artist: 'Ece Yıldız', album_art: ART.sunset })],
  paused: [track(YTM, { title: 'Gece Yarısı Şarkısı', artist: 'Ece Yıldız', album_art: ART.ocean, is_playing: false })],
  pending: [track(YTM, { title: 'Yeni Şarkı (kapak yükleniyor)', artist: 'Sanatçı', album_art: '', art_pending: true })],
  noart: [track(SPOTIFY, { title: 'Kapağı Olmayan Parça', artist: 'Bilinmeyen Sanatçı', album_art: '' })],
  multi: [
    track(YTM, { title: 'Gece Yarısı Şarkısı', artist: 'Ece Yıldız', album_art: ART.sunset }),
    track(SPOTIFY, { title: 'Deep Focus: Çalışma Müziği', artist: 'Spotify', album_art: ART.lime, position: 40_000, duration: 3_600_000 }),
    track(YT, { title: 'Kanal sunumu — 4K belgesel fragmanı', artist: 'Doğa Kanalı', album_art: ART.crimson, is_playing: false, position: 120_000, duration: 560_000 }),
    track(PODCAST, { title: 'Bölüm 212: Tasarım Sistemleri', artist: 'Teknoloji Sohbetleri', album_art: ART.mono, is_playing: false, position: 900_000, duration: 2_700_000 }),
  ],
  live: [track(YT, { title: 'Canlı yayın — Gece haberleri', artist: 'Haber Kanalı', album_art: ART.crimson, position: 0, duration: 0 })],
  long: [track(YTM, { title: 'Çok uzun bir parça adı: Bir Yaz Gecesi Rüyası, Op. 61 — Uvertür (Mendelssohn) [2024 Remastered Deluxe Edition]', artist: 'Berlin Filarmoni Orkestrası, Herbert von Karajan, Anne-Sophie Mutter', album_art: ART.ocean })],
};
const sessions = SCENES[scene] || [];
const primary = sessions[0];

useNotificationStore.getState().resetMediaSync();
useNotificationStore.setState({
  notifications: [],
  mediaStatus: primary ? { active: true, ...primary, sessions } : null,
  mediaStatusByPkg: Object.fromEntries(sessions.map((s) => [s.package, s])),
  liveSessionPkgs: sessions.map((s) => s.package),
  pendingActionsByPkg: {},
  pendingSeeksByPkg: {},
});
// Oturum yokken kart görünmez (panele giriş yok); boş durum, panel açıkken son oturum kapanınca görünür → sahne bunu taklit eder.
window.__clearMedia = (disconnected = false) => {
  useNotificationStore.getState().resetMediaSync();
  useNotificationStore.setState({ mediaStatus: null, mediaStatusByPkg: {}, liveSessionPkgs: [] });
  if (disconnected) useSystemStore.setState({ connectionState: 'disconnected' });
};
// RouteChip: YouTube Music PC'de açık bir pencereye sahip → "PC'de" rozeti görünür
useAudioMixerStore.setState({ apps: { [YTM]: { windows: [{ id: 'w1' }], live_route: 'pc', on_phone: false } } });

// ── Sahte backend ─────────────────────────────────────────────────────────────────────────────────────────────
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const icon = (pkg) => {
  const hue = [...pkg].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="22" fill="hsl(${hue} 65% 48%)"/><circle cx="48" cy="48" r="20" fill="rgba(255,255,255,.9)"/></svg>`;
};
const APPS = [
  { package: YTM, display_name: 'YouTube Music' }, { package: SPOTIFY, display_name: 'Spotify' },
  { package: YT, display_name: 'YouTube' }, { package: PODCAST, display_name: 'Pocket Casts' },
];
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const p = url.pathname;
  if (!p.startsWith('/api/') && url.port !== '8710') return realFetch(input, init);
  if (p === '/api/auth/bootstrap') return json({ token: 't' });
  if (p === '/api/apps') return json(APPS);
  if (p.startsWith('/api/apps/icon-v2/')) return new Response(icon(decodeURIComponent(p.split('/').pop())), { headers: { 'Content-Type': 'image/svg+xml' } });
  if (p === '/api/media/status') return json({ active: false, error: 'device_not_connected' });
  if (p === '/api/notifications') return json([]);
  return json({});
};

const box = document.createElement('div');
box.style.cssText = `width:${W}px;height:${H}px;position:relative;overflow:hidden;border:1px solid #888;display:flex;flex-direction:column;justify-content:flex-end;background:radial-gradient(120% 90% at 20% 0%, color-mix(in oklab, var(--primary) 14%, var(--workspace)), var(--workspace))`;
document.getElementById('root').appendChild(box);
createRoot(box).render(<Taskbar windowSize={{ width: W, height: H }} />);
