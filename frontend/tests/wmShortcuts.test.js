// Pencere yöneticisi kısayolları: tek tanıma tablosu, Ctrl+Alt+D ve
// "uygulanan kısayol telefona ASLA gitmez" sözleşmesi.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { WM_ACTIONS, matchWmShortcut } from '../src/window/wmShortcuts.js';
import { isWindowManagerShortcut } from '../src/input/keyboardInject.js';
import { useWindowStore } from '../src/window/windowStore.js';
import { useSystemStore } from '../src/state/systemStore.js';

const ev = (props) => ({
  key: '',
  code: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  preventDefault: vi.fn(),
  ...props,
});

describe('matchWmShortcut', () => {
  it.each([
    [{ altKey: true, key: 'Tab' }, WM_ACTIONS.altTab],
    [{ altKey: true, shiftKey: true, key: 'Tab' }, WM_ACTIONS.altTab],
    [{ ctrlKey: true, key: 'w' }, WM_ACTIONS.closeWindow],
    [{ ctrlKey: true, key: 'W' }, WM_ACTIONS.closeWindow],
    [{ ctrlKey: true, key: 'm' }, WM_ACTIONS.minimizeWindow],
    [{ ctrlKey: true, shiftKey: true, key: 'F' }, WM_ACTIONS.fullscreen],
    [{ ctrlKey: true, altKey: true, key: 'ArrowUp' }, WM_ACTIONS.workspaceArrow],
    [{ ctrlKey: true, altKey: true, key: 'ArrowDown' }, WM_ACTIONS.workspaceArrow],
    [{ ctrlKey: true, altKey: true, key: 'd' }, WM_ACTIONS.dexQuickPanel],
    [{ ctrlKey: true, altKey: true, key: 'D' }, WM_ACTIONS.dexQuickPanel],
    [{ metaKey: true, key: 'd' }, WM_ACTIONS.showDesktop],
    [{ ctrlKey: true, shiftKey: true, key: 'D' }, WM_ACTIONS.showDesktop],
  ])('%o → %s', (props, expected) => {
    expect(matchWmShortcut(ev(props))).toBe(expected);
  });

  it('Ctrl+Alt+D, `key` AltGr yüzünden başka bir karakter olsa da fiziksel D tuşuyla (code) tanınır', () => {
    expect(matchWmShortcut(ev({ ctrlKey: true, altKey: true, key: '∂', code: 'KeyD' }))).toBe(WM_ACTIONS.dexQuickPanel);
  });

  it('Ctrl+Alt+D, Ctrl+Alt+Ok ile ve Ctrl+Shift+D (masaüstünü göster) ile çakışmaz', () => {
    expect(matchWmShortcut(ev({ ctrlKey: true, altKey: true, key: 'd' }))).not.toBe(WM_ACTIONS.showDesktop);
    expect(matchWmShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'd' }))).toBe(WM_ACTIONS.showDesktop);
    expect(matchWmShortcut(ev({ ctrlKey: true, altKey: true, shiftKey: true, key: 'd' }))).not.toBe(WM_ACTIONS.dexQuickPanel);
  });

  it.each([
    [{ key: 'a' }],
    [{ ctrlKey: true, key: 'k' }], // AppLauncher (Launchpad): App.jsx kendisi işler
    [{ ctrlKey: true, key: 'c' }], // telefona gitmesi GEREKEN panoya kopyalama
    [{ ctrlKey: true, key: 'd' }], // Ctrl+D tek başına telefonundur
    [{ altKey: true, key: 'd' }],
    [{ key: 'Escape' }], // durum gerektirir; tabloda değil
    [{ key: 'F11' }],
  ])('%o tanınmaz', (props) => {
    expect(matchWmShortcut(ev(props))).toBeNull();
  });

  it('bozuk olay (key yok) güvenle null döner', () => {
    expect(matchWmShortcut({})).toBeNull();
    expect(matchWmShortcut(null)).toBeNull();
  });
});

