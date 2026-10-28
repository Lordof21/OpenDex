// Pencere istifi: pinli pencere odaksız olanların üstünde; OpenDeX'in kendi araçları (Ayarlar, Dosyalar) odaktayken pinlinin de önünde.
import { describe, expect, it } from 'vitest';
import { Z_INDEX, windowStackZ } from '../src/ui/zIndex.js';

describe('windowStackZ', () => {
  it('sıradan pencere kendi sırasında; pinli pencere sabit bandın üstünde; tam ekran en üstte', () => {
    expect(windowStackZ({ z: 7 })).toBe(7);
    expect(windowStackZ({ z: 7, pinned: true })).toBe(Z_INDEX.windowPinnedBase + 7);
    expect(windowStackZ({ z: 7, pinned: true, fullscreen: true })).toBe(Z_INDEX.windowFullscreen);
  });

  it('Ayarlar/Dosyalar odaktayken pinli bir videonun önüne çıkar, odak gidince arkasına döner', () => {
    const pinnedVideo = windowStackZ({ z: 40, pinned: true });
    const focusedTool = windowStackZ({ z: 41, focused: true, raisedWhenFocused: true });
    const blurredTool = windowStackZ({ z: 41, focused: false, raisedWhenFocused: true });
    expect(focusedTool).toBeGreaterThan(pinnedVideo);
    expect(blurredTool).toBeLessThan(pinnedVideo);
  });

  it('odaktaki sıradan (araç olmayan) pencere pinlinin önüne çıkmaz', () => {
    expect(windowStackZ({ z: 99, focused: true })).toBeLessThan(windowStackZ({ z: 1, pinned: true }));
  });

  it('görev çubuğu paneli (taskbar) her sabit/odaktaki pencerenin üstünde kalır', () => {
    const highestTool = windowStackZ({ z: 30000, focused: true, raisedWhenFocused: true });
    expect(highestTool).toBeLessThan(Z_INDEX.taskbar);
  });
});
