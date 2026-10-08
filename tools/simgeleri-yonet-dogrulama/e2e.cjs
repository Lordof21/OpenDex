// Uçtan uca: gerçek Desktop'ta anahtar → kaydedilen düzen (PUT /api/layout) ve masaüstündeki simge sayısı birlikte değişir.
// Kullanım: node e2e.cjs   (önce ./run.sh; ortam değişkenleri snap.cjs ile aynı)
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const BASE = process.env.HARNESS_URL || 'http://localhost:5198';
const assert = (cond, msg) => { if (!cond) { console.log('FAIL', msg); process.exitCode = 1; } else console.log('ok  ', msg); };
(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox'] });
  const page = await (await browser.newContext({ viewport: { width: 1300, height: 780 } })).newPage();
  await page.goto(`${BASE}/harness.html?w=1280&h=760&theme=light`);
  await page.waitForSelector('main[aria-label="DeX Masaüstü"]');
  await page.waitForTimeout(1200);
  const icons = () => page.locator('main[aria-label="DeX Masaüstü"] button[draggable="true"]');
  const desktopIcons = () => icons().count();
  const onDesktop = async (name) => (await icons().filter({ has: page.locator(`xpath=self::*[@aria-label="${name}"]`) }).count()) > 0;
  const saved = () => page.evaluate(() => window.__layoutSaved());
  const open = async () => {
    await page.locator('main[aria-label="DeX Masaüstü"]').click({ button: 'right', position: { x: 640, y: 470 } });
    await page.getByRole('menuitem', { name: /Simgeleri Yönet/ }).click();
    await page.getByRole('dialog', { name: 'Simgeleri yönet' }).waitFor();
    await page.waitForTimeout(500);
  };
  const before = await desktopIcons();
  await open();
  const dialog = page.getByRole('dialog', { name: 'Simgeleri yönet' });
  await dialog.locator('[role=switch][aria-label="Chrome"]').click();           // masaüstündeydi → kaldır
  await dialog.locator('[role=switch][aria-label="BiP"]').click();              // eklenmemişti → ekle
  await page.waitForTimeout(400);
  let s = await saved();
  const pick = (name) => s.find((e) => e.package.endsWith(name));
  assert(s.find((e) => e.package === 'com.example.chrome0').hidden === true, 'Chrome kaydedilen düzende gizli');
  assert(s.find((e) => e.package === 'com.example.bip38').hidden === false, 'BiP kaydedilen düzende görünür');
  await dialog.getByRole('button', { name: 'Bitti' }).click();
  await page.waitForTimeout(600);
  const after = await desktopIcons();
  assert(before > 5 && after === before, `masaüstündeki simge sayısı aynı kaldı (1 çıktı, 1 girdi): ${before} → ${after}`);
  assert(!(await onDesktop('Chrome')) && (await onDesktop('BiP')), 'masaüstünde Chrome yok, BiP var');
  // Geri al
  await open();
  await dialog.locator('[role=switch][aria-label="Chrome"]').click();           // tekrar ekle
  await dialog.getByRole('button', { name: /Geri al/ }).click();               // geri al → Chrome yine kapalı
  await page.waitForTimeout(300);
  s = await saved();
  assert(s.find((e) => e.package === 'com.example.chrome0').hidden === true, 'Geri al kaydedilen düzeni de döndürdü');
  await dialog.getByRole('button', { name: 'Kapat' }).click();
  await browser.close();
})();
