// Tuş düzenleyicisinden Esc ile çıkış. Değişiklikler her adımda kaydedildiği için kapatmak veri kaybettirmez. Esc
// "escape yığını" üzerinden gider: tam ekrandan çıkmaz, telefona Esc yazılmaz, açık tuş seçici varsa önce o kapanır.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import KeymapperOverlay from '../src/keymapper/KeymapperOverlay.jsx';
import { useKeymapStore } from '../src/keymapper/keymapStore.js';
import { escapeStackDepth } from '../src/lib/escapeStack.js';

const WIN = { id: 'w1', package: 'com.game' };
const esc = () => fireEvent.keyDown(window, { key: 'Escape' });

beforeEach(() => {
  useKeymapStore.setState({ presets: { 'com.game': [{ id: 'n1', type: 'tap', key: 'f', label: 'Ateş', rx: 0.5, ry: 0.5 }] } });
});
afterEach(cleanup);

describe('KeymapperOverlay — Esc', () => {
  it('düzenleme açıkken Esc düzenleyiciyi kapatır', () => {
    const onClose = vi.fn();
    render(<KeymapperOverlay win={WIN} isEditing onCloseEdit={onClose} />);
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('düzenleme kapalıyken Esc\'e karışmaz (yığına hiç girmez)', () => {
    const onClose = vi.fn();
    const before = escapeStackDepth();
    render(<KeymapperOverlay win={WIN} isEditing={false} onCloseEdit={onClose} />);
    expect(escapeStackDepth()).toBe(before);
    esc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc olayı başka dinleyicilere (tam ekrandan çık, telefona yaz) ulaşmaz', () => {
    const bubbled = vi.fn();
    window.addEventListener('keydown', bubbled);
    render(<KeymapperOverlay win={WIN} isEditing onCloseEdit={() => {}} />);
    esc();
    window.removeEventListener('keydown', bubbled);
    expect(bubbled).not.toHaveBeenCalled();
  });

  it('açık tuş seçici varsa önce o kapanır, düzenleyici açık kalır; ikinci Esc düzenleyiciyi kapatır', async () => {
    const onClose = vi.fn();
    render(<KeymapperOverlay win={WIN} isEditing onCloseEdit={onClose} />);

    fireEvent.click(screen.getByTitle('Tuş değiştir'));
    expect(screen.getByText('Fiziksel Tuş Seçin')).toBeInTheDocument();

    esc();
    await waitFor(() => expect(screen.queryByText('Fiziksel Tuş Seçin')).toBeNull()); // çıkış animasyonu biter
    expect(onClose).not.toHaveBeenCalled();

    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('yeniden çizimlerde işleyici yığında bir kez kalır, kapanınca temizlenir', () => {
    const base = escapeStackDepth();
    const { rerender, unmount } = render(<KeymapperOverlay win={WIN} isEditing onCloseEdit={() => {}} />);
    rerender(<KeymapperOverlay win={WIN} isEditing onCloseEdit={() => {}} />);
    rerender(<KeymapperOverlay win={WIN} isEditing onCloseEdit={() => {}} />);
    expect(escapeStackDepth()).toBe(base + 1);
    unmount();
    expect(escapeStackDepth()).toBe(base);
  });

  it('güncel onCloseEdit çağrılır (eski kapanış değil)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<KeymapperOverlay win={WIN} isEditing onCloseEdit={first} />);
    rerender(<KeymapperOverlay win={WIN} isEditing onCloseEdit={second} />);
    esc();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
