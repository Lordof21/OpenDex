// Ayarlar modelinin saf kuralları: arama (aksan duyarsız, VE, puanlama), profiller, öneriler, özetler, yerleşim.
import { describe, expect, it } from 'vitest';
import {
  PROFILES,
  SECTIONS,
  SECTION_GROUPS,
  SECTION_ORDER,
  SETTING_ITEMS,
  activeProfileId,
  fold,
  layoutForWidth,
  recommendations,
  searchSettings,
  sectionSummary,
} from '../src/settings/settingsModel.js';

describe('kayıt defteri', () => {
  it('her ayar var olan bir bölüme bağlı; grup sırası tüm bölümleri kapsar', () => {
    for (const [id, item] of Object.entries(SETTING_ITEMS)) {
      expect(SECTIONS[item.section], `${id} → ${item.section}`).toBeDefined();
      expect(item.title.length).toBeGreaterThan(2);
      expect(item.description.length).toBeGreaterThan(10);
    }
    expect([...SECTION_ORDER].sort()).toEqual(Object.keys(SECTIONS).sort());
    expect(SECTION_GROUPS.flatMap((g) => g.sections)).toEqual(SECTION_ORDER);
  });

  it('genel bakış dışındaki her bölümde en az bir aranabilir ayar var', () => {
    const used = new Set(Object.values(SETTING_ITEMS).map((i) => i.section));
    for (const id of Object.keys(SECTIONS)) {
      if (id !== 'overview') expect(used.has(id), id).toBe(true);
    }
  });
});

describe('fold', () => {
  it('Türkçe harfleri ve büyük/küçük farkını katlar', () => {
    expect(fold('ÇÖZÜNÜRLÜK')).toBe('cozunurluk');
    expect(fold('Işık İyi')).toBe('isik iyi');
    expect(fold('  Ağ  ')).toBe('ag');
    expect(fold(null)).toBe('');
  });
});

