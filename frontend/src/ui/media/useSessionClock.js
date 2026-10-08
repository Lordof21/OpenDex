// Oturum saati: telefonun gönderdiği konum yalnız bir ANLIK GÖRÜNTÜDÜR (bildirim/WS ile birkaç saniyede bir gelir).
// Çalarken aradaki süreyi yerelde ilerletir; yeni görüntü gelince (ya da parça/çalma durumu değişince) ona yeniden oturur.
// Denetleyici (`useMediaPlaybackController`) zaten kendi 250 ms saatini taşıyan BİRİNCİL oturum için (`session.driven`)
// hiçbir şey eklemez — iki saat birbirine karışıp kayma yapmasın.

import { useEffect, useMemo, useState } from 'react';

const TICK_MS = 250;

export function useSessionClock(session) {
  const driven = Boolean(session?.driven);
  const positionMs = session?.positionMs || 0;
  const durationMs = session?.durationMs || 0;
  const playing = Boolean(session?.is_playing);
  const trackKey = session?.trackKey ?? session?.id ?? null;

  const anchor = useMemo(
    () => ({ pos: positionMs, at: Date.now() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positionMs, durationMs, playing, trackKey],
  );
  const running = !driven && playing && durationMs > 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [running, anchor]);

  if (driven) {
    return { positionMs, durationMs, percent: session?.progress ?? 0 };
  }
  const pos = running ? Math.min(durationMs, anchor.pos + Math.max(0, now - anchor.at)) : positionMs;
  const percent = durationMs > 0 ? Math.min(100, Math.max(0, (pos / durationMs) * 100)) : (session?.progress ?? 0);
  return { positionMs: pos, durationMs, percent };
}

export default useSessionClock;
