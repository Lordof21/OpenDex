#!/usr/bin/env node
// Takes the screenshots in docs/images/ from the REAL frontend running against a sample backend (see README.md).
//
//   node tools/screenshots/shoot.cjs                 every screenshot
//   node tools/screenshots/shoot.cjs hero launcher   only these
//
// Environment: APP_URL (the dev server, default http://127.0.0.1:5173), OUT_DIR (default docs/images), SCALE (device scale factor,
// default 2), PLAYWRIGHT_PATH, CHROME_PATH, PYTHON. Exit code 1 when a scenario met an error the app logged or a call the sample backend
// does not know (a new screen that needs more sample data is noticed, not silently painted empty).
const fs = require('fs');
const path = require('path');
const { launch, openApp, inApp, arrange, waitForDesktop, shutdown, SYSTEM_STORE } = require('./lib.cjs');

const OUT = path.resolve(process.env.OUT_DIR || path.join(__dirname, '..', '..', 'docs', 'images'));
const SCALE = Number(process.env.SCALE || 2);
const RAW = fs.mkdtempSync(path.join(require('os').tmpdir(), 'opendex-shots-'));   // lossless captures; the published files are WebP (see to_webp.py)
const SIZE = { width: 1600, height: 900 };

// Window sizes follow the sample apps' own aspect ratio (the frame is 45 px of title bar plus the picture), so nothing is letterboxed.
const frame = (w, deviceW, deviceH) => Math.round((w * deviceH) / deviceW) + 45;
const HERO = [
  { id: 'win-clips', x: 190, y: 40, w: 880, h: frame(880, 1100, 640), title: 'Clips' },
  { id: 'win-notes', x: 1110, y: 56, w: 400, h: frame(400, 460, 760), title: 'Notes' },
  { id: 'win-chat', x: 640, y: 236, w: 330, h: frame(330, 420, 700), title: 'Chat', focused: true },
];

const bar = (page) => page.locator('nav[aria-label="DeX görev çubuğu"]');
const statusButton = (page, index) => page.locator('[aria-label="Bağlantı, ses ve pil durumu"] button').nth(index);

/** The desktop with the three sample windows up, the stream overlay hidden with its own F8 shortcut. */
async function desktop(browser, options = {}) {
  const session = await openApp(browser, { ...SIZE, scale: SCALE, ...options });
  await waitForDesktop(session.page, 3);
  await arrange(session.page, HERO);
  await session.page.waitForTimeout(2500);
  await session.page.keyboard.press('F8');
  await session.page.waitForTimeout(600);
  return session;
}

