// src/ui/ tek UI sistemi: primitive sözleşmeleri (rol, aria, tek tetiklenme, statik sınıflar, Esc katmanı).
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Monitor } from 'lucide-react';
import Button, { buttonClasses } from '../src/ui/Button.jsx';
import { IconButton, WindowControl } from '../src/ui/IconButton.jsx';
import { Switch, SwitchRow } from '../src/ui/Switch.jsx';
import { SegmentedControl } from '../src/ui/SegmentedControl.jsx';
import { ChoiceGrid, IconTile } from '../src/ui/Choice.jsx';
import { SettingsGroup } from '../src/ui/Card.jsx';
import { Dialog } from '../src/ui/Dialog.jsx';
import { escapeStackDepth } from '../src/lib/escapeStack.js';

afterEach(cleanup);

describe('Button', () => {
  it('eski TailAdmin varyant adları yeni varyantlara eşlenir', () => {
    expect(buttonClasses({ variant: 'primary' })).toBe(buttonClasses({ variant: 'default' }));
    expect(buttonClasses({ variant: 'danger' })).toBe(buttonClasses({ variant: 'destructive' }));
    expect(buttonClasses({ size: 'md' })).toBe(buttonClasses({ size: 'default' }));
  });

  it('TailAdmin rengi üretmez', () => {
    for (const variant of ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link']) {
      expect(buttonClasses({ variant })).not.toMatch(/\b(dark:|gray-|slate-|brand-|surface-)/);
    }
  });

  it('loading iken devre dışıdır', () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Kaydet</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('IconButton / WindowControl', () => {
  it('label → aria-label + data-tooltip', () => {
    render(<IconButton label="Kapat"><Monitor /></IconButton>);
    const btn = screen.getByRole('button', { name: 'Kapat' });
    expect(btn).toHaveAttribute('data-tooltip', 'Kapat');
  });

  it('WindowControl tıklamayı ve pointerdown\'ı pencereye sızdırmaz; title geçer', () => {
    const outer = vi.fn();
    const onClick = vi.fn();
    render(
      <div onClick={outer} onPointerDown={outer}>
        <WindowControl label="Kapat" title="Kapat" onClick={onClick}><Monitor /></WindowControl>
      </div>,
    );
    const btn = screen.getByTitle('Kapat');
    fireEvent.pointerDown(btn);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    expect(btn).toHaveAttribute('data-tooltip-position', 'bottom');
  });
});

describe('Switch / SwitchRow', () => {
  it('Switch role="switch" ve aria-checked taşır', () => {
    const onChange = vi.fn();
    render(<Switch checked label="Wi‑Fi aç/kapat" onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Wi‑Fi aç/kapat' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each(['card', 'row', 'panel'])('SwitchRow(%s) tek buton — içinde ikinci buton yok, tek tıklama tek çağrı', (variant) => {
    const onToggle = vi.fn();
    const { container } = render(<SwitchRow variant={variant} icon={Monitor} title="Gerçek Çözünürlük" checked={false} onToggle={onToggle} />);
    expect(container.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Gerçek Çözünürlük/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('SegmentedControl', () => {
  const options = [
    { value: 'pc', label: 'PC' },
    { value: 'phone', label: 'Telefon' },
  ];
  it('radiogroup/radio; seçili olana tekrar basmak onChange çağırmaz', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Ses çıkışı" options={options} value="pc" onChange={onChange} />);
    expect(screen.getByRole('radiogroup', { name: 'Ses çıkışı' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'PC' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: 'Telefon' }));
    expect(onChange).toHaveBeenCalledWith('phone');
  });
});

describe('ChoiceGrid / IconTile / SettingsGroup', () => {
  it('sütun sayısı statik sınıf üretir; seçili çip aria-pressed=true; kapsayıcıya data-* geçer', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ChoiceGrid
        columns={3}
        data-window-setting="video_fit_mode"
        options={[{ value: true, label: 'Kilitli' }, { value: false, label: 'Serbest' }, { value: 'follow', label: 'Genele uy', hint: 'Genel: Serbest' }]}
        value={false}
        onChange={onChange}
      />,
    );
    const grid = container.firstChild;
    expect(grid.className).toContain('grid-cols-3');
    expect(grid).toHaveAttribute('data-window-setting', 'video_fit_mode');
    expect(screen.getByRole('button', { name: /^Serbest/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Genele uy/ }));
    expect(onChange).toHaveBeenCalledWith('follow');
  });

  it('IconTile aria-pressed taşır', () => {
    render(<IconTile icon={Monitor} title="Fener" status="Açık" active onClick={() => {}} />);
    expect(screen.getByRole('button', { name: /Fener/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('SettingsGroup bir <section> çizer ve değeri rozet olarak gösterir', () => {
    render(<SettingsGroup icon={Monitor} title="Başlık Çubuğu" value="Sabit"><span>içerik</span></SettingsGroup>);
    expect(screen.getByText('Başlık Çubuğu').closest('section')).not.toBeNull();
    expect(screen.getByText('Sabit')).toBeInTheDocument();
  });
});

describe('Dialog', () => {
  it('açıkken Esc katmanı ekler, Esc onClose çağırır, kapanınca katman kalkar', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Dialog open label="Klasör" onClose={onClose}><p>içerik</p></Dialog>);
    expect(screen.getByRole('dialog', { name: 'Klasör' })).toBeInTheDocument();
    expect(escapeStackDepth()).toBe(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<Dialog open={false} label="Klasör" onClose={onClose}><p>içerik</p></Dialog>);
    expect(escapeStackDepth()).toBe(0);
  });

  it('karta tıklamak kapatmaz, karartmaya tıklamak kapatır', () => {
    const onClose = vi.fn();
    render(<Dialog open label="Klasör" onClose={onClose}><p>içerik</p></Dialog>);
    fireEvent.click(screen.getByText('içerik'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('dialog').parentElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
