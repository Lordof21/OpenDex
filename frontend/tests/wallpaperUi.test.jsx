// Kapak resmi arayüzü: katman stili/çapraz geçiş, karo ızgarası klavyesi, diyalogun uçtan uca akışları (galeri, resimlerim, renkler,
// ayarlar, slayt gösterisi, geri alma, sürükle-bırak, yapıştır).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../src/desktop/wallpaper/processImage.js', async (importOriginal) => ({ ...(await importOriginal()), processImage: vi.fn() }));

import { processImage } from '../src/desktop/wallpaper/processImage.js';
import { ImageProcessError } from '../src/desktop/wallpaper/processImage.js';
import { artStyle, blurStyle, dimStyle } from '../src/desktop/wallpaper/layerStyle.js';
import { DEFAULT_PREFS, resolveWallpaper } from '../src/desktop/wallpaper/prefs.js';
import { useWallpaperStore } from '../src/desktop/wallpaper/wallpaperStore.js';
import { imageStore } from '../src/desktop/wallpaper/imageStore.js';
import WallpaperLayer from '../src/desktop/wallpaper/WallpaperLayer.jsx';
import WallpaperDialog from '../src/desktop/wallpaper/WallpaperDialog.jsx';
import { ChoiceGrid, Tile } from '../src/desktop/wallpaper/WallpaperParts.jsx';
import { ThemeProvider } from '../src/state/ThemeContext.jsx';

const store = () => useWallpaperStore.getState();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let urlSeq = 0;
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => `blob:wp-${(urlSeq += 1)}`);
  URL.revokeObjectURL = vi.fn();
  useWallpaperStore.setState({ prefs: { ...DEFAULT_PREFS, slideshow: { ...DEFAULT_PREFS.slideshow } }, images: [], hydrated: true, persistent: false, lastRemoved: null });
  processImage.mockReset();
});
afterEach(cleanup);

const okProcess = (name) => ({ name, blob: new Blob(['x']), thumb: new Blob(['t']), width: 1920, height: 1080, luma: 0.3, avg: '#223344' });
const pngFile = (name) => new File(['x'], name, { type: 'image/png' });

