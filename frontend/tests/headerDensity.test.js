// A window header that is too narrow for all its buttons drops the least needed ones first (Reload page — it is in the Hub — then audio and,
// outside a PiP, "Send to phone", which a right-click on the header still offers). An unmeasured header shows everything.
import { describe, expect, it } from 'vitest';
import { headerDensity } from '../src/window/TitleBar.jsx';

describe('headerDensity', () => {
  it('unmeasured (0) or wide enough: everything', () => {
    expect(headerDensity(0)).toBe('full');
    expect(headerDensity(800)).toBe('full');
    expect(headerDensity(400)).toBe('full');
  });

  it('DeX header: medium, then narrow', () => {
    expect(headerDensity(399)).toBe('medium');
    expect(headerDensity(330)).toBe('medium');
    expect(headerDensity(329)).toBe('narrow');
  });

  it('the PiP header has smaller buttons, so it keeps everything down to a narrower width', () => {
    expect(headerDensity(320, true)).toBe('full');
    expect(headerDensity(300, true)).toBe('medium');
    expect(headerDensity(240, true)).toBe('narrow');
  });
});
