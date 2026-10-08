import { describe, it, expect } from 'vitest';
import {
  applySubpixelRule,
  calculateWorkspaceTaskDpi,
} from '../src/window/windowMath.js';

describe('Subpixel Math & Workspace DPI (Plan §1.2 & §4)', () => {
  describe('applySubpixelRule', () => {
    it('applies Math.floor to starting offsets and Math.round to dimensions', () => {
      const { x, y, w, h } = applySubpixelRule(120.85, 45.92, 800.4, 600.6);
      expect(x).toBe(120); // Math.floor(120.85)
      expect(y).toBe(45);  // Math.floor(45.92)
      expect(w).toBe(800); // Math.round(800.4)
      expect(h).toBe(601); // Math.round(600.6)
    });

    it('handles exact integer coordinates without alteration', () => {
      const { x, y, w, h } = applySubpixelRule(100, 200, 500, 400);
      expect(x).toBe(100);
      expect(y).toBe(200);
      expect(w).toBe(500);
      expect(h).toBe(400);
    });
  });

  describe('calculateWorkspaceTaskDpi (Plan §4)', () => {
    it('yields compact phone DPI (300 DPI) for small tasks', () => {
      const dpi = calculateWorkspaceTaskDpi(360, 640, 1080);
      expect(dpi).toBe(300);
    });

    it('yields desktop DPI (180 DPI) for maximized tasks', () => {
      const dpi = calculateWorkspaceTaskDpi(1600, 960, 1080);
      expect(dpi).toBe(180);
    });

    it('interpolates smoothly for tablet-sized windows', () => {
      const dpi = calculateWorkspaceTaskDpi(700, 550, 1080);
      expect(dpi).toBeGreaterThanOrEqual(200);
      expect(dpi).toBeLessThanOrEqual(280);
    });
  });
});
