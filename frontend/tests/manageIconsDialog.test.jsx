// "Simgeleri yönet" penceresi: anahtarlar masaüstü düzenini gerçekten değiştirir, arama/süzgeç, Esc sırası (önce arama sonra
// kapat), geri al, dolu masaüstü, toplu işlemler, "Önerilen düzen" klasörleri korur, klavye gezintisi, boş durumlar.
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ManageIconsDialog from '../src/desktop/ManageIconsDialog.jsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const app = (pkg, name, extra = {}) => ({ package: pkg, display_name: name, ...extra });
const APPS = [
  app('com.opendex.settings', 'OpenDeX Ayarları', { isBuiltin: true }),
  app('com.android.chrome', 'Chrome'),
  app('com.sec.android.gallery3d', 'Galeri'),
  app('com.google.android.youtube', 'YouTube'),
  app('com.whatsapp', 'WhatsApp'),
];

function Harness({ initial = { 0: 'com.android.chrome' }, custom = [], apps = APPS, cells = 119, onChange, onClosed }) {
  const [layout, setLayout] = useState(initial);
  const [open, setOpen] = useState(true);
  return (
    <>
      <div data-testid="layout" hidden>{JSON.stringify(layout)}</div>
      <button type="button" onClick={() => setOpen(true)}>aç</button>
      <ManageIconsDialog
        open={open}
        onClose={() => { setOpen(false); onClosed?.(); }}
        apps={apps}
        layout={layout}
        custom={custom}
        cells={cells}
        getDefaultLayout={() => ({ 0: 'com.opendex.settings', 1: 'com.android.chrome' })}
        onLayoutChange={(next) => { setLayout(next); onChange?.(next); }}
      />
    </>
  );
}

const layoutNow = () => JSON.parse(screen.getByTestId('layout').textContent);
const row = (name) => screen.getByRole('switch', { name });
const gone = () => new Promise((resolve) => setTimeout(resolve, 400)); // çıkış animasyonu

