// Kullanım: node perf.cjs   (ORTAM: HARNESS_URL, PLAYWRIGHT_PATH, CHROME_PATH — snap.cjs ile aynı)
// 50 000 girdili klasörde: ilk satır süresi, DOM düğümü, kaydırma kare süreleri, sıralama→boyama. ÜRETİM derlemesiyle ölçün
// (vite build + statik sunum); dev sunucusunda sayılar kat kat kötüdür.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = process.env.HARNESS_URL || 'http://localhost:5199';
(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox'] });
  for (const view of ['list', 'grid']) {
    const page = await (await browser.newContext({ viewport: { width: 1120, height: 720 } })).newPage();
    await page.route('http://127.0.0.1:8710/api/fs/thumb**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#58a"/></svg>' }));
    const t0 = Date.now();
    await page.goto(`${BASE}/harness.html?w=1100&h=700&loc=big&view=${view}`);
    await page.waitForSelector('[data-index="0"]', { timeout: 20000 });
    const firstRow = Date.now() - t0;
    await page.waitForFunction(() => document.body.textContent.includes('50.000 öğe'), null, { timeout: 30000 });
    const full = Date.now() - t0;
    const nodes = await page.evaluate(() => document.querySelectorAll('[data-index]').length);
    // kaydırma: 120 kare boyunca scrollTop'u artır, kare sürelerini ölç
    const stats = await page.evaluate(async () => {
      const el = document.querySelector('[data-files-scroll]');
      const frames = [];
      let last = performance.now();
      const total = el.scrollHeight - el.clientHeight;
      await new Promise((resolve) => {
        let n = 0;
        const tick = (now) => {
          frames.push(now - last); last = now;
          el.scrollTop = (n / 240) * total;           // baştan sona 240 karede
          n += 1;
          if (n <= 240) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      frames.shift();
      frames.sort((a, b) => a - b);
      const p = (q) => frames[Math.min(frames.length - 1, Math.floor(frames.length * q))].toFixed(1);
      return { frames: frames.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: frames[frames.length - 1].toFixed(1), domNodes: document.querySelectorAll('[data-index]').length, scrollHeight: el.scrollHeight };
    });
    // sıralama değiştir (50k): süre
    const sortMs = await page.evaluate(async () => {
      const btn = [...document.querySelectorAll('[role=columnheader] button')].find((b) => b.textContent.includes('Boyut')) || document.querySelector('[aria-label="Sırala"]');
      const t = performance.now(); btn.click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return (performance.now() - t).toFixed(0);
    });
    console.log(JSON.stringify({ view, firstRowMs: firstRow, fullyLoadedMs: full, nodesAtRest: nodes, scroll: stats, sortClickToPaintMs: sortMs }));
    await page.context().close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
