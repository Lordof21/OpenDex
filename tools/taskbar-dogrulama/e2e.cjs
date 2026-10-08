// Görev çubuğu uçtan uca denetimi (gerçek Chromium, gerçek Taskbar + WindowPreview): node e2e.cjs   (önce ./run.sh)
//   ORTAM: HARNESS_URL (http://localhost:5200), PLAYWRIGHT_PATH, CHROME_PATH (ops.), OUT_DIR (ekran görüntüleri, ops.)
// Denetlenenler: alt çizgi/ikon hizası (2.+ uygulama dahil), aktif durum, Windows tıklama davranışı (düğme VE önizleme),
// önizleme: gerçek en-boy oranı, kırpılmama (dört kenar görünür), yüksek çözünürlük, sahte başlık yok, küçültülmüşken önbellekten, tooltip çakışması,
// Çalışma Alanı ikonu ve önizlemesi, gerçek uygulama ikonu (harf değil), konsol hatası yok.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.HARNESS_URL || 'http://localhost:5200';
const OUT = process.env.OUT_DIR || '';
let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
};

const ICON_SVG = (label) => `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="20" fill="#2a7"/><text x="48" y="64" font-size="46" text-anchor="middle" fill="#fff">${label}</text></svg>`;
const KNOWN = { 'com.google.android.youtube': 'Y', 'com.android.chrome': 'C', 'com.whatsapp': 'W', 'com.spotify.music': 'S' };

const winState = (page, id) => page.evaluate((i) => { const w = window.__ws.getState().windows.find((x) => x.id === i); return w && { minimized: !!w.minimized, focused: !!w.focused }; }, id);
const btn = (page, label) => page.locator(`nav button[aria-label^="${label}, açık"]`);

