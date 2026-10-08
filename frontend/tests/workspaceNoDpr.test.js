// I6: Mimari değişmez — kaynak taraması.
//
// Workspace matematiği tamamen CSS px <-> VD px arasında çalışır:
// ResizeObserver.contentRect, getBoundingClientRect() ve pointer
// clientX/clientY'nin hepsi CSS px. Araya devicePixelRatio sokmak,
// %125/%150 ölçeklemeli Windows'ta çerçeveyi tam o oran kadar kaydırır.
//
// exactFitDisplaySize (BAĞIMSIZ pencereler için) DPR'ı kasıtlı kullanır —
// bu test, o desenin yanlışlıkla workspace'e kopyalanmasını engeller.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOSYALAR = [
  'src/window/WorkspaceCanvas.jsx',
  'src/window/WorkspaceTaskFrame.jsx',
];

describe('I6: workspace matematiğinde devicePixelRatio kullanılmaz', () => {
  it.each(DOSYALAR)('%s içinde DPR referansı yok', (rel) => {
    const src = readFileSync(resolve(__dirname, '..', rel), 'utf8');
    expect(src).not.toMatch(/devicePixelRatio/);
    expect(src).not.toMatch(/devicePixelRatioSafe/);
  });
});
