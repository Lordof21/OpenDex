// Göreli sürükleme kaydırıcı davranışı. Ses mikseri, PrecisionSlider ve Workspace DPI ince
// ayarı bu TEK kancayı kullanır.
//
// Kurallar
//  - Yalnız TUTAMAÇ (merkezine ±`grabRadius` px) yakalanırsa sürükleme başlar. Boş track tıklaması HİÇBİR
//    ŞEY yapmaz (tarayıcının yerel range girdisi gibi tıklanan noktaya atlama yok).
//  - Değer, başlangıç değeri + dx/genişlik·aralık ile hesaplanır: tutamağa neresinden basılırsa basılsın
//    sıçrama olmaz.
//  - onChange(v): her yeni adımda (canlı gösterge, ya da canlı uygulama isteyenler için).
//    onCommit(v): jest bitince TEK kez — pointerup, ya da klavye / ± düğmesi dizisi bitince (keyup, blur,
//    düğme bırakma). Değer başlangıçtan farklı değilse commit yoktur.
//  - Esc / pointercancel / yakalamanın kaybı: eski değere dönülür, commit YOK.
//  - `holdoffMs` > 0 ise commit'ten sonra o süre boyunca dışarıdan gelen değer yok sayılır: telefondan dönen
//    gecikmeli yankı (device_volumes_update) tutamağı geri sıçratmasın.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pushEscapeHandler } from '../lib/escapeStack.js';

/** Boş track tıklamasını yok saymak için: tutamaç merkezine bu kadar yakın basılırsa sürükleme başlar. */
export const THUMB_GRAB_RADIUS_PX = 18;
/** Ses gibi, değeri telefonun geri yansıttığı kaydırıcılar için önerilen yankı bekletme süresi. */
export const ECHO_HOLDOFF_MS = 800;

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);
const EPS = 1e-9;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function decimalsOf(n) {
  const s = String(n);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(s.length - dot - 1, 8);
}

/** Değeri [min, max] içinde adım ızgarasına (min + k·step) oturtur. */
export function snapToStep(raw, min, max, step = 1) {
  if (!(max > min)) return min;
  const s = step > 0 ? step : 1;
  const snapped = min + Math.round((raw - min) / s) * s;
  const precision = Math.max(decimalsOf(s), decimalsOf(min));
  return clamp(Number(snapped.toFixed(precision)), min, max);
}

/** Tutamaç `startValue`'dayken `dx` piksel sürüklenince oluşan değer (izleyicinin genişliği `width`). */
export function valueFromDrag({ startValue, dx, width, min, max, step = 1 }) {
  if (!(width > 0) || !(max > min)) return startValue;
  const raw = startValue + (dx / width) * (max - min);
  // Yarım adımdan küçük hareket başlangıç değerini korur (ızgara dışı başlangıçta sahte sıçrama olmaz).
  if (Math.abs(raw - startValue) < (step > 0 ? step : 1) / 2) return startValue;
  return snapToStep(raw, min, max, step);
}

/** Basılan nokta tutamacın (merkezine ±yarıçap) üzerinde mi? */
export function isThumbHit(clientX, rect, percentage, radius = THUMB_GRAB_RADIUS_PX) {
  if (!rect || !(rect.width > 0)) return false;
  const thumbX = rect.left + (rect.width * percentage) / 100;
  return Math.abs(clientX - thumbX) <= radius;
}

/**
 * `count` adım yukarı (dir > 0) / aşağı (dir < 0). Izgara dışındaki bir değerden (ör. otomatik hesaplanan 197)
 * ilk adım en yakın ızgara noktasına gider; sonraki adımlar ızgaradadır.
 */
