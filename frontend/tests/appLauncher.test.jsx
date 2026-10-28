// Uygulama çekmecesi — arayüz düzeyi: arama-öncelikli akış, klavye (combobox), bağlam menüsü, favori / gizle, görünümler,
// kullanım kaydı, boş durumlar. Model mantığı launcherModel.test.js'te.
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../src/lib/api.js', () => ({
  BASE: 'http://localhost:8710',
  api: { get: vi.fn().mockResolvedValue([]), post: vi.fn().mockResolvedValue({}), put: vi.fn() },
  wsUrl: (p) => `ws://test${p}`,
}));

import { AppLauncher } from '../src/taskbar/AppLauncher.jsx';
import { useLauncherStore } from '../src/taskbar/launcher/launcherStore.js';
import { useSystemStore } from '../src/state/systemStore.js';

const app = (name, pkg, extra = {}) => ({ package: pkg, display_name: name, ...extra });
const APPS = [
  app('Chrome', 'com.android.chrome'),
  app('Instagram', 'com.instagram.android'),
  app('YouTube', 'com.google.android.youtube'),
  app('YouTube Music', 'com.google.android.apps.youtube.music'),
  app('WhatsApp', 'com.whatsapp'),
  app('Ayarlar', 'com.android.settings'),
  app('Dosyalar', 'com.opendex.files', { isBuiltin: true, is_system: true }),
  app('Takvim', 'com.calendar'),
];

function Harness({ initialQuery = '', onLaunch = vi.fn(), onClose = vi.fn(), extra = {} }) {
  const [query, setQuery] = useState(initialQuery);
  return (
    <AppLauncher apps={APPS} query={query} onQuery={setQuery} onLaunch={onLaunch} onClose={onClose} openAppIds={[]} {...extra} />
  );
}

const input = () => screen.getByRole('combobox');
const options = () => screen.getAllByRole('option');
const optionNames = () => options().map((el) => el.getAttribute('aria-label').split(',')[0]);
const key = (el, k, init = {}) => fireEvent.keyDown(el, { key: k, ...init });