describe('handleWindowManagerShortcut — Ctrl+Alt+D', () => {
  beforeEach(() => {
    useSystemStore.setState({ dexQuickOpen: false });
    useWindowStore.setState({ windows: [] });
  });

  it('DeX hızlı ayar panelini açar/kapatır, olayı tüketir', () => {
    const open = ev({ ctrlKey: true, altKey: true, key: 'd' });
    expect(useWindowStore.getState().handleWindowManagerShortcut(open)).toBe(true);
    expect(open.preventDefault).toHaveBeenCalled();
    expect(useSystemStore.getState().dexQuickOpen).toBe(true);

    expect(useWindowStore.getState().handleWindowManagerShortcut(ev({ ctrlKey: true, altKey: true, key: 'd' }))).toBe(true);
    expect(useSystemStore.getState().dexQuickOpen).toBe(false);
  });

  it('tam ekran pencere varken de çalışır (görev çubuğu gizli olsa bile panele ulaşılır)', () => {
    useWindowStore.setState({
      windows: [{ id: 'w1', package: 'com.app', fullscreen: true, focused: true, minimized: false }],
    });
    useWindowStore.getState().handleWindowManagerShortcut(ev({ ctrlKey: true, altKey: true, key: 'd' }));
    expect(useSystemStore.getState().dexQuickOpen).toBe(true);
  });
});

describe('Sözleşme: uygulanan kısayol telefona İLETİLMEZ (uygulama ⇔ enjeksiyon dışı)', () => {
  beforeEach(() => {
    useSystemStore.setState({ dexQuickOpen: false });
    useWindowStore.setState({ windows: [] });
  });

  const KEYS = ['Tab', 'w', 'W', 'm', 'f', 'F', 'd', 'D', 'ArrowUp', 'ArrowDown', 'a', 'k', 'Escape', 'Enter'];

  it('modifier × tuş matrisinde: store tüketti ⇔ isWindowManagerShortcut true', () => {
    let checked = 0;
    for (const key of KEYS) {
      for (let mask = 0; mask < 16; mask += 1) {
        const props = {
          key,
          code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
          ctrlKey: Boolean(mask & 1),
          altKey: Boolean(mask & 2),
          shiftKey: Boolean(mask & 4),
          metaKey: Boolean(mask & 8),
        };
        const event = ev(props);
        const consumed = useWindowStore.getState().handleWindowManagerShortcut(event);
        const forwarded = !isWindowManagerShortcut(ev(props));
        // Esc yalnız tam ekran pencere varken tüketilir (bu matriste pencere yok) → ikisi de "iletilir" der.
        expect(consumed, JSON.stringify(props)).toBe(!forwarded);
        checked += 1;
      }
    }
    expect(checked).toBe(KEYS.length * 16);
  });

  it('eskiden telefona sızan kısayollar artık enjekte edilmez: Ctrl+M, Ctrl+Shift+F, Ctrl+Alt+Ok, Ctrl+Alt+D', () => {
    expect(isWindowManagerShortcut(ev({ ctrlKey: true, key: 'm' }))).toBe(true);
    expect(isWindowManagerShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'F' }))).toBe(true);
    expect(isWindowManagerShortcut(ev({ ctrlKey: true, altKey: true, key: 'ArrowUp' }))).toBe(true);
    expect(isWindowManagerShortcut(ev({ ctrlKey: true, altKey: true, key: 'd' }))).toBe(true);
  });

  it('telefona gitmesi gereken tuşlar enjekte edilmeye devam eder (Ctrl+C, Ctrl+V, harfler, Esc)', () => {
    for (const props of [{ ctrlKey: true, key: 'c' }, { ctrlKey: true, key: 'v' }, { key: 'a' }, { key: 'Escape' }]) {
      expect(isWindowManagerShortcut(ev(props))).toBe(false);
    }
  });
});

