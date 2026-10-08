// Kullanım: node snap.cjs [scenes.json] [sahne-adı-parçası]
//   ORTAM: HARNESS_URL (varsayılan http://localhost:5199), OUT_DIR (varsayılan ./shots),
//          PLAYWRIGHT_PATH (playwright paket yolu; varsayılan 'playwright'), CHROME_PATH (Chromium yürütülebilir; ops.)
// Önce `./run.sh` ile harness'ı başlatın. Sahne: {name,w,h,params,steps:[...],touch?,wait?}
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.HARNESS_URL || 'http://localhost:5199';
const OUT = process.env.OUT_DIR || path.join(process.cwd(), 'shots');
const FIXTURES = process.env.FIXTURES_DIR || path.join(__dirname, '..', '..', '..', 'frontend', 'harness-fixtures');   // run.sh'ın ürettiği belgeler/ses
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const only = process.argv[3];
  const scenes = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, 'scenes.json'), 'utf8')).filter((sc) => !only || sc.name.includes(only));
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox'] });
  for (const sc of scenes) {
    const ctx = await browser.newContext({ viewport: { width: sc.w + 20, height: sc.h + 20 }, deviceScaleFactor: sc.dpr || 1, hasTouch: Boolean(sc.touch) });
    const page = await ctx.newPage();
    const logs = [];
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)); });
    page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`.slice(0, 300)));
    await page.route('http://127.0.0.1:8710/api/fs/content**', (r) => {
      const name = decodeURIComponent(new URL(r.request().url()).searchParams.get('path') || '').split('/').pop();
      const fixture = path.join(FIXTURES, name);
      if (/\.(wav|webm)$/i.test(name) && fs.existsSync(fixture)) return r.fulfill({ status: 200, contentType: /wav$/i.test(name) ? 'audio/wav' : 'video/webm', body: fs.readFileSync(fixture) });
      return r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82c4"/><stop offset="1" stop-color="#e0a458"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="900" cy="200" r="90" fill="#fff8"/><path d="M0 640 L360 330 L620 560 L820 400 L1200 650 V800 H0Z" fill="#0006"/></svg>' });
    });
    await page.goto(`${BASE}/harness.html?w=${sc.w}&h=${sc.h}&${sc.params || ''}`);
    await page.waitForTimeout(sc.wait ?? 1500);
    for (const st of sc.steps || []) {
      if (st.type === 'click') await page.click(st.sel, { button: st.button || 'left', modifiers: st.mods || [], position: st.pos, clickCount: st.count || 1 });
      else if (st.type === 'press') await page.keyboard.press(st.key);
      else if (st.type === 'type') await page.keyboard.type(st.text);
      else if (st.type === 'hover') await page.hover(st.sel);
      else if (st.type === 'wait') await page.waitForTimeout(st.ms);
      else if (st.type === 'eval') await page.evaluate(st.code);
      else if (st.type === 'drag') { await page.mouse.move(st.x1, st.y1); await page.mouse.down(); await page.mouse.move(st.x2, st.y2, { steps: 12 }); if (st.hold) await page.waitForTimeout(st.hold); else await page.mouse.up(); }
      else if (st.type === 'wheel') await page.mouse.wheel(0, st.dy);
      await page.waitForTimeout(st.after ?? 150);
    }
    const out = path.join(OUT, `${sc.name}.png`);
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: sc.w + 20, height: sc.h + 20 } });
    console.log(sc.name, logs.length ? `\n  ${logs.join('\n  ')}` : 'ok');
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
