// Geri alınabilir silme: kart hemen gizlenir (çıkış animasyonu oynar) ama gerçek silme (telefonda da) UNDO_MS sonra yapılır.
// "Geri al" gizlemeyi bozar — hiçbir şey silinmemiştir. Panel kapanırsa bekleyenler hemen kesinleşir (silme kaybolmaz).
// Art arda silinenler tek toplu işlemde birleşir (tek "Geri al" hepsini döndürür, süre her silmede yeniden başlar).
import { useCallback, useEffect, useRef, useState } from 'react';

export const UNDO_MS = 5000;

export function useUndoableDismiss(commit, delay = UNDO_MS) {
  const [hidden, setHidden] = useState(() => new Set());
  const [round, setRound] = useState(0); // her silmede artar: geri sayım çubuğu baştan başlar
  const hiddenRef = useRef(new Set());
  const timer = useRef(null);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const settle = useCallback((notify) => {
    clearTimeout(timer.current);
    timer.current = null;
    const ids = [...hiddenRef.current];
    hiddenRef.current = new Set();
    // Önce kalıcı silme (liste kaynağından çıkar), sonra gizleme kalkar: kart bir kare bile geri görünmez.
    if (ids.length) commitRef.current(ids);
    if (notify) setHidden(new Set());
  }, []);

  const hide = useCallback(
    (ids) => {
      const next = new Set(hiddenRef.current);
      ids.forEach((id) => next.add(id));
      hiddenRef.current = next;
      setHidden(next);
      setRound((r) => r + 1);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => settle(true), delay);
    },
    [delay, settle],
  );

  const undo = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    hiddenRef.current = new Set();
    setHidden(new Set());
  }, []);

  // Panel kapanırken (bileşen kalkarken) bekleyen silmeler hemen uygulanır.
  useEffect(() => () => settle(false), [settle]);

  return { hidden, count: hidden.size, round, hide, undo, flush: () => settle(true) };
}
