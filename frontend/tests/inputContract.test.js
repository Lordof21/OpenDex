// Giriş kanallarının kabul ettiği DEĞERLER sözleşmesi. apiContract.test.js yalnız rotanın var olduğunu denetler; D-pad ise
// var olan bir rotaya (POST /api/input/key) şemanın reddettiği `kind: 'dpad'` yolluyordu — backend 422 veriyor, arayüz
// `.catch(() => {})` ile yutuyordu ve oklar aylarca hiçbir şey yapmadı. Bu test o sınıfı yakalar:
// kaynakta yazılı her `kind`, tuş adı ve /ws/input mesaj tipi, backend'in pinlenmiş listesinde olmalıdır
// (tests/fixtures/backend-input-contract.json — backend tests/test_route_manifest.py güncel tutar).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({ api: { post: vi.fn() }, wsUrl: (p) => `ws://test${p}` }));

import { DPAD_KEYS, DPAD_SELECT_KEY, NAMED_KEYS } from '../src/input/keyboardInject.js';

const ROOT = join(__dirname, '..');
const contract = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'backend-input-contract.json'), 'utf8'));

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(jsx?|tsx?)$/.test(name) && !/\.test\./.test(name)) yield full;
  }
}

/** `api.post('/api/input/key', { … kind: 'x', key: 'y' … })` gövdelerindeki sabit değerler. */
export function scanKeyRequests(text) {
  const found = [];
  for (const m of text.matchAll(/api\.post\(\s*['"`]\/api\/input\/key['"`]\s*,\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const kind = body.match(/\bkind:\s*['"`](\w+)['"`]/)?.[1];
    const key = body.match(/\bkey:\s*['"`]([^'"`]+)['"`]/)?.[1];
    if (kind) found.push({ kind, key: kind === 'keycode' ? key : undefined });
  }
  for (const m of text.matchAll(/\bsendKeycode\(\s*[^,)]+,\s*['"`]([^'"`]+)['"`]/g)) {
    found.push({ kind: 'keycode', key: m[1] });
  }
  return found;
}

/** /ws/input soketine yazılan mesajların sabit `type` değerleri (yalnız o soketi kullanan dosyalarda). */
export function scanInputSocketTypes(text) {
  if (!/\/ws\/input/.test(text)) return [];
  return [...text.matchAll(/\btype:\s*['"`](\w+)['"`]/g)].map((m) => m[1]);
}

const requests = [];
const socketTypes = new Set();
for (const file of sourceFiles(join(ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  for (const r of scanKeyRequests(text)) requests.push({ ...r, file: rel });
  for (const t of scanInputSocketTypes(text)) socketTypes.add(t);
}

describe('giriş sözleşmesi: arayüzün gönderdiği değerleri backend kabul eder', () => {
  it('taramalar boş değil (sözleşme testi boşa geçmesin)', () => {
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.some((r) => r.kind === 'keycode' && r.key === 'back')).toBe(true);
    for (const t of ['down', 'move', 'up', 'scroll', 'clipboard', 'release_all']) expect(socketTypes.has(t)).toBe(true);
  });

  it('POST /api/input/key: her sabit `kind` backend şemasında var', () => {
    const bad = requests.filter((r) => !contract.key_kinds.includes(r.kind)).map((r) => `kind '${r.kind}' (${r.file})`);
    expect([...new Set(bad)]).toEqual([]);
  });

  it('POST /api/input/key: her sabit keycode adı backend tablosunda var (yoksa 422)', () => {
    const bad = requests
      .filter((r) => r.kind === 'keycode' && r.key && !contract.keycode_names.includes(r.key))
      .map((r) => `key '${r.key}' (${r.file})`);
    expect([...new Set(bad)]).toEqual([]);
  });

  it('adlandırılmış klavye tuşları ve D-pad tuşları backend keycode tablosunda', () => {
    const wanted = [...[...NAMED_KEYS].map((k) => k.toLowerCase()), ...Object.values(DPAD_KEYS), DPAD_SELECT_KEY];
    expect(wanted.filter((k) => !contract.keycode_names.includes(k))).toEqual([]);
  });

  it('/ws/input: arayüzün yazdığı her mesaj tipini backend tanır', () => {
    expect([...socketTypes].filter((t) => !contract.ws_input_types.includes(t))).toEqual([]);
  });
});

describe('tarayıcının kendisi (aksi hâlde sessizce hiçbir şeyi yakalamazdı)', () => {
  it('eski D-pad hatasını — `kind: "dpad"` — yakalar', () => {
    const old = `api.post('/api/input/key', {
      window_id: win.id,
      kind: 'dpad',
      direction: dir,
    }).catch(() => {})`;
    const [req] = scanKeyRequests(old);
    expect(req.kind).toBe('dpad');
    expect(contract.key_kinds.includes(req.kind)).toBe(false);
  });

  it('çok satırlı gövdede keycode adını okur; sendKeycode sabitini de', () => {
    expect(scanKeyRequests(`api.post('/api/input/key', { window_id: id, kind: 'keycode', key: 'back' })`)).toEqual([
      { kind: 'keycode', key: 'back' },
    ]);
    expect(scanKeyRequests(`await sendKeycode(windowId, 'pagedown')`)).toEqual([{ kind: 'keycode', key: 'pagedown' }]);
  });

  it('değişken değerleri sabit sanmaz', () => {
    expect(scanKeyRequests(`api.post('/api/input/key', { window_id: id, kind: 'keycode', key })`)).toEqual([
      { kind: 'keycode', key: undefined },
    ]);
  });
});
