// Tuş düzeni veri modeli ve geometri: bozuk veri temizlenir, çakışmalar bulunur, kaplama videonun GERÇEK dikdörtgenine oturur.
import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  activeNodes,
  findConflicts,
  fitRect,
  hitPoint,
  keyFromEvent,
  nodeRadiusPx,
  normalizeKeyName,
  sanitizeLayout,
  sanitizeNode,
} from '../src/keymapper/model.js';
import { mapClickToDeviceCoords } from '../src/input/touchInject.js';

describe('sanitizeNode / sanitizeLayout', () => {
  it('eksik alanlar varsayılanla dolar; sınırlar korunur', () => {
    expect(sanitizeNode({ type: 'tap', rx: 3, ry: -1, size: 9, mode: 'x' })).toMatchObject({
      type: 'tap', key: 'Space', rx: LIMITS.position.max, ry: LIMITS.position.min, size: LIMITS.tapSize.max, mode: 'hold',
    });
    expect(sanitizeNode({ type: 'dpad', radius: 0.01, scheme: 'dvorak', walkKey: 'Control' })).toMatchObject({
      key: 'WASD', radius: LIMITS.dpadRadius.min, scheme: 'wasd', walkKey: null, walkScale: LIMITS.walkScale.def,
    });
    expect(sanitizeNode({ type: 'look', sensX: 99, sensY: 0, invertY: 'yes' })).toMatchObject({
      key: 'Mouse', sensX: LIMITS.sens.max, sensY: LIMITS.sens.min, invertY: false, radius: LIMITS.lookRadius.def,
    });
  });

  it('eski (v1) tuş düğümündeki yan `radius: 0.1` görsel boyutu bozmaz', () => {
    const legacy = { id: 'a', type: 'tap', key: 'f', label: 'Ateş', rx: 0.5, ry: 0.5, radius: 0.1 };
    expect(sanitizeNode(legacy).size).toBe(LIMITS.tapSize.def);
  });

  it('bilinmeyen tür ve bozuk girdi atılır; joystick ve bakıştan yalnız ilki kalır; kimlikler tekil olur', () => {
    const layout = sanitizeLayout([
      null, 'x', { type: 'nope' },
      { id: 'a', type: 'tap', key: 'f' },
      { id: 'a', type: 'tap', key: 'g' },
      { id: 'd1', type: 'dpad' }, { id: 'd2', type: 'dpad' },
      { id: 'l1', type: 'look' }, { id: 'l2', type: 'look' },
    ]);
    expect(layout.map((n) => n.type)).toEqual(['tap', 'tap', 'dpad', 'look']);
    expect(new Set(layout.map((n) => n.id)).size).toBe(layout.length);
    expect(sanitizeLayout('bozuk')).toEqual([]);
  });
});

describe('tuş adları', () => {
  it('olaydan saklanacak ad: harf küçük, boşluk Space, özel tuşlar olduğu gibi; ayrılmışlar null', () => {
    expect(keyFromEvent({ key: 'F' })).toBe('f');
    expect(keyFromEvent({ key: ' ' })).toBe('Space');
    expect(keyFromEvent({ key: 'Shift' })).toBe('Shift');
    expect(keyFromEvent({ key: 'ArrowUp' })).toBe('ArrowUp');
    expect(keyFromEvent({ key: 'F5' })).toBe('F5');
    for (const reserved of ['Control', 'Escape', 'Meta', 'ContextMenu', 'Dead', 'Unidentified']) {
      expect(keyFromEvent({ key: reserved })).toBeNull();
    }
    expect(keyFromEvent(null)).toBeNull();
  });

  it('karşılaştırma adı büyük/küçük harfe ve boşluğa bakmaz', () => {
    expect(normalizeKeyName(' ')).toBe('space');
    expect(normalizeKeyName('Space')).toBe('space');
    expect(normalizeKeyName('ArrowUp')).toBe('arrowup');
  });
});

describe('çakışmalar', () => {
  it('aynı tuşu dinleyen iki düğüm birbirini işaret eder; joystick ok/WASD tuşlarını da dinler', () => {
    const nodes = sanitizeLayout([
      { id: 'a', type: 'tap', key: 'f' }, { id: 'b', type: 'tap', key: 'F' },
      { id: 'c', type: 'tap', key: 'g' },
      { id: 'j', type: 'dpad' }, { id: 'w', type: 'tap', key: 'w' },
    ]);
    const conflicts = findConflicts(nodes);
    expect(conflicts.get('a')).toEqual(['b']);
    expect(conflicts.get('b')).toEqual(['a']);
    expect(conflicts.has('c')).toBe(false);
    expect(conflicts.get('j')).toEqual(['w']);
  });

  it('ESDF şemasında W artık joystick tuşu değildir', () => {
    const nodes = sanitizeLayout([{ id: 'j', type: 'dpad', scheme: 'esdf' }, { id: 'w', type: 'tap', key: 'w' }]);
    expect(findConflicts(nodes).has('w')).toBe(false);
  });
});

