// İşaretçi (pointer) tabanlı sürükle-bırak. HTML5 DnD KULLANILMAZ: Tauri'nin WebView2'sinde yerel "dosya bırakma" işleyicisi
// (Gezgin'den sürüklenen dosyalar için gerekli — yollar yalnız oradan gelir) açıkken HTML5 sürükle-bırak bozulur; pencere
// içi sürükleme de bu yüzden kendi yöneticimizle yapılır. Faydası: hayalet öğe, imleç bilgisi ve kenarda otomatik kaydırma
// tam bizim elimizde, fare ve kalem aynı yoldan geçer.
//
// Akış: satır `armDrag` ile işaretçiyi izlemeye alır → eşik (5 px) aşılınca sürükleme BAŞLAR → hedefler `data-drop-id`
// taşıyan öğelerdir (`registerDropTarget`) → bırakınca hedefin `onDrop`'u çalışır. Esc ya da pointercancel iptal eder.
// Sürüklemeden sonraki "click" yutulur (satır yanlışlıkla açılmasın).
import { dropOperation } from './filesCommands.js';

const THRESHOLD_PX = 5;
const EDGE_PX = 40;
const MAX_SCROLL_PX = 18;

let drag = null;                          // { sources, count, label, x, y, target: { id, name } | null, op: 'copy'|'move'|null }
let armed = null;                         // sürükleme eşiği beklenen işaretçi
const targets = new Map();                // id → { loc, name, accepts, onDrop }
const subscribers = new Set();
let scrollFrame = 0;
let recentlyDragged = false;

export const getDrag = () => drag;

/** Az önce bir sürükleme bitti mi? (aynı olay döngüsü: satır, sürüklemenin ardındaki pointerup'ı "tıklama" saymasın) */
export const justDragged = () => recentlyDragged;

export function subscribeDrag(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function publish(next) {
  drag = next;
  subscribers.forEach((fn) => fn());
}

/**
 * Bir öğeyi bırakma hedefi yapar. `accepts(sources, mods, dest)` hedefin bu kaynakları kabul edip etmediği (kendi klasörü /
 * kendi altı reddedilir). Bir liste satırları gibi çok sayıda hedef TEK kayıtla verilebilir: `resolve(el)` öğeden
 * { loc, name } üretir (null → hedef değil) — 40 satır için 40 kayıt gerekmez.
 */
export function registerDropTarget(id, config) {
  targets.set(id, config);
  return () => {
    if (targets.get(id) === config) targets.delete(id);
  };
}

const targetUnder = (x, y) => {
  const el = document.elementFromPoint?.(x, y);
  const holder = el?.closest?.('[data-drop-id]');
  return holder ? { el: holder, id: holder.getAttribute('data-drop-id'), config: targets.get(holder.getAttribute('data-drop-id')) } : null;
};

export function labelFor(op, dest) {
  const where = dest?.provider === 'phone' ? 'Telefona' : dest?.provider === 'pc' ? 'Bilgisayara' : '';
  if (op === 'move') return where ? `${where} taşı` : 'Taşı';
  return where ? `${where} kopyala` : 'Kopyala';
}

function markHover(el) {
  if (markHover.current === el) return;
  markHover.current?.removeAttribute('data-drop-hover');
  el?.setAttribute('data-drop-hover', 'true');
  markHover.current = el || null;
}

function autoScroll(x, y) {
  cancelAnimationFrame(scrollFrame);
  const box = document.elementFromPoint?.(x, y)?.closest?.('[data-files-scroll]');
  if (!box) return;
  const rect = box.getBoundingClientRect();
  const speed = y < rect.top + EDGE_PX ? -Math.min(MAX_SCROLL_PX, (rect.top + EDGE_PX - y) / 2)
    : y > rect.bottom - EDGE_PX ? Math.min(MAX_SCROLL_PX, (y - (rect.bottom - EDGE_PX)) / 2) : 0;
  if (!speed) return;
  const step = () => {
    if (!drag) return;
    box.scrollTop += speed;
    scrollFrame = requestAnimationFrame(step);
  };
  scrollFrame = requestAnimationFrame(step);
}

function update(event) {
  const hit = targetUnder(event.clientX, event.clientY);
  const config = hit?.config;
  const resolved = config ? (config.resolve ? config.resolve(hit.el) : config) : null;
  const mods = { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey };
  const ok = Boolean(resolved && config.accepts(drag.sources, mods, resolved.loc));
  markHover(ok ? hit.el : null);
  const op = ok ? dropOperation({ sources: drag.sources, dest: resolved.loc, ...mods }) : null;
  publish({ ...drag, x: event.clientX, y: event.clientY, target: ok ? { id: hit.id, name: resolved.name } : null, op, destLoc: ok ? resolved.loc : null });
  autoScroll(event.clientX, event.clientY);
}

function finish(event, { drop }) {
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
  window.removeEventListener('keydown', onKey, true);
  cancelAnimationFrame(scrollFrame);
  markHover(null);
  const finished = drag;
  armed = null;
  if (finished) {
    recentlyDragged = true;
    setTimeout(() => { recentlyDragged = false; }, 0);
    // Sürüklemenin ardından gelen "click" yutulur; gelmezse (pencere dışında bırakıldı) dinleyici 120 ms sonra kalkar —
    // sonraki GERÇEK tıklama asla yutulmaz.
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); window.removeEventListener('click', swallow, true); };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 120);
    queueMicrotask(() => publish(null));
    if (drop && finished.target) {
      const config = targets.get(finished.target.id);
      config?.onDrop(finished.sources, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey }, finished.destLoc);
    }
  }
}

function onMove(event) {
  if (!armed || event.pointerId !== armed.pointerId) return;
  if (!drag) {
    if (Math.hypot(event.clientX - armed.x, event.clientY - armed.y) < THRESHOLD_PX) return;
    const payload = armed.payload();
    if (!payload?.sources?.length) {
      finish(event, { drop: false });
      return;
    }
    drag = { ...payload, x: event.clientX, y: event.clientY, target: null, op: null, destLoc: null };
  }
  update(event);
}

const onUp = (event) => finish(event, { drop: true });
const onCancel = (event) => finish(event, { drop: false });
function onKey(event) {
  if (event.key === 'Escape' && drag) {
    event.stopPropagation();
    finish(event, { drop: false });
  }
}

/**
 * Bir satırdaki `pointerdown` sürüklemeyi ARMAR (hemen başlatmaz). `payload()` sürükleme gerçekten başladığında çağrılır:
 * { sources: [Konum], count, label } döndürür — böylece seçim, tıklama işlendikten SONRAKİ hâliyle okunur.
 * Yalnız fare/kalem: dokunmatikte kaydırma ile çakışır (menüden Kopyala/Kes/Gönder kullanılır).
 */
export function armDrag(event, payload) {
  if (event.button !== 0 || event.pointerType === 'touch') return;
  armed = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, payload };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
}

/** Dışarıdan (Gezgin) sürüklenen dosyalar: Tauri konumu verir; vurgulanacak/bırakılacak hedefi buradan buluruz. */
export function externalTargetAt(x, y) {
  const hit = targetUnder(x, y);
  const resolved = hit?.config ? (hit.config.resolve ? hit.config.resolve(hit.el) : hit.config) : null;
  return resolved ? { id: hit.id, loc: resolved.loc, name: resolved.name, el: hit.el } : null;
}

export function highlightExternalTarget(el) {
  markHover(el);
}

/** Yalnız testler. */
export function resetDragManager() {
  targets.clear();
  armed = null;
  markHover(null);
  publish(null);
}
