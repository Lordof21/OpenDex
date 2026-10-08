// Kullanım: node snap.cjs [sahne-adı-parçası]   (önce ./run.sh)
//   ORTAM: HARNESS_URL (http://localhost:5199), OUT_DIR (./shots), PLAYWRIGHT_PATH (playwright), CHROME_PATH (ops.)
// Sahneler: varsayılan kapak (açık/koyu), tüm hazır kapakların kontak sayfası + ÖLÇÜLEN parlaklık, diyalog sekmeleri (galeri, resimlerim —
// gerçek işleme hattıyla üretilen resimlerle —, renkler), yerleşim modları, bulanıklık/karartma, dar ve kısa pencere.
// Her sahne konsol hatası ve diyalogun ekrana sığması denetlenir; yalnız görüntü almaz.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.HARNESS_URL || 'http://localhost:5199';
const OUT = process.env.OUT_DIR || path.join(process.cwd(), 'shots');
fs.mkdirSync(OUT, { recursive: true });

/** Sayfada üretilen deneme resimleri (fotoğraf benzeri): büyük yatay (4K'dan büyük), dikey, küçük döşemelik, aydınlık. */
const IMAGES = [
  { name: 'Dağ gün batımı', w: 5200, h: 2925, hue: 20, dark: true },
  { name: 'Dikey portre', w: 1080, h: 1920, hue: 210, dark: true },
  { name: 'Küçük desen', w: 320, h: 180, hue: 130, dark: false },
  { name: 'Aydınlık plaj', w: 2560, h: 1440, hue: 190, dark: false },
];

async function makePng(page, spec) {
  const dataUrl = await page.evaluate(({ w, h, hue, dark }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, `hsl(${hue} 70% ${dark ? 18 : 80}%)`);
    sky.addColorStop(1, `hsl(${(hue + 40) % 360} 80% ${dark ? 48 : 92}%)`);
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = `hsl(${(hue + 20) % 360} 90% ${dark ? 70 : 96}%)`;
    g.beginPath(); g.arc(w * 0.7, h * 0.35, Math.min(w, h) * 0.12, 0, 7); g.fill();
    for (let i = 0; i < 3; i += 1) {
      g.fillStyle = `hsl(${hue} 40% ${dark ? 10 + i * 6 : 55 - i * 8}%)`;
      g.beginPath(); g.moveTo(0, h);
      for (let x = 0; x <= w; x += w / 14) g.lineTo(x, h * (0.62 + i * 0.1) - Math.sin(x / w * 9 + i) * h * 0.07 * (i + 1));
      g.lineTo(w, h); g.closePath(); g.fill();
    }
    g.fillStyle = '#fff'; g.font = `${Math.round(h / 12)}px sans-serif`; g.fillText('OpenDeX', w * 0.04, h * 0.1); // yerleşim kırpmasını gösterir
    g.strokeStyle = '#f0f'; g.lineWidth = Math.max(2, w / 400); g.strokeRect(2, 2, w - 4, h - 4);
    return c.toDataURL('image/png');
  }, spec);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const lumaCheck = (page) =>
  page.evaluate(async () => {
    const out = [];
    for (const fig of document.querySelectorAll('[data-contact]')) {
      const id = fig.getAttribute('data-contact');
      const el = fig.querySelector('[data-art]');
      out.push({ id, rect: el.getBoundingClientRect().toJSON(), caption: fig.querySelector('figcaption').textContent });
    }
    return out;
  });

async function measure(page, rect) {
  const png = await page.screenshot({ clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 40; c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, 40, 24);
    const d = g.getImageData(0, 0, 40, 24).data;
    const luma = (i) => (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    let sum = 0; let min = 1; let max = 0;
    for (let i = 0; i < d.length; i += 4) { const l = luma(i); sum += l; min = Math.min(min, l); max = Math.max(max, l); }
    return { mean: sum / (d.length / 4), min, max };
  }, png.toString('base64'));
}

