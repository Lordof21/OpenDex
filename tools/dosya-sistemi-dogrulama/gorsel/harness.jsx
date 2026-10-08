// Scratch-only visual harness: FilesApp inside a sized box with a mocked backend (fetch).
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/index.css';
import FilesApp from './src/files/FilesApp.jsx';
import { useFilesStore } from './src/files/filesStore.js';
import { useTransferStore } from './src/files/transferStore.js';
import { setApiToken } from './src/lib/apiToken.js';

const q = new URLSearchParams(location.search);
const W = Number(q.get('w') || 1100);
const H = Number(q.get('h') || 700);
if (q.get('theme') === 'dark') document.documentElement.classList.add('dark');
setApiToken('t');

const now = Math.floor(Date.now() / 1000);
const d = (name, extra = {}) => ({ name, kind: 'dir', size: 0, mtime: now - 86400 * 3, hidden: false, ...extra });
const f = (name, size, ago = 3600, extra = {}) => ({ name, kind: 'file', size, mtime: now - ago, hidden: false, ...extra });
const ROOT = [d('Alarms'), d('Android', { hidden: false }), d('DCIM'), d('Documents'), d('Download'), d('Movies'), d('Music'), d('Pictures'), d('WhatsApp'), d('.thumbnails', { hidden: true }),
  f('rapor-2024-q3.pdf', 2_480_000, 7200), f('notlar.txt', 1_420, 86400), f('bütçe.xlsx', 88_400, 86400 * 2), f('yedek-2024.zip', 412_000_000, 86400 * 9), f('sunum final.pptx', 12_300_000, 86400 * 30),
  f('şarkı - demo.mp3', 4_200_000, 86400 * 40), f('kayıt.mp4', 88_000_000, 86400 * 4), f('uygulama.apk', 52_000_000, 86400 * 5), f('script.py', 3_100, 86400 * 6), f('IMG_20240812_141530.jpg', 3_400_000, 86400 * 20)];
const PHOTOS = Array.from({ length: 60 }, (_, i) => f(`IMG_2024${String(8 + (i % 4)).padStart(2, '0')}${String(10 + (i % 18))}_${String(100000 + i * 137)}.jpg`, 2_000_000 + i * 31_000, 3600 * (i + 1)));
const BIG = Array.from({ length: 50000 }, (_, i) => (i % 9 === 0 ? d(`Klasör ${i}`) : f(`dosya-${String(i).padStart(5, '0')}.${['txt','jpg','pdf','zip','mp4'][i % 5]}`, 1000 + i * 13, i * 37)));
const DOCS = [f('butce.xlsx', 4_200, 7200), f('rapor.pdf', 1_262, 3600), f('sunum.pptx', 2_100, 86400), f('yillik-rapor.docx', 3_900, 86400 * 2)];   // gerçek belgeler: belgeler/uret.py
const MEDYA = [f('klip.mp4', 400_000_000, 3600), f('muzik.wav', 132_000, 7200)];          // klip.mp4: bu Chromium H.264 çözmez → oynatılamadı kartı
const FOLDERS = { '/storage/emulated/0/Medya': MEDYA, '/storage/emulated/0/Belgeler': DOCS, '/storage/emulated/0/BIG': BIG, '/storage/emulated/0': ROOT, '/storage/emulated/0/DCIM': [d('Camera'), d('Screenshots'), ...PHOTOS], 'C:\\Users\\ali\\Downloads': [f('indir.zip', 5_000_000, 600), d('Projeler'), f('fatura.pdf', 120_000, 8000)] };
const PLACES = {
  phone: [{ id: 'phone:internal', provider: 'phone', kind: 'internal', name: 'Dahili depolama', path: '/storage/emulated/0', device: 'S24', total: 256 * 2 ** 30, free: 61 * 2 ** 30 },
    { id: 'phone:sd', provider: 'phone', kind: 'sdcard', name: 'SD kart', path: '/storage/1A2B-3C4D', device: 'S24', total: 128 * 2 ** 30, free: 6 * 2 ** 30 }],
  pc: [{ id: 'pc:desktop', provider: 'pc', kind: 'desktop', name: 'Masaüstü', path: 'C:\\Users\\ali\\Desktop' }, { id: 'pc:documents', provider: 'pc', kind: 'documents', name: 'Belgeler', path: 'C:\\Users\\ali\\Documents' },
    { id: 'pc:downloads', provider: 'pc', kind: 'downloads', name: 'İndirilenler', path: 'C:\\Users\\ali\\Downloads' }, { id: 'pc:pictures', provider: 'pc', kind: 'pictures', name: 'Resimler', path: 'C:\\Users\\ali\\Pictures' },
    { id: 'pc:c', provider: 'pc', kind: 'drive', name: 'Yerel Disk (C:)', path: 'C:\\', total: 476 * 2 ** 30, free: 211 * 2 ** 30 }],
  favorites: [{ id: 'f1', provider: 'phone', device: 'S24', path: '/storage/emulated/0/WhatsApp', name: 'WhatsApp' }], device: 'S24', pc_access: 'folders',
};
const svg = (hue, label) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 38%)"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="190" cy="70" r="26" fill="rgba(255,255,255,.55)"/><path d="M0 220 L90 120 L150 190 L200 140 L256 210 V256 H0Z" fill="rgba(0,0,0,.28)"/></svg>`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const p = url.pathname;
  if (!p.startsWith('/api/') && url.port !== '8710') return realFetch(input, init);
  if (p === '/api/auth/bootstrap') return json({ token: 't' });
  if (p === '/api/fs/places') return json(PLACES);
  if (p === '/api/fs/transfers') return json({ items: [] });
  if (p === '/api/fs/trash') return json({ items: [{ id: 't1', name: 'eski sözleşme.docx', original: '/storage/emulated/0/Documents/eski sözleşme.docx', size: 184000, is_dir: false, deleted: now - 3600 * 5 }, { id: 't2', name: 'Fotoğraflar 2019', original: '/storage/emulated/0/DCIM/Fotoğraflar 2019', size: 0, is_dir: true, deleted: now - 86400 * 2 }, { id: 't3', name: 'IMG_0001.jpg', original: '/storage/emulated/0/DCIM/Camera/IMG_0001.jpg', size: 3100000, is_dir: false, deleted: now - 86400 * 9 }] });
  if (p === '/api/fs/stat') return json({ name: 'x', kind: 'file', size: 1, mtime: now, mode: 0o640 });
  if (p === '/api/fs/thumb') { const n = [...(url.searchParams.get('path') || '')].reduce((a, c) => a + c.charCodeAt(0), 0); return new Response(svg(n % 360), { headers: { 'Content-Type': 'image/svg+xml' } }); }
  if (p === '/api/fs/content') {
    const name = (url.searchParams.get('path') || '').split('/').pop();
    if (/\.(pdf|docx|xlsx|pptx)$/i.test(name)) return realFetch(`/harness-fixtures/${name}`);       // gerçek belge baytları → gerçek çözücüler
    return new Response(svg(200), { headers: { 'Content-Type': 'image/svg+xml' } });
  }
  if (p === '/api/fs/list') {
    const items = FOLDERS[url.searchParams.get('path')] ?? [];
    const lines = [{ type: 'meta', path: url.searchParams.get('path'), parent: null }, { type: 'entries', items }, { type: 'end', total: items.length }];
    return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
  }
  return json({});
};