describe('Simgeleri yönet', () => {
  it('başlık, doluluk ve her uygulama için bir anahtar gösterir', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Simgeleri yönet' });
    expect(within(dialog).getByRole('heading', { name: 'Simgeleri yönet' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('switch')).toHaveLength(APPS.length);
    expect(row('Chrome')).toHaveAttribute('aria-checked', 'true');
    expect(row('Galeri')).toHaveAttribute('aria-checked', 'false');
    const bar = within(dialog).getByRole('progressbar', { name: 'Masaüstü doluluğu' });
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '119');
    expect(screen.getByText(/1 \/ 119 yer dolu/)).toBeInTheDocument();
  });

  it('OpenDeX uygulamaları ayrı ilk grupta, sonra harf grupları gelir', () => {
    render(<Harness />);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['OpenDeX', 'C', 'G', 'W', 'Y']);
  });

  it('anahtarı açmak uygulamayı ilk boş hücreye koyar, kapatmak kaldırır', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(row('Galeri'));
    expect(layoutNow()).toEqual({ 0: 'com.android.chrome', 1: 'com.sec.android.gallery3d' });
    expect(row('Galeri')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('«Galeri» masaüstüne eklendi.');

    fireEvent.click(row('Chrome'));
    expect(layoutNow()).toEqual({ 1: 'com.sec.android.gallery3d' });
    expect(screen.getByRole('status')).toHaveTextContent('«Chrome» masaüstünden kaldırıldı.');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('"Geri al" son değişikliği döndürür ve kendini söyler', () => {
    render(<Harness />);
    fireEvent.click(row('Galeri'));
    fireEvent.click(screen.getByRole('button', { name: /Geri al/ }));
    expect(layoutNow()).toEqual({ 0: 'com.android.chrome' });
    expect(row('Galeri')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Değişiklik geri alındı.');
    expect(screen.queryByRole('button', { name: /Geri al/ })).toBeNull();
  });

  it('durum satırı birkaç saniye sonra kendiliğinden kapanır', () => {
    vi.useFakeTimers();
    render(<Harness />);
    fireEvent.click(row('Galeri'));
    expect(screen.getByRole('status')).toHaveTextContent('Galeri');
    act(() => { vi.advanceTimersByTime(8100); });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('dolu masaüstüne eklemeyi reddeder, nedenini söyler, düzeni değiştirmez', () => {
    const onChange = vi.fn();
    render(<Harness cells={2} initial={{ 0: 'com.android.chrome', 1: 'custom-x' }} onChange={onChange} />);
    fireEvent.click(row('Galeri'));
    expect(onChange).not.toHaveBeenCalled();
    expect(row('Galeri')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Masaüstü dolu');
    expect(screen.queryByRole('button', { name: /Geri al/ })).toBeNull();      // geri alınacak bir şey yok
  });

  it('arama ad ve paket adına bakar; eşleşme yoksa boş durum ve "Aramayı temizle"', () => {
    render(<Harness />);
    const search = screen.getByRole('searchbox', { name: 'Uygulama ara' });
    fireEvent.change(search, { target: { value: 'tube' } });
    expect(screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toEqual(['YouTube']);
    expect(screen.getByText('1 sonuç')).toBeInTheDocument();
    expect(within(row('YouTube')).getByText('Tube').tagName).toBe('MARK');                  // eşleşen kısım vurgulu

    fireEvent.change(search, { target: { value: 'zzzz' } });
    expect(screen.getByText('«zzzz» ile eşleşen uygulama yok')).toBeInTheDocument();
    const clears = screen.getAllByRole('button', { name: 'Aramayı temizle' });          // arama kutusundaki × ve boş durumdaki düğme
    expect(clears).toHaveLength(2);
    fireEvent.click(clears[1]);
    expect(search).toHaveValue('');
    expect(screen.getAllByRole('switch')).toHaveLength(APPS.length);
  });

  it('süzgeç sekmeleri sayıları gösterir ve listeyi daraltır', () => {
    render(<Harness />);
    expect(screen.getByRole('radio', { name: 'Tümü 5' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Masaüstünde 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Eklenmemiş 4' }));
    expect(screen.getAllByRole('switch')).toHaveLength(4);
    fireEvent.click(screen.getByRole('radio', { name: 'Masaüstünde 1' }));
    expect(screen.getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toEqual(['Chrome']);
  });

  it('süzgeçli listede bir uygulamayı eklemek onu listeden düşürür (Eklenmemiş) ve sayılar güncellenir', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'Eklenmemiş 4' }));
    fireEvent.click(row('Galeri'));
    expect(screen.queryByRole('switch', { name: 'Galeri' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Eklenmemiş 3' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Masaüstünde 2' })).toBeInTheDocument();
  });

  it('hepsi masaüstündeyse "Eklenmemiş" sekmesi olumlu boş durum gösterir', () => {
    render(<Harness initial={{ 0: 'com.opendex.settings', 1: 'com.android.chrome', 2: 'com.sec.android.gallery3d', 3: 'com.google.android.youtube', 4: 'com.whatsapp' }} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Eklenmemiş 0' }));
    expect(screen.getByText('Tüm uygulamalar masaüstünde')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tümünü göster' }));
    expect(screen.getAllByRole('switch')).toHaveLength(5);
  });

  it('uygulama listesi boşsa açıklayıcı boş durum gösterir', () => {
    render(<Harness apps={[]} initial={{}} />);
    expect(screen.getByText('Uygulama listesi boş')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('toplu ekle/kaldır görünen listeye uygulanır, etiket bunu söyler; tümü geri alınır', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Tümünü ekle \(4\)/ }));
    expect(Object.values(layoutNow()).sort()).toEqual(
      ['com.android.chrome', 'com.google.android.youtube', 'com.opendex.settings', 'com.sec.android.gallery3d', 'com.whatsapp'],
    );
    expect(screen.getByRole('status')).toHaveTextContent('4 uygulama masaüstüne eklendi.');
    fireEvent.click(screen.getByRole('button', { name: /Geri al/ }));
    expect(layoutNow()).toEqual({ 0: 'com.android.chrome' });

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'a' } });                 // "Galeri, WhatsApp, Chrome, Ayarlar…"
    expect(screen.getByRole('button', { name: /Görünenleri ekle/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Görünenleri kaldır/ })).toBeInTheDocument();
  });

  it('toplu ekleme yer yetmezse kalanı söyler', () => {
    render(<Harness cells={3} initial={{ 0: 'com.android.chrome' }} />);
    fireEvent.click(screen.getByRole('button', { name: /Tümünü ekle/ }));
    expect(screen.getByRole('status')).toHaveTextContent('2 uygulama eklendi · 2 uygulama için yer kalmadı.');
  });

  it('toplu kaldırma klasörlere dokunmaz', () => {
    render(<Harness initial={{ 0: 'com.android.chrome', 1: 'custom-1', 2: 'com.whatsapp' }} custom={[{ id: 'custom-1', name: 'Oyunlar', appIds: [] }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Tümünü kaldır \(2\)/ }));
    expect(layoutNow()).toEqual({ 1: 'custom-1' });
  });

  it('"Önerilen düzen" uygulamaları varsayılana çevirir ama klasörleri kaybetmez; geri alınır', () => {
    const initial = { 0: 'custom-1', 5: 'com.whatsapp' };
    render(<Harness initial={initial} custom={[{ id: 'custom-1', name: 'Oyunlar', appIds: [] }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Önerilen düzen' }));
    const next = layoutNow();
    expect(next[0]).toBe('com.opendex.settings');
    expect(Object.values(next)).toContain('custom-1');
    expect(Object.values(next)).not.toContain('com.whatsapp');
    fireEvent.click(screen.getByRole('button', { name: /Geri al/ }));
    expect(layoutNow()).toEqual(initial);
  });

  it('klasördeki uygulamada klasör adı rozeti görünür ve yine de masaüstüne eklenebilir', () => {
    render(<Harness custom={[{ id: 'custom-1', name: 'Sosyal', appIds: ['com.whatsapp'] }]} />);
    const whatsapp = row('WhatsApp');
    expect(within(whatsapp).getByText('Sosyal')).toBeInTheDocument();
    fireEvent.click(whatsapp);
    expect(Object.values(layoutNow())).toContain('com.whatsapp');
  });

  it('Esc önce aramayı temizler, ikinci Esc kapatır', async () => {
    const onClosed = vi.fn();
    render(<Harness onClosed={onClosed} />);
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'chr' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Simgeleri yönet' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClosed).toHaveBeenCalledTimes(1);
    await act(gone);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Bitti" ve "Kapat" pencereyi kapatır; yeniden açılınca arama/süzgeç/durum temiz başlar', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'chr' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Masaüstünde 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bitti' }));
    await act(gone);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'aç' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('radio', { name: /^Tümü/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
    await act(gone);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ok tuşları aramadan listeye, satırlar arasında ve geri aramaya gezdirir', () => {
    render(<Harness />);
    const search = screen.getByRole('searchbox');
    search.focus();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const rows = screen.getAllByRole('switch');
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: 'End' });
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    fireEvent.keyDown(rows[rows.length - 1], { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(search);
  });

  it('listedeyken yazmaya başlamak aramaya geçirir; Boşluk satırı çevirir', () => {
    render(<Harness />);
    const rows = screen.getAllByRole('switch');
    rows[1].focus();
    fireEvent.keyDown(rows[1], { key: 'y' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
    rows[1].focus();
    fireEvent.keyDown(rows[1], { key: ' ' });                    // tuş bir düğmedeyse tarayıcı tıklar; burada yalnız gezinmeyi bozmadığını sınarız
    expect(document.activeElement).toBe(rows[1]);
  });
});