async function openPage(browser, query, { width = 1300, height = 520 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`.slice(0, 200)));
  await page.route('**/api/apps/icon-v2/**', (route) => {
    const pkg = decodeURIComponent(route.request().url().split('/icon-v2/')[1].split('?')[0]);
    if (!KNOWN[pkg]) return route.fulfill({ status: 404, body: '' }); // gerçek backend gibi: bilinmeyen paket → 404 → harf yedeği
    return route.fulfill({ contentType: 'image/svg+xml', body: ICON_SVG(KNOWN[pkg]) });
  });
  await page.goto(`${BASE}/harness.html?${query}`);
  await page.waitForSelector('nav[aria-label="DeX görev çubuğu"]');
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

const centers = (page) => page.evaluate(() => [...document.querySelectorAll('nav button[aria-label*=", açık"]')].map((b) => {
  const r = b.getBoundingClientRect();
  const line = [...b.querySelectorAll('span.absolute')].find((s) => s.className.includes('bottom-0.5'));
  const lr = line.getBoundingClientRect();
  const icon = b.querySelector('.app-icon, img, div[class*="rounded-"]')?.getBoundingClientRect();
  return { label: b.getAttribute('aria-label'), display: getComputedStyle(b).display, current: b.getAttribute('aria-current'), lineDx: Math.round(lr.left + lr.width / 2 - (r.left + r.width / 2)), lineW: Math.round(lr.width), iconDx: icon ? Math.round(icon.left + icon.width / 2 - (r.left + r.width / 2)) : null };
}));

// Önizleme tuvalinin dört kenarının "magenta çerçeve" pikselini taşıdığını doğrular (kare kırpılmadan tam çizildi).
const edgesIntact = (page) => page.evaluate(() => {
  const c = document.querySelector('[data-testid="window-preview-thumb"] canvas');
  const g = c.getContext('2d', { willReadFrequently: true });
  const px = (x, y) => [...g.getImageData(Math.max(0, Math.min(c.width - 1, x)), Math.max(0, Math.min(c.height - 1, y)), 1, 1).data];
  const mag = ([r, gg, b]) => r > 140 && gg < 120 && b > 140;
  const w = c.width; const h = c.height;
  return { w, h, top: mag(px(w >> 1, 1)), bottom: mag(px(w >> 1, h - 2)), left: mag(px(1, h >> 1)), right: mag(px(w - 2, h >> 1)) };
});

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox'] });
  let { ctx, page, errors } = await openPage(browser, 'w=1280&h=500&theme=light&wins=3&workspace=1');
  const shot = (name) => (OUT ? page.screenshot({ path: path.join(OUT, `${name}.png`) }) : null);
  if (OUT) fs.mkdirSync(OUT, { recursive: true });

  // ── 1. Alt çizgi ve ikon hizası: HER düğmede düğmenin tam ortasında ───────────────────────────────────────
  const rows = await centers(page);
  check(rows.length === 4, 'dört açık uygulama düğmesi (3 VD + Çalışma Alanı)', rows.map((r) => r.label).join(' | '));
  check(rows.every((r) => Math.abs(r.lineDx) <= 1), 'alt çizgi her düğmede tam ortada (2.+ uygulama dahil)', rows.map((r) => r.lineDx).join(','));
  check(rows.every((r) => r.iconDx === null || Math.abs(r.iconDx) <= 1), 'ikon her düğmede tam ortada', rows.map((r) => r.iconDx).join(','));
  check(rows.every((r) => r.display === 'flex'), 'tüm düğmeler aynı düzen kipinde (display ezilmiyor)');
  check(rows.filter((r) => r.current === 'true').length === 1 && rows[2].current === 'true', 'tam olarak bir düğme aktif: odaktaki pencere (WhatsApp)');
  check(rows[2].lineW === 16 && rows[0].lineW === 6, 'aktif pencerenin çizgisi geniş (16 px), diğerleri kısa (6 px)', `${rows[2].lineW}/${rows[0].lineW}`);

  // ── 2. Gerçek uygulama ikonları, Çalışma Alanı ikonu ───────────────────────────────────────────────────────
  check(await btn(page, 'YouTube').locator('img').evaluate((i) => i.complete && i.naturalWidth > 0), 'VD penceresi gerçek uygulama ikonunu gösteriyor (img yüklendi)');
  check(await btn(page, 'Çalışma Alanı').locator('[data-app-icon="workspace"] svg').count() === 1, 'Çalışma Alanı özel ikonla (harf değil) gösteriliyor');
  check(await btn(page, 'Çalışma Alanı').locator('[data-app-icon="workspace"]').evaluate((e) => getComputedStyle(e).backgroundImage.includes('gradient')), 'Çalışma Alanı ikonunun gradyan zemini var');

  // ── 3. Düğme tıklaması: Windows davranışı ──────────────────────────────────────────────────────────────────
  await btn(page, 'WhatsApp').click();
  await page.waitForTimeout(200);
  check((await winState(page, 'win-3')).minimized === true, 'ön plandaki pencerenin düğmesine basınca KÜÇÜLÜR');
  await page.mouse.move(10, 10);
  await btn(page, 'WhatsApp').click();
  await page.waitForTimeout(200);
  let w3 = await winState(page, 'win-3');
  check(!w3.minimized && w3.focused, 'küçültülmüş pencerenin düğmesine basınca GERİ YÜKLENİR ve odaklanır');
  await btn(page, 'Chrome').click();
  await page.waitForTimeout(200);
  const w2 = await winState(page, 'win-2');
  const w3b = await winState(page, 'win-3');
  check(w2.focused && !w2.minimized && !w3b.focused && !w3b.minimized, 'arkada kalan açık pencerenin düğmesine basınca ÖNE GELİR (küçülmez)');
  check((await centers(page))[1].current === 'true', 'aktiflik göstergesi odakla birlikte taşındı');

  // ── 4. Önizleme: tam kare, gerçek oran, yüksek çözünürlük, başlıksız ──────────────────────────────────────
  await page.mouse.move(10, 10);
  await btn(page, 'Chrome').hover();
  await page.locator('[data-testid="window-preview-thumb"]').waitFor();
  await page.waitForTimeout(500);
  let thumb = await page.locator('[data-testid="window-preview-thumb"]').boundingBox();
  check(Math.abs(thumb.width / thumb.height - 1920 / 1080) < 0.02, 'yatay pencere önizlemesi 16:9 oranında', `${thumb.width}×${thumb.height}`);
  check(thumb.width >= 280, 'önizleme büyük (≥ 280 px)', `${thumb.width}px`);
  let e = await edgesIntact(page);
  check(e.top && e.bottom && e.left && e.right, 'yatay önizlemede karenin dört kenarı da görünür (kırpılmadı)', JSON.stringify(e));
  check(e.w >= thumb.width * 2 - 1, 'tuval ekran pikselinde çiziliyor (CSS boyutu × devicePixelRatio)', `${e.w}px için ${thumb.width} CSS px`);
  check(await page.locator('[role="region"], section').locator('.bg-window-close\\/80, .bg-window-minimize\\/80, .bg-window-expand\\/80').count() === 0, 'sahte pencere başlığı (üç nokta) yok');
  check(await btn(page, 'Chrome').getAttribute('data-tooltip') === null, 'önizleme açıkken düğmenin tooltip\'i gizli (çakışma yok)');
  check(/Chrome: (Küçült|Öne getir|Geri yükle)/.test(await page.locator('[data-testid="window-preview-thumb"]').getAttribute('aria-label')), 'önizleme düğmesi eylemini söylüyor', await page.locator('[data-testid="window-preview-thumb"]').getAttribute('aria-label'));
  await shot('onizleme-yatay');

  await btn(page, 'YouTube').hover();
  await page.waitForTimeout(600);
  thumb = await page.locator('[data-testid="window-preview-thumb"]').boundingBox();
  check(Math.abs(thumb.width / thumb.height - 1080 / 2400) < 0.02, 'dikey (telefon) pencere önizlemesi dar-uzun, oranı korunmuş', `${thumb.width}×${thumb.height}`);
  check(thumb.height >= 200, 'dikey önizleme yeterince uzun (≥ 200 px)', `${thumb.height}px`);
  e = await edgesIntact(page);
  check(e.top && e.bottom && e.left && e.right, 'dikey önizlemede de dört kenar görünür: yalnız "baş" değil TAM ekran', JSON.stringify(e));
  await shot('onizleme-dikey');

  // ── 5. Önizlemeye tıklama = düğmeyle aynı eylem ────────────────────────────────────────────────────────────
  await page.locator('[data-testid="window-preview-thumb"]').click(); // YouTube arkada → öne gelir
  await page.waitForTimeout(250);
  let w1 = await winState(page, 'win-1');
  check(w1.focused && !w1.minimized, 'arkadaki pencerenin önizlemesine basınca ÖNE GELİR');
  check(await page.locator('[data-testid="window-preview-thumb"]').count() === 0, 'önizlemeye basınca kart kapanır');
  await page.mouse.move(10, 10);
  await btn(page, 'YouTube').hover();
  await page.waitForTimeout(500);
  await page.locator('[data-testid="window-preview-thumb"]').click(); // artık aktif → küçülür
  await page.waitForTimeout(250);
  w1 = await winState(page, 'win-1');
  check(w1.minimized && !w1.focused, 'ÖN PLANDAKİ pencerenin önizlemesine basınca KÜÇÜLÜR (eskiden hiçbir şey olmuyordu)');

  await page.mouse.move(10, 10);
  await btn(page, 'YouTube').hover();
  await page.waitForTimeout(600);
  check((await page.getByText('Küçültüldü').count()) === 1, 'küçültülmüş pencerenin kartında "Küçültüldü" yazıyor');
  e = await edgesIntact(page);
  check(e.top && e.bottom && e.left && e.right, 'küçültülmüş pencere önbellekteki SON KARE ile (tam, kırpılmadan) önizleniyor', JSON.stringify(e));
  await shot('onizleme-kucultulmus');
  await page.locator('[data-testid="window-preview-thumb"]').click();
  await page.waitForTimeout(250);
  w1 = await winState(page, 'win-1');
  check(!w1.minimized && w1.focused, 'küçültülmüş pencerenin önizlemesine basınca GERİ YÜKLENİR');

  // ── 6. Çalışma Alanı: ikon + önizleme + tıklama ────────────────────────────────────────────────────────────
  await page.mouse.move(10, 10);
  await btn(page, 'Çalışma Alanı').hover();
  await page.locator('[data-testid="window-preview-thumb"]').waitFor();
  await page.waitForTimeout(600);
  e = await edgesIntact(page);
  check(e.top && e.bottom && e.left && e.right, 'Çalışma Alanı önizlemesi VD akışının tam karesini gösteriyor', JSON.stringify(e));
  check(await page.locator('section [data-app-icon="workspace"]').count() >= 1, 'Çalışma Alanı kartının başlığında özel ikon var');
  await shot('onizleme-calisma-alani');
  await page.locator('[data-testid="window-preview-thumb"]').click();
  await page.waitForTimeout(250);
  check((await winState(page, 'eco-workspace')).focused, 'Çalışma Alanı önizlemesine basınca öne gelir');

  // ── 7. Önizleme kapat (X) ──────────────────────────────────────────────────────────────────────────────────
  await page.mouse.move(10, 10);
  await btn(page, 'Chrome').hover();
  await page.getByRole('button', { name: 'Chrome uygulamasını kapat' }).click();
  await page.waitForTimeout(250);
  check(!(await page.evaluate(() => window.__ws.getState().windows.some((w) => w.id === 'win-2'))), 'önizlemedeki X pencereyi kapatır');

  check(errors.length === 0, 'konsolda hata yok', errors.slice(0, 3).join(' | '));
  await ctx.close();

  // ── 8. Dar ekran: görünürlük sınıfları düzeni bozmaz ───────────────────────────────────────────────────────
  ({ ctx, page, errors } = await openPage(browser, 'w=700&h=400&theme=dark&wins=4&workspace=1', { width: 740, height: 440 }));
  const narrow = await page.evaluate(() => [...document.querySelectorAll('nav button[aria-label*=", açık"]')].map((b) => {
    const r = b.getBoundingClientRect();
    const line = [...b.querySelectorAll('span.absolute')].find((s) => s.className.includes('bottom-0.5'));
    const lr = line.getBoundingClientRect();
    return { label: b.getAttribute('aria-label'), shown: getComputedStyle(b).display !== 'none', dx: Math.round(lr.left + lr.width / 2 - (r.left + r.width / 2)) };
  }));
  const shown = narrow.filter((r) => r.shown);
  check(shown.length >= 2 && shown.length < narrow.length, '700 px genişlikte yalnız ilk uygulamalar görünür (4. sıradan sonrası gizli)', `${shown.length}/${narrow.length}`);
  check(shown.every((r) => Math.abs(r.dx) <= 1), 'dar ekranda da görünen her düğmenin çizgisi ortalı');
  await page.screenshot(OUT ? { path: path.join(OUT, 'dar-koyu.png') } : {});
  check(errors.length === 0, 'dar ekranda konsolda hata yok', errors.slice(0, 3).join(' | '));
  await ctx.close();

  await browser.close();
  console.log(failed ? `\n${failed} denetim BAŞARISIZ` : '\nTüm denetimler geçti');
  process.exit(failed ? 1 : 0);
})();