export function stepFrom(current, dir, count, min, max, step = 1) {
  if (!(max > min)) return min;
  const s = step > 0 ? step : 1;
  const k = (current - min) / s;
  const onGrid = Math.abs(k - Math.round(k)) < EPS;
  const base = onGrid ? Math.round(k) : dir >= 0 ? Math.ceil(k) : Math.floor(k);
  const moves = onGrid ? count : count - 1;
  return snapToStep(min + (dir >= 0 ? base + moves : base - moves) * s, min, max, s);
}

export function useRelativeDrag({
  value,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  onChange,
  onCommit,
  pageSteps = 5,
  holdoffMs = 0,
  grabRadius = THUMB_GRAB_RADIUS_PX,
}) {
  const trackRef = useRef(null);
  const [draft, setDraft] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const external = clamp(Number.isFinite(value) ? value : min, min, max);
  const shown = draft !== null ? draft : external;
  const percentage = max > min ? clamp(((shown - min) / (max - min)) * 100, 0, 100) : 0;

  // Olay işleyicileri en güncel prop'ları okur (ref) — interval/klavye tekrarında bayat değer kalmaz.
  const latest = useRef({ min, max, step, disabled, onChange, onCommit, pageSteps, holdoffMs, grabRadius, external });
  useLayoutEffect(() => {
    latest.current = { min, max, step, disabled, onChange, onCommit, pageSteps, holdoffMs, grabRadius, external };
  });

  const draftRef = useRef(null); // `draft`'ın eşzamanlı aynası (bir render'ı beklemeden okunur)
  const sessionRef = useRef(null); // aktif işaretçi sürüklemesi
  const gestureBaseRef = useRef(null); // klavye / ± düğmesi dizisinin başlangıç değeri
  const holdTimerRef = useRef(null);

  const current = useCallback(() => (draftRef.current !== null ? draftRef.current : latest.current.external), []);

  const clearHold = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const dropDraft = useCallback(() => {
    clearHold();
    draftRef.current = null;
    setDraft(null);
  }, [clearHold]);

  const scheduleDrop = useCallback(() => {
    clearHold();
    const ms = latest.current.holdoffMs;
    if (ms > 0) holdTimerRef.current = setTimeout(dropDraft, ms);
    else dropDraft();
  }, [clearHold, dropDraft]);

  const emit = useCallback(
    (next) => {
      if (next === current()) return false;
      clearHold(); // yeni jest, önceki bekletmeyi iptal eder
      draftRef.current = next;
      setDraft(next);
      latest.current.onChange?.(next);
      return true;
    },
    [current, clearHold],
  );

  /** Jest bitti: başlangıçtan farklıysa TEK commit; sonra (varsa) yankı bekletmesi. */
  const finish = useCallback(
    (base) => {
      const v = draftRef.current;
      if (v === null || v === base) {
        dropDraft();
        return;
      }
      latest.current.onCommit?.(v);
      scheduleDrop();
    },
    [dropDraft, scheduleDrop],
  );

  /** Jest iptal: eski değere dön (yalnız gösterge/etiket için onChange), commit YOK. */
  const revert = useCallback(
    (base) => {
      emit(base);
      if (base === latest.current.external) dropDraft();
      else scheduleDrop();
    },
    [emit, dropDraft, scheduleDrop],
  );

  const endGesture = useCallback(() => {
    const base = gestureBaseRef.current;
    if (base === null) return;
    gestureBaseRef.current = null;
    finish(base);
  }, [finish]);

  const cancelDrag = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    sessionRef.current = null; // önce boşalt: releasePointerCapture → lostpointercapture tekrar girmesin
    try {
      s.el.releasePointerCapture?.(s.pointerId);
    } catch {
      /* yakalama zaten bırakılmış */
    }
    setIsDragging(false);
    revert(s.v0);
  }, [revert]);

  // ── işaretçi ────────────────────────────────────────────────────────────────
  const onPointerDown = (e) => {
    const L = latest.current;
    if (L.disabled || sessionRef.current || e.button > 0) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const v0 = current();
    const pct = L.max > L.min ? ((v0 - L.min) / (L.max - L.min)) * 100 : 0;
    if (!isThumbHit(e.clientX, rect, pct, L.grabRadius)) return; // boş track: hiçbir şey yapma
    e.preventDefault();
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      /* yakalanamazsa sürükleme yine de işlenir */
    }
    clearHold();
    gestureBaseRef.current = null;
    sessionRef.current = { pointerId: e.pointerId, x0: e.clientX, v0, width: rect.width, last: v0, el };
    setIsDragging(true);
    el.focus?.({ preventScroll: true });
  };

  const onPointerMove = (e) => {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    const L = latest.current;
    const next = valueFromDrag({ startValue: s.v0, dx: e.clientX - s.x0, width: s.width, min: L.min, max: L.max, step: L.step });
    if (next !== s.last) {
      s.last = next;
      emit(next);
    }
  };

  const onPointerUp = (e) => {
    const s = sessionRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    sessionRef.current = null;
    try {
      s.el.releasePointerCapture?.(s.pointerId);
    } catch {
      /* zaten bırakılmış */
    }
    setIsDragging(false);
    finish(s.v0);
  };

  // Esc sürüklemeyi iptal eder. Katman yığınına girer (lib/escapeStack): sürükleme paneli açık tutan Esc'yi
  // önce tüketir, panel ancak sonraki Esc'de kapanır.
  useEffect(() => {
    if (!isDragging) return undefined;
    return pushEscapeHandler(cancelDrag);
  }, [isDragging, cancelDrag]);

  useEffect(() => clearHold, [clearHold]);

  // ── klavye ve ± düğmeleri: dizi bitince TEK commit ─────────────────────────────
  const onKeyDown = (e) => {
    const L = latest.current;
    if (L.disabled || sessionRef.current || !NAV_KEYS.has(e.key)) return;
    e.preventDefault();
    const cur = current();
    if (gestureBaseRef.current === null) gestureBaseRef.current = cur;
    let next;
    if (e.key === 'Home') next = L.min;
    else if (e.key === 'End') next = L.max;
    else {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'PageUp' ? 1 : -1;
      const count = e.key === 'PageUp' || e.key === 'PageDown' ? L.pageSteps : 1;
      next = stepFrom(cur, dir, count, L.min, L.max, L.step);
    }
    emit(next);
  };

  const onKeyUp = (e) => {
    if (NAV_KEYS.has(e.key)) endGesture();
  };

  /** ± düğmeleri (basılı tutunca tekrar): değişti mi diye döner; sınıra gelince çağıran tekrarı bırakır. */
  const nudge = useCallback(
    (dir, count = 1) => {
      const L = latest.current;
      if (L.disabled) return false;
      const cur = current();
      if (gestureBaseRef.current === null) gestureBaseRef.current = cur;
      return emit(stepFrom(cur, dir, count, L.min, L.max, L.step));
    },
    [current, emit],
  );

  /** Düğme bırakıldı: biriken değişiklik TEK commit olur. */
  const settle = useCallback(() => endGesture(), [endGesture]);

  /** Ayrık değişiklik (sessize al, hazır ayar): ara adım yok; tek onChange + tek onCommit. */
  const applyValue = useCallback(
    (raw) => {
      const L = latest.current;
      if (L.disabled) return;
      const base = current();
      const next = snapToStep(raw, L.min, L.max, L.step);
      if (next === base) return;
      emit(next);
      finish(base);
    },
    [current, emit, finish],
  );

  const sliderProps = {
    role: 'slider',
    tabIndex: disabled ? -1 : 0,
    'aria-orientation': 'horizontal',
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuenow': shown,
    'aria-disabled': disabled || undefined,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: cancelDrag,
    onLostPointerCapture: cancelDrag,
    onKeyDown,
    onKeyUp,
    onBlur: endGesture,
  };

  return { trackRef, value: shown, percentage, isDragging, nudge, settle, applyValue, sliderProps };
}
