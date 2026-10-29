import { describe, expect, it, vi } from 'vitest';

let liveSettings = null;
vi.mock('../src/settings/liveSettings.js', () => ({ getLiveSettings: () => liveSettings, useLiveSettings: () => liveSettings }));

import { chromeFor } from '../src/window/ResizeHandle.jsx';
import { FRAME_BORDER_PX, FRAME_CHROME_H_PX } from '../src/window/windowMath.js';

// A DeX crop window: no VideoCanvas, so never a measured canvasW/canvasH; its header follows the general setting.
const cropWin = { id: 'crop-1', kind: 'workspace-crop', w: 900, h: 700, headerMode: 'follow' };

describe('chromeFor (unmeasured window)', () => {
  it('counts no title bar when the general setting hides the header', () => {
    // Log 2026-10-29 12:42:46: the title bar counted here was not on screen — the released resize asked Android for a box
    // 44 px too short, and the canvas then sent the real height in a second request.
    liveSettings = { header_hover_mode: true };
    expect(chromeFor(cropWin)).toEqual({ dw: FRAME_BORDER_PX, dh: FRAME_BORDER_PX });
  });

  it('counts the title bar when it shows (setting off, or not loaded yet)', () => {
    liveSettings = { header_hover_mode: false };
    expect(chromeFor(cropWin)).toEqual({ dw: FRAME_BORDER_PX, dh: FRAME_CHROME_H_PX });
    liveSettings = null;
    expect(chromeFor(cropWin)).toEqual({ dw: FRAME_BORDER_PX, dh: FRAME_CHROME_H_PX });
  });

  it('a pinned header shows whatever the setting says', () => {
    liveSettings = { header_hover_mode: true };
    expect(chromeFor({ ...cropWin, headerMode: 'pinned' })).toEqual({ dw: FRAME_BORDER_PX, dh: FRAME_CHROME_H_PX });
  });
});