describe('layerStyle', () => {
  it('hazır kapak: tüm alana tek katman; düz renk: yalnız zemin rengi', () => {
    const css = resolveWallpaper(DEFAULT_PREFS, { isDark: false });
    expect(artStyle(css)).toMatchObject({ backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' });
    expect(artStyle(css).backgroundImage).toContain('gradient');
    const solid = resolveWallpaper({ ...DEFAULT_PREFS, mode: 'solid', color: '#336699' });
    expect(artStyle(solid)).toEqual({ backgroundColor: '#336699' });
  });

  it('düz (themed) kapakta resim katmanı yok, zemin tema rengi', () => {
    const plain = resolveWallpaper({ ...DEFAULT_PREFS, id: 'plain' });
    expect(artStyle(plain)).toEqual({ backgroundColor: 'var(--workspace)' });
  });

  it('kullanıcı resmi: her yerleşim için doğru CSS; URL yokken yalnız ortalama renk', () => {
    const base = { kind: 'image', color: '#123456' };
    expect(artStyle({ ...base, fit: 'fill' }, 'blob:a')).toMatchObject({ backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundImage: 'url("blob:a")', backgroundColor: '#123456' });
    expect(artStyle({ ...base, fit: 'fit' }, 'blob:a').backgroundSize).toBe('contain');
    expect(artStyle({ ...base, fit: 'stretch' }, 'blob:a').backgroundSize).toBe('100% 100%');
    expect(artStyle({ ...base, fit: 'center' }, 'blob:a')).toMatchObject({ backgroundSize: 'auto', backgroundRepeat: 'no-repeat' });
    expect(artStyle({ ...base, fit: 'tile' }, 'blob:a')).toMatchObject({ backgroundRepeat: 'repeat', backgroundPosition: 'top left' });
    expect(artStyle({ ...base, fit: 'fill' }, null).backgroundImage).toBeUndefined();
    expect(artStyle({ ...base, fit: 'bilinmeyen' }, 'blob:a').backgroundSize).toBe('cover');
  });

  it('bulanıklık katmanı kenar boşluğu bırakmasın diye 2× taşar; blur 0 → filtre yok', () => {
    expect(blurStyle(0)).toEqual({ inset: 0 });
    expect(blurStyle(10)).toEqual({ inset: '-20px', filter: 'blur(10px)' });
  });

  it('karartma %60 ile sınırlı', () => {
    expect(dimStyle(30).backgroundColor).toBe('rgba(0,0,0,0.3)');
    expect(dimStyle(500).backgroundColor).toBe('rgba(0,0,0,0.6)');
    expect(dimStyle(-5).backgroundColor).toBe('rgba(0,0,0,0)');
  });
});

describe('WallpaperLayer', () => {
  it('hazır kapağı çizer: anahtar, bulanıklık ve karartma katmanı; tıklamayı geçirir, ekran okuyucudan gizli', () => {
    const wp = resolveWallpaper({ ...DEFAULT_PREFS, blur: 8, dim: 25 }, { isDark: false });
    const { container } = render(<WallpaperLayer wallpaper={wp} />);
    const layer = container.firstChild;
    expect(layer).toHaveAttribute('data-wallpaper', wp.key);
    expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(layer.className).toContain('pointer-events-none');
    expect(container.querySelector('[style*="blur(8px)"]')).not.toBeNull();
    expect(container.querySelector('[style*="rgba(0, 0, 0, 0.25)"]')).not.toBeNull();
    // jsdom çok katmanlı SVG/gradyan değerlerini ayrıştırmaz (gerçek tarayıcıda çizim görsel doğrulamada); zemin rengi her durumda yazılır.
    expect(container.querySelector('[style*="background-color"]')).not.toBeNull();
  });

  it('kullanıcı resmi: baytı okur, blob URL ile gösterir; kalkarken URL serbest bırakılır', async () => {
    const readBlob = vi.fn().mockResolvedValue(new Blob(['x']));
    const wp = resolveWallpaper({ ...DEFAULT_PREFS, mode: 'image', id: 'a' }, { images: [{ id: 'a', name: 'A', luma: 0.3, avg: '#223344' }] });
    const { container, unmount } = render(<WallpaperLayer wallpaper={wp} readBlob={readBlob} />);
    await waitFor(() => expect(container.querySelector('[style*="blob:wp-"]')).not.toBeNull());
    expect(readBlob).toHaveBeenCalledWith('a');
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('resmin baytı yoksa boş zemin bırakmaz: varsayılan kapağa döner', async () => {
    useWallpaperStore.setState({ prefs: { ...DEFAULT_PREFS, mode: 'image', id: 'a' } });
    const wp = resolveWallpaper(store().prefs, { images: [{ id: 'a', name: 'A', luma: 0.3, avg: '#223344' }] });
    render(<WallpaperLayer wallpaper={wp} readBlob={async () => null} />);
    await waitFor(() => expect(store().prefs).toMatchObject({ mode: 'builtin', id: 'flow' }));
  });

  it('okuma hatasında da varsayılana döner (çökmez)', async () => {
    useWallpaperStore.setState({ prefs: { ...DEFAULT_PREFS, mode: 'image', id: 'a' } });
    const wp = resolveWallpaper(store().prefs, { images: [{ id: 'a', name: 'A', luma: 0.3, avg: '#223344' }] });
    render(<WallpaperLayer wallpaper={wp} readBlob={async () => { throw new Error('IDB'); }} />);
    await waitFor(() => expect(store().prefs.mode).toBe('builtin'));
  });

  it('yerleşim değişince aynı URL korunur ve anında uygulanır (yeniden okuma yok)', async () => {
    const readBlob = vi.fn().mockResolvedValue(new Blob(['x']));
    const images = [{ id: 'a', name: 'A', luma: 0.3, avg: '#223344' }];
    const at = (fit) => resolveWallpaper({ ...DEFAULT_PREFS, mode: 'image', id: 'a', fit }, { images });
    const { container, rerender } = render(<WallpaperLayer wallpaper={at('fill')} readBlob={readBlob} />);
    await waitFor(() => expect(container.querySelector('[style*="blob:wp-"]')).not.toBeNull());
    rerender(<WallpaperLayer wallpaper={at('tile')} readBlob={readBlob} />);
    await waitFor(() => expect(container.querySelector('[style*="repeat: repeat"], [style*="background-repeat: repeat"]')).not.toBeNull());
    expect(readBlob).toHaveBeenCalledTimes(1);
  });
});

describe('ChoiceGrid klavye gezintisi', () => {
  const Grid = () => (
    <ChoiceGrid label="Deneme">
      {['A', 'B', 'C'].map((name, index) => (
        <Tile key={name} name={name} selected={index === 1} focusable={index === 1} onSelect={() => {}} />
      ))}
    </ChoiceGrid>
  );

  it('yalnız seçili karo Tab ile erişilir; ok tuşları odağı taşır, Home/End uçlara gider (seçmez)', () => {
    render(<Grid />);
    const [a, b, c] = screen.getAllByRole('option');
    expect([a.tabIndex, b.tabIndex, c.tabIndex]).toEqual([-1, 0, -1]);
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(c); // sonda dönmez
    fireEvent.keyDown(c, { key: 'Home' });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: 'End' });
    expect(document.activeElement).toBe(c);
    expect(b).toHaveAttribute('aria-selected', 'true'); // odak seçimi değiştirmedi
    expect(c).toHaveAttribute('aria-selected', 'false');
  });

  it('yukarı/aşağı: ekran konumuna göre bir alt/üst satırda aynı sütuna gider (karolar `relative` sarmalayıcıda — offsetTop kullanılamaz)', () => {
    render(
      <ChoiceGrid label="2×2">
        {['A', 'B', 'C', 'D'].map((name, index) => (
          <Tile key={name} name={name} selected={false} focusable={index === 0} onSelect={() => {}} />
        ))}
      </ChoiceGrid>,
    );
    const items = screen.getAllByRole('option');
    // jsdom'da düzen yok: 2 sütun × 2 satır konumlarını taklit ederiz (A B / C D).
    const at = [[0, 0], [100, 0], [0, 80], [100, 80]];
    items.forEach((item, index) => {
      item.getBoundingClientRect = () => ({ left: at[index][0], top: at[index][1], right: 0, bottom: 0, width: 90, height: 60 });
    });
    const [a, b, c, d] = items;
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(d);
    fireEvent.keyDown(d, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(d); // son satırda kalır
    fireEvent.keyDown(d, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(b); // ilk satırda kalır
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(c);
  });

  it('düzen bilgisi yoksa (tüm konumlar 0) aşağı/yukarı odağı oynatmaz', () => {
    render(<Grid />);
    const [a, b] = screen.getAllByRole('option');
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b);
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(a);
  });

  it('ilgisiz tuşlar ve ızgara dışı odak yok sayılır', () => {
    render(<Grid />);
    const [a] = screen.getAllByRole('option');
    a.focus();
    const event = fireEvent.keyDown(a, { key: 'x' });
    expect(event).toBe(true); // engellenmedi
  });
});

// ── Diyalog ─────────────────────────────────────────────────────────────────────────────────────────────────

const renderDialog = (props = {}) => {
  const onClose = vi.fn();
  const view = render(
    <ThemeProvider>
      <WallpaperDialog open onClose={onClose} {...props} />
    </ThemeProvider>,
  );
  return { onClose, ...view };
};
const dialog = () => screen.getByRole('dialog', { name: 'Arka plan' });
const tile = (name) => within(dialog()).getByRole('option', { name });
const openTab = (label) => fireEvent.click(within(dialog()).getByRole('radio', { name: label }));

describe('WallpaperDialog: galeri', () => {
  it('14 hazır kapak listelenir; mevcut seçim (Akış) işaretli, önizleme adı gösterir', async () => {
    renderDialog();
    const options = within(screen.getByRole('listbox', { name: 'Hazır kapaklar' })).getAllByRole('option');
    expect(options).toHaveLength(14);
    expect(tile('Akış')).toHaveAttribute('aria-selected', 'true');
    expect(tile('Okyanus')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('wallpaper-current')).toHaveTextContent('Akış');
    expect(screen.getByRole('figure', { name: 'Önizleme: Akış' })).toBeInTheDocument();
  });

  it('bir kapağa tıklamak anında uygular ve önizlemeyi günceller', async () => {
    renderDialog();
    fireEvent.click(tile('Okyanus'));
    expect(store().prefs).toMatchObject({ mode: 'builtin', id: 'ocean' });
    await waitFor(() => expect(tile('Okyanus')).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByTestId('wallpaper-current')).toHaveTextContent('Okyanus');
  });

  it('kategori süzgeci karoları daraltır', () => {
    renderDialog();
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Manzara' }));
    expect(within(screen.getByRole('listbox', { name: 'Hazır kapaklar' })).getAllByRole('option')).toHaveLength(4);
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Sade' }));
    expect(within(screen.getByRole('listbox', { name: 'Hazır kapaklar' })).getAllByRole('option')).toHaveLength(5);
  });

  it('"Görünüm" (açık/koyu) yalnız temaya bağlı olmayan hazır kapakta görünür', () => {
    renderDialog();
    expect(within(dialog()).getByRole('radiogroup', { name: 'Görünüm' })).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Koyu' }));
    expect(store().prefs.appearance).toBe('dark');
    fireEvent.click(tile('Düz'));
    expect(within(dialog()).queryByRole('radiogroup', { name: 'Görünüm' })).toBeNull();
    expect(within(dialog()).queryByRole('radiogroup', { name: 'Yerleşim' })).toBeNull();
  });

  it('Rastgele düğmesi şimdikinden farklı bir kapak seçer', () => {
    renderDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: /Rastgele/ }));
    expect(store().prefs.id).not.toBe('flow');
  });
});

