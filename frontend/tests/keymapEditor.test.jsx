// Tuş düzeni atölyesi ve oyun içi HUD (OYUN_TUS_DUZENI_TASARIM_PLANI.md): ekleme + "bir tuşa bas" ataması, sürükle/yapış, kısayollar,
// geri al, test modu, şablon, aktarma, çakışma uyarısı ve kaplamanın videonun GERÇEK dikdörtgenine oturması.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import KeymapperOverlay from '../src/keymapper/KeymapperOverlay.jsx';
import { DEFAULT_MOUSE_PREFS, DEFAULT_UI_PREFS, useKeymapStore } from '../src/keymapper/keymapStore.js';
import { handleKeymapperInput, releaseKeymapperInput } from '../src/keymapper/keymapperEngine.js';
import { fitRect } from '../src/keymapper/model.js';

const PKG = 'com.game';
const WIN = { id: 'w1', package: PKG, deviceW: 1000, deviceH: 500 };
const FIRE = { id: 'fire', type: 'tap', key: 'f', label: 'Ateş', rx: 0.5, ry: 0.5 };
const nodes = () => useKeymapStore.getState().presets[PKG] || [];
const byId = (id) => nodes().find((n) => n.id === id);

const renderEditor = (props = {}) => {
  const onClose = vi.fn();
  const view = render(<KeymapperOverlay win={WIN} isEditing onCloseEdit={onClose} {...props} />);
  return { ...view, onClose };
};
const node = (id) => document.querySelector(`[data-node-id="${id}"]`);
const select = (id) => fireEvent.pointerDown(node(id), { button: 0 });
const press = (key, init = {}) => fireEvent.keyDown(window, { key, ...init });
const frameWithRect = (width = 1000, height = 500) => {
  const frame = screen.getByTestId('keymap-frame');
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 });
  return frame;
};

beforeEach(() => {
  localStorage.clear();
  releaseKeymapperInput(WIN.id, { up() {} });
  useKeymapStore.setState({
    presets: { [PKG]: [{ ...FIRE }] },
    layoutOff: {},
    windowOwned: {},
    userTemplates: [],
    history: {},
    prefs: { ...DEFAULT_MOUSE_PREFS },
    uiPrefs: { ...DEFAULT_UI_PREFS, snap: false },
    editWindowId: null,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Atölye — düğüm ekleme ve "bir tuşa bas" ataması', () => {
  it('"+ Tuş" yeni düğümü ekler, seçer ve HEMEN tuş dinlemeye başlar; basılan tuş atanır', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Tuş ekle' }));
    expect(nodes()).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent(/Bir tuşa bas/);

    press('g');
    expect(nodes()[1]).toMatchObject({ type: 'tap', key: 'g' });
    expect(screen.queryByRole('status')).toBeNull();   // dinleme bitti
  });

  it('Ctrl / Esc / Meta atanamaz: uyarı gösterir ve dinlemeye devam eder; geçerli tuş sonra atanır', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Tuş ekle' }));
    press('Control', { ctrlKey: true });
    expect(screen.getByRole('status')).toHaveTextContent(/atanamaz/);
    expect(nodes()[1].key).toBe('Space');
    press('Shift');
    expect(nodes()[1].key).toBe('Shift');
  });

  it('dinlerken fare düğmesi ve tekerlek de atanır (sol tık = ateş, tekerlek = silah değiştir)', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Tuş ekle' }));
    fireEvent.pointerDown(document.body, { button: 0 });
    expect(nodes()[1].key).toBe('MouseLeft');

    select(nodes()[1].id);
    fireEvent.click(screen.getByRole('button', { name: 'Tuş ata' }));
    fireEvent.pointerDown(document.body, { button: 4 });
    expect(nodes()[1].key).toBe('MouseForward');

    fireEvent.click(screen.getByRole('button', { name: 'Tuş ata' }));
    fireEvent.wheel(document.body, { deltaY: -120 });
    expect(nodes()[1].key).toBe('WheelUp');
  });

  it('dinlerken aynı düğmeye tekrar basmak vazgeçirir; atama değişmez', () => {
    renderEditor();
    select('fire');
    const capture = screen.getByRole('button', { name: 'Tuş ata' });
    fireEvent.click(capture);
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.pointerDown(capture, { button: 0 });
    expect(screen.queryByRole('status')).toBeNull();
    expect(byId('fire').key).toBe('f');
  });

  it('"Tuş tanı" düğmesine basmak vazgeçirir ve ardından gelen click dinlemeyi yeniden açmaz', () => {
    renderEditor();
    select('fire');
    const detect = screen.getByRole('button', { name: 'Tuş ata' });
    fireEvent.click(detect);
    fireEvent.pointerDown(detect, { button: 0 });
    fireEvent.click(detect);                                   // gerçek fare: basış + click
    expect(screen.queryByRole('status')).toBeNull();
    expect(byId('fire').key).toBe('f');
  });

  it('ekran klavyesi: klavye simgesi açar, harfe ve fare düğmelerine tıklamak atar', () => {
    renderEditor();
    select('fire');
    expect(screen.queryByTestId('key-picker')).toBeNull();
    fireEvent.click(screen.getByTestId('key-picker-toggle'));
    const picker = screen.getByTestId('key-picker');
    fireEvent.click(picker.querySelector('[data-key="ı"]'));
    expect(byId('fire').key).toBe('ı');
    expect(screen.queryByTestId('key-picker')).toBeNull();      // seçince kapanır

    fireEvent.click(screen.getByTestId('key-picker-toggle'));
    fireEvent.click(screen.getByTestId('key-picker').querySelector('[data-key="MouseLeft"]'));
    expect(byId('fire').key).toBe('MouseLeft');
    expect(screen.getByTestId('key-value')).toHaveTextContent('Fare sol tık');

    fireEvent.click(screen.getByTestId('key-picker-toggle'));
    fireEvent.click(screen.getByTestId('key-picker').querySelector('[data-key="MouseRight"]'));
    expect(byId('fire').key).toBe('MouseRight');
    fireEvent.click(screen.getByTestId('key-picker-toggle'));
    expect(screen.getByTestId('key-picker').querySelector('[data-key="MouseRight"]')).toHaveAttribute('aria-pressed', 'true');
  });

  it('yürü tuşunun ekran klavyesinde fare düğmesi yok (fare tuşu yürü tuşu olamaz)', () => {
    useKeymapStore.setState({ presets: { [PKG]: [{ id: 'j', type: 'dpad', rx: 0.2, ry: 0.7 }] } });
    renderEditor();
    select('j');
    fireEvent.click(screen.getAllByTestId('key-picker-toggle')[0]);
    expect(screen.getByTestId('key-picker').querySelector('[data-key="MouseLeft"]')).toBeNull();
    expect(screen.getByTestId('key-picker').querySelector('[data-key="Shift"]')).not.toBeNull();
  });

  it('joystick ve bakış tek olur: ikinci tıklama yenisini eklemez, varolanı seçer', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Joystick ekle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bakış alanı ekle' }));
    expect(nodes().map((n) => n.type)).toEqual(['tap', 'dpad', 'look']);
    fireEvent.click(screen.getByRole('button', { name: 'Joystick ekle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bakış alanı ekle' }));
    expect(nodes()).toHaveLength(3);
    expect(document.querySelector('[data-node-type="look"]')).not.toBeNull();   // düzenlerken görünür
  });

  it('yeni düğümler üst üste binmez (boş yere konur)', () => {
    renderEditor();
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Tuş ekle' }));
      press(String.fromCharCode(103 + i));   // g h i
    }
    const taps = nodes();
    for (let a = 0; a < taps.length; a++) {
      for (let b = a + 1; b < taps.length; b++) {
        expect(Math.hypot((taps[a].rx - taps[b].rx) * 1.78, taps[a].ry - taps[b].ry)).toBeGreaterThanOrEqual(0.1);
      }
    }
  });
});