beforeEach(() => {
  useLauncherStore.getState().resetForTests();
  useSystemStore.setState({ toasts: [] });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe('açılış ve düzen', () => {
  it('diyalog olarak çizilir, odak arama kutusundadır, sayı alt başlıkta', () => {
    render(<Harness />);
    expect(screen.getByRole('dialog', { name: 'Uygulamalar' })).toHaveAttribute('aria-modal', 'true');
    expect(input()).toHaveFocus();
    expect(screen.getByText('8 uygulama')).toBeInTheDocument();
  });

  it('kenar çubuğunda altı görünüm ve sayıları vardır', () => {
    render(<Harness />);
    const nav = screen.getByRole('navigation', { name: 'Görünümler' });
    for (const name of ['Tümü', 'Favoriler', 'Sık kullanılanlar', 'Açık', 'Sistem', 'Gizli']) {
      expect(within(nav).getByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('button', { name: /^Tümü/ })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: /^Sistem/ })).toHaveTextContent('2');
  });

  it('"Tümü" düz alfabetik liste: harf başlığı yok, yerleşik uygulamalar da ad sırasında', () => {
    render(<Harness />);
    expect(screen.getByText('Tüm uygulamalar')).toBeInTheDocument();
    expect(optionNames()).toEqual(['Ayarlar', 'Chrome', 'Dosyalar', 'Instagram', 'Takvim', 'WhatsApp', 'YouTube', 'YouTube Music']);
    expect(within(screen.getByRole('listbox')).queryByRole('group')).toBeNull();   // eskiden her harf bir grup + yapışkan başlıktı
  });

  it('sağ kenardaki harf dizini o harfin ilk uygulamasına kaydırır', () => {
    const scrolled = [];
    Element.prototype.scrollIntoView = vi.fn(function scrollIntoView() { scrolled.push(this); });
    render(<Harness />);
    const index = screen.getByRole('navigation', { name: 'Harf dizini' });
    fireEvent.click(within(index).getByRole('button', { name: 'Y' }));
    const target = scrolled.at(-1);
    expect(target.getAttribute('aria-label')).toBe('YouTube');          // "Y" harfinin İLK uygulaması
    expect(target).toHaveAttribute('data-letter', 'Y');
    expect(target).toHaveAttribute('aria-selected', 'true');           // seçili olur: ok tuşları buradan sürer
    expect(target).toHaveClass('settings-flash');                      // vurgu animasyonu oynar
    fireEvent.animationEnd(target);
    expect(target).not.toHaveClass('settings-flash');
    expect(options().filter((el) => el.hasAttribute('data-letter')).map((el) => el.getAttribute('data-letter'))).toEqual(['A', 'C', 'D', 'I', 'T', 'W', 'Y']);
  });

  it('ızgara/liste düğmesinin SVG simgesine basmak çekmeceyi kapatmaz (tooltip sistemin kendisi)', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const toggle = screen.getByRole('button', { name: 'Liste görünümü' });
    expect(toggle).toHaveAttribute('data-tooltip', 'Liste görünümü');
    expect(toggle).not.toHaveAttribute('title');
    fireEvent.click(toggle.querySelector('svg'));
    expect(screen.getByRole('dialog', { name: 'Uygulamalar' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('arama-öncelikli akış', () => {
  it('yazınca sıralı sonuçlar gelir ve en iyi sonuç seçili olur; Enter onu açar', () => {
    const onLaunch = vi.fn();
    render(<Harness onLaunch={onLaunch} />);
    fireEvent.change(input(), { target: { value: 'you' } });
    expect(optionNames()).toEqual(['YouTube', 'YouTube Music']);
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    expect(input()).toHaveAttribute('aria-activedescendant', options()[0].id);
    key(input(), 'Enter');
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch.mock.calls[0][0].package).toBe('com.google.android.youtube');
  });

  it('Türkçe I/ı: "instagram" Instagram\'ı bulur', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'instagram' } });
    expect(optionNames()).toEqual(['Instagram']);
  });

  it('sonuç sayısı canlı bölgede duyurulur; sonuç yoksa boş durum', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'you' } });
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('2 sonuç');
    fireEvent.change(input(), { target: { value: 'zzzz' } });
    expect(screen.getByText(/ile eşleşen uygulama yok/)).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('çekmece açıkken yazılan karakter, odak başka yerdeyse kutuya taşınır; "/" da kutuya odaklar', () => {
    render(<Harness />);
    const rail = screen.getByRole('button', { name: /^Favoriler/ });
    rail.focus();
    key(rail, 'y');
    expect(input()).toHaveFocus();
    rail.focus();
    key(rail, '/');
    expect(input()).toHaveFocus();
  });

  it('Esc önce aramayı temizler, ikinci basış kapatır', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.change(input(), { target: { value: 'you' } });
    key(window, 'Escape');
    expect(input()).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
    key(window, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('klavye gezinmesi (combobox)', () => {
  it('→ ← seçili öğeyi okuma sırasında gezdirir; Home / End uçlara gider', () => {
    render(<Harness />);
    key(input(), 'ArrowRight');
    const first = options()[0];
    expect(first).toHaveAttribute('aria-selected', 'true');
    key(input(), 'ArrowRight');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    key(input(), 'ArrowLeft');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    key(input(), 'End');
    expect(options().at(-1)).toHaveAttribute('aria-selected', 'true');
    key(input(), 'Home');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('kutuda yazı varken ← → imleç içindir (seçimi oynatmaz)', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'you' } });
    key(input(), 'ArrowRight');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('↓ ↑ bitişik satıra gider (satır konumları görünür kutulardan)', () => {
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      const els = [...document.querySelectorAll('[data-launcher-option]')];
      const i = els.indexOf(this);
      return i < 0 ? { left: 0, top: 0, width: 0, height: 0 } : { left: (i % 3) * 100, top: Math.floor(i / 3) * 100, width: 90, height: 90 };
    });
    try {
      render(<Harness />);
      key(input(), 'ArrowRight');                              // 0
      key(input(), 'ArrowDown');                               // 3
      expect(options()[3]).toHaveAttribute('aria-selected', 'true');
      key(input(), 'ArrowUp');
      expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    } finally {
      spy.mockRestore();
    }
  });

  it('seçili yokken Enter hiçbir şey açmaz (rastgele uygulama açılmaz)', () => {
    const onLaunch = vi.fn();
    render(<Harness onLaunch={onLaunch} />);
    key(input(), 'Enter');
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('Tab odak tuzağı: son öğeden ilke, ilkten sona sarar', () => {
    render(<Harness />);
    const focusables = [...screen.getByRole('dialog').querySelectorAll('button:not([tabindex="-1"]):not([disabled]), input')];
    const last = focusables.at(-1);
    last.focus();
    key(last, 'Tab');
    expect(document.activeElement).toBe(focusables[0]);
    key(focusables[0], 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe('bağlam menüsü, favori, gizle', () => {
  const openMenuOf = (name) => fireEvent.contextMenu(screen.getAllByRole('option', { name: new RegExp(`^${name}`) })[0]);

  it('sağ tık menüyü açar: Aç / Favorilere ekle / Gizle (kapalı uygulamada "Pencereyi kapat" yok)', () => {
    render(<Harness />);
    openMenuOf('Chrome');
    const menu = screen.getByRole('menu', { name: 'Chrome menüsü' });
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Aç', 'Favorilere ekle', 'Gizle']);
  });

  it('açık uygulamada "Pencereyi kapat" çıkar ve onCloseApp çağrılır', () => {
    const onCloseApp = vi.fn();
    render(<Harness extra={{ openAppIds: ['com.android.chrome'], onCloseApp }} />);
    openMenuOf('Chrome');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pencereyi kapat' }));
    expect(onCloseApp).toHaveBeenCalledWith(expect.objectContaining({ package: 'com.android.chrome' }));
  });

  it('Favorilere ekle: Favoriler bölümü ve sayacı oluşur, menü metni "Favorilerden çıkar"a döner, bilgi mesajı çıkar', () => {
    render(<Harness />);
    openMenuOf('Chrome');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Favorilere ekle' }));
    expect(useLauncherStore.getState().favorites).toEqual(['com.android.chrome']);
    expect(screen.getAllByRole('option', { name: /^Chrome/ }).length).toBe(2);           // Favoriler + A–Z
    expect(useSystemStore.getState().toasts.at(-1).message).toBe('Chrome favorilere eklendi');
    openMenuOf('Chrome');
    expect(screen.getByRole('menuitem', { name: 'Favorilerden çıkar' })).toBeInTheDocument();
  });

  it('Gizle: uygulama Tümü\'nden ve aramadan kaybolur, Gizli görünümünde durur; Göster geri getirir', () => {
    render(<Harness />);
    openMenuOf('Takvim');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Gizle' }));
    expect(screen.queryByRole('option', { name: /^Takvim/ })).toBeNull();
    fireEvent.change(input(), { target: { value: 'takvim' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Gizli/ }));
    expect(optionNames()).toEqual(['Takvim']);
    openMenuOf('Takvim');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Göster' }));
    expect(useLauncherStore.getState().hidden).toEqual([]);
  });

  it('menü Esc ile kapanır (çekmeceyi kapatmaz) ve odak kutuya döner', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    openMenuOf('Chrome');
    key(window, 'Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(input()).toHaveFocus();
  });

  it('klavyeyle: seçili öğede Shift+F10 / Menü tuşu menüyü açar', () => {
    render(<Harness />);
    key(input(), 'ArrowRight');
    key(input(), 'ContextMenu');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});

describe('görünümler ve durum', () => {
  it('Açık görünümü yalnız açık uygulamaları listeler; boşsa boş durum', () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Açık/ }));
    expect(screen.getByText('Açık uygulama yok')).toBeInTheDocument();
    rerender(<Harness extra={{ openAppIds: ['com.whatsapp'] }} />);
    expect(optionNames()).toEqual(['WhatsApp']);
    expect(screen.getByRole('option', { name: /Açık/ })).toBeInTheDocument();
  });

  it('telefona devredilen uygulama "Telefonda" etiketini taşır', () => {
    render(<Harness extra={{ openAppIds: ['com.whatsapp'], handoffAppIds: ['com.whatsapp'] }} />);
    expect(screen.getByRole('option', { name: /WhatsApp, Açık, Telefonda/ })).toBeInTheDocument();
  });

  it('Favoriler ve Sık kullanılanlar boş durumları yol gösterir', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Favoriler/ }));
    expect(screen.getByText('Henüz favori yok')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Sık kullanılanlar/ }));
    expect(screen.getByText('Henüz sık kullanılan yok')).toBeInTheDocument();
  });

  it('sık kullanılanlar kullanımdan öğrenilir ve gizlenebilir', () => {
    const now = Date.now();
    useLauncherStore.setState({ usage: { 'com.whatsapp': { score: 5, last: now }, 'com.instagram.android': { score: 3, last: now } } });
    render(<Harness />);
    expect(screen.getByText('Sık kullanılanlar', { selector: 'h3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sık kullanılanları gizle' }));
    expect(useLauncherStore.getState().showFrequent).toBe(false);
    expect(screen.queryByText('Sık kullanılanlar', { selector: 'h3' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sık kullanılanları göster' })).toBeInTheDocument();
  });

  it('liste görünümüne geçince satırlar paket adını gösterir ve tercih saklanır', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Liste görünümü' }));
    expect(useLauncherStore.getState().view).toBe('list');
    expect(screen.getByText('com.android.chrome')).toBeInTheDocument();
  });

  it('uygulama listesi gelmediyse uyarı bandı ve Yenile; yenileme sonucu bildirilir', async () => {
    const onRefresh = vi.fn().mockResolvedValue({ added: [{}, {}], removed: ['x'] });
    render(<Harness extra={{ appsLoaded: false, onRefresh }} />);
    expect(screen.getByText('Uygulama listesi alınamadı')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Uygulama listesini yenile' })[0]);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(useSystemStore.getState().toasts.at(-1).message).toBe('2 yeni, 1 kaldırılan uygulama');
  });
});

describe('kullanım kaydı', () => {
  it('açık pencereyi öne getirmek kullanım sayılır (yeni pencereyi openWindow sayar)', () => {
    render(<Harness extra={{ openAppIds: ['com.whatsapp'] }} />);
    fireEvent.click(screen.getByRole('option', { name: /^WhatsApp/ }));
    expect(useLauncherStore.getState().usage['com.whatsapp'].score).toBe(1);
  });

  it('henüz açık olmayan uygulamayı çekmece saymaz (openWindow sayar: çift sayım yok)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('option', { name: /^Chrome/ }));
    expect(useLauncherStore.getState().usage['com.android.chrome']).toBeUndefined();
  });
});