describe('WallpaperDialog: renkler', () => {
  it('örnek renk seçilir; seçili örnek işaretlenir', () => {
    renderDialog();
    openTab('Renkler');
    fireEvent.click(within(dialog()).getByRole('option', { name: 'Renk #2f6fe0' }));
    expect(store().prefs).toMatchObject({ mode: 'solid', color: '#2f6fe0' });
    expect(within(dialog()).getByRole('option', { name: 'Renk #2f6fe0' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('wallpaper-current')).toHaveTextContent('Düz renk');
  });

  it('renk kodu: geçerli olunca uygulanır, geçersizken uygulanmaz ve alan uyarılır; "#" otomatik eklenir', () => {
    renderDialog();
    openTab('Renkler');
    const input = within(dialog()).getByRole('textbox', { name: 'Renk kodu' });
    fireEvent.change(input, { target: { value: '#12' } });
    expect(store().prefs.mode).toBe('builtin');
    expect(input.className).toContain('border-destructive');
    fireEvent.change(input, { target: { value: 'ff8800' } });
    expect(store().prefs).toMatchObject({ mode: 'solid', color: '#ff8800' });
    expect(input).toHaveValue('#ff8800');
  });
});

describe('WallpaperDialog: resimlerim', () => {
  it('boşken açıklayıcı boş durum ve sayaç; dosya seçici gizli girdide', () => {
    renderDialog();
    openTab(/Resimlerim/);
    expect(within(dialog()).getByText('Henüz resim eklemediniz')).toBeInTheDocument();
    expect(within(dialog()).getByText('0 / 24')).toBeInTheDocument();
    expect(within(dialog()).getByTestId('wallpaper-file-input')).toHaveAttribute('multiple');
  });

  it('dosya seçince hazırlanır, eklenir, hemen uygulanır ve yerleşim denetimi çıkar', async () => {
    processImage.mockImplementation(async (file) => okProcess(file.name.replace(/\.\w+$/, '')));
    renderDialog();
    openTab(/Resimlerim/);
    fireEvent.change(within(dialog()).getByTestId('wallpaper-file-input'), { target: { files: [pngFile('Tatil.png')] } });
    const added = await within(dialog()).findByRole('option', { name: 'Tatil' });
    expect(added).toHaveAttribute('aria-selected', 'true');
    expect(store().prefs.mode).toBe('image');
    expect(within(dialog()).getByText(/«Tatil» eklendi ve uygulandı/)).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Sığdır' }));
    expect(store().prefs.fit).toBe('fit');
  });

  it('reddedilen dosyanın nedeni gösterilir; diğerleri eklenir; uyarı kapatılır', async () => {
    processImage.mockImplementation(async (file) => {
      if (file.name === 'belge.pdf') throw new ImageProcessError('type', '«belge» bir resim dosyası değil.');
      return okProcess('Güzel');
    });
    renderDialog();
    openTab(/Resimlerim/);
    fireEvent.change(within(dialog()).getByTestId('wallpaper-file-input'), { target: { files: [new File(['x'], 'belge.pdf', { type: 'application/pdf' }), pngFile('g.png')] } });
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('«belge» bir resim dosyası değil.');
    expect(await within(dialog()).findByRole('option', { name: 'Güzel' })).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Uyarıyı kapat' }));
    expect(within(dialog()).queryByRole('alert')).toBeNull();
  });

  it('sil → durum satırında "Geri al" → resim geri gelir', async () => {
    processImage.mockImplementation(async () => okProcess('Sil beni'));
    renderDialog();
    openTab(/Resimlerim/);
    fireEvent.change(within(dialog()).getByTestId('wallpaper-file-input'), { target: { files: [pngFile('s.png')] } });
    await within(dialog()).findByRole('option', { name: 'Sil beni' });
    fireEvent.click(within(dialog()).getByRole('button', { name: '«Sil beni» resmini sil' }));
    await waitFor(() => expect(within(dialog()).queryByRole('option', { name: 'Sil beni' })).toBeNull());
    expect(store().prefs.mode).toBe('builtin'); // seçili resim silinince varsayılana döner
    const status = within(dialog()).getByRole('status');
    expect(status).toHaveTextContent('«Sil beni» silindi.');
    fireEvent.click(within(status).getByRole('button', { name: 'Geri al' }));
    await within(dialog()).findByRole('option', { name: 'Sil beni' });
    expect(store().prefs.mode).toBe('image');
    await waitFor(() => expect(within(dialog()).getByRole('status')).toHaveTextContent('geri getirildi'));
  });

  it('dolu depoda ekleme düğmesi kapanır ve nedeni söylenir', async () => {
    useWallpaperStore.setState({ images: Array.from({ length: 24 }, (_, i) => ({ id: `i${i}`, name: `R${i}`, width: 1, height: 1, luma: 0.5, avg: '#000000', addedAt: i })) });
    renderDialog();
    openTab(/Resimlerim/);
    expect(within(dialog()).getByText('En fazla 24 resim eklenebilir')).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: /En fazla 24/ })).toBeDisabled();
  });

  it('kalıcı olmayan depoda (IndexedDB yok) kullanıcıya dürüst uyarı verir', () => {
    useWallpaperStore.setState({ images: [{ id: 'i1', name: 'R', width: 1, height: 1, luma: 0.5, avg: '#000000', addedAt: 1 }], persistent: false });
    renderDialog();
    openTab(/Resimlerim/);
    expect(within(dialog()).getByText(/yalnız bu oturumda kalır/)).toBeInTheDocument();
  });

  it('Ctrl+V ile yapıştırılan resim eklenir; yapıştırılan metin yok sayılır', async () => {
    processImage.mockImplementation(async () => okProcess('Panodan'));
    renderDialog();
    const text = new Event('paste', { bubbles: true, cancelable: true });
    text.clipboardData = { files: [], getData: () => 'metin' };
    document.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
    expect(processImage).not.toHaveBeenCalled();

    const paste = new Event('paste', { bubbles: true, cancelable: true });
    paste.clipboardData = { files: [pngFile('pano.png')] };
    document.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    await within(dialog()).findByRole('option', { name: 'Panodan' });
  });

  it('dosya sürüklenirken bırakma bölgesi görünür, bırakınca eklenir; dosya olmayan sürükleme yok sayılır', async () => {
    processImage.mockImplementation(async () => okProcess('Sürüklenen'));
    renderDialog();
    const target = dialog().firstChild;
    fireEvent.dragEnter(target, { dataTransfer: { types: ['text/plain'] } });
    expect(screen.queryByText(/Bırakın — kapak resmi/)).toBeNull();
    fireEvent.dragEnter(target, { dataTransfer: { types: ['Files'] } });
    expect(await screen.findByText(/Bırakın — kapak resmi olarak eklensin/)).toBeInTheDocument();
    fireEvent.drop(target, { dataTransfer: { types: ['Files'], files: [pngFile('s.png')] } });
    await within(dialog()).findByRole('option', { name: 'Sürüklenen' });
    expect(screen.queryByText(/Bırakın — kapak resmi/)).toBeNull();
  });
});

