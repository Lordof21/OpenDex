// Uçtan uca davranış denetimi (gerçek Chromium + gerçek IndexedDB/Canvas): node e2e.cjs   (önce ./run.sh)
//   ORTAM: HARNESS_URL (http://localhost:5199), PLAYWRIGHT_PATH, CHROME_PATH (ops.)
// Denetlenenler: sağ tık akışı, kalıcılık (yeniden yükleme), resim içe aktarma (4K küçültme, WebP, önizleme, IndexedDB), sil/geri al,
// klavye (gerçek düzende yukarı/aşağı), çapraz geçiş, yazı tonu, slayt gösterisi (sahte saat), sürükle-bırak, yapıştır, hata mesajları.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = process.env.HARNESS_URL || 'http://localhost:5199';
let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `  ${detail}` : ''}`);
};

const url = (extra = '') => `${BASE}/harness.html?w=1280&h=760&theme=light${extra}`;
const layerKey = (page) => page.locator('[data-wallpaper]').first().getAttribute('data-wallpaper');
const inkColor = (page) => page.locator('.desktop-ink').first().evaluate((el) => getComputedStyle(el).color);

async function png(page, w, h, hue = 200) {
  const dataUrl = await page.evaluate(({ w, h, hue }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = `hsl(${hue} 70% 40%)`; g.fillRect(0, 0, w, h);
    g.fillStyle = `hsl(${hue + 60} 80% 70%)`; g.fillRect(w * 0.25, h * 0.25, w * 0.5, h * 0.5);
    return c.toDataURL('image/png');
  }, { w, h, hue });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function openDialog(page) {
  await page.locator('main[aria-label="DeX Masaüstü"]').click({ button: 'right', position: { x: 640, y: 470 } });
  await page.getByRole('menuitem', { name: /Arka planı değiştir/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Arka plan' });
  await dialog.waitFor();
  await page.waitForTimeout(400);
  return dialog;
}

const idbDump = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('opendex-wallpapers');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['meta', 'blobs']);
          const metas = tx.objectStore('meta').getAll();
          const keys = tx.objectStore('blobs').getAllKeys();
          tx.oncomplete = () => resolve({ metas: metas.result, blobKeys: keys.result });
        };
        open.onerror = () => resolve(null);
      }),
  );

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 790 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`.slice(0, 200)));

  // ── 1. Varsayılan, sağ tık menüsü, kapak seçimi, kalıcılık ─────────────────────────────────────────────────
  await page.goto(url());
  await page.waitForSelector('main[aria-label="DeX Masaüstü"]');
  await page.waitForTimeout(800);
  check((await layerKey(page)) === 'builtin:flow:light', 'ilk açılışta varsayılan kapak: Akış (açık)');
  check(/rgba?\(18, 20, 26/.test(await inkColor(page)), 'açık kapakta simge adları koyu', await inkColor(page));

  await page.locator('main[aria-label="DeX Masaüstü"]').click({ button: 'right', position: { x: 640, y: 470 } });
  const menu = page.getByRole('menu', { name: 'Masaüstü menüsü' });
  check(await menu.getByRole('menuitem', { name: /Arka planı değiştir/ }).isVisible(), 'sağ tık menüsünde "Arka planı değiştir…"');
  check(await menu.getByRole('menuitem', { name: /Rastgele arka plan/ }).isVisible(), 'sağ tık menüsünde "Rastgele arka plan"');
  await page.keyboard.press('Escape');
  await page.mouse.click(700, 300);

  let dialog = await openDialog(page);
  await dialog.getByRole('option', { name: 'Okyanus' }).click();
  await page.waitForTimeout(300);
  check((await layerKey(page)) === 'builtin:ocean:light', 'galeriden Okyanus anında uygulandı');

  // Çapraz geçiş: yeni kapağa geçerken eski ve yeni katman birlikte, sonra tek katman.
  await dialog.getByRole('option', { name: 'Kumullar' }).click();
  await page.waitForTimeout(120);
  const during = await page.locator('[data-wallpaper] > div > div').count();
  await page.waitForTimeout(1100);
  const after = await page.locator('[data-wallpaper] > div > div').count();
  check(during >= 2 && after === 1, 'çapraz geçiş: sırasında 2 katman, sonra 1', `${during} → ${after}`);

  await page.reload();
  await page.waitForSelector('main[aria-label="DeX Masaüstü"]');
  await page.waitForTimeout(800);
  check((await layerKey(page)) === 'builtin:dunes:light', 'yeniden yüklemede seçim korundu (Kumullar)');

  // ── 2. Tema: koyuda aynı seçim koyu varyant, yazı beyaz ────────────────────────────────────────────────────
  await page.goto(url().replace('theme=light', 'theme=dark'));
  await page.waitForSelector('main[aria-label="DeX Masaüstü"]');
  await page.waitForTimeout(800);
  check((await layerKey(page)) === 'builtin:dunes:dark', 'koyu temada Kumullar koyu varyantta');
  check(/rgba?\(255, 255, 255/.test(await inkColor(page)), 'koyu kapakta simge adları beyaz', await inkColor(page));
  await page.goto(url());
  await page.waitForSelector('main[aria-label="DeX Masaüstü"]');
  await page.waitForTimeout(600);

  // ── 3. Resim içe aktarma: gerçek Canvas/WebP/IndexedDB ─────────────────────────────────────────────────────
  dialog = await openDialog(page);
  await dialog.getByRole('radio', { name: /Resimlerim/ }).click();
  await dialog.getByTestId('wallpaper-file-input').setInputFiles([{ name: 'Büyük.png', mimeType: 'image/png', buffer: await png(page, 6000, 3375, 20) }]);
  await dialog.getByRole('option', { name: 'Büyük' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
  const dump = await idbDump(page);
  const meta = dump?.metas?.[0];
  check(meta && meta.width === 3840 && meta.height === 2160, '6000×3375 resim 3840×2160\'a küçültüldü', JSON.stringify(meta && { w: meta.width, h: meta.height, bytes: meta.bytes }));
  check(meta && meta.bytes < 400000, 'WebP kodlama sonucu küçük', `${meta?.bytes} bayt`);
  check(dump && dump.blobKeys.length === 2 && dump.blobKeys.some((k) => String(k).endsWith('#thumb')), 'IndexedDB: resim + önizleme birlikte saklandı');
  check(/^image:/.test((await layerKey(page)) || ''), 'eklenen resim hemen kapak oldu', await layerKey(page));
  check(await page.locator('[data-wallpaper] [style*="blob:"]').count() === 1, 'masaüstü katmanı blob URL ile çiziyor');
  const imageKey = await layerKey(page);
  const thumbOk = await dialog.getByRole('option', { name: 'Büyük' }).locator('[style*="blob:"]').count();
  check(thumbOk === 1, 'galeri karosu küçük önizlemeyi gösteriyor');
  check(await dialog.getByRole('radio', { name: 'Doldur' }).getAttribute('aria-checked') === 'true', 'yerleşim denetimi görünür (Doldur seçili)');

  // Yerleşim: anında, çapraz geçişsiz.
  await dialog.getByRole('radio', { name: 'Döşe' }).click();
  await page.waitForTimeout(150);
  const tileStyle = await page.locator('[data-wallpaper] [style*="blob:"]').first().evaluate((el) => getComputedStyle(el).backgroundRepeat);
  check(/^repeat/.test(tileStyle) && (await page.locator('[data-wallpaper] > div > div').count()) === 1, 'Döşe anında uygulandı, ek katman yok', tileStyle);
  await dialog.getByRole('radio', { name: 'Doldur' }).click();

  // Yeniden yükleme: resim IndexedDB'den gelir.
  await page.reload();
  await page.waitForSelector('main[aria-label="DeX Masaüstü"]');
  await page.waitForTimeout(1200);
  check((await layerKey(page)) === imageKey && (await page.locator('[data-wallpaper] [style*="blob:"]').count()) === 1, 'yeniden yüklemede resim kalıcı depodan geldi');

  // ── 4. Sil / geri al ───────────────────────────────────────────────────────────────────────────────────────
  dialog = await openDialog(page);
  await dialog.getByRole('radio', { name: /Resimlerim/ }).click();
  await dialog.getByRole('option', { name: 'Büyük' }).hover();
  await dialog.getByRole('button', { name: /«Büyük» resmini sil/ }).click();
  await page.waitForTimeout(500);
  check((await layerKey(page)) === 'builtin:flow:light', 'seçili resim silinince varsayılana dönüldü');
  check((await idbDump(page)).metas.length === 0, 'IndexedDB\'den silindi (resim + önizleme)');
  await dialog.getByRole('status').getByRole('button', { name: 'Geri al' }).click();
  await dialog.getByRole('option', { name: 'Büyük' }).waitFor();
  await page.waitForTimeout(700);
  check((await layerKey(page)) === imageKey && (await idbDump(page)).metas.length === 1, 'geri al: resim ve seçim geri geldi');

  // ── 5. Hata yolları ────────────────────────────────────────────────────────────────────────────────────────
  const input = dialog.getByTestId('wallpaper-file-input');
  await input.setInputFiles([{ name: 'notlar.txt', mimeType: 'text/plain', buffer: Buffer.from('merhaba') }]);
  check(/resim dosyası değil/.test(await dialog.getByRole('alert').innerText()), 'metin dosyası anlaşılır mesajla reddedildi');
  await dialog.getByRole('button', { name: 'Uyarıyı kapat' }).click();
  await input.setInputFiles([{ name: 'bozuk.png', mimeType: 'image/png', buffer: Buffer.from('PNG değil, çöp veri'.repeat(20)) }]);
  await dialog.getByRole('alert').waitFor();
  check(/açılamadı/.test(await dialog.getByRole('alert').innerText()), 'bozuk resim "açılamadı" mesajıyla reddedildi');
  check((await idbDump(page)).metas.length === 1, 'reddedilenler depoya yazılmadı');
  await dialog.getByRole('button', { name: 'Uyarıyı kapat' }).click();
  await input.setInputFiles([{ name: 'vektor.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }]);
  check(/SVG/.test(await dialog.getByRole('alert').innerText()), 'SVG için ayrı açıklama');
  await dialog.getByRole('button', { name: 'Uyarıyı kapat' }).click();

  // ── 6. Sürükle-bırak ve yapıştır (gerçek olaylar) ──────────────────────────────────────────────────────────
  const dropBuf = (await png(page, 800, 450, 300)).toString('base64');
  const synth = (type, withFile) =>
    dialog.evaluate((el, [kind, b64, withFileFlag]) => {
      const dt = new DataTransfer();
      if (withFileFlag) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], 'Sürüklenen.png', { type: 'image/png' }));
      }
      const target = el.firstElementChild;
      if (kind === 'paste') {
        const ev = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: dt });
        document.dispatchEvent(ev);
      } else {
        target.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    }, [type, dropBuf, withFile]);
  await synth('dragenter', true);
  check(await page.getByText('Bırakın — kapak resmi olarak eklensin').waitFor({ timeout: 3000 }).then(() => true, () => false), 'dosya sürüklenirken bırakma bölgesi görünür');
  await synth('drop', true);
  await dialog.getByRole('option', { name: 'Sürüklenen' }).waitFor({ timeout: 20000 });
  check(!(await page.getByText('Bırakın — kapak resmi olarak eklensin').isVisible().catch(() => false)), 'bırakınca bölge kapandı, resim eklendi');
  await synth('paste', true);
  await page.waitForTimeout(100);
  await page.waitForFunction(() => document.querySelectorAll('[role=dialog] [role=option]').length >= 3, null, { timeout: 20000 });
  check((await idbDump(page)).metas.length === 3, 'Ctrl+V ile yapıştırılan resim eklendi', `${(await idbDump(page)).metas.length} resim`);

  // ── 7. Klavye: gerçek düzende ok tuşları ───────────────────────────────────────────────────────────────────
  await dialog.getByRole('radio', { name: 'Galeri' }).click();
  await dialog.getByRole('option', { name: 'Akış' }).focus();
  await page.keyboard.press('ArrowRight');
  const right = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await page.keyboard.press('ArrowDown');
  const down = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  await page.keyboard.press('ArrowUp');
  const up = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  check(right === 'Kutup Işığı' && down === 'Bokeh' && up === 'Kutup Işığı', 'oklar: sağ → Kutup Işığı, aşağı → Bokeh, yukarı → Kutup Işığı', `${right} / ${down} / ${up}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check((await layerKey(page)) === 'builtin:aurora:light', 'Enter odaktaki kapağı seçti (oklar seçmedi)');

  // ── 8. Ayarlar: gerçek kaydırıcı sürükleme + kalıcılık ─────────────────────────────────────────────────────
  const blurThumb = dialog.getByRole('slider', { name: 'Bulanıklık' }).locator('[data-slider-thumb]');
  const box = await blurThumb.boundingBox();
  const track = await dialog.getByRole('slider', { name: 'Bulanıklık' }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.3, box.y + box.height / 2, { steps: 8 });
  const liveBlur = await page.evaluate(() => window.__wp.getState().prefs.blur);
  await page.mouse.up();
  check(liveBlur > 5 && liveBlur < 20, 'bulanıklık kaydırıcısı sürüklenirken canlı uygulanır', `blur=${liveBlur}`);
  await page.evaluate(() => { window.__wp.getState().setBlur(12); window.__wp.getState().setDim(25); });
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForSelector('main[aria-label="DeX Masaüstü"]');
  await page.waitForTimeout(800);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('opendex_wallpaper_v2')));
  check(persisted.blur === 12 && persisted.dim === 25 && persisted.id === 'aurora', 'bulanıklık/karartma/seçim yeniden yüklemede korundu', JSON.stringify(persisted));
  check((await page.locator('[data-wallpaper] > div').first().getAttribute('style') || '').includes('blur(12px)'), 'bulanıklık katmana uygulandı');

  check(errors.length === 0, 'konsolda hata yok', errors.slice(0, 3).join(' | '));
  await ctx.close(); // gizli sekmede slayt geçişi bilerek durur (sekme görünür olmalı) — diğer sayfa arka plana düşmesin

  // ── 9. Slayt gösterisi: sahte saat ─────────────────────────────────────────────────────────────────────────
  const ctx2 = await browser.newContext({ viewport: { width: 1300, height: 790 } });
  const p2 = await ctx2.newPage();
  await p2.clock.install();
  await p2.goto(url(`&prefs=${encodeURIComponent(JSON.stringify({ mode: 'builtin', id: 'flow', slideshow: { enabled: true, intervalMin: 5, source: 'builtin' } }))}`));
  await p2.waitForSelector('main[aria-label="DeX Masaüstü"]');
  const before = await layerKey(p2);
  await p2.clock.fastForward('04:30');
  check((await layerKey(p2)) === before, 'slayt gösterisi: süre dolmadan değişmedi');
  await p2.clock.fastForward('00:40');
  await p2.waitForTimeout(200);
  const next = await layerKey(p2);
  check(next !== before && /^builtin:/.test(next), 'slayt gösterisi: süre dolunca sıradaki kapağa geçti', `${before} → ${next}`);
  await ctx2.close();

  // ── 10. Eski sürümden göç ──────────────────────────────────────────────────────────────────────────────────
  const ctx3 = await browser.newContext({ viewport: { width: 1300, height: 790 } });
  const p3 = await ctx3.newPage();
  await p3.addInitScript(() => localStorage.setItem('opendex_wallpaper', 'dusk'));
  await p3.goto(url());
  await p3.waitForSelector('main[aria-label="DeX Masaüstü"]');
  await p3.waitForTimeout(600);
  check((await layerKey(p3)) === 'builtin:dusk:light', 'eski sürümde "Alacakaranlık" seçen kullanıcının seçimi korundu');
  check(await p3.locator('.workspace-grid').count() === 0, 'ızgara yalnız "Düz" kapakta (Alacakaranlık\'ta yok)');
  await ctx3.close();

  await browser.close();
  console.log(failed ? `\n${failed} denetim BAŞARISIZ` : '\nTüm denetimler geçti');
  process.exit(failed ? 1 : 0);
})();