describe('Atölye — denetçi', () => {
  it('seçili düğümün konumu yüzde olarak girilir; vuruş noktası cihaz pikselinde okunur', () => {
    renderEditor();
    select('fire');
    expect(screen.getByTestId('hit-readout')).toHaveTextContent('500 × 250 px');
    const x = screen.getByRole('textbox', { name: 'X' });
    fireEvent.change(x, { target: { value: '30' } });
    fireEvent.blur(x);
    expect(byId('fire').rx).toBe(0.3);
    expect(screen.getByTestId('hit-readout')).toHaveTextContent('300 × 250 px');

    fireEvent.change(x, { target: { value: 'abc' } });   // geçersiz giriş uygulanmaz, eski değere döner
    fireEvent.blur(x);
    expect(byId('fire').rx).toBe(0.3);
    expect(x).toHaveValue('30.0');

    fireEvent.change(x, { target: { value: '500' } });   // sınıra sıkışır
    fireEvent.blur(x);
    expect(byId('fire').rx).toBe(0.98);
  });

  it('davranış (basılı tut / bas-aç) ve etiket yazılır', () => {
    renderEditor();
    select('fire');
    expect(screen.getByTestId('mode-help')).toHaveTextContent(/bıraktığında kalkar/);
    fireEvent.click(screen.getByRole('radio', { name: /Bas-aç/ }));
    expect(byId('fire').mode).toBe('toggle');
    expect(screen.getByTestId('mode-help')).toHaveTextContent(/ikinci kez basana kadar/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Etiket' }), { target: { value: 'Koş' } });
    expect(byId('fire').label).toBe('Koş');
  });

  it('seçim yokken düzen özeti: fareyle bakış anahtarı ve genel duyarlılık', () => {
    renderEditor();
    const inspector = screen.getByTestId('keymap-inspector');
    expect(within(inspector).getByText('Düzen')).toBeInTheDocument();
    expect(useKeymapStore.getState().prefs.mouseLook).toBe(true);                       // varsayılan açık
    expect(within(inspector).getByText('Genel duyarlılık')).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole('switch', { name: 'Fareyle bakış' }));
    expect(useKeymapStore.getState().prefs.mouseLook).toBe(false);
    expect(within(inspector).queryByText('Genel duyarlılık')).toBeNull();
  });

  it('telefon boyutundaki dar pencerede de seçim yokken denetçi görünür (kaybolmaz)', () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb) { this.cb = cb; }
      observe() { this.cb([{ contentRect: { width: 400, height: 700 } }]); }
      disconnect() {}
    };
    try {
      renderEditor();
      expect(screen.getByTestId('keymap-inspector')).toBeInTheDocument();
      expect(screen.getByTestId('keymap-toolbar')).toBeInTheDocument();
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('boş alana basmak seçimi kaldırır (denetçi düzen özetine döner)', () => {
    renderEditor();
    select('fire');
    expect(screen.getByTestId('hit-readout')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByTestId('keymap-frame'), { button: 0 });
    expect(screen.queryByTestId('hit-readout')).toBeNull();
  });

  it('joystick: şema, yürü tuşu ve menzil alanları; bakış: yatay/dikey duyarlılık ve ters çevirme', () => {
    useKeymapStore.setState({ presets: { [PKG]: [
      { id: 'j', type: 'dpad', rx: 0.2, ry: 0.7, radius: 0.12 },
      { id: 'l', type: 'look', rx: 0.7, ry: 0.5, radius: 0.18 },
    ] } });
    renderEditor();
    select('j');
    fireEvent.click(screen.getByRole('radio', { name: 'ESDF' }));
    expect(byId('j').scheme).toBe('esdf');
    expect(screen.getByRole('button', { name: 'Yürü tuşu' })).toBeInTheDocument();
    expect(screen.queryByText('Yürüyüş oranı')).toBeNull();   // yürü tuşu yokken oran gizli
    fireEvent.click(screen.getByRole('button', { name: 'Yürü tuşu' }));
    press('Shift');
    expect(byId('j').walkKey).toBe('Shift');
    expect(screen.getByText('Yürüyüş oranı')).toBeInTheDocument();

    select('l');
    expect(screen.getByText('Yatay duyarlılık')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Dikey ekseni ters çevir' }));
    expect(byId('l').invertY).toBe(true);
  });
});

describe('Atölye — sürükle, yapış, boyutlandır', () => {
  it('sürükleme konumu günceller ve TEK geri alma adımı olur; tıklama (3 px altı) konumu bozmaz', () => {
    renderEditor();
    const frame = frameWithRect();
    fireEvent.pointerDown(node('fire'), { button: 0, clientX: 500, clientY: 250 });
    fireEvent.pointerMove(window, { clientX: 501, clientY: 251 });
    fireEvent.pointerUp(window);
    expect(byId('fire')).toMatchObject({ rx: 0.5, ry: 0.5 });
    expect(useKeymapStore.getState().history[PKG]).toBeUndefined();   // hiçbir şey yazılmadı

    fireEvent.pointerDown(node('fire'), { button: 0, clientX: 500, clientY: 250 });
    fireEvent.pointerMove(window, { clientX: 700, clientY: 100 });
    expect(frame).toBeTruthy();
    fireEvent.pointerUp(window);
    expect(byId('fire')).toMatchObject({ rx: 0.7, ry: 0.2 });
    expect(useKeymapStore.getState().history[PKG].past).toHaveLength(1);
  });

  it('düğümü tuttuğun noktadan sürüklersin: merkez imlece sıçramaz', () => {
    renderEditor();
    frameWithRect();
    fireEvent.pointerDown(node('fire'), { button: 0, clientX: 520, clientY: 260 });   // merkezin 20/10 px sağ-altından tuttu
    fireEvent.pointerMove(window, { clientX: 720, clientY: 160 });
    fireEvent.pointerUp(window);
    expect(byId('fire')).toMatchObject({ rx: 0.7, ry: 0.3 });   // 720-20 → 0,7 · 160-10 → 0,3
  });

  it('yapışma açıkken merkez çizgisine yapışır ve hiza çizgisi gösterilir; Alt basılıyken yapışmaz', () => {
    useKeymapStore.getState().setUiPrefs({ snap: true });
    useKeymapStore.setState({ presets: { [PKG]: [{ ...FIRE, rx: 0.3, ry: 0.3 }] } });
    renderEditor();
    frameWithRect();
    fireEvent.pointerDown(node('fire'), { button: 0, clientX: 300, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 503, clientY: 150 });
    expect(document.querySelector('[data-guide="x"]')).not.toBeNull();
    fireEvent.pointerUp(window);
    expect(byId('fire').rx).toBe(0.5);
    expect(document.querySelector('[data-guide="x"]')).toBeNull();

    fireEvent.pointerDown(node('fire'), { button: 0, clientX: 500, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 503, clientY: 150, altKey: true });
    fireEvent.pointerUp(window);
    expect(byId('fire').rx).toBeCloseTo(0.503, 3);
  });

  it('boyut tutamacı sürüklenince halka boyutu gerçek cihaz pikseline göre değişir ve sınırlanır', () => {
    renderEditor();
    frameWithRect();
    select('fire');
    fireEvent.pointerUp(window);   // seçmek için basış bir sürükleme jesti başlatır; gerçekte bırakış her zaman gelir
    const handle = document.querySelector('[data-resize-handle]');
    fireEvent.pointerDown(handle, { button: 0, clientX: 523, clientY: 250 });
    fireEvent.pointerMove(window, { clientX: 625, clientY: 250 });   // merkezden 125 px → 125 / 500 (kısa kenar) = 0,25 → üst sınır
    fireEvent.pointerUp(window);
    expect(byId('fire').size).toBe(0.12);

    fireEvent.pointerDown(document.querySelector('[data-resize-handle]'), { button: 0, clientX: 530, clientY: 250 });
    fireEvent.pointerMove(window, { clientX: 525, clientY: 250 });   // 25 px → 0,05
    fireEvent.pointerUp(window);
    expect(byId('fire').size).toBe(0.05);
  });
});

describe('Atölye — kısayollar ve geri al', () => {
  it('ok tuşları 0,5 % kaydırır, Shift ile 0,1 %; Del siler; Ctrl+D çoğaltır; Ctrl+Z/Y geri alır/yineler', () => {
    renderEditor();
    select('fire');
    press('ArrowRight');
    expect(byId('fire').rx).toBeCloseTo(0.505, 4);
    press('ArrowUp', { shiftKey: true });
    expect(byId('fire').ry).toBeCloseTo(0.499, 4);

    press('d', { ctrlKey: true });
    expect(nodes()).toHaveLength(2);
    press('Delete');
    expect(nodes()).toHaveLength(1);
    expect(byId('fire')).toBeDefined();

    press('z', { ctrlKey: true });   // silmeyi geri al
    expect(nodes()).toHaveLength(2);
    press('y', { ctrlKey: true });   // yinele
    expect(nodes()).toHaveLength(1);
    press('z', { ctrlKey: true, shiftKey: true });   // Ctrl+Shift+Z de geri alınanı yineler (önce geri al)
  });

  it('ardışık ok tuşu basışları tek geri alma adımıdır', () => {
    renderEditor();
    select('fire');
    for (let i = 0; i < 8; i++) press('ArrowLeft');
    expect(byId('fire').rx).toBeCloseTo(0.46, 3);
    press('z', { ctrlKey: true });
    expect(byId('fire').rx).toBe(0.5);
  });

  it('yazı alanındayken (X/Y, etiket) kısayollar çalışmaz: Delete düğümü silmez', () => {
    renderEditor();
    select('fire');
    const label = screen.getByRole('textbox', { name: 'Etiket' });
    label.focus();
    fireEvent.keyDown(label, { key: 'Delete' });
    fireEvent.keyDown(label, { key: 'ArrowRight' });
    expect(nodes()).toHaveLength(1);
    expect(byId('fire').rx).toBe(0.5);
  });

  it('tuş dinlenirken ok/Del kısayolları çalışmaz: ArrowRight tuşu atanabilir, düğümü kaydırmaz', () => {
    renderEditor();
    select('fire');
    fireEvent.click(screen.getByRole('button', { name: 'Tuş ata' }));
    press('ArrowRight');
    expect(byId('fire')).toMatchObject({ key: 'ArrowRight', rx: 0.5 });
  });

  it('araç çubuğundaki geri al / yinele düğmeleri geçmişe göre açılıp kapanır', () => {
    renderEditor();
    const undo = screen.getByRole('button', { name: 'Geri al (Ctrl+Z)' });
    const redo = screen.getByRole('button', { name: 'Yinele (Ctrl+Y)' });
    expect(undo).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Tuş ekle' }));
    press('g');
    expect(undo).not.toBeDisabled();
    fireEvent.click(undo);
    fireEvent.click(undo);
    expect(nodes()).toHaveLength(1);
    expect(redo).not.toBeDisabled();
  });
});

describe('Atölye — açılır menü', () => {
  it('"Daha fazla" menüsü OPAK bir yüzeydir (şeffaf değil) ve denetçinin üstünde katmanlanır', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla' }));
    const menu = screen.getByRole('menu');
    expect(menu.className).toMatch(/(^| )bg-popover( |$)/);   // 'bg-popover/98' Tailwind'de yok: şeffaf kalırdı
    const topBar = menu.closest('[data-workbench-chrome]');
    const inspector = screen.getByTestId('keymap-inspector');
    const z = (el) => Number((el.className.match(/(?:^| )z-(\d+)/) || [])[1]);
    expect(z(topBar)).toBeGreaterThan(z(inspector));
  });
});