const openDialog = async (page, sc) => {
  await page.locator('main[aria-label="DeX Masaüstü"]').click({ button: 'right', position: { x: Math.round(sc.w * 0.5), y: Math.round(sc.h * 0.62) } });
  await page.getByRole('menuitem', { name: /Arka planı değiştir/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Arka plan' });
  await dialog.waitFor();
  await page.waitForTimeout(500);
  return dialog;
};

const addImages = async (page, dialog, which) => {
  await dialog.getByRole('radio', { name: /Resimlerim/ }).click();
  const files = [];
  for (const spec of which) files.push({ name: `${spec.name}.png`, mimeType: 'image/png', buffer: await makePng(page, spec) });
  await dialog.getByTestId('wallpaper-file-input').setInputFiles(files);
  await dialog.getByRole('option', { name: which[which.length - 1].name }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
};

const SCENES = [
  { name: 'varsayilan-acik', w: 1280, h: 760, params: 'theme=light' },
  { name: 'varsayilan-koyu', w: 1280, h: 760, params: 'theme=dark' },
  { name: 'kontak-acik', w: 1280, h: 900, params: 'theme=light&contact=1', contact: true },
  { name: 'kontak-koyu', w: 1280, h: 900, params: 'theme=dark&contact=1', contact: true },
  { name: 'dialog-galeri-acik', w: 1280, h: 760, params: 'theme=light', dialog: true },
  { name: 'dialog-galeri-koyu', w: 1280, h: 760, params: 'theme=dark', dialog: true },
  { name: 'dialog-manzara', w: 1280, h: 760, params: 'theme=light', dialog: true, steps: [['click', '[role=radio]:has-text("Manzara")'], ['click', '[role=option][aria-label="Okyanus"]']] },
  { name: 'dialog-resimlerim', w: 1280, h: 760, params: 'theme=light', dialog: true, images: [0, 1, 2, 3] },
  { name: 'dialog-resimlerim-koyu', w: 1280, h: 760, params: 'theme=dark', dialog: true, images: [0, 1, 2, 3] },
  { name: 'dialog-yerlesim-sigdir', w: 1280, h: 760, params: 'theme=light', dialog: true, images: [1], steps: [['click', '[role=radio]:has-text("Sığdır")']] },
  { name: 'dialog-renkler', w: 1280, h: 760, params: 'theme=light', dialog: true, steps: [['click', '[role=radio]:has-text("Renkler")'], ['click', '[role=option][aria-label="Renk #2f6fe0"]']] },
  { name: 'dialog-slayt', w: 1280, h: 760, params: 'theme=light', dialog: true, steps: [['click', '[role=switch][aria-label="Slayt gösterisi"]']] },
  { name: 'dialog-dar', w: 420, h: 760, params: 'theme=light', dialog: true },
  { name: 'dialog-kisa', w: 900, h: 480, params: 'theme=light', dialog: true },
  { name: 'masaustu-resim-bulanik', w: 1280, h: 760, params: 'theme=light', dialog: true, images: [0], close: true, steps: [['set', 'blur', 14], ['set', 'dim', 30]] },
  { name: 'masaustu-resim-yerlesim-doldur', w: 1280, h: 760, params: 'theme=light', dialog: true, images: [1], close: true },
  { name: 'masaustu-aydinlik-resim', w: 1280, h: 760, params: 'theme=light', dialog: true, images: [3], close: true },
  { name: 'masaustu-duz-renk-koyu', w: 1280, h: 760, params: 'theme=light', dialog: true, close: true, steps: [['click', '[role=radio]:has-text("Renkler")'], ['click', '[role=option][aria-label="Renk #202226"]']] },
  { name: 'masaustu-duz-kapak', w: 1280, h: 760, params: 'theme=light&prefs=' + encodeURIComponent(JSON.stringify({ mode: 'builtin', id: 'plain' })) },
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
    let extra = '';
    if (sc.contact) {
      await page.waitForSelector('[data-contact]');
      await page.waitForTimeout(500);
      const cells = await lumaCheck(page);
      const rows = [];
      for (const cell of cells) {
        const m = await measure(page, cell.rect);
        const declared = Number(cell.caption.match(/luma ([\d.]+)/)[1]);
        const off = Math.abs(m.mean - declared);
        rows.push(`${cell.id.padEnd(10)} bildirilen ${declared.toFixed(2)}  ölçülen ${m.mean.toFixed(2)} [${m.min.toFixed(2)}–${m.max.toFixed(2)}]${off > 0.12 ? '  ← FARK' : ''}${(declared < 0.5 ? m.max > 0.75 : m.min < 0.3) ? '  ← KARIŞIK PARLAKLIK' : ''}`);
      }
      extra = `\n     ${rows.join('\n     ')}`;
      await page.screenshot({ path: path.join(OUT, `${sc.name}.png`), fullPage: true });
      console.log(`ok   ${sc.name}${extra}`);
      await ctx.close();
      continue;
    }
    await page.waitForSelector('main[aria-label="DeX Masaüstü"]');
    await page.waitForTimeout(1500);
    let checks = {};
    if (sc.dialog) {
      const dialog = await openDialog(page, sc);
      if (sc.images) await addImages(page, dialog, sc.images.map((i) => IMAGES[i]));
      for (const [kind, sel, val] of sc.steps || []) {
        if (kind === 'click') await dialog.locator(sel).first().click();
        if (kind === 'set') await page.evaluate(([k, v]) => window.__wp.getState()[k === 'blur' ? 'setBlur' : 'setDim'](v), [sel, val]);
        await page.waitForTimeout(450);
      }
      if (sc.close) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(900);
      } else {
        await page.waitForTimeout(500);
        checks = await page.evaluate(() => {
          const d = document.querySelector('[role=dialog][aria-label="Arka plan"]');
          const r = d.getBoundingClientRect();
          return { fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, w: Math.round(r.width), h: Math.round(r.height), options: d.querySelectorAll('[role=option]').length };
        });
      }
    } else {
      await page.waitForTimeout(800);
    }
    await page.screenshot({ path: path.join(OUT, `${sc.name}.png`) });
    const ok = (checks.fits ?? true) && !logs.length;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${sc.name.padEnd(30)} ${JSON.stringify(checks)}${logs.length ? '\n     ' + logs.join('\n     ') : ''}`);
    await ctx.close();
  }
  await browser.close();
  process.exit(bad ? 1 : 0);
})();
