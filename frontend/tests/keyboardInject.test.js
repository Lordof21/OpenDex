import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  isWindowManagerShortcut,
  resolveKeyEvent,
  injectDomKeyEvent,
  sendDpad,
} from '../src/input/keyboardInject.js';
import { logger } from '../src/lib/logger.js';
import { api } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', () => ({
  api: {
    post: vi.fn().mockResolvedValue({ status: 'ok' }),
  },
}));

describe('keyboardInject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('isWindowManagerShortcut correctly identifies WM shortcuts', () => {
    expect(isWindowManagerShortcut({ altKey: true, key: 'Tab' })).toBe(true);
    expect(isWindowManagerShortcut({ ctrlKey: true, altKey: false, key: 'w' })).toBe(true);
    expect(isWindowManagerShortcut({ ctrlKey: true, altKey: false, key: 'W' })).toBe(true);

    expect(isWindowManagerShortcut({ key: 'a' })).toBe(false);
    expect(isWindowManagerShortcut({ ctrlKey: true, key: 'k' })).toBe(false);
  });

  test('resolveKeyEvent classifies keys correctly', () => {
    expect(resolveKeyEvent({ key: 'Enter' })).toEqual({
      type: 'keycode',
      payload: { key: 'enter' },
    });

    expect(resolveKeyEvent({ key: 'a' })).toEqual({
      type: 'ascii',
      payload: { char: 'a' },
    });

    expect(resolveKeyEvent({ key: 'ç' })).toEqual({
      type: 'special',
      payload: { char: 'ç' },
    });

    expect(resolveKeyEvent({ ctrlKey: true, key: 'c' })).toEqual({
      type: 'shortcut',
      payload: { modifiers: ['ctrl'], key: 'c' },
    });
  });

  test('injectDomKeyEvent triggers API exactly once per keystroke', async () => {
    const windowId = 'win-123';
    const event = { key: 'a', length: 1 };

    const handled = await injectDomKeyEvent(windowId, event);
    expect(handled).toBe(true);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/api/input/key', {
      window_id: windowId,
      kind: 'char',
      char: 'a',
    });
  });

  describe('sendDpad (the on-screen "Yön tuşları")', () => {
    test.each([
      ['up', 'arrowup'],
      ['down', 'arrowdown'],
      ['left', 'arrowleft'],
      ['right', 'arrowright'],
      ['select', 'enter'],
    ])('%s presses the Android key "%s" through the keycode path the backend accepts', async (direction, key) => {
      await expect(sendDpad('win-1', direction)).resolves.toBe(true);
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(api.post).toHaveBeenCalledWith('/api/input/key', { window_id: 'win-1', kind: 'keycode', key });
    });

    test('an unknown direction sends nothing', async () => {
      await expect(sendDpad('win-1', 'diagonal')).resolves.toBe(false);
      expect(api.post).not.toHaveBeenCalled();
    });

    test('a refused press is logged, never swallowed silently, and does not throw', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => ({}));
      api.post.mockRejectedValueOnce(new Error('422 Unprocessable'));
      await expect(sendDpad('win-1', 'up')).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith('input', 'dpad_press_failed', expect.objectContaining({ direction: 'up', key: 'arrowup' }));
      warn.mockRestore();
    });
  });
});
