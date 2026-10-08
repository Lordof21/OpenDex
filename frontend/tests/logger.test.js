// Faz 0 — frontend log altyapısı: konsol sessiz, halka tampon her şeyi tutar, akış kategorileri backend'e gider.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let logger;
let deriveCategory;
let consoleSpies;
const original = {};

async function freshLogger() {
  vi.resetModules();
  ({ logger, deriveCategory } = await import('../src/lib/logger.js'));
  logger.setTrace([]);
  logger.clear();
  logger.setTransport(null);
}

beforeEach(async () => {
  vi.useFakeTimers();
  for (const level of ['log', 'info', 'debug', 'warn', 'error']) original[level] = console[level];
  consoleSpies = Object.fromEntries(
    ['log', 'info', 'debug', 'warn', 'error'].map((l) => [l, vi.spyOn(console, l).mockImplementation(() => {})]),
  );
  delete window.__opendexLogCapture;
  window.localStorage.clear();
  await freshLogger();
});

afterEach(() => {
  for (const level of Object.keys(original)) console[level] = original[level];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const consoleCalls = () => Object.values(consoleSpies).reduce((n, s) => n + s.mock.calls.length, 0);

describe('deriveCategory', () => {
  it.each([
    ['[OpenDeX:WORKSPACE 🌱] açılıyor', 'workspace'],
    ['[OpenDeX:HANDOFF 📱] telefona', 'handoff'],
    ['[OpenDeX Resize:REQ 📐] win=1', 'resize'],
    ['[PixelAudit] x', 'pixelaudit'],
    ['%c[🎵 MediaUpdate]%c ▶ PLAYING', 'mediaupdate'],
    ['[MediaCardBody 🎛️] Clicked', 'mediacardbody'],
    ['etiketsiz mesaj', 'app'],
    [undefined, 'app'],
  ])('%s → %s', (input, expected) => {
    expect(deriveCategory(input)).toBe(expected);
  });
});

describe('konsol sessiz, halka tampon eksiksiz', () => {
  it('info/debug/trace konsola BASILMAZ ama halka tampona girer', () => {
    logger.info('applock', 'retry_clicked', { windowId: 'w1' });
    logger.debug('handoff', 'aday');
    logger.trace('[OpenDeX:WORKSPACE 🌱] paylaşımlı alanda açılıyor');
    expect(consoleCalls()).toBe(0);
    const dump = logger.dump();
    expect(dump).toHaveLength(3);
    expect(dump[0]).toMatch(/INFO\s+\[applock\] retry_clicked \{"windowId":"w1"\}/);
    expect(dump[2]).toContain('[workspace] [OpenDeX:WORKSPACE 🌱] paylaşımlı alanda açılıyor');
  });

  it('warn ve error HER ZAMAN konsola da çıkar', () => {
    logger.warn('handoff', 'taşıma başarısız', { task: 5 });
    logger.error('applock', 'istek patladı');
    expect(consoleSpies.warn).toHaveBeenCalledTimes(1);
    expect(consoleSpies.error).toHaveBeenCalledTimes(1);
  });

  it('halka tampon son 500 kaydı tutar', () => {
    for (let i = 0; i < 620; i += 1) logger.info('x', `olay-${i}`);
    const entries = logger.entries();
    expect(entries).toHaveLength(500);
    expect(entries[0].event).toBe('olay-120');
    expect(entries.at(-1).event).toBe('olay-619');
  });

  it('akış numarası (op) satırda görünür', () => {
    logger.withOp('a3f9k2').info('applock', 'retry_clicked');
    expect(logger.dump()[0]).toContain('[op:a3f9k2]');
  });
});

describe('izleme modu (trace)', () => {
  it('izlenen kategori konsola basılır, diğerleri sessiz kalır', () => {
    logger.setTrace(['handoff']);
    logger.info('handoff', 'görünür');
    logger.info('applock', 'görünmez');
    expect(consoleSpies.info).toHaveBeenCalledTimes(1);
    expect(consoleSpies.info.mock.calls[0][1]).toBe('görünür');
  });

  it('"all" her şeyi açar; setTrace kalıcıdır (localStorage)', () => {
    expect(logger.setTrace('all')).toEqual(['all']);
    logger.debug('herhangi', 'olay');
    expect(consoleSpies.debug).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('opendexTrace')).toBe('all');
  });

  it('handoff izlemesi reclaim akışını da açar (takma ad)', () => {
    logger.setTrace(['handoff']);
    logger.info('reclaim', 'sonuç');
    expect(consoleSpies.info).toHaveBeenCalledTimes(1);
  });

  it('trace() izlenirken ÖZGÜN çağrıyı (stil argümanları dahil) aynen basar', () => {
    logger.setTrace(['mediaupdate']);
    logger.trace('%c[🎵 MediaUpdate]%c ▶ PLAYING', 'color:#06b6d4;', 'color:#94a3b8;');
    expect(consoleSpies.log).toHaveBeenCalledWith('%c[🎵 MediaUpdate]%c ▶ PLAYING', 'color:#06b6d4;', 'color:#94a3b8;');
    // Halka tamponda CSS argümanları GÜRÜLTÜ olarak görünmez.
    expect(logger.dump().at(-1)).toContain('[mediaupdate] [🎵 MediaUpdate] ▶ PLAYING');
    expect(logger.dump().at(-1)).not.toContain('color:');
  });

  it('URL ?trace= parametresi başlangıçta okunur', async () => {
    window.history.pushState({}, '', '/?trace=applock,power');
    vi.resetModules();
    const fresh = await import('../src/lib/logger.js');     // freshLogger() izlemeyi sıfırlar; burada ham başlangıç okunur
    window.history.pushState({}, '', '/');
    expect(fresh.logger.getTrace()).toEqual(['applock', 'power']);
  });
});

describe('backend taşıması', () => {
  const sent = [];
  beforeEach(() => {
    sent.length = 0;
    logger.setTransport(async (batch) => {
      sent.push(...batch);
    });
  });

  it('akış kategorileri ve warn/error toplu gönderilir; gürültülü kategoriler ve debug gönderilmez', async () => {
    logger.info('applock', 'retry_clicked', { windowId: 'w1' });
    logger.info('hizalama', 'her render');           // gürültü: yalnızca halka tampon
    logger.debug('handoff', 'aday listesi');          // debug: gönderilmez
    logger.warn('handoff', 'taşıma başarısız');
    logger.trace('[OpenDeX:WORKSPACE 🌸] tomurcuklanıyor');
    await vi.advanceTimersByTimeAsync(1100);
    expect(sent.map((e) => `${e.cat}:${e.event}`)).toEqual([
      'applock:retry_clicked',
      'handoff:taşıma başarısız',
      'workspace:[OpenDeX:WORKSPACE 🌸] tomurcuklanıyor',
    ]);
    expect(sent[0]).toMatchObject({ level: 'info', data: { windowId: 'w1' } });
  });

  it('op numarası backend kaydına op_id olarak taşınır', async () => {
    logger.withOp('fe-42').info('power', 'clicked', { on: false });
    await vi.advanceTimersByTimeAsync(1100);
    expect(sent[0].op_id).toBe('fe-42');
  });

  it('error beklemeden hemen gönderilir', async () => {
    logger.error('applock', 'patladı');
    await vi.advanceTimersByTimeAsync(5);
    expect(sent).toHaveLength(1);
  });

  it('aynı pencerede birden çok kayıt TEK istekte toplanır', async () => {
    const calls = [];
    logger.setTransport(async (batch) => { calls.push(batch.length); });
    for (let i = 0; i < 7; i += 1) logger.info('handoff', `adım-${i}`);
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls).toEqual([7]);
  });

  it('taşıma hatası uygulamayı bozmaz ve döngüye girmez', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('backend kapalı'));
    logger.setTransport(failing);
    logger.info('applock', 'olay');
    await vi.advanceTimersByTimeAsync(1100);
    expect(failing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(failing).toHaveBeenCalledTimes(1);      // yeniden deneme fırtınası yok
    expect(consoleSpies.error).not.toHaveBeenCalled();
  });

  it('taşıma yokken hiçbir şey kuyruğa alınmaz', async () => {
    logger.setTransport(null);
    logger.warn('applock', 'x');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(0);
  });
});