describe('Atölye — çakışma uyarısı', () => {
  it('aynı tuşu dinleyen iki düğüm uyarı simgesi taşır; birini değiştirince uyarı kalkar', () => {
    useKeymapStore.setState({ presets: { [PKG]: [{ ...FIRE }, { ...FIRE, id: 'dup', rx: 0.7 }] } });
    renderEditor();
    expect(screen.getAllByRole('img', { name: /Aynı tuş başka bir düğümde de var/ }).length).toBe(2);
    select('dup');
    expect(screen.getByRole('alert')).toHaveTextContent(/birbirine girer/);
    fireEvent.click(screen.getByRole('button', { name: 'Tuş ata' }));
    press('h');
    expect(screen.queryAllByRole('img', { name: /Aynı tuş başka bir düğümde de var/ })).toHaveLength(0);
  });

  it('joystick tuşlarına bağlanan tuş uyarılır (W joystick de)', () => {
    useKeymapStore.setState({ presets: { [PKG]: [{ id: 'j', type: 'dpad', rx: 0.2, ry: 0.7 }, { ...FIRE, key: 'w' }] } });
    renderEditor();
    expect(screen.getAllByRole('img', { name: /Aynı tuş başka bir düğümde de var/ }).length).toBe(2);
  });
});

describe('Atölye — test modu', () => {
  it('tuşa basınca ilgili düğüm yanar, bırakınca söner; Esc önce test modundan çıkar, düzenleyiciyi kapatmaz', () => {
    useKeymapStore.setState({ presets: { [PKG]: [{ ...FIRE }, { id: 'j', type: 'dpad', rx: 0.2, ry: 0.7 }] } });
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Test modu/ }));
    expect(screen.getByText('Testi bitir')).toBeInTheDocument();

    press('f');
    expect(node('fire').dataset.pressed).toBe('true');
    fireEvent.keyUp(window, { key: 'f' });
    expect(node('fire').dataset.pressed).toBeUndefined();

    press('d');   // joystick sağ yönü
    expect(document.querySelector('[data-node-id="j"] [class*="shadow-"]')).not.toBeNull();
    fireEvent.keyUp(window, { key: 'd' });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Testi bitir')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('test modunda fare düğmesi ve tekerlek de bağlı düğümü yakar; düzen değişmez', () => {
    useKeymapStore.setState({ presets: { [PKG]: [
      { id: 'mouse', type: 'tap', key: 'MouseLeft', rx: 0.8, ry: 0.5 },
      { id: 'wheel', type: 'tap', key: 'WheelUp', rx: 0.3, ry: 0.5 },
    ] } });
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Test modu/ }));
    fireEvent.pointerDown(document.body, { button: 0 });
    expect(node('mouse').dataset.pressed).toBe('true');
    fireEvent.pointerUp(document.body, { button: 0 });
    expect(node('mouse').dataset.pressed).toBeUndefined();

    vi.useFakeTimers();
    try {
      fireEvent.wheel(document.body, { deltaY: -120 });
      expect(node('wheel').dataset.pressed).toBe('true');
      act(() => { vi.advanceTimersByTime(200); });
      expect(node('wheel').dataset.pressed).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(nodes()).toHaveLength(2);
  });

  it('test modunda denetçi ve palet gizlenir', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Test modu/ }));
    await waitFor(() => expect(screen.queryByTestId('keymap-inspector')).toBeNull());   // çıkış animasyonu biter
    expect(screen.queryByRole('button', { name: 'Tuş ekle' })).toBeNull();
  });
});

