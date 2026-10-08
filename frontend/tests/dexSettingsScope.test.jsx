// DeX ayar paneli — kapsam etiketleri ve "bu pencere" ayarlarının odaktaki pencereye bağlanması.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue(null), post: vi.fn().mockResolvedValue({}), put: vi.fn().mockResolvedValue({}) },
  wsUrl: (p) => `ws://test${p}`,
}));
vi.mock('../src/settings/settingsApi.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ dynamic_resolution_enabled: true, header_hover_mode: false }),
  saveSettings: vi.fn().mockResolvedValue({}),
  subscribeSettings: vi.fn(() => () => {}),
}));
vi.mock('../src/settings/SettingsPanel.jsx', () => ({ openOpenDexSettings: vi.fn() }));

import { DexSettings } from '../src/taskbar/DexSettings.jsx';
import { ThemeProvider } from '../src/state/ThemeContext.jsx';
import { useWindowStore } from '../src/window/windowStore.js';

const WIN_A = { id: 'wa', package: 'com.app.a', title: 'Uygulama A', x: 0, y: 0, w: 900, h: 600, focused: true, minimized: false };
const WIN_B = { id: 'wb', package: 'com.app.b', title: 'Uygulama B', x: 50, y: 50, w: 900, h: 600, focused: false, minimized: false };
const MIRROR = { id: 'wm', package: 'com.opendex.screen_mirror', title: 'Telefon', x: 0, y: 0, w: 900, h: 600, focused: true, minimized: false };
const ECO = { id: 'eco', package: 'opendex.workspace', title: 'Çalışma Alanı', isEcoWorkspace: true, tasks: [], focused: true, minimized: false };

function renderPanel() {
  return render(
    <ThemeProvider>
      <DexSettings onClose={() => {}} />
    </ThemeProvider>,
  );
}

const setWindows = (windows) => act(() => useWindowStore.setState({ windows }));
const scopeHeading = (container, scope) => container.querySelector(`[data-scope="${scope}"]`);