describe('searchSettings', () => {
  it('boş sorgu sonuç vermez', () => {
    expect(searchSettings('')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('aksan yazmadan da bulur ("cozunurluk" → Gerçek çözünürlük, Çözünürlük Stratejisi)', () => {
    const ids = searchSettings('cozunurluk').map((r) => r.id);
    expect(ids).toContain('resolutionMode');
    expect(ids).toContain('realResolution');
  });

  it('başlık eşleşmesi anahtar sözcük ve açıklamadan önce gelir', () => {
    const ids = searchSettings('dpi').map((r) => r.id);
    expect(ids.slice(0, 3)).toContain('customDpi');                     // başlığında DPI geçenler en üstte
    expect(ids.indexOf('customDpi')).toBeLessThan(ids.indexOf('dpLock')); // yalnız anahtar sözcükte geçen sonra
  });

  it('birden çok sözcük VE ile birleşir', () => {
    const ids = searchSettings('ses codec').map((r) => r.id);
    expect(ids).toContain('audioCodec');
    expect(searchSettings('ses zzzzqq')).toEqual([]);
  });

  it('anahtar sözcükle ve eş anlamlıyla bulur (hevc → codec, karanlık → tema, freeform → aktarma kipi)', () => {
    expect(searchSettings('hevc')[0].id).toBe('codec');
    expect(searchSettings('karanlık').map((r) => r.id)).toContain('theme');
    expect(searchSettings('freeform')[0].id).toBe('handoffWindowing');
  });

  it('kartların içindeki seçeneklerde de arar ("1 mbps" → Video bit hızı · 12 ve 16 Mbps)', () => {
    const [first] = searchSettings('1 mbps');
    expect(first.id).toBe('bitrate');
    expect(first.options.map((o) => o.value)).toEqual(['12', '16']);
    expect(searchSettings('200 dpi')[0]).toMatchObject({ id: 'customDpi', options: [{ value: '200', label: '200 DPI' }] });
    expect(searchSettings('av1')[0]).toMatchObject({ id: 'codec', options: [{ value: 'av1' }] });
  });

  it('ayarın kendisi daha iyi eşleşiyorsa seçenek taşımaz; yalnız seçeneğin açıklamasında geçen sözcük kartı öne çıkarmaz', () => {
    const custom = searchSettings('özel dpi').find((r) => r.id === 'customDpi');
    expect(custom.options).toBeUndefined();
    expect(searchSettings('özel dpi')[0].id).toBe('customDpi');
    // "zayıf ağ için" yalnız 2 Mbps kartının açıklamasında: kart vurgulanmaz
    expect(searchSettings('zayif').find((r) => r.id === 'bitrate')).toBeUndefined();
  });

  it('sonuç sınırını uygular ve bölüm bilgisini taşır', () => {
    const results = searchSettings('a', { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
    for (const r of results) expect(SECTIONS[r.section]).toBeDefined();
  });
});

describe('profiller', () => {
  const live = (patch) => ({ ...PROFILES[0].patch, ...patch });

  it('her profilin yaması kendi kimliğini üretir', () => {
    for (const profile of PROFILES) expect(activeProfileId(profile.patch), profile.id).toBe(profile.id);
  });

  it('profile uymayan ayar "custom" olur; boş canlı ayar da', () => {
    expect(activeProfileId(live({ max_fps: 45 }))).toBe('custom');
    expect(activeProfileId(null)).toBe('custom');
  });

  it('keskinleştirme arayüz adı ("smart") ile backend adı ("adaptive") aynı sayılır', () => {
    expect(activeProfileId(live({ sharpening_mode: 'smart' }))).toBe('balanced');
  });

  it('eksik anahtarlar backend varsayılanlarıyla okunur', () => {
    expect(activeProfileId({})).toBe('balanced');                                 // gerçek çözünürlük istemek varsayılanda açık
    expect(activeProfileId({ dynamic_resolution_enabled: false })).toBe('custom');
  });

  it('profiller kişisel tercihlere (DPI, tema, ses, pencere) dokunmaz', () => {
    const forbidden = ['custom_dpi', 'target_dp', 'audio_output_mode', 'ambient_backdrop', 'windowing_mode', 'resolution_mode'];
    for (const profile of PROFILES) {
      for (const key of forbidden) expect(Object.keys(profile.patch), `${profile.id}:${key}`).not.toContain(key);
    }
  });
});

describe('recommendations', () => {
  it('sağlıklı ayarda öneri yok', () => {
    expect(recommendations({ ...PROFILES[0].patch, resolution_mode: 'dynamic_fix' })).toEqual([]);
    expect(recommendations(null)).toEqual([]);
  });

  it('uyarılar bilgilerden önce gelir ve eylem taşır', () => {
    const tips = recommendations({
      density_refresh_hard: true, dynamic_resolution_enabled: false, resolution_mode: 'dynamic', video_codec: 'h264',
    });
    expect(tips[0].tone).toBe('warn');
    expect(tips[0].action.patch).toEqual({ density_refresh_hard: false });
    expect(tips.map((t) => t.id)).toContain('real-resolution-off');
  });

  it('düşük bit hızı + 60 FPS uyarır; 8 Mbps yama önerir', () => {
    const [tip] = recommendations({ video_bit_rate: 2_000_000, max_fps: 60, dynamic_resolution_enabled: true });
    expect(tip.id).toBe('low-bitrate-high-fps');
    expect(tip.action.patch).toEqual({ video_bit_rate: 8_000_000 });
    expect(recommendations({ video_bit_rate: 2_000_000, max_fps: 30, dynamic_resolution_enabled: true })).toEqual([]);
  });

  it('"İkisi" ses rotası bir bölüme yönlendiren öneri verir; ince ayar yapılmışsa vermez', () => {
    const base = { ...PROFILES[0].patch, audio_output_mode: 'both' };
    expect(recommendations(base)[0].action.section).toBe('audio');
    expect(recommendations({ ...base, audio_sync_offset_ms: 40 })).toEqual([]);
  });

  it('en çok `limit` öneri döner', () => {
    const many = { dynamic_resolution_enabled: false, density_refresh_hard: true, video_bit_rate: 2_000_000, max_fps: 60, video_codec: 'h264', audio_output_mode: 'both' };
    expect(recommendations(many).length).toBe(3);
    expect(recommendations(many, { limit: 5 }).length).toBe(5);
  });
});

describe('sectionSummary', () => {
  it('canlı ayardan tek satırlık özet üretir', () => {
    expect(sectionSummary('stream', { video_codec: 'h265', max_fps: 30, video_bit_rate: 4_000_000 })).toBe('H.265 · 30 FPS · 4 Mbps');
    expect(sectionSummary('audio', { audio_output_mode: 'both' })).toBe('İkisi');
    expect(sectionSummary('display', { resolution_mode: 'dynamic_fix', custom_dpi: 200 })).toContain('200 DPI');
    expect(sectionSummary('display', { resolution_mode: 'dynamic', target_dp: 720 })).toContain('720 dp');
    expect(sectionSummary('windows', { phone_handoff_windowing: 'freeform' })).toContain('Serbest');
    expect(sectionSummary('about', {})).toBe('');
  });
});

describe('layoutForWidth', () => {
  it('telefon / orta / geniş eşikleri', () => {
    expect(layoutForWidth(360)).toBe('narrow');
    expect(layoutForWidth(559)).toBe('narrow');
    expect(layoutForWidth(560)).toBe('rail');
    expect(layoutForWidth(779)).toBe('rail');
    expect(layoutForWidth(780)).toBe('wide');
    expect(layoutForWidth(1600)).toBe('wide');
    expect(layoutForWidth(0)).toBe('wide');          // ölçü yoksa geniş varsayılır (ilk çizim)
  });
});