describe('WallpaperDialog: ayarlar, slayt gösterisi, geri alma', () => {
  it('slayt gösterisi anahtarı seçenekleri açar; süre ve kaynak değişir', () => {
    renderDialog();
    expect(within(dialog()).queryByLabelText('Süre')).toBeNull();
    fireEvent.click(within(dialog()).getByRole('switch', { name: 'Slayt gösterisi' }));
    expect(store().prefs.slideshow.enabled).toBe(true);
    fireEvent.change(within(dialog()).getByLabelText('Süre'), { target: { value: '60' } });
    fireEvent.change(within(dialog()).getByLabelText('Kaynak'), { target: { value: 'images' } });
    expect(store().prefs.slideshow).toMatchObject({ enabled: true, intervalMin: 60, source: 'images' });
    expect(within(dialog()).getByText(/önce «Resimlerim» sekmesinden resim ekleyin/)).toBeInTheDocument();
  });

  it('Varsayılana dön: varsayılandayken kapalı; değişince açılır ve her şeyi sıfırlar', () => {
    renderDialog();
    const reset = within(dialog()).getByRole('button', { name: /Varsayılana dön/ });
    expect(reset).toBeDisabled();
    fireEvent.click(tile('Okyanus'));
    expect(reset).not.toBeDisabled();
    fireEvent.click(reset);
    expect(store().prefs).toEqual(DEFAULT_PREFS);
  });

  it('"Değişiklikleri geri al" pencere açılırken ki hâle döner ve yalnız değişiklik varken görünür', () => {
    store().selectBuiltin('dunes');
    renderDialog();
    expect(within(dialog()).queryByRole('button', { name: /Değişiklikleri geri al/ })).toBeNull();
    fireEvent.click(tile('Bokeh'));
    fireEvent.click(within(dialog()).getByRole('button', { name: /Değişiklikleri geri al/ }));
    expect(store().prefs.id).toBe('dunes');
    expect(within(dialog()).queryByRole('button', { name: /Değişiklikleri geri al/ })).toBeNull();
  });

  it('açılışta sekme mevcut seçime göre: resim → Resimlerim, düz renk → Renkler', () => {
    useWallpaperStore.setState({ prefs: { ...DEFAULT_PREFS, mode: 'solid', color: '#336699' } });
    const { unmount } = renderDialog();
    expect(within(dialog()).getByRole('radio', { name: 'Renkler' })).toHaveAttribute('aria-checked', 'true');
    unmount();
    cleanup();
    useWallpaperStore.setState({ prefs: { ...DEFAULT_PREFS, mode: 'builtin', id: 'ocean' } });
    renderDialog();
    expect(within(dialog()).getByRole('radio', { name: 'Galeri' })).toHaveAttribute('aria-checked', 'true');
  });

  it('Bitti ve Kapat pencereyi kapatır; Esc de kapatır', () => {
    const { onClose } = renderDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Bitti' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Kapat' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('kapalıyken hiçbir şey çizilmez', () => {
    render(
      <ThemeProvider>
        <WallpaperDialog open={false} onClose={() => {}} />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('silinen resim baytları pencere kapanırken bırakılır', async () => {
    processImage.mockImplementation(async () => okProcess('Geçici'));
    const { unmount } = renderDialog();
    openTab(/Resimlerim/);
    fireEvent.change(within(dialog()).getByTestId('wallpaper-file-input'), { target: { files: [pngFile('g.png')] } });
    await within(dialog()).findByRole('option', { name: 'Geçici' });
    fireEvent.click(within(dialog()).getByRole('button', { name: '«Geçici» resmini sil' }));
    await waitFor(() => expect(store().lastRemoved).not.toBeNull());
    unmount();
    expect(store().lastRemoved).toBeNull();
  });
});

describe('küçük resim URL\'leri', () => {
  it('eklenen resmin önizlemesi blob URL ile çizilir; resim silinince URL serbest bırakılır', async () => {
    processImage.mockImplementation(async () => okProcess('Önizlemeli'));
    renderDialog();
    openTab(/Resimlerim/);
    fireEvent.change(within(dialog()).getByTestId('wallpaper-file-input'), { target: { files: [pngFile('o.png')] } });
    const option = await within(dialog()).findByRole('option', { name: 'Önizlemeli' });
    await waitFor(() => expect(option.querySelector('[style*="blob:wp-"]')).not.toBeNull());
    fireEvent.click(within(dialog()).getByRole('button', { name: '«Önizlemeli» resmini sil' }));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled());
  });
});

afterEach(async () => {
  await act(async () => {
    await wait(0);
  });
  // Tekil depodaki test artıkları bir sonraki testi etkilemesin.
  for (const meta of await imageStore.list()) await imageStore.remove(meta.id);
});