describe('geometri: düğüm merkezi = motorun vurduğu cihaz pikseli', () => {
  const DEVICE = { w: 1220, h: 2712 };
  const BOXES = [{ w: 800, h: 450 }, { w: 450, h: 800 }, { w: 1220, h: 2712 }, { w: 300, h: 900 }];
  const POINTS = [[0.5, 0.5], [0.1, 0.9], [0.72, 0.31], [0.98, 0.02]];

  for (const fit of ['object-fill', 'object-contain', 'object-cover']) {
    for (const zoom of [1, 1.25, 1.5]) {
      it(`${fit} ×${zoom}: kaplamada çizilen nokta ile tıklama eşlemesi aynı cihaz pikselini verir`, () => {
        for (const box of BOXES) {
          const rect = fitRect(box.w, box.h, DEVICE.w, DEVICE.h, fit, zoom);
          for (const [rx, ry] of POINTS) {
            // Ekranda düğümün çizildiği nokta (kutu pikseli)…
            const screenX = rect.left + rx * rect.width;
            const screenY = rect.top + ry * rect.height;
            // …VideoCanvas.mapPointerToDevice'in yaptığı gibi: önce yakınlaştırma geri alınır, sonra mapClickToDeviceCoords.
            const cx = box.w / 2;
            const cy = box.h / 2;
            const unzoomedX = zoom === 1 ? screenX : cx + (screenX - cx) / zoom;
            const unzoomedY = zoom === 1 ? screenY : cy + (screenY - cy) / zoom;
            const device = mapClickToDeviceCoords(unzoomedX, unzoomedY, { left: 0, top: 0, width: box.w, height: box.h }, DEVICE.w, DEVICE.h, fit);
            const wanted = hitPoint({ rx, ry }, DEVICE.w, DEVICE.h);
            // Kırpan (cover) modda kutunun dışındaki noktalar uca yaslanır: yalnız görünür olanlar karşılaştırılır.
            const visible = screenX >= 0 && screenX <= box.w && screenY >= 0 && screenY <= box.h;
            if (visible) {
              expect(Math.abs(device.x - wanted.x)).toBeLessThanOrEqual(2);
              expect(Math.abs(device.y - wanted.y)).toBeLessThanOrEqual(2);
            }
          }
        }
      });
    }
  }

  it('object-contain harf kutusu bırakır: geniş kutuda video ortalanır', () => {
    const rect = fitRect(1000, 500, 500, 500, 'object-contain');
    expect(rect).toEqual({ left: 250, top: 0, width: 500, height: 500 });
  });

  it('sıfır / geçersiz kutu bozulmaz', () => {
    expect(fitRect(0, 0, 100, 100, 'object-contain')).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});

describe('boyutlar', () => {
  it('joystick yarıçapı motorun kullandığı değerdir: oran × kısa kenar', () => {
    expect(nodeRadiusPx({ type: 'dpad', radius: 0.12 }, 1000, 500)).toBe(60);
    expect(nodeRadiusPx({ type: 'tap', size: 0.05 }, 1000, 500)).toBe(25);
    expect(nodeRadiusPx({ type: 'look', radius: 0.18 }, 1000, 500)).toBe(90);
  });
});

describe('etkin / devre dışı düğüm', () => {
  it('`enabled` varsayılan açık; yalnız açıkça false olan kapalıdır; devre dışı düğüm çakışmaya girmez', () => {
    const nodes = sanitizeLayout([
      { id: 'a', type: 'tap', key: 'f' },
      { id: 'b', type: 'tap', key: 'f', enabled: false },
      { id: 'c', type: 'tap', key: 'g', enabled: 'hayır' },
    ]);
    expect(nodes.map((n) => n.enabled)).toEqual([true, false, true]);
    expect(findConflicts(nodes).size).toBe(0);   // b devre dışı: f'yi dinlemiyor
    expect(findConflicts(nodes.map((n) => ({ ...n, enabled: true }))).get('a')).toEqual(['b']);
  });

  it('activeNodes devre dışı olanları çıkarır; hiçbiri çıkmıyorsa AYNI diziyi, çıkıyorsa her seferinde AYNI yeni diziyi verir', () => {
    const all = sanitizeLayout([{ id: 'a', type: 'tap', key: 'f' }, { id: 'b', type: 'tap', key: 'g', enabled: false }]);
    const allOn = sanitizeLayout([{ id: 'a', type: 'tap', key: 'f' }]);
    expect(activeNodes(allOn)).toBe(allOn);
    expect(activeNodes(all).map((n) => n.id)).toEqual(['a']);
    expect(activeNodes(all)).toBe(activeNodes(all));   // önbellek: efekt/seçici bağımlılıkları durmadan yeniden kurulmaz
    expect(activeNodes(undefined)).toBeUndefined();
  });
});
