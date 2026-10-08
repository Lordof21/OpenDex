// Kullanım: node snap.cjs [sahne-adı-parçası]   (önce ./run.sh)
//   ORTAM: HARNESS_URL (http://localhost:5198), OUT_DIR (./shots), PLAYWRIGHT_PATH (playwright), CHROME_PATH (ops.)
// Her sahne: gerçek masaüstünü açar → boş yere sağ tık → "Simgeleri Yönet" → adımlar → ekran görüntüsü + tutarlılık kontrolleri.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.HARNESS_URL || 'http://localhost:5198';
const OUT = process.env.OUT_DIR || path.join(process.cwd(), 'shots');
fs.mkdirSync(OUT, { recursive: true });

const SCENES = [
  { name: 'acik', w: 1280, h: 760, params: 'theme=light' },
  { name: 'koyu', w: 1280, h: 760, params: 'theme=dark' },
  { name: 'arama', w: 1280, h: 760, params: 'theme=light', steps: [['type', 'input[type=search]', 'ga']] },
  { name: 'bos-arama', w: 1280, h: 760, params: 'theme=dark', steps: [['type', 'input[type=search]', 'zzzz']] },
  { name: 'eklenmemis', w: 1280, h: 760, params: 'theme=light', steps: [['click', '[role=radio]:has-text("Eklenmemiş")']] },
  { name: 'geri-al', w: 1280, h: 760, params: 'theme=light', steps: [['click', '[role=switch][aria-label="Galeri"]']] },
  { name: 'dar', w: 420, h: 760, params: 'theme=light' },
  { name: 'dar-koyu', w: 420, h: 760, params: 'theme=dark', steps: [['click', '[role=radio]:has-text("Masaüstünde")']] },
  { name: 'kisa', w: 900, h: 480, params: 'theme=light' },
  { name: 'liste-yok', w: 1280, h: 760, params: 'theme=light&apps=0' },
];

(async () => {
  const only = process.argv[2];
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox'] });
  let bad = 0;
  for (const sc of SCENES.filter((s) => !only || s.name.includes(only))) {
    const ctx = await browser.newContext({ viewport: { width: sc.w + 20, height: sc.h + 20 } });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/Failed to load resource/.test(m.text())) logs.push(`${m.type()}: ${m.text()}`.slice(0, 240)); });
    page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`.slice(0, 240)));
    await page.goto(`${BASE}/harness.html?w=${sc.w}&h=${sc.h}&${sc.params}`);
    await page.waitForSelector('main[aria-label="DeX Masaüstü"]');
    await page.waitForTimeout(1200);
    await page.locator('main[aria-label="DeX Masaüstü"]').click({ button: 'right', position: { x: Math.round(sc.w * 0.5), y: Math.round(sc.h * 0.62) } });
    await page.getByRole('menuitem', { name: /Simgeleri Yönet/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Simgeleri yönet' });
    await dialog.waitFor();
    await page.waitForTimeout(700);
    for (const [kind, sel, text] of sc.steps || []) {
      if (kind === 'click') await dialog.locator(sel).first().click();
      if (kind === 'type') await dialog.locator(sel).first().fill(text);
      await page.waitForTimeout(350);
    }
    const checks = await page.evaluate(() => {
      const d = document.querySelector('[role=dialog][aria-label="Simgeleri yönet"]');
      const r = d.getBoundingClientRect();
      const list = d.querySelector('.dex-scroll');
      const overflowX = [...d.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth > 0).slice(0, 3).map((el) => el.tagName + '.' + String(el.className).slice(0, 40));
      return { fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, w: Math.round(r.width), h: Math.round(r.height), rows: d.querySelectorAll('[role=switch]').length, listScrolls: list ? list.scrollHeight > list.clientHeight : false, overflowX };
    });
    await page.screenshot({ path: path.join(OUT, `${sc.name}.png`) });
    const ok = checks.fits && !logs.length;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.name.padEnd(12)} ${JSON.stringify(checks)}${logs.length ? '\n     ' + logs.join('\n     ') : ''}`);
    await ctx.close();
  }
  await browser.close();
  process.exit(bad ? 1 : 0);
})();
