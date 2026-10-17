import '@testing-library/jest-dom/vitest';

// Testler gerçek backend'e ASLA çıkmaz: çalışan bir OpenDeX varsa istek ona gider (anahtarsız → 401 + günlükte "reddedildi", ya da
// daha kötüsü gerçek veriye dokunur). api.js'i ya da fetch'i taklit eden testler bunu etkilemez (kendi taklitleri bu sarmalayıcının üstüne yazılır).
const BACKEND_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):8710(?:[/?#]|$)/i;
const realFetch = globalThis.fetch;
if (typeof realFetch === 'function') {
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (BACKEND_URL.test(url)) {
      return Promise.reject(new TypeError(`[tests] ${url}: gerçek backend'e istek atılamaz — api.js'i ya da fetch'i taklit edin`));
    }
    return realFetch.call(globalThis, input, init);
  };
}

if (typeof window !== 'undefined') {
  if (!window.PointerEvent) {
    class PointerEvent extends MouseEvent {
      constructor(type, props = {}) {
        super(type, props);
        this.pointerId = props.pointerId ?? 0;
        this.pointerType = props.pointerType ?? 'mouse';
      }
    }
    window.PointerEvent = PointerEvent;
    global.PointerEvent = PointerEvent;
  }

  if (typeof Element !== 'undefined') {
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {};
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {};
    }
  }
}