const SCENARIOS = {
  async hero(browser) {
    for (const theme of ['dark', 'light']) {
      const s = await desktop(browser, { theme });
      await s.page.screenshot({ path: path.join(RAW, `hero-${theme}.png`) });
      await finish(s);
    }
  },

  async launcher(browser) {
    const s = await desktop(browser);
    await s.page.locator('button[aria-label="Uygulamalar"]').click();
    await s.page.waitForTimeout(1200);
    await s.page.screenshot({ path: path.join(RAW, 'launcher.png') });
    await finish(s);
  },

  async 'quick-settings'(browser) {
    const s = await desktop(browser);
    await statusButton(s.page, 2).click();
    await s.page.waitForTimeout(1200);
    await s.page.screenshot({ path: path.join(RAW, 'quick-settings.png') });
    await finish(s);
  },

  async 'audio-mixer'(browser) {
    const s = await desktop(browser);
    await statusButton(s.page, 0).click();
    await s.page.waitForTimeout(1200);
    await s.page.screenshot({ path: path.join(RAW, 'audio-mixer.png') });
    await finish(s);
  },

  async battery(browser) {
    const s = await desktop(browser);
    await statusButton(s.page, 3).click();
    await s.page.waitForTimeout(1200);
    await s.page.screenshot({ path: path.join(RAW, 'battery.png') });
    await finish(s);
  },

  async 'media-center'(browser) {
    const s = await desktop(browser);
    await s.page.locator('[aria-label="Medya oynatıcı"] button').first().click();
    await s.page.waitForTimeout(1200);
    await s.page.screenshot({ path: path.join(RAW, 'media-center.png') });
    await finish(s);
  },

  async notifications(browser) {
    const s = await desktop(browser);
    await s.page.locator('button[aria-label^="Saat, takvim"]').click();
    await s.page.waitForTimeout(1200);
    await s.page.screenshot({ path: path.join(RAW, 'notifications.png') });
    await finish(s);
  },

  async 'device-load'(browser) {
    const s = await desktop(browser);
    await s.page.locator('button[aria-label^="Telefon yükü"]').click();
    await s.page.waitForTimeout(1800);
    await s.page.screenshot({ path: path.join(RAW, 'device-load.png') });
    await finish(s);
  },

  async files(browser) {
    // The file manager: phone storage on the left, the camera folder open (a media folder opens as a grid with thumbnails by itself).
    const s = await desktop(browser);
    await arrange(s.page, HERO.map((w) => ({ ...w, minimized: true })));
    await s.page.locator('button[aria-label="Uygulamalar"]').click();
    await s.page.locator('[role="dialog"][aria-label="Uygulamalar"]').getByText('Dosyalar', { exact: true }).click();
    await s.page.waitForSelector('[role="toolbar"][aria-label="Dosya araçları"]', { timeout: 15_000 });
    await arrange(s.page, [{ id: 'files-1', x: 170, y: 50, w: 1260, h: 770, title: 'Dosyalar', focused: true }, ...HERO.map((w) => ({ ...w, minimized: true }))]);
    await s.page.waitForTimeout(2500);                         // the window's own settle animation (scale / layout) must be over
    const inFiles = s.page.locator('[data-window-frame-id="files-1"]');
    await inFiles.getByText('DCIM', { exact: true }).dblclick();
    await inFiles.getByText('Camera', { exact: true }).dblclick();
    await s.page.waitForTimeout(1500);
    await s.page.screenshot({ path: path.join(RAW, 'files.png') });
    await finish(s);
  },

  async workspace(browser) {
    // Workspace: the phone's freeform tasks share one virtual display; the UI frames each one where the phone placed it.
    const s = await openApp(browser, { ...SIZE, scale: SCALE, theme: 'dark', mutate: (fx) => { fx.windows = fx.workspace_windows; } });
    await s.page.waitForSelector('nav[aria-label="DeX görev çubuğu"]', { timeout: 20_000 });
    await s.page.waitForTimeout(5000);
    await s.page.screenshot({ path: path.join(RAW, 'workspace.png') });
    await finish(s);
  },

  async pairing(browser) {
    // No phone yet: the desktop is empty and the pairing dialog (QR / pair code / manual IP) opens by itself.
    const s = await openApp(browser, { ...SIZE, scale: SCALE, theme: 'dark', windows: [], mutate: (fx) => { fx.devices = []; fx.devices_state = fx.no_device; fx.windows = []; } });
    await s.page.waitForSelector('canvas, img[src^="data:image/png"]', { timeout: 20_000 });
    await s.page.waitForTimeout(2500);
    await s.page.screenshot({ path: path.join(RAW, 'pairing.png') });
    await finish(s);
  },

  async boot(browser) {
    // The boot screen mid-way: core up, the phone found, the daemon's health check at attempt 2 of 3 (the snapshot comes from startup_state).
    const s = await openApp(browser, { ...SIZE, scale: SCALE, theme: 'dark', mutate: (fx) => { fx.startup = fx.startup_booting; } });
    await s.page.waitForTimeout(2200);
    await s.page.screenshot({ path: path.join(RAW, 'boot.png') });
    await finish(s);
  },

  async devices(browser) {
    const s = await desktop(browser);
    await s.page.locator('button[aria-label^="Cihaz merkezi"]').click();
    await s.page.waitForTimeout(1200);
    await s.page.screenshot({ path: path.join(RAW, 'devices.png') });
    await finish(s);
  },

  async settings(browser) {
    const s = await desktop(browser);
    await arrange(s.page, [{ ...HERO[0] }, { ...HERO[1] }, { ...HERO[2], minimized: true }]);
    await inApp(s.page, SYSTEM_STORE, ({ useSystemStore }) => useSystemStore.getState().openSettings());
    await s.page.waitForTimeout(1200);
    await s.page.screenshot({ path: path.join(RAW, 'settings.png') });
    await finish(s);
  },
};

const problemsAll = [];

/** PNG captures → WebP in OUT (PIL). Without Python/Pillow the PNGs are kept instead, with a warning. */
function convert() {
  const run = require('child_process').spawnSync(process.env.PYTHON || 'python3', [path.join(__dirname, 'to_webp.py'), RAW, OUT], { stdio: 'inherit' });
  if (run.status !== 0) {
    console.warn('to_webp.py failed (is Pillow installed?) — keeping the PNG captures');
    fs.readdirSync(RAW).filter((f) => f.endsWith('.png')).forEach((f) => fs.copyFileSync(path.join(RAW, f), path.join(OUT, f)));
  }
  fs.rmSync(RAW, { recursive: true, force: true });
}
async function finish(session) {
  problemsAll.push(...session.problems.map((p) => `[${session.name || 'scenario'}] ${p}`));
  session.backend.dispose();
  await session.context.close().catch(() => {});
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(SCENARIOS);
  const unknown = names.filter((n) => !SCENARIOS[n]);
  if (unknown.length) {
    console.error(`unknown scenario(s): ${unknown.join(', ')} — known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(2);
  }
  const browser = await launch();
  for (const name of names) {
    process.stdout.write(`${name} … `);
    await SCENARIOS[name](browser);
    console.log('ok');
  }
  await shutdown(browser);
  convert();
  if (problemsAll.length) {
    console.error(`\n${problemsAll.length} problem(s):\n${[...new Set(problemsAll)].join('\n')}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
