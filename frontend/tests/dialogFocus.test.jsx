// ui/Dialog odak yönetimi: açılınca odak içeri girer, Tab kartın içinde döner, kapanınca odak açan öğeye döner.
import React, { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dialog } from '../src/ui/Dialog.jsx';

afterEach(cleanup);

function Harness({ withAutoFocus = false }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>aç</button>
      <button>arka plan</button>
      <Dialog open={open} onClose={() => setOpen(false)} label="Deneme">
        <button>bir</button>
        <input aria-label="ad" autoFocus={withAutoFocus} />
        <button onClick={() => setOpen(false)}>kapat</button>
      </Dialog>
    </div>
  );
}

const tab = (shiftKey = false) => fireEvent.keyDown(document.activeElement || document.body, { key: 'Tab', shiftKey });

describe('Dialog odak yönetimi', () => {
  it('açılınca odak ilk odaklanabilir öğeye girer', async () => {
    render(<Harness />);
    screen.getByText('aç').focus();
    await act(async () => fireEvent.click(screen.getByText('aç')));
    expect(document.activeElement).toBe(screen.getByText('bir'));
  });

  it('tüketicinin autoFocus\'u korunur', async () => {
    render(<Harness withAutoFocus />);
    await act(async () => fireEvent.click(screen.getByText('aç')));
    expect(document.activeElement).toBe(screen.getByLabelText('ad'));
  });

  it('Tab sonuncudan ilke, Shift+Tab ilkinden sona döner (arka plana çıkmaz)', async () => {
    render(<Harness />);
    await act(async () => fireEvent.click(screen.getByText('aç')));
    screen.getByText('kapat').focus();
    tab();
    expect(document.activeElement).toBe(screen.getByText('bir'));
    tab(true);
    expect(document.activeElement).toBe(screen.getByText('kapat'));
  });

  it('odak hiçbir yerde değilken (body) Tab karta geri alır', async () => {
    render(<Harness />);
    await act(async () => fireEvent.click(screen.getByText('aç')));
    document.activeElement.blur();
    tab();
    expect(document.activeElement).toBe(screen.getByText('bir'));
  });

  it('kapanınca odak diyaloğu açan düğmeye döner', async () => {
    render(<Harness />);
    const opener = screen.getByText('aç');
    opener.focus();
    await act(async () => fireEvent.click(opener));
    screen.getByText('kapat').focus();                                  // kullanıcı diyaloğun içinde çalışıyor
    await act(async () => fireEvent.click(screen.getByText('kapat')));
    expect(document.activeElement).toBe(opener);
  });
});
