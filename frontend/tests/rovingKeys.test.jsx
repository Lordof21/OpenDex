// Menü ve sekmelerde klavye: ↑↓ (←→) odağı öğeler arasında gezdirir, Home/End uçlara atlar, uçlar döner; roller sözünü tutar.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MenuItem, MenuSurface } from '../src/ui/Menu.jsx';
import { rovingKeys } from '../src/ui/rovingKeys.js';
import SnapLayoutMenu from '../src/window/titlebar/SnapLayoutMenu.jsx';
import { OverflowPanel } from '../src/taskbar/TaskbarOverflow.jsx';

afterEach(cleanup);
const press = (key, el = document.activeElement) => fireEvent.keyDown(el, { key });

describe('MenuSurface', () => {
  const setup = () => render(
    <MenuSurface aria-label="menü">
      <MenuItem label="Bir" onClick={() => {}} />
      <MenuItem label="İki" onClick={() => {}} />
      <MenuItem label="Üç" onClick={() => {}} />
    </MenuSurface>,
  );

  it('açılınca odak yüzeye girer; ↓ ilk öğeye, ↑ sona gider; uçlar döner; Home/End atlar', () => {
    setup();
    const menu = screen.getByRole('menu');
    expect(document.activeElement).toBe(menu);
    press('ArrowDown');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bir' }));
    press('ArrowDown'); press('ArrowDown');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Üç' }));
    press('ArrowDown');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bir' }));
    press('ArrowUp');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Üç' }));
    press('Home');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bir' }));
    press('End');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Üç' }));
  });

  it('IME bileşimi sırasında ok tuşları öğeye geçmez', () => {
    setup();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown', isComposing: true });
    expect(document.activeElement).toBe(screen.getByRole('menu'));
  });
});

describe('SnapLayoutMenu / TaskbarOverflow', () => {
  it('SnapLayoutMenu: herhangi bir ok DOM sırasında ilerler', () => {
    render(<SnapLayoutMenu current="max" onPick={() => {}} />);
    const items = screen.getAllByRole('menuitem');
    items[0].focus();
    press('ArrowRight');
    expect(document.activeElement).toBe(items[1]);
    press('ArrowDown');
    expect(document.activeElement).toBe(items[2]);
  });

  it('TaskbarOverflow: ↓ sıradaki pencereye odaklanır', () => {
    const items = [{ id: 'a', name: 'Bir', package: 'p.a' }, { id: 'b', name: 'İki', package: 'p.b' }];
    render(<OverflowPanel items={items} onActivate={() => {}} />);
    const rows = screen.getAllByRole('menuitem');
    rows[0].focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
  });
});

describe('rovingKeys', () => {
  it('yatay kipte yalnız ←→ çalışır; ↑↓ elenir', () => {
    const calls = [];
    const event = (key) => ({ key, currentTarget: { querySelectorAll: () => [] }, preventDefault: () => calls.push('pd') });
    expect(rovingKeys(event('ArrowDown'), '[role=tab]', { orientation: 'horizontal' })).toBe(false);
    expect(rovingKeys(event('ArrowRight'), '[role=tab]', { orientation: 'horizontal' })).toBe(false); // öğe yok → ele almaz
    expect(calls).toEqual([]);
  });
});
