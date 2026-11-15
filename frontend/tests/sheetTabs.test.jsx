// Excel çalışma sayfası sekmeleri: yalnız açık sekme Tab sırasında; ←/→/Home/End sekmeyi değiştirir ve odağı taşır.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../src/files/fsApi.js', () => ({ fetchBytes: vi.fn().mockResolvedValue(new ArrayBuffer(8)) }));
vi.mock('../src/files/documents/workbook.js', async (orig) => ({
  ...(await orig()),
  readWorkbook: vi.fn().mockResolvedValue([
    { name: 'Ocak', rows: [['a']], totalRows: 1, totalCols: 1 },
    { name: 'Şubat', rows: [['b']], totalRows: 1, totalCols: 1 },
    { name: 'Mart', rows: [['c']], totalRows: 1, totalCols: 1 },
  ]),
}));

import { SheetBody } from '../src/files/DocumentBodies.jsx';

afterEach(cleanup);

describe('SheetBody sekmeleri', () => {
  it('roving tabindex + ok tuşları', async () => {
    render(<SheetBody loc={{ provider: 'pc', path: '/x.xlsx' }} entry={{ name: 'x.xlsx', mtime: 1, size: 10 }} onOpen={() => {}} />);
    const tabs = await waitFor(() => screen.getAllByRole('tab'));
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(document.activeElement).toBe(screen.getAllByRole('tab')[1]);
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    expect(document.activeElement).toBe(screen.getAllByRole('tab')[2]);
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });                         // sondan başa döner
    expect(document.activeElement).toBe(screen.getAllByRole('tab')[0]);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'sheet-tab-0');
  });
});
