// AnimatePresence'in doğrudan çocuğuna `ref` verilmez: framer-motion bunu props.ref olarak da okur ve React 18.3 dev'de
// "`ref` is not a prop" uyarısı basar. Menü yüzeyine `surfaceRef` ile erişilir; bu test uyarının geri gelmediğini ve
// klavye davranışının (açılışta ilk öğeye odak, ↓ ile gezinme) sürdüğünü sabitler.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import DropdownMenu from '../src/files/DropdownMenu.jsx';
import FileContextMenu from '../src/files/FileContextMenu.jsx';
import { MenuItem } from '../src/ui/Menu.jsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const refWarnings = (spy) => spy.mock.calls.filter((c) => String(c[0]).includes('is not a prop'));

describe('menü yüzeyi AnimatePresence içinde', () => {
  it('DropdownMenu: ref uyarısı yok, ilk öğeye odaklanır, ↓ gezinir', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <DropdownMenu
        label="Menü"
        trigger={(p) => <button type="button" {...p}>aç</button>}
      >
        {() => (
          <>
            <MenuItem label="Bir" />
            <MenuItem label="İki" />
          </>
        )}
      </DropdownMenu>,
    );
    await act(async () => { fireEvent.click(screen.getByText('aç')); });

    const menu = await screen.findByRole('menu');
    expect(menu).toBeTruthy();
    expect(document.activeElement?.textContent).toContain('Bir');
    await act(async () => { fireEvent.keyDown(menu, { key: 'ArrowDown' }); });
    expect(document.activeElement?.textContent).toContain('İki');
    expect(refWarnings(err)).toEqual([]);
  });

  it('FileContextMenu: ref uyarısı yok, ilk etkin öğeye odaklanır', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <FileContextMenu
        menu={[{ type: 'item', id: 'open', label: 'Aç' }, { type: 'item', id: 'del', label: 'Sil' }]}
        x={10}
        y={10}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    const menu = await screen.findByRole('menu');
    expect(menu).toBeTruthy();
    expect(document.activeElement?.textContent).toContain('Aç');
    expect(refWarnings(err)).toEqual([]);
  });
});