describe('Atölye — şablon, aktarma, kopyalama, temizleme', () => {
  it('şablon seçilince düzen onun olur; Ctrl+Z eski düzeni getirir', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /Şablonlar/ }));
    fireEvent.click(await screen.findByText('Nişancı / Hayatta kalma'));
    expect(nodes().some((n) => n.type === 'dpad')).toBe(true);
    expect(nodes().length).toBeGreaterThan(8);
    press('z', { ctrlKey: true });
    expect(nodes().map((n) => n.id)).toEqual(['fire']);
  });

  it('boş düzende yönlendirme kartı görünür ve şablonlara götürür', async () => {
    useKeymapStore.setState({ presets: { [PKG]: [] } });
    renderEditor();
    expect(screen.getByText('Düzen boş')).toBeInTheDocument();
    fireEvent.click(within(screen.getByText('Düzen boş').parentElement).getByRole('button', { name: /Şablonlar/ }));
    expect(await screen.findByText('MOBA')).toBeInTheDocument();
  });

  it('dışa aktar: JSON panoya yazılır; pano yoksa uyarı verir', async () => {
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Dışa aktar/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({ format: 'opendex-keymap', nodes: [expect.objectContaining({ id: 'fire' })] });
    expect(await screen.findByText('Düzen panoya kopyalandı')).toBeInTheDocument();
  });

  it('içe aktar: geçerli metin düzeni değiştirir ve kapanır; geçersiz metin hata gösterir', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'İçe aktar' }));
    const box = await screen.findByRole('textbox', { name: 'Düzen metni' });

    fireEvent.change(box, { target: { value: 'saçma' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'İçe aktar' }).at(-1));
    expect(screen.getByRole('alert')).toHaveTextContent('Geçerli bir JSON değil');
    expect(nodes()).toHaveLength(1);

    fireEvent.change(box, { target: { value: JSON.stringify([{ type: 'tap', key: 'q', rx: 0.2, ry: 0.2 }]) } });
    fireEvent.click(screen.getAllByRole('button', { name: 'İçe aktar' }).at(-1));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Düzen metni' })).toBeNull());
    expect(nodes().map((n) => n.key)).toEqual(['q']);
  });

  it('başka uygulamadan kopyala: yalnız düzeni olan uygulamalar listelenir', async () => {
    useKeymapStore.setState({ presets: { [PKG]: [], 'com.other': [{ id: 'o', type: 'tap', key: 'x', rx: 0.4, ry: 0.4 }], 'com.empty': [] } });
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Başka uygulamadan kopyala' }));
    expect(await screen.findByText('com.other')).toBeInTheDocument();
    expect(screen.queryByText('com.empty')).toBeNull();
    fireEvent.click(document.querySelector('[data-copy-from="com.other"]'));
    expect(nodes().map((n) => n.key)).toEqual(['x']);
  });

  it('temizle iki adımdır: ilk tıklama onay ister, ikincisi temizler; geri alınabilir', async () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla' }));
    const clear = screen.getByRole('menuitem', { name: 'Tüm tuşları temizle' });
    fireEvent.click(clear);
    expect(nodes()).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Emin misin? Tekrar tıkla' }));
    expect(nodes()).toHaveLength(0);
    press('z', { ctrlKey: true });
    expect(nodes()).toHaveLength(1);
  });
});

