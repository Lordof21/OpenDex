// Every backend call the UI makes must exist on the backend — pinned in tests/fixtures/backend-routes.json, which the
// backend's tests/test_route_manifest.py keeps current. A renamed or removed route fails here, not in a user's hands
// (the way /api/device/stress-test and /api/device/dpi silently 404'd for months).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const manifest = new Set(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'backend-routes.json'), 'utf8')));

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(jsx?|tsx?)$/.test(name) && !/\.test\./.test(name)) yield full;
  }
}

const normalize = (path) => path.replace(/\$\{[^}]*\}/g, '{}').split('?')[0];

function collectCalls() {
  const calls = [];
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    for (const m of text.matchAll(/\bapi\.(get|post|put|delete)\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      calls.push({ key: `${m[1].toUpperCase()} ${normalize(m[2])}`, file: rel });
    }
    for (const m of text.matchAll(/\bfetch\(\s*`\$\{BASE\}(\/api\/[^`]+)`/g)) {
      calls.push({ key: `${/method:\s*'POST'/.test(text.slice(m.index, m.index + 400)) ? 'POST' : 'GET'} ${normalize(m[1])}`, file: rel });
    }
    for (const m of text.matchAll(/wsUrl\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      calls.push({ key: `WS ${normalize(m[1])}`, file: rel });
    }
  }
  return calls;
}

describe('frontend ↔ backend route contract', () => {
  const calls = collectCalls();

  it('finds the UI\'s backend calls', () => {
    expect(calls.length).toBeGreaterThan(60);
    expect(calls.some((c) => c.key === 'POST /api/windows/open')).toBe(true);
    expect(calls.some((c) => c.key === 'WS /ws/events')).toBe(true);
  });

  it('every call targets a route the backend serves', () => {
    const missing = [...new Set(calls.filter((c) => !manifest.has(c.key)).map((c) => `${c.key}  (${c.file})`))];
    expect(missing).toEqual([]);
  });
});