describe('genel yakalama', () => {
  it('console.warn/error halka tampona ve backend\'e de girer, konsol çıktısı KORUNUR (çift kayıt yok)', async () => {
    const sent = [];
    logger.setTransport(async (b) => { sent.push(...b); });
    const nativeWarn = console.warn;
    logger.installGlobalCapture();
    console.warn('[Frontend API Exception]', 'POST /x', 'boom');
    logger.warn('handoff', 'kendi uyarım');           // logger kendi çıktısını YENİDEN yakalamaz
    await vi.advanceTimersByTimeAsync(1100);

    expect(nativeWarn).toHaveBeenCalledTimes(2);       // ikisi de gerçekten konsola basıldı
    const dump = logger.dump();
    expect(dump.filter((l) => l.includes('Frontend API Exception'))).toHaveLength(1);
    expect(dump.filter((l) => l.includes('kendi uyarım'))).toHaveLength(1);
    expect(sent.some((e) => e.cat === 'console' && e.event.includes('Frontend API Exception'))).toBe(true);
  });

  it('yakalanmamış hata/promise reddi kaydedilir', () => {
    logger.installGlobalCapture();
    window.dispatchEvent(new ErrorEvent('error', { message: 'kırıldı', filename: 'a.js', lineno: 3, colno: 4 }));
    expect(logger.dump().join('\n')).toContain('yakalanmamış hata: kırıldı');
  });

  it('installGlobalCapture ikinci kez çağrılsa da konsolu iki kez sarmaz', () => {
    logger.installGlobalCapture();
    const first = console.warn;
    logger.installGlobalCapture();
    expect(console.warn).toBe(first);
  });
});