describe('Kaplama videonun gerçek dikdörtgenine oturur', () => {
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe() { this.callback([{ contentRect: { width: 800, height: 450 } }]); }
    disconnect() {}
  }
  const frameBox = (container) => {
    const style = container.querySelector('[data-keymap-frame]').style;
    return { left: parseFloat(style.left), top: parseFloat(style.top), width: parseFloat(style.width), height: parseFloat(style.height) };
  };

  it('object-contain: portre cihaz yatay kutuda ortalanır (harf kutusu); düğümler bu dikdörtgenin yüzdesidir', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const win = { ...WIN, deviceW: 1220, deviceH: 2712 };
    const { container } = render(<KeymapperOverlay win={win} isEditing={false} fit={{ css: 'object-contain', zoom: 1 }} />);
    const want = fitRect(800, 450, 1220, 2712, 'object-contain', 1);
    const got = frameBox(container);
    expect(got.left).toBeCloseTo(want.left, 1);
    expect(got.width).toBeCloseTo(want.width, 1);
    expect(got.height).toBe(450);
    expect(got.left).toBeGreaterThan(250);   // kenarlarda boşluk var: kaplama kabın tamamına yaslanmaz
    expect(container.querySelector('[data-node-id="fire"]').style.left).toBe('50%');
  });

  it('object-fill kabın tamamıdır; yakınlaştırma çerçeveyi merkezden büyütür', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const fill = render(<KeymapperOverlay win={WIN} isEditing={false} fit={{ css: 'object-fill', zoom: 1 }} />);
    expect(frameBox(fill.container)).toEqual({ left: 0, top: 0, width: 800, height: 450 });
    fill.unmount();
    const zoomed = render(<KeymapperOverlay win={WIN} isEditing={false} fit={{ css: 'object-fill', zoom: 1.25 }} />);
    const box = frameBox(zoomed.container);
    expect(box.width).toBeCloseTo(1000, 1);
    expect(box.left).toBeCloseTo(-100, 1);
  });

  it('kutu henüz ölçülmediyse (ResizeObserver yok) kabın tamamını doldurur', () => {
    const { container } = render(<KeymapperOverlay win={WIN} isEditing={false} />);
    const style = container.querySelector('[data-keymap-frame]').style;
    expect(style.width).toBe('100%');
    expect(style.height).toBe('100%');
  });
});

