// Shared plumbing of the screenshot scenarios: launch Chromium, install the sample backend and the sample video decoder, open the
// real app, and reach into it (through the dev server's module graph) to arrange what a screenshot needs.
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { installMockBackend } = require('./mock/backend.cjs');
const { build } = require('./mock/fixtures.cjs');

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5173';
const INIT = ['scenes.js', 'media.js'].map((f) => fs.readFileSync(path.join(__dirname, 'mock', f), 'utf8')).join('\n');

// Every screenshot is "taken" at the same moment, so clocks, notification times and the calendar are identical from run to run.
const FIXED_NOW = new Date('2026-10-06T11:24:30+03:00');

async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
}

/** A new page on the real app with the sample backend behind it. `theme`: 'light' | 'dark'. */
async function openApp(browser, { width = 1600, height = 900, theme = 'dark', scale = 2, windows, mutate, locale = 'tr-TR', go = true } = {}) {
  const fixtures = build(FIXED_NOW.getTime() / 1000);
  if (mutate) mutate(fixtures);
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: scale, colorScheme: theme, locale, timezoneId: 'Europe/Istanbul',
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|mock: not implemented/.test(m.text())) problems.push(`console: ${m.text()}`.slice(0, 300));
  });
  await page.clock.setFixedTime(FIXED_NOW);
  await page.addInitScript(INIT);
  await page.addInitScript((value) => { try { localStorage.setItem('theme', value); } catch { /* storage unavailable */ } }, theme);
  const backend = await installMockBackend(page, { fixtures, windows, onUnhandled: (key) => problems.push(`unhandled request: ${key}`) });
  if (go) await page.goto(APP_URL);
  return { context, page, backend, problems, fixtures };
}

/** Runs `fn(module)` inside the page against one of the app's own modules (same instances the app uses — Vite dev server). */
const inApp = (page, modulePath, fn, arg) =>
  page.evaluate(async ([m, source, a]) => {
    const mod = await import(/* @vite-ignore */ m);
    // eslint-disable-next-line no-new-func
    return new Function('mod', 'arg', `return (${source})(mod, arg);`)(mod, a);
  }, [modulePath, fn.toString(), arg]);

const WINDOW_STORE = '/src/window/windowStore.js';
const SYSTEM_STORE = '/src/state/systemStore.js';

/** Waits until the desktop is up (boot splash gone) and every sample window has painted its first frame. */
async function waitForDesktop(page, windowCount) {
  await page.waitForSelector('nav[aria-label="DeX görev çubuğu"]', { timeout: 20_000 });
  if (windowCount) {
    await page.waitForFunction((n) => document.querySelectorAll('[data-window-frame-id] canvas').length >= n, windowCount, { timeout: 20_000 });
  }
  await page.waitForTimeout(1200);
}

/** Puts the windows where a screenshot wants them: `[{id, x, y, w, h, title?, focused?}]`. Everything else stays as the app made it. */
async function arrange(page, layout) {
  await inApp(page, WINDOW_STORE, ({ useWindowStore }, items) => {
    let z = 10;
    useWindowStore.setState((s) => ({
      windows: s.windows.map((w) => {
        const spec = items.find((i) => i.id === w.id);
        if (!spec) return w;
        z += 1;
        return { ...w, x: spec.x, y: spec.y, w: spec.w, h: spec.h, title: spec.title ?? w.title, focused: Boolean(spec.focused), zIndex: spec.focused ? 100 : z,
          maximized: false, minimized: Boolean(spec.minimized) };
      }),
    }));
  }, layout);
  await page.waitForTimeout(500);
}

/** Closes the browser even when a mocked WebSocket would keep it busy. */
async function shutdown(browser, backends = []) {
  backends.forEach((b) => b.dispose());
  await Promise.race([browser.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
}

module.exports = { launch, openApp, inApp, arrange, waitForDesktop, shutdown, APP_URL, FIXED_NOW, WINDOW_STORE, SYSTEM_STORE };
