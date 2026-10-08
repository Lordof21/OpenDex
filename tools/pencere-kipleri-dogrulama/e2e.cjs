// Pencere kipleri uçtan uca denetimi (gerçek Chromium, gerçek WindowFrame + TitleBar + Hub + Taskbar): node e2e.cjs   (önce ./run.sh)
//   ORTAM: HARNESS_URL (http://localhost:5201), PLAYWRIGHT_PATH, CHROME_PATH (ops.), OUT_DIR (ekran görüntüleri, ops.)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = process.env.HARNESS_URL || 'http://localhost:5201';
const OUT = process.env.OUT_DIR || '';
let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
};

const VIEW = { width: 1280, height: 720 };
const TASKBAR = 50;

async function open(browser, query = '') {
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`.slice(0, 200)));
  await page.goto(`${BASE}/harness.html?${query}`);
  await page.waitForSelector('[data-window-frame-id]');
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}

const state = (page, id = 'win-1') => page.evaluate((i) => {
  const w = window.__ws.getState().windows.find((x) => x.id === i);
  return w && { maximized: !!w.maximized, fullscreen: !!w.fullscreen, snapZone: w.snapZone || null, x: w.x, y: w.y, w: w.w, h: w.h, pending: !!w.pendingResizeTransition, stack: (w.modeStack || []).map((e) => e.mode) };
}, id);
const frame = (page, id = 'win-1') => page.evaluate((i) => {
  const r = document.querySelector(`[data-window-frame-id="${i}"]`).getBoundingClientRect();
  return { left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10, right: Math.round(r.right * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
}, id);
const taskbar = (page) => page.evaluate(() => {
  const nav = document.querySelector('nav[aria-label="DeX görev çubuğu"]');
  const host = nav?.parentElement;
  const visible = !!host && getComputedStyle(host).display !== 'none';
  const r = nav.getBoundingClientRect();
  return { visible, top: Math.round(r.top * 10) / 10, height: Math.round(r.height * 10) / 10 };
});
const calls = (page, kind) => page.evaluate((k) => window.__calls.filter((c) => c[0] === k).map((c) => c[1]), kind);

const maximizeBtn = (page) => page.locator('button[aria-label="Ekranı kapla"], button[aria-label="Önceki boyut"]').first();
const clickMaximize = async (page) => { await revealHeader(page); await maximizeBtn(page).click(); };
// Tam ekranda başlık kendiliğinden gizlenir (isHeaderHidden): imleci üst şeride götürünce kayarak iner — kullanıcı da böyle yapar.
const revealHeader = async (page) => { await page.mouse.move(640, 1); await page.waitForTimeout(450); };
const openHub = async (page) => { await revealHeader(page); await page.locator('button[aria-label="Pencere Hub ayarları"]').click(); await page.waitForSelector('[role="dialog"][aria-label="Pencere Hub\'ı"]'); };
const hubTile = (page, name) => page.locator(`[role="dialog"][aria-label="Pencere Hub'ı"] button[aria-label^="${name}"]`);
const settle = (page, ms = 1400) => page.waitForTimeout(ms);
const exactlyOneMode = (s) => [s.maximized, s.fullscreen, !!s.snapZone].filter(Boolean).length <= 1;

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox'] });

  // ── 1. Ekranı kapla: görev çubuğunun üstünde biter, altına sarkmaz ─────────────────────────────────────────
  {
    const { ctx, page, errors } = await open(browser);
    await clickMaximize(page);
    await settle(page);
    const s = await state(page); const f = await frame(page); const t = await taskbar(page);
    check(s.maximized && !s.fullscreen, 'kapla: yalnız maximized bayrağı', JSON.stringify(s));
    check(t.visible && t.height === TASKBAR, 'görev çubuğu görünür, 50 px', JSON.stringify(t));
    check(f.top === 0 && f.left === 0 && f.w === VIEW.width, 'kapla: sol-üst köşede, tam genişlik', JSON.stringify(f));
    check(f.bottom <= t.top + 0.5, 'kapla: görev çubuğunun ALTINA SARKMAZ', `pencere alt=${f.bottom} görev çubuğu üst=${t.top}`);
    check(f.bottom >= t.top - 1.5, 'kapla: görev çubuğuna kadar uzanır (boşluk yok)', `fark=${(t.top - f.bottom).toFixed(1)}`);
    if (OUT) await page.screenshot({ path: `${OUT}/kapla.png` });
    check(errors.length === 0, 'konsolda hata yok (kapla)', errors.join(' | '));
    await ctx.close();
  }

  // ── 2. Hub tam ekran → başlıktan kapla: iki bayrak birlikte AÇIK KALMAZ ────────────────────────────────────
  for (const dynamic of [1, 0]) {
    const { ctx, page, errors } = await open(browser, `dynamic=${dynamic}`);
    const tag = dynamic ? 'dinamik' : 'statik';
    await openHub(page);
    await hubTile(page, 'Tam ekran').click();
    await settle(page);
    let s = await state(page); let f = await frame(page); let t = await taskbar(page);
    check(s.fullscreen && !s.maximized, `[${tag}] Hub tam ekran: yalnız fullscreen`, JSON.stringify(s));
    check(f.w === VIEW.width && f.h === VIEW.height && f.top === 0, `[${tag}] tam ekran: görüntü alanının TAMAMI`, JSON.stringify(f));
    check(!t.visible, `[${tag}] tam ekranda görev çubuğu gizli`);

    await page.keyboard.press('Escape'); // Hub'ı kapat
    await clickMaximize(page); // tam ekrandayken başlıktaki "Ekranı kapla"
    await settle(page);
    s = await state(page); f = await frame(page); t = await taskbar(page);
    check(s.maximized && !s.fullscreen, `[${tag}] tam ekran → kapla: fullscreen KAPANIR, yalnız maximized`, JSON.stringify(s));
    check(t.visible, `[${tag}] kaplayınca görev çubuğu geri gelir`);
    check(f.bottom <= t.top + 0.5 && f.bottom >= t.top - 1.5, `[${tag}] kaplanmış pencere görev çubuğuna oturur`, `alt=${f.bottom} üst=${t.top}`);

    await clickMaximize(page); // "Önceki boyut"
    await settle(page);
    s = await state(page); f = await frame(page);
    check(!s.maximized && !s.fullscreen && !s.snapZone, `[${tag}] önceki boyuta dönüş: hiçbir kip açık değil`, JSON.stringify(s));
    check(Math.abs(f.w - 640) <= 2 && Math.abs(f.h - 440) <= 2, `[${tag}] eski kutu geri geldi`, JSON.stringify(f));
    check(errors.length === 0, `[${tag}] konsolda hata yok`, errors.join(' | '));
    await ctx.close();
  }

  // ── 3. Hızlı art arda kip değişimi (bekleme yok): sonunda TEK tutarlı kip ve doğru kutu ─────────────────────
  for (const [name, steps] of [
    ['kapla → tam ekran → kapla', ['max', 'full', 'max']],
    ['tam ekran → kapla → tam ekran', ['full', 'max', 'full']],
    ['kapla → kapla (çift tık hızı)', ['max', 'max']],
    ['tam ekran → tam ekran', ['full', 'full']],
  ]) {
    const { ctx, page, errors } = await open(browser);
    for (const step of steps) {
      if (step === 'max') await clickMaximize(page);
      else { await openHub(page); await hubTile(page, 'Tam ekran').click(); await page.keyboard.press('Escape'); }
      await page.waitForTimeout(40);
    }
    await settle(page, 2200);
    const s = await state(page); const f = await frame(page); const t = await taskbar(page);
    const expectMax = steps.filter((x) => x === 'max').length % 2 === 1 && steps[steps.length - 1] === 'max';
    check(exactlyOneMode(s), `hızlı [${name}]: aynı anda iki kip AÇIK DEĞİL`, JSON.stringify(s));
    check(!s.pending, `hızlı [${name}]: bekleyen geçiş kalmadı`, JSON.stringify(s));
    const lastMode = s.fullscreen ? 'full' : s.maximized ? 'max' : 'normal';
    const geomOk = lastMode === 'full' ? (f.w === VIEW.width && f.h === VIEW.height)
      : lastMode === 'max' ? (f.w === VIEW.width && f.bottom <= t.top + 0.5 && f.bottom >= t.top - 1.5)
        : (Math.abs(f.w - 640) <= 2);
    check(geomOk, `hızlı [${name}]: kutu son kipe uyar (${lastMode})`, `${JSON.stringify(f)} görev çubuğu üst=${t.top}`);
    check(t.visible === (lastMode !== 'full'), `hızlı [${name}]: görev çubuğu kipe uyar`);
    void expectMax;
    check(errors.length === 0, `hızlı [${name}]: konsolda hata yok`, errors.join(' | '));
    await ctx.close();
  }

  // ── 4. Hub "Ekran kilidi": akışın px+DPI'ı sabit, React penceresi SERBEST (en-boy oranı kilitlenmez) ──────────
  {
    const dragSE = async (page, dx, dy) => {
      const c = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[role="separator"]')].find((e) => e.className.includes('-bottom-1.5') && e.className.includes('-right-1.5'));
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await page.mouse.move(c.x + dx / 2, c.y + dy / 2, { steps: 4 });
      await page.mouse.move(c.x + dx, c.y + dy, { steps: 4 });
      await page.mouse.up();
      await settle(page, 1200);
    };
    const resizes = (page) => calls(page, 'resize');

    // Karşılaştırma: kilitsiz pencerede boyutlandırma akışı yeniden müzakere eder.
    {
      const { ctx, page } = await open(browser);
      await dragSE(page, 200, 60);
      check((await resizes(page)).length >= 1, 'kilitsiz: boyutlandırma akış çözünürlüğü ister (karşılaştırma)');
      await ctx.close();
    }

    const { ctx, page, errors } = await open(browser);
    await openHub(page);
    const tile = hubTile(page, 'Ekran serbest');
    check(await tile.count() === 1, 'Hub: "Ekran serbest" düğmesi var (eski "Oran kilitli/Serbest boy" yerine)');
    check(await page.locator('[role="dialog"][aria-label="Pencere Hub\'ı"] button[aria-label^="Oran kilitli"], [role="dialog"][aria-label="Pencere Hub\'ı"] button[aria-label^="Serbest boy"]').count() === 0, 'Hub: eski en-boy kilidi düğmesi yok');
    await tile.click();
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__ws.getState().windows[0].resolutionLocked === true), 'kilit: resolutionLocked açıldı');
    check(await hubTile(page, 'Ekran kilitli').count() === 1, 'Hub: düğme "Ekran kilitli" oldu');
    check(await page.locator('[data-testid="display-lock-hint"]').count() === 1, 'Hub: kilit açıklaması görünür');
    await page.keyboard.press('Escape');

    const before = await frame(page);
    await dragSE(page, 260, -140);
    const after = await frame(page);
    // (Yükseklik asgari boyutta durabilir: 440 → 300 istendi, 320'ye oturdu.) Ölçüt: genişlik imleci izledi ve oran serbestçe değişti.
    check(Math.abs(after.w - (before.w + 260)) <= 3 && after.h < before.h && Math.abs(after.w / after.h - before.w / before.h) > 0.5, 'kilitli: pencere SERBEST boyutlanır (en-boy oranı korunmaz)', `önce ${before.w}×${before.h} → sonra ${after.w}×${after.h}`);
    check((await resizes(page)).length === 0, 'kilitli: boyutlandırma akış çözünürlüğü İSTEMEZ (px+DPI sabit)', JSON.stringify(await resizes(page)));

    await clickMaximize(page);
    await settle(page);
    const s = await state(page);
    check(s.maximized && (await resizes(page)).length === 0, 'kilitli: ekranı kapla da akışı değiştirmez', JSON.stringify(s));
    check(errors.length === 0, 'konsolda hata yok (kilit)', errors.join(' | '));
    await ctx.close();
  }

  await browser.close();
  console.log(failed ? `\n${failed} denetim BAŞARISIZ` : '\nTüm denetimler geçti');
  process.exit(failed ? 1 : 0);
})();