describe('Oyun içi HUD', () => {
  it('her düğüm bir rozettir; bakış alanı oynarken yalnız silüettir (etiketsiz); tıklamayı engellemez', () => {
    useKeymapStore.setState({ presets: { [PKG]: [{ ...FIRE }, { id: 'l', type: 'look', rx: 0.7, ry: 0.5, radius: 0.18 }, { id: 'j', type: 'dpad', rx: 0.2, ry: 0.7 }] } });
    const { container } = render(<KeymapperOverlay win={WIN} isEditing={false} />);
    expect(node('fire')).not.toBeNull();
    expect(node('j')).not.toBeNull();
    expect(node('l')).not.toBeNull();                      // silüet: kesik halka
    expect(node('l').textContent).toBe('');                // etiket / ipucu yok: ekranı kirletmez
    expect(container.firstChild.className).toContain('pointer-events-none');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('motor bir tuşa bastığında rozet yanar, bıraktığında söner (canlı geri bildirim)', () => {
    render(<KeymapperOverlay win={WIN} isEditing={false} />);
    const socket = { down() {}, move() {}, up() {} };
    const event = (key) => ({ key, repeat: false, target: {}, preventDefault() {} });
    expect(node('fire').dataset.pressed).toBeUndefined();
    act(() => { handleKeymapperInput(event('f'), true, WIN.id, nodes(), socket, 1000, 500); });
    expect(node('fire').dataset.pressed).toBe('true');
    act(() => { handleKeymapperInput(event('f'), false, WIN.id, nodes(), socket, 1000, 500); });
    expect(node('fire').dataset.pressed).toBeUndefined();
  });

  it('etiketler ayardan kapatılabilir; rozet ölçeği ve saydamlık uygulanır', () => {
    useKeymapStore.getState().setUiPrefs({ showLabels: true, hudOpacity: 0.4 });
    const { rerender } = render(<KeymapperOverlay win={WIN} isEditing={false} />);
    expect(screen.getByText('Ateş')).toBeInTheDocument();
    expect(node('fire').style.opacity).toBe('0.4');
    act(() => useKeymapStore.getState().setUiPrefs({ showLabels: false }));
    rerender(<KeymapperOverlay win={WIN} isEditing={false} />);
    expect(screen.queryByText('Ateş')).toBeNull();
  });

  it('tuş kapağı kısa adı gösterir: harf büyük, fare düğmesi LMB, ok işareti', () => {
    useKeymapStore.setState({ presets: { [PKG]: [
      { id: 'a', type: 'tap', key: 'f', rx: 0.2, ry: 0.2 },
      { id: 'b', type: 'tap', key: 'MouseLeft', rx: 0.4, ry: 0.2 },
      { id: 'c', type: 'tap', key: 'ArrowUp', rx: 0.6, ry: 0.2 },
      { id: 'd', type: 'tap', key: 'Space', mode: 'toggle', rx: 0.8, ry: 0.2 },
    ] } });
    render(<KeymapperOverlay win={WIN} isEditing={false} />);
    expect(within(node('a')).getByText('F')).toBeInTheDocument();
    expect(within(node('b')).getByText('LMB')).toBeInTheDocument();
    expect(within(node('c')).getByText('↑')).toBeInTheDocument();
    expect(within(node('d')).getByText('Space')).toBeInTheDocument();
  });
});

describe('Etkin / devre dışı', () => {
  it('düğümde "Etkin" anahtarı: kapatınca düğüm düzende kalır, atölyede soluk görünür, oyunda çizilmez', () => {
    const { unmount } = renderEditor();
    select('fire');
    const inspector = screen.getByTestId('keymap-inspector');
    const toggle = within(inspector).getByRole('switch', { name: 'Etkin' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    expect(byId('fire').enabled).toBe(false);
    expect(nodes()).toHaveLength(1);                                         // silinmedi
    expect(within(inspector).getByText(/düzende kalır ama çalışmaz/)).toBeInTheDocument();
    expect(node('fire').className).toContain('grayscale');
    expect(node('fire').style.opacity).toBe('0.4');
    unmount();

    render(<KeymapperOverlay win={WIN} isEditing={false} />);
    expect(node('fire')).toBeNull();                                         // oyunda yok
  });

  it('devre dışı düğüm çakışma uyarısı vermez; tekrar açınca uyarı geri gelir', () => {
    useKeymapStore.setState({ presets: { [PKG]: [{ ...FIRE }, { ...FIRE, id: 'dup', rx: 0.7 }] } });
    renderEditor();
    expect(screen.getAllByRole('img', { name: /Aynı tuş başka bir düğümde de var/ })).toHaveLength(2);
    select('dup');
    fireEvent.click(within(screen.getByTestId('keymap-inspector')).getByRole('switch', { name: 'Etkin' }));
    expect(screen.queryAllByRole('img', { name: /Aynı tuş başka bir düğümde de var/ })).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId('keymap-inspector')).getByRole('switch', { name: 'Etkin' }));
    expect(screen.getAllByRole('img', { name: /Aynı tuş başka bir düğümde de var/ })).toHaveLength(2);
  });

  it('araç çubuğundaki güç düğmesi tüm düzeni kapatır: düğümler soluk, düzen özetinde açıklama; tekrar açılır; geri al geçmişine girmez', () => {
    renderEditor();
    const power = screen.getByTestId('layout-toggle');
    expect(power).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(power);
    expect(useKeymapStore.getState().layoutOff).toEqual({ [PKG]: true });
    expect(power).toHaveAttribute('aria-pressed', 'false');
    expect(node('fire').className).toContain('grayscale');
    expect(within(screen.getByTestId('keymap-inspector')).getByRole('status')).toHaveTextContent(/Sohbet yazarken/);
    expect(useKeymapStore.getState().history[PKG]).toBeUndefined();

    fireEvent.click(within(screen.getByTestId('keymap-inspector')).getByRole('switch', { name: 'Tuş düzeni etkin' }));
    expect(useKeymapStore.getState().layoutOff).toEqual({});
    expect(node('fire').className).not.toContain('grayscale');
  });

  it('kapalı düzen oyunda hiç çizilmez; açılınca aynen geri gelir', () => {
    useKeymapStore.setState({ layoutOff: { [PKG]: true } });
    const { rerender } = render(<KeymapperOverlay win={WIN} isEditing={false} />);
    expect(node('fire')).toBeNull();
    act(() => useKeymapStore.getState().setLayoutEnabled(PKG, true));
    rerender(<KeymapperOverlay win={WIN} isEditing={false} />);
    expect(node('fire')).not.toBeNull();
  });
});

describe('İpuçları uygulamanın kendi sistemiyle (data-tooltip), düz title ile değil', () => {
  it('araç çubuğu ve palet düğmeleri data-tooltip taşır; title yok; palet sağa, üst çubuk aşağı açılır', () => {
    renderEditor();
    const undo = screen.getByRole('button', { name: 'Geri al (Ctrl+Z)' });
    expect(undo).toHaveAttribute('data-tooltip', 'Geri al (Ctrl+Z)');
    expect(undo).toHaveAttribute('data-tooltip-position', 'bottom');
    expect(undo).not.toHaveAttribute('title');

    const add = screen.getByRole('button', { name: 'Tuş ekle' });
    expect(add).toHaveAttribute('data-tooltip', 'Tuş ekle');
    expect(add).toHaveAttribute('data-tooltip-position', 'right');

    const test = screen.getByRole('button', { name: /Test modu/ });
    expect(test.getAttribute('data-tooltip')).toBe('Test modu · telefona gitmez');   // uzun erişilebilir ad yerine kısa ipucu
  });

  it('denetçi simgeleri sağa hizalı ipucu taşır; konumlu öğeler (tutamaç, uyarı) `!absolute` ile düzenini korur', () => {
    useKeymapStore.setState({ presets: { [PKG]: [{ ...FIRE }, { ...FIRE, id: 'dup', rx: 0.7 }] } });
    renderEditor();
    select('fire');
    const remove = screen.getByRole('button', { name: 'Sil (Del)' });
    expect(remove).toHaveAttribute('data-tooltip-align', 'end');
    expect(remove).not.toHaveAttribute('title');

    const handle = document.querySelector('[data-resize-handle]');
    expect(handle).toHaveAttribute('data-tooltip');
    expect(handle.className).toContain('!absolute');
    const badge = screen.getAllByRole('img', { name: /Aynı tuş/ })[0];
    expect(badge).toHaveAttribute('data-tooltip');
    expect(badge.className).toContain('!absolute');
  });

  it('düzenleyicide düz title kalmadı (tuş kapakları, tutamaç, uyarı rozeti dahil)', () => {
    useKeymapStore.setState({ presets: { [PKG]: [{ ...FIRE }, { ...FIRE, id: 'dup', rx: 0.7 }, { id: 'j', type: 'dpad', rx: 0.2, ry: 0.7, walkKey: 'Shift' }] } });
    const { container } = renderEditor();
    select('fire');
    const withTitle = [...container.querySelectorAll('[title]')].filter((el) => !el.closest('[role="radiogroup"]'));   // SegmentedControl kendi title'ını taşır
    expect(withTitle.map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
  });
});

describe('Pencereye özel düzen ("her pencerenin kendi oyun konsolu")', () => {
  const switchOf = () => within(screen.getByTestId('keymap-inspector')).getByRole('switch', { name: 'Bu pencereye özel düzen' });

  it('anahtarı açınca uygulamanın düzeni kopyalanır, rozet çıkar; düzenleme yalnız bu pencereyi etkiler', () => {
    renderEditor();
    expect(switchOf()).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByTestId('own-layout-badge')).toBeNull();

    fireEvent.click(switchOf());
    expect(useKeymapStore.getState().windowOwned).toEqual({ w1: true });
    expect(screen.getByTestId('own-layout-badge')).toHaveTextContent('Bu pencereye özel');
    expect(useKeymapStore.getState().presets['win:w1']).toHaveLength(1);        // uygulamanın düzeni kopyalandı
    expect(document.querySelectorAll('[data-node-type="tap"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Tuş ekle' }));
    press('g');
    expect(useKeymapStore.getState().presets['win:w1']).toHaveLength(2);
    expect(useKeymapStore.getState().presets[PKG]).toHaveLength(1);              // uygulamanın düzeni değişmedi
  });

  it('başka bir pencere aynı uygulamanın düzenini görmeye devam eder; pencerenin kendi düzeni onunla karışmaz', () => {
    useKeymapStore.getState().setWindowLayoutOwned('w1', PKG, true);
    useKeymapStore.getState().addNodeToPackage('win:w1', { type: 'tap', key: 'x', rx: 0.2, ry: 0.2 });

    const mine = render(<KeymapperOverlay win={WIN} isEditing={false} />);
    expect(mine.container.querySelectorAll('[data-node-type="tap"]')).toHaveLength(2);   // kendi düzeni: fire + x
    mine.unmount();
    const other = render(<KeymapperOverlay win={{ ...WIN, id: 'w2' }} isEditing={false} />);
    expect(other.container.querySelectorAll('[data-node-type="tap"]')).toHaveLength(1);  // uygulamanın düzeni: yalnız fire
  });

  it('anahtarı kapatınca pencere düzeni silinir ve pencere uygulamanın düzenine döner', () => {
    useKeymapStore.getState().setWindowLayoutOwned('w1', PKG, true);
    useKeymapStore.getState().addNodeToPackage('win:w1', { type: 'tap', key: 'x' });
    renderEditor();
    expect(screen.getByTestId('own-layout-badge')).toBeInTheDocument();
    fireEvent.click(switchOf());
    expect(useKeymapStore.getState().windowOwned).toEqual({});
    expect(useKeymapStore.getState().presets['win:w1']).toBeUndefined();
    expect(screen.queryByTestId('own-layout-badge')).toBeNull();
    expect(document.querySelectorAll('[data-node-type="tap"]')).toHaveLength(1);          // uygulamanın düzeni
  });

  it('"Uygulama düzeni olarak kaydet" pencere düzenini uygulamanın düzeni yapar', async () => {
    useKeymapStore.getState().setWindowLayoutOwned('w1', PKG, true);
    useKeymapStore.getState().addNodeToPackage('win:w1', { type: 'tap', key: 'x' });
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Uygulama düzeni olarak kaydet' }));
    expect(useKeymapStore.getState().presets[PKG].map((n) => n.key)).toEqual(expect.arrayContaining(['f', 'x']));
    expect(await screen.findByText('Uygulama düzeni güncellendi')).toBeInTheDocument();
  });

  it('pencerenin düzeninin açık/kapalı durumu da pencereye özeldir (uygulamanınki etkilenmez)', () => {
    useKeymapStore.getState().setWindowLayoutOwned('w1', PKG, true);
    renderEditor();
    fireEvent.click(screen.getByTestId('layout-toggle'));
    expect(useKeymapStore.getState().layoutOff).toEqual({ 'win:w1': true });
    expect(useKeymapStore.getState().getActiveKeymap(PKG)).toHaveLength(1);              // uygulama düzeni hâlâ açık
  });
});

describe('Kendi hazır şablonlarım', () => {
  const openTemplates = async () => {
    fireEvent.click(screen.getAllByRole('button', { name: /Şablonlar/ })[0]);   // araç çubuğu (boş düzende yönlendirme kartı da aynı adı taşır)
    return screen.findByRole('dialog', { name: 'Şablonlar' });
  };

  it('düzen adla şablon olarak kaydedilir; kart olarak görünür; boş ad ya da boş düzende kaydedilemez', async () => {
    renderEditor();
    const dialog = await openTemplates();
    expect(within(dialog).getByText(/Henüz kendi şablonun yok/)).toBeInTheDocument();
    const save = within(dialog).getByRole('button', { name: 'Mevcut düzeni kaydet' });
    expect(save).toBeDisabled();                                                          // ad yok

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Şablon adı' }), { target: { value: 'Benim nişancı' } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    expect(useKeymapStore.getState().userTemplates).toHaveLength(1);
    expect(useKeymapStore.getState().userTemplates[0]).toMatchObject({ name: 'Benim nişancı' });
    expect(within(dialog).getByText('Benim nişancı')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Şablon adı' })).toHaveValue('');   // alan temizlendi
  });

  it('boş düzende kaydet kapalıdır', async () => {
    useKeymapStore.setState({ presets: { [PKG]: [] } });
    renderEditor();
    const dialog = await openTemplates();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Şablon adı' }), { target: { value: 'x' } });
    expect(within(dialog).getByRole('button', { name: 'Mevcut düzeni kaydet' })).toBeDisabled();
  });

  it('kendi şablonuna tıklamak düzeni onunla değiştirir (geri alınabilir) ve başka pencerede de uygulanır', async () => {
    useKeymapStore.getState().applyTemplate(PKG, 'moba');
    const id = useKeymapStore.getState().saveUserTemplate(PKG, 'MOBA benim');
    useKeymapStore.setState({ presets: { [PKG]: [{ ...FIRE }] } });
    renderEditor();
    const dialog = await openTemplates();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'MOBA benim' })[0]);   // kart: önizleme düğmesi + ad düğmesi
    expect(nodes().length).toBeGreaterThan(4);
    press('z', { ctrlKey: true });
    expect(nodes().map((n) => n.id)).toEqual(['fire']);
    expect(useKeymapStore.getState().userTemplates[0].id).toBe(id);                       // şablon duruyor
  });

  it('adı yerinde değiştirilir; silmek iki adımdır (ilk tıklama onay ister)', async () => {
    useKeymapStore.getState().applyTemplate(PKG, 'racing');
    useKeymapStore.getState().saveUserTemplate(PKG, 'Eski ad');
    renderEditor();
    const dialog = await openTemplates();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Adını değiştir' }));
    const input = within(dialog).getByDisplayValue('Eski ad');
    fireEvent.change(input, { target: { value: 'Yeni ad' } });
    fireEvent.blur(input);
    expect(useKeymapStore.getState().userTemplates[0].name).toBe('Yeni ad');
    expect(within(dialog).getByText('Yeni ad')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Şablonu sil' }));
    expect(useKeymapStore.getState().userTemplates).toHaveLength(1);                      // ilk tıklama yalnız onay ister
    fireEvent.click(within(dialog).getByRole('button', { name: 'Silmek için tekrar tıkla' }));
    expect(useKeymapStore.getState().userTemplates).toHaveLength(0);
    expect(within(dialog).getByText(/Henüz kendi şablonun yok/)).toBeInTheDocument();
  });

  it('boş adla yeniden adlandırma eski adı korur', async () => {
    useKeymapStore.getState().applyTemplate(PKG, 'racing');
    useKeymapStore.getState().saveUserTemplate(PKG, 'Kalsın');
    renderEditor();
    const dialog = await openTemplates();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adını değiştir' }));
    const input = within(dialog).getByDisplayValue('Kalsın');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(useKeymapStore.getState().userTemplates[0].name).toBe('Kalsın');
  });
});