describe('DexSettings — kapsam bölümleri', () => {
  beforeEach(() => {
    useWindowStore.setState({ windows: [WIN_A, WIN_B] });
  });
  afterEach(cleanup);

  it('"Bu pencere" bölümü odaktaki pencerenin ADINI gösterir; "Tüm pencereler" ondan sonra gelir', () => {
    const { container } = renderPanel();
    const win = scopeHeading(container, 'window');
    const all = scopeHeading(container, 'global');

    expect(win).toHaveTextContent('Bu pencere');
    expect(win).toHaveTextContent('Uygulama A');
    expect(all).toHaveTextContent('Tüm pencereler');
    // DOM sırası: önce pencere kapsamı, sonra genel
    expect(win.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('odak değişince başlık ANINDA yeni pencerenin adına geçer', () => {
    const { container } = renderPanel();
    expect(scopeHeading(container, 'window')).toHaveTextContent('Uygulama A');

    setWindows([{ ...WIN_A, focused: false }, { ...WIN_B, focused: true }]);
    expect(scopeHeading(container, 'window')).toHaveTextContent('Uygulama B');
    expect(scopeHeading(container, 'window')).not.toHaveTextContent('Uygulama A');
  });

  it('pencereye özel ayarlar (DPI, Target DP, çözünürlük, sığdırma, DP kilidi, başlık) "Bu pencere" içinde; genel varsayılanlar "Tüm pencereler" içinde durur', () => {
    const { container, getByText } = renderPanel();
    const win = scopeHeading(container, 'window');
    const all = scopeHeading(container, 'global');
    const after = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    const perWindow = ['Özel DPI Yoğunluğu', 'Mantıksal Alan (Target DP)', 'Çözünürlük Stratejisi', 'Görüntü Sığdırma',
      'Flex DP Kilidi', 'Başlık Çubuğu'].map((t) => getByText(t));
    for (const el of perWindow) {
      expect(after(win, el)).toBe(true); // "Bu pencere"den sonra
      expect(after(el, all)).toBe(true); // "Tüm pencereler"den ÖNCE
    }
    const globals = ['Varsayılan Çözünürlük Stratejisi', 'Varsayılan Görüntü Sığdırma', 'Varsayılan Flex DP Kilidi',
      'Video Bit Hızı'].map((t) => getByText(t));
    for (const el of globals) {
      expect(after(all, el)).toBe(true); // genel varsayılanlar "Tüm pencereler"den sonra
    }
  });

  it('açık pencere yokken pencere ayarları gösterilmez, açıklama gösterilir', () => {
    setWindows([]);
    const { container, queryByText } = renderPanel();

    expect(scopeHeading(container, 'window')).toHaveTextContent('Bu pencere');
    expect(container).toHaveTextContent('Açık pencere yok');
    expect(queryByText('Özel DPI Yoğunluğu')).toBeNull();
    expect(queryByText('Başlık Çubuğu')).toBeNull();
    expect(queryByText('Çözünürlük Stratejisi')).toBeNull(); // pencereye özel olan yok…
    expect(queryByText('Varsayılan Çözünürlük Stratejisi')).not.toBeNull(); // …genel varsayılan her zaman var
  });

  it('Çalışma Alanı odaktayken DPI/başlık uygulanmaz; nedenini söyler', () => {
    setWindows([ECO]);
    const { container, queryByText } = renderPanel();

    expect(container).toHaveTextContent('kendi ⚙ menüsünden');
    expect(queryByText('Özel DPI Yoğunluğu')).toBeNull();
  });

  it('DPI hazır ayarı YALNIZ odaktaki pencereye yazılır', () => {
    const { getByText } = renderPanel();
    const spy = vi.spyOn(useWindowStore.getState(), 'setWindowDpiPolicy').mockResolvedValue(undefined);

    fireEvent.click(getByText('200 DPI'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('wa', { mode: 'custom', dpi: 200 });

    // odak B'ye geçince aynı düğme B'ye yazar
    setWindows([{ ...WIN_A, focused: false }, { ...WIN_B, focused: true }]);
    const spyB = vi.spyOn(useWindowStore.getState(), 'setWindowDpiPolicy').mockResolvedValue(undefined);
    fireEvent.click(getByText('240 DPI'));
    expect(spyB).toHaveBeenLastCalledWith('wb', { mode: 'custom', dpi: 240 });
  });

  it('Target DP "Oto": Target\'ın ürettiği DPI özel DPI olarak korunur (yoğunluk sıçramaz)', () => {
    setWindows([{ ...WIN_A, dpiPolicy: { mode: 'target', dp: 840 } }, WIN_B]);
    const { getByText } = renderPanel();
    // Target seçiliyken DPI grubunun rozeti Target'ın ürettiği GERÇEK DPI'ı gösterir ("Oto (N DPI · pencere)");
    // kaydırıcı 160–340 aralığına kırptığı için ondan değil rozetten okunur.
    const dpiGroup = getByText('Özel DPI Yoğunluğu').closest('section');
    const shownDpi = Number(dpiGroup.textContent.match(/Oto \((\d+) DPI/)[1]);
    expect(shownDpi).toBeGreaterThan(0);

    const spy = vi.spyOn(useWindowStore.getState(), 'setWindowDpiPolicy').mockResolvedValue(undefined);
    const targetGroup = getByText('Mantıksal Alan (Target DP)').closest('section');
    fireEvent.click(within(targetGroup).getByRole('button', { name: /Oto/ }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('wa', { mode: 'custom', dpi: shownDpi });
  });

  it('Target DP seçili değilken "Oto" hiçbir şey değiştirmez', () => {
    const { getByText } = renderPanel();
    const spy = vi.spyOn(useWindowStore.getState(), 'setWindowDpiPolicy').mockResolvedValue(undefined);
    const targetGroup = getByText('Mantıksal Alan (Target DP)').closest('section');
    fireEvent.click(within(targetGroup).getByRole('button', { name: /Oto/ }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('DPI kaydırıcısı sürüklenirken politika DEĞİŞMEZ; bırakınca TEK kez uygulanır', () => {
    const { getByRole } = renderPanel();
    const spy = vi.spyOn(useWindowStore.getState(), 'setWindowDpiPolicy').mockResolvedValue(undefined);
    const slider = getByRole('slider', { name: 'Özel DPI yoğunluğu' });
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
      left: 0, width: 200, right: 200, top: 0, bottom: 32, height: 32, x: 0, y: 0, toJSON() {},
    });
    const start = Number(slider.getAttribute('aria-valuenow'));
    const thumbX = ((start - 160) / (340 - 160)) * 200;

    fireEvent.pointerDown(slider, { pointerId: 1, button: 0, clientX: thumbX });
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: thumbX + 20 });
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: thumbX + 40 });
    expect(spy).not.toHaveBeenCalled(); // sürüklerken commit yok
    const dragged = Number(slider.getAttribute('aria-valuenow')); // tutamağın bırakıldığı değer
    expect(dragged).toBeGreaterThan(start);

    fireEvent.pointerUp(slider, { pointerId: 1, clientX: thumbX + 40 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [id, policy] = spy.mock.calls[0];
    expect(id).toBe('wa');
    expect(policy).toEqual({ mode: 'custom', dpi: dragged });
  });

  it('başlık kipi seçimi odaktaki pencereye yazılır ve genel ayarı ipucu olarak gösterir', () => {
    const { getByText } = renderPanel();
    const spy = vi.spyOn(useWindowStore.getState(), 'setHeaderMode').mockResolvedValue(undefined);

    expect(getByText('Genel: Sabit')).toBeInTheDocument(); // header_hover_mode=false → "Genele uy" = Sabit
    fireEvent.click(getByText('Hover'));
    expect(spy).toHaveBeenCalledWith('wa', 'hover');
  });

  it('ayna (telefon ekranı) penceresinde başlık kipi seçilemez: her zaman gizli olduğu söylenir', () => {
    setWindows([MIRROR]);
    const { container, queryByText } = renderPanel();

    expect(container).toHaveTextContent('başlık her zaman gizlidir');
    const header = queryByText('Başlık Çubuğu').closest('section');
    expect(within(header).queryByText('Genele uy')).toBeNull();
    // Aynanın akışı telefonun kendi ekranıdır: çözünürlük ve DP kilidi seçilemez, yalnız görüntü sığdırma seçilir.
    expect(container).toHaveTextContent('çözünürlüğü telefon belirler');
    expect(queryByText('Flex DP Kilidi')).toBeNull();
    expect(queryByText('Görüntü Sığdırma')).not.toBeNull();
  });

  it('Gerçek Çözünürlük kapalıysa DPI ayarının uygulanmadığı açıkça söylenir', async () => {
    const { getSettings } = await import('../src/settings/settingsApi.js');
    getSettings.mockResolvedValueOnce({ dynamic_resolution_enabled: false });
    const { container } = renderPanel();
    await act(async () => {});

    expect(container).toHaveTextContent('«Gerçek Çözünürlük» kapalı');
  });

  it('"Telefona Aktarma Kipi" genel bölümdedir; seçim tek global ayar olarak kaydedilir', async () => {
    const { saveSettings } = await import('../src/settings/settingsApi.js');
    saveSettings.mockClear();
    const { container, getByText } = renderPanel();
    await act(async () => {});

    const heading = getByText('Telefona Aktarma Kipi');
    const all = scopeHeading(container, 'global');
    expect(Boolean(all.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(getByText('Önerilen')).toBeInTheDocument(); // varsayılan tam ekran

    fireEvent.click(getByText('Serbest pencere'));
    expect(saveSettings).toHaveBeenCalledWith({ phone_handoff_windowing: 'freeform' });

    fireEvent.click(getByText('Tam ekran'));
    expect(saveSettings).toHaveBeenLastCalledWith({ phone_handoff_windowing: 'fullscreen' });
  });

  it('kayıtlı aktarma kipi açılışta seçili gelir', async () => {
    const { getSettings } = await import('../src/settings/settingsApi.js');
    getSettings.mockResolvedValueOnce({ dynamic_resolution_enabled: true, phone_handoff_windowing: 'freeform' });
    const { getByRole } = renderPanel();
    await act(async () => {});

    // (grup başlığındaki değer rozeti de aynı metni taşıdığından düğmeler erişilebilir adla aranır)
    expect(getByRole('button', { name: /Serbest pencere/ })).toHaveAttribute('aria-pressed', 'true');
    expect(getByRole('button', { name: /Tam ekran/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('bölüm başlığı her iki kapsamı da erişilebilir başlık (h3) olarak sunar', () => {
    const { container } = renderPanel();
    const headings = within(scopeHeading(container, 'window')).getAllByRole('heading', { level: 3 });
    expect(headings.length).toBe(1);
  });
});

describe('DexSettings — pencere başına çözünürlük, sığdırma, DP kilidi', () => {
  // Store eylemlerine yalnız bu testlerde casus konur; getSettings'in modül mock'u (vi.fn) restoreAllMocks ile
  // uygulamasını kaybedeceğinden casuslar tek tek geri alınır.
  const spies = [];
  const spyOn = (name, impl) => {
    const spy = vi.spyOn(useWindowStore.getState(), name).mockImplementation(impl);
    spies.push(spy);
    return spy;
  };
  beforeEach(() => {
    useWindowStore.setState({ windows: [WIN_A, WIN_B] });
  });
  afterEach(() => {
    cleanup();
    spies.splice(0).forEach((spy) => spy.mockRestore());
  });

  const group = (getByText, title) => getByText(title).closest('section');

  it('çözünürlük seçimi YALNIZ odaktaki pencereye yazılır; genel ayar kaydedilmez', async () => {
    const { saveSettings } = await import('../src/settings/settingsApi.js');
    saveSettings.mockClear();
    const spy = spyOn('setWindowOverride', async () => {});
    const { getByText } = renderPanel();
    await act(async () => {});

    fireEvent.click(within(group(getByText, 'Çözünürlük Stratejisi')).getByText('Dinamik‑Fix'));
    expect(spy).toHaveBeenCalledWith('wa', 'resolution_mode', 'dynamic_fix', { apply: true });
    expect(saveSettings).not.toHaveBeenCalledWith(expect.objectContaining({ resolution_mode: expect.anything() }));

    fireEvent.click(within(group(getByText, 'Çözünürlük Stratejisi')).getByText('Genele uy'));
    expect(spy).toHaveBeenLastCalledWith('wa', 'resolution_mode', null, { apply: true });
  });

  it('odak değişince seçili değer o pencerenin kendi değerine geçer', () => {
    setWindows([
      { ...WIN_A, overrides: { resolution_mode: '1080p' } },
      { ...WIN_B, overrides: {} },
    ]);
    const { getByText } = renderPanel();
    const chip = (label) => within(group(getByText, 'Çözünürlük Stratejisi')).getByRole('button', { name: new RegExp(label) });
    expect(chip('1080p')).toHaveAttribute('aria-pressed', 'true');

    setWindows([
      { ...WIN_A, focused: false, overrides: { resolution_mode: '1080p' } },
      { ...WIN_B, focused: true, overrides: {} },
    ]);
    expect(chip('1080p')).toHaveAttribute('aria-pressed', 'false');
    expect(chip('Genele uy')).toHaveAttribute('aria-pressed', 'true');
  });

  it('DP kilidi pencereye üç durumlu yazılır (Genele uy / Kilitli / Serbest)', () => {
    const spy = spyOn('setWindowOverride', async () => {});
    const { getByText } = renderPanel();
    const lock = group(getByText, 'Flex DP Kilidi');
    fireEvent.click(within(lock).getByText('Kilitli'));
    expect(spy).toHaveBeenLastCalledWith('wa', 'dp_lock_enabled', true, expect.anything());
    fireEvent.click(within(lock).getByText('Serbest'));
    expect(spy).toHaveBeenLastCalledWith('wa', 'dp_lock_enabled', false, expect.anything());
    fireEvent.click(within(lock).getByText('Genele uy'));
    expect(spy).toHaveBeenLastCalledWith('wa', 'dp_lock_enabled', null, expect.anything());
  });

  it('görüntü sığdırma pencerenin kendi kipine yazılır', () => {
    const spy = spyOn('setWindowFitMode', () => {});
    const { getByText } = renderPanel();
    fireEvent.click(within(group(getByText, 'Görüntü Sığdırma')).getByText('1.25× yakın'));
    expect(spy).toHaveBeenCalledWith('wa', 'zoom125');
  });
});