describe('Ctrl+G (tuş düzenini aç / kapat)', () => {
  it('yalnız KAYITLI bir tuş düzeni olan pencerede tanınır; yoksa tuş uygulamanındır', () => {
    const e = ev({ ctrlKey: true, key: 'g' });
    expect(matchWmShortcut(e, { layout: true })).toBe(WM_ACTIONS.toggleKeymap);
    expect(matchWmShortcut(e)).toBeNull();
    expect(matchWmShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'G' }), { layout: true })).toBeNull();
    expect(isWindowManagerShortcut(e, { layout: true })).toBe(true);
  });

  it('oyun kipindeyken de çalışır (düzenden çıkmanın tek yolu bu)', () => {
    expect(matchWmShortcut(ev({ ctrlKey: true, key: 'g' }), { game: true, layout: true })).toBe(WM_ACTIONS.toggleKeymap);
  });
});

describe('Ctrl+G uygulanışı', () => {
  it('odaktaki pencerenin düzenini kapatır, tekrar basınca açar; düzeni olmayan pencerede tuşu tüketmez', async () => {
    const { useKeymapStore } = await import('../src/keymapper/keymapStore.js');
    const node = { id: 'n1', type: 'tap', key: 'KeyF', x: 0.5, y: 0.5, enabled: true };
    useKeymapStore.setState({ presets: { 'com.game': [node] }, layoutOff: {}, windowOwned: {} });
    useWindowStore.setState({ windows: [{ id: 'w1', package: 'com.game', focused: true, minimized: false }] });
    const press = () => {
      const e = ev({ ctrlKey: true, key: 'g' });
      return [useWindowStore.getState().handleWindowManagerShortcut(e), e];
    };

    expect(press()[0]).toBe(true);
    expect(useKeymapStore.getState().layoutOff['com.game']).toBe(true);
    expect(press()[0]).toBe(true);
    expect(useKeymapStore.getState().layoutOff['com.game']).toBeUndefined();

    useKeymapStore.setState({ presets: {}, layoutOff: {} });
    const [consumed, event] = press();
    expect(consumed).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe('Win+Ok / Alt+Shift+Ok yerleştirme', () => {
  it.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])('%s: Win ile de Alt+Shift ile de tanınır, telefona gitmez', (key) => {
    expect(matchWmShortcut(ev({ metaKey: true, key }))).toBe(WM_ACTIONS.snapArrow);
    expect(matchWmShortcut(ev({ altKey: true, shiftKey: true, key }))).toBe(WM_ACTIONS.snapArrow);
    expect(isWindowManagerShortcut(ev({ metaKey: true, key }))).toBe(true);
  });

  it('düz ok, Ctrl/Shift/Alt tek başına ve Ctrl+Alt+Ok (Workspace) karışmaz; oyun kipinde Alt+Shift+Ok oyunundur', () => {
    for (const props of [{}, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { ctrlKey: true, shiftKey: true }]) {
      expect(matchWmShortcut(ev({ key: 'ArrowUp', ...props }))).not.toBe(WM_ACTIONS.snapArrow);
    }
    expect(matchWmShortcut(ev({ ctrlKey: true, altKey: true, key: 'ArrowUp' }))).toBe(WM_ACTIONS.workspaceArrow);
    expect(matchWmShortcut(ev({ altKey: true, shiftKey: true, key: 'ArrowLeft' }), { game: true })).toBeNull();
    expect(matchWmShortcut(ev({ metaKey: true, key: 'ArrowLeft' }), { game: true })).toBe(WM_ACTIONS.snapArrow);
  });

  it('odaktaki pencereyi yerleştirir (sol yarı → sol-üst), odaklı pencere yoksa tuşu yine de tüketir', () => {
    const moveWindowByArrow = vi.fn();
    useWindowStore.setState({ windows: [{ id: 'w1', package: 'a', focused: true, minimized: false }], moveWindowByArrow });
    const e = ev({ metaKey: true, key: 'ArrowLeft' });
    expect(useWindowStore.getState().handleWindowManagerShortcut(e)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(moveWindowByArrow).toHaveBeenCalledWith('w1', 'ArrowLeft');

    moveWindowByArrow.mockClear();
    useWindowStore.setState({ windows: [] });
    expect(useWindowStore.getState().handleWindowManagerShortcut(ev({ metaKey: true, key: 'ArrowUp' }))).toBe(true);
    expect(moveWindowByArrow).not.toHaveBeenCalled();
  });
});