describe('"Oyna": düzenleyici açıkken gerçekten oynama', () => {
  const livePlay = () => useKeymapStore.getState().livePlayWindowId;

  it('denetçideki ve çubuktaki düğme aynı kipi açar; kaplama tıklamayı geçirir, düzenleyicinin çubukları tıklanır kalır', () => {
    const { container } = renderEditor();
    const overlay = container.querySelector('[data-keymap-overlay]');
    expect(overlay.className).toContain('pointer-events-auto');

    fireEvent.click(screen.getByTestId('inspector-live-play'));
    expect(livePlay()).toBe(WIN.id);
    expect(overlay.className).toContain('pointer-events-none');
    expect(overlay.className).toContain('[&_[data-workbench-chrome]]:pointer-events-auto');
    expect(screen.getByTestId('keymap-inspector')).toBeInTheDocument();           // denetçi açık kalır (test modundan farkı)
    expect(screen.getByTestId('live-play-band')).toBeInTheDocument();
    expect(screen.getByTestId('keymap-frame').className).toContain('pointer-events-none');

    fireEvent.click(screen.getByTestId('live-play-toggle'));                          // çubuk düğmesi de aynı anahtar
    expect(livePlay()).toBeNull();
    expect(overlay.className).toContain('pointer-events-auto');
  });

  it('oynarken düzenleyici kısayolları kapalıdır (Delete düğümü silmez), Esc önce oynamayı bitirir, düzenleyiciyi kapatmaz', () => {
    const { onClose } = renderEditor();
    select('fire');
    fireEvent.click(screen.getByTestId('live-play-toggle'));

    press('Delete');
    expect(nodes()).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(livePlay()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Test ve Oyna birbirini dışlar', () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('live-play-toggle'));
    expect(screen.getByRole('button', { name: /Test modu/ })).toBeDisabled();
    fireEvent.click(screen.getByTestId('live-play-toggle'));
    fireEvent.click(screen.getByRole('button', { name: /Test modu/ }));
    expect(screen.getByTestId('live-play-toggle')).toBeDisabled();
  });

  it('düzenleyici kapanınca oynama da biter', () => {
    useKeymapStore.getState().setEditWindowId(WIN.id);
    useKeymapStore.getState().setLivePlayWindowId(WIN.id);
    useKeymapStore.getState().setEditWindowId(null);
    expect(livePlay()).toBeNull();
  });
});

describe('Bakış alanı silueti', () => {
  it('"Bakış alanını göster" kapalıyken oynarken hiç çizilmez', () => {
    useKeymapStore.setState({
      presets: { [PKG]: [{ id: 'l', type: 'look', rx: 0.7, ry: 0.5, radius: 0.18 }] },
      uiPrefs: { ...DEFAULT_UI_PREFS, showLook: false },
    });
    render(<KeymapperOverlay win={WIN} isEditing={false} />);
    expect(node('l')).toBeNull();
  });
});
