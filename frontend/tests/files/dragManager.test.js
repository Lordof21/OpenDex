import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armDrag, externalTargetAt, getDrag, labelFor, registerDropTarget, resetDragManager, subscribeDrag } from '../../src/files/dragManager.js';

const phone = (path) => ({ provider: 'phone', path, device: 'S' });
const pc = (path) => ({ provider: 'pc', path });

let holder;
let hit = null;

function ptr(type, init = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 0, clientY: 0, ...init });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  Object.defineProperty(e, 'pointerType', { value: init.pointerType ?? 'mouse' });
  return e;
}

beforeEach(() => {
  resetDragManager();
  holder = document.createElement('div');
  holder.setAttribute('data-drop-id', 't1');
  document.body.appendChild(holder);
  hit = holder;
  document.elementFromPoint = vi.fn(() => hit);
});
afterEach(() => {
  holder.remove();
  vi.restoreAllMocks();
});

const payload = () => ({ sources: [phone('/a/x.jpg')], count: 1, label: 'x.jpg' });

describe('sürükleme', () => {
  it('eşik aşılmadan başlamaz; aşılınca başlar ve hedef üzerinde işlem belli olur', () => {
    registerDropTarget('t1', { loc: pc('C:\\Hedef'), name: 'Hedef', accepts: () => true, onDrop: vi.fn() });
    armDrag(ptr('pointerdown', { clientX: 10, clientY: 10 }), payload);
    window.dispatchEvent(ptr('pointermove', { clientX: 12, clientY: 12 }));
    expect(getDrag()).toBeNull();
    window.dispatchEvent(ptr('pointermove', { clientX: 30, clientY: 30 }));
    expect(getDrag()).toMatchObject({ count: 1, target: { id: 't1', name: 'Hedef' }, op: 'copy' });   // telefon → PC: varsayılan kopya
    expect(holder.getAttribute('data-drop-hover')).toBe('true');
    window.dispatchEvent(ptr('pointermove', { clientX: 31, clientY: 31, shiftKey: true }));
    expect(getDrag().op).toBe('move');                                                                 // Shift: taşı
  });

  it('bırakınca hedefin onDrop işlevi kaynak + değiştiricilerle çalışır; hayalet kalkar; ardından gelen click yutulur', async () => {
    const onDrop = vi.fn();
    registerDropTarget('t1', { loc: phone('/b'), name: 'B', accepts: () => true, onDrop });
    armDrag(ptr('pointerdown', { clientX: 0, clientY: 0 }), payload);
    window.dispatchEvent(ptr('pointermove', { clientX: 40, clientY: 0 }));
    expect(getDrag().op).toBe('move');                                                                 // aynı yer: taşı
    window.dispatchEvent(ptr('pointerup', { clientX: 40, clientY: 0, ctrlKey: true }));
    expect(onDrop).toHaveBeenCalledWith([phone('/a/x.jpg')], { ctrl: true, shift: false }, phone('/b'));
    await Promise.resolve();
    expect(getDrag()).toBeNull();
    expect(holder.hasAttribute('data-drop-hover')).toBe(false);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    const seen = vi.fn();
    holder.addEventListener('click', seen);
    holder.dispatchEvent(click);
    expect(seen).not.toHaveBeenCalled();                                                               // sürüklemeden sonraki click yutuldu
  });

  it('kabul etmeyen hedefe bırakılamaz; hedefsiz bırakma hiçbir şey yapmaz', () => {
    const onDrop = vi.fn();
    registerDropTarget('t1', { loc: phone('/a'), name: 'A', accepts: () => false, onDrop });
    armDrag(ptr('pointerdown'), payload);
    window.dispatchEvent(ptr('pointermove', { clientX: 50, clientY: 0 }));
    expect(getDrag().target).toBeNull();
    expect(holder.hasAttribute('data-drop-hover')).toBe(false);
    window.dispatchEvent(ptr('pointerup', { clientX: 50 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('Esc iptal eder', () => {
    const onDrop = vi.fn();
    registerDropTarget('t1', { loc: phone('/a'), name: 'A', accepts: () => true, onDrop });
    armDrag(ptr('pointerdown'), payload);
    window.dispatchEvent(ptr('pointermove', { clientX: 50 }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(ptr('pointerup', { clientX: 50 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('dokunmatik ve ikincil düğme sürüklemeyi başlatmaz', () => {
    registerDropTarget('t1', { loc: phone('/a'), name: 'A', accepts: () => true, onDrop: vi.fn() });
    armDrag(ptr('pointerdown', { pointerType: 'touch' }), payload);
    armDrag(ptr('pointerdown', { button: 2 }), payload);
    window.dispatchEvent(ptr('pointermove', { clientX: 80 }));
    expect(getDrag()).toBeNull();
  });

  it('kaynak yoksa sürükleme başlamaz', () => {
    armDrag(ptr('pointerdown'), () => ({ sources: [], count: 0, label: '' }));
    window.dispatchEvent(ptr('pointermove', { clientX: 60 }));
    expect(getDrag()).toBeNull();
  });

  it('tek kayıt çok hedefi çözebilir (liste satırları): öğeden konum üretilir, onDrop o konumu alır', () => {
    const onDrop = vi.fn();
    holder.setAttribute('data-index', '3');
    registerDropTarget('t1', {
      resolve: (el) => (el.getAttribute('data-index') === '3' ? { loc: pc('C:\\Satir3'), name: 'Satir3' } : null),
      accepts: (_sources, _mods, dest) => dest.path !== 'C:\\Yasak',
      onDrop,
    });
    armDrag(ptr('pointerdown'), payload);
    window.dispatchEvent(ptr('pointermove', { clientX: 60 }));
    expect(getDrag()).toMatchObject({ target: { name: 'Satir3' }, destLoc: pc('C:\\Satir3') });
    window.dispatchEvent(ptr('pointerup', { clientX: 60 }));
    expect(onDrop).toHaveBeenCalledWith([phone('/a/x.jpg')], { ctrl: false, shift: false }, pc('C:\\Satir3'));
    holder.setAttribute('data-index', '9');
    armDrag(ptr('pointerdown'), payload);
    window.dispatchEvent(ptr('pointermove', { clientX: 60 }));
    expect(getDrag().target).toBeNull();                                                   // çözümlenemeyen öğe hedef değil
  });

  it('abonelere haber verilir', () => {
    registerDropTarget('t1', { loc: phone('/a'), name: 'A', accepts: () => true, onDrop: vi.fn() });
    const listener = vi.fn();
    const off = subscribeDrag(listener);
    armDrag(ptr('pointerdown'), payload);
    window.dispatchEvent(ptr('pointermove', { clientX: 60 }));
    expect(listener).toHaveBeenCalled();
    off();
  });
});

describe('dışarıdan sürükleme ve etiketler', () => {
  it('imlecin altındaki hedef bulunur', () => {
    registerDropTarget('t1', { loc: pc('C:\\x'), name: 'x', accepts: () => true, onDrop: vi.fn() });
    expect(externalTargetAt(5, 5)).toMatchObject({ id: 't1', name: 'x' });
    hit = document.body;
    expect(externalTargetAt(5, 5)).toBeNull();
  });
  it('işlem etiketi hedefi söyler', () => {
    expect(labelFor('copy', phone('/a'))).toBe('Telefona kopyala');
    expect(labelFor('move', pc('C:\\a'))).toBe('Bilgisayara taşı');
    expect(labelFor('copy', null)).toBe('Kopyala');
  });
});