const box = document.createElement('div');
box.style.cssText = `width:${W}px;height:${H}px;position:relative;overflow:hidden;border:1px solid #888`;
document.getElementById('root').appendChild(box);
const inner = document.createElement('div'); inner.style.cssText = 'width:100%;height:100%'; box.appendChild(inner);
const loc = q.get('loc') || 'phone';
const initialLoc = loc === 'big' ? { provider: 'phone', path: '/storage/emulated/0/BIG', device: 'S24' } : loc === 'dcim' ? { provider: 'phone', path: '/storage/emulated/0/DCIM', device: 'S24' } : loc === 'docs' ? { provider: 'phone', path: '/storage/emulated/0/Belgeler', device: 'S24' } : loc === 'medya' ? { provider: 'phone', path: '/storage/emulated/0/Medya', device: 'S24' } : loc === 'pc' ? { provider: 'pc', path: 'C:\\Users\\ali\\Downloads' } : null;
if (q.get('layout')) useFilesStore.setState({ prefs: { ...useFilesStore.getState().prefs, layout: q.get('layout'), view: q.get('view') || 'auto' } });
else if (q.get('view')) useFilesStore.setState({ prefs: { ...useFilesStore.getState().prefs, view: q.get('view') } });
createRoot(inner).render(<FilesApp win={{ id: 'files-1', focused: true, initialLoc }} />);

// Sahne kurulumu: durum parametreleri (seçim, menü, önizleme, aktarım…)
setTimeout(() => {
  const S = useFilesStore.getState();
  const pane = () => useFilesStore.getState().wins['files-1']?.panes[Number(q.get('pane') || 0)];
  const pick = q.get('select');
  if (pick) pick.split(',').forEach((i, n) => S.click('files-1', 0, pane().order[Number(i)], { ctrl: n > 0 }));
  if (q.get('preview') != null) S.openPreview('files-1', 0, pane().order[Number(q.get('preview'))]);
  if (q.get('tray')) {
    useTransferStore.getState().applyJob({ id: 'j1', state: 'running', op: 'copy', sources: [{ provider: 'pc', path: 'C:\\a' }], dest: { provider: 'phone', path: '/x' }, source_count: 3, total_bytes: 600e6, done_bytes: 252e6, done_files: 1, speed: 18e6, eta: 19, current: ['C:\\Users\\ali\\Videolar\\tatil-2024.mp4'], errors: [], skipped: 0, failed: 0 });
    useTransferStore.getState().applyJob({ id: 'j2', state: 'completed', op: 'copy', sources: [{ provider: 'phone', path: '/x' }], dest: { provider: 'pc', path: 'C:\\y' }, source_count: 12, total_bytes: 40e6, done_bytes: 40e6, done_files: 12, errors: [], skipped: 1, failed: 0 });
    useTransferStore.getState().setTrayOpen(true);
  }
  if (q.get('dialog')) S.openDialog('files-1', { type: q.get('dialog') });
  if (q.get('rename')) S.startRename('files-1', 0, pane().order[Number(q.get('rename'))]);
  if (q.get('hover')) document.querySelector(`[data-index="${q.get('hover')}"]`)?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  if (q.get('menu')) {
    const row = document.querySelector(`[data-index="${q.get('menu')}"]`) || document.querySelector('[data-files-scroll]');
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 12 }));
  }
}, 700);
