// "İkisi" (Telefon + DeX at the same instant): the by-ear fine tune. The two outputs are put on ONE timeline by the
// backend (device clock, presentation time — see streams/app_audio.py), so normally nothing needs touching; this slider
// is for the last few milliseconds a particular headset/speaker or a particular room can still add. + delays the phone,
// − brings it forward. The status line says what the alignment is doing right now, read from the apps on "İkisi".

import React, { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { updateSettings, useLiveSettings } from '../settings/liveSettings.js';
import { calibrationMessage, runCalibration } from '../media/syncCalibration.js';
import { useAudioMixerStore } from '../state/audioMixerStore.js';
import { cn } from '../lib/utils.js';
import { PrecisionSlider } from '../ui/PrecisionSlider.jsx';

const FINE_TUNE_MIN = -300;
const FINE_TUNE_MAX = 500;
const PHASE_TEXT = {
  mic: 'Mikrofon açılıyor…',
  clock: 'Telefonun saati ölçülüyor…',
  listen: 'Dinleniyor: telefon ve DeX ölçü sesi çalıyor (≈ 5 sn)…',
  analyze: 'Çözümleniyor…',
};

/** What the alignment is doing, in words — `apps` = the store's apps, `sync` = what the backend says about it. */
export function syncStatus(sync, apps) {
  const both = Object.values(apps || {}).filter((a) => a.live_route === 'both');
  if (sync && sync.supported === false) {
    return { tone: 'warn', text: 'Telefon yardımcısı güncel değil: «İkisi»de telefon sesi DeX\'ten önce duyulur. py backend/java/build.py ile yenileyip OpenDeX\'i yeniden başlatın.' };
  }
  if (both.length === 0) return { tone: 'idle', text: '«İkisi» seçili bir uygulama yok.' };
  const synced = both.find((a) => a.synced);
  if (synced) {
    return { tone: 'ok', text: `Telefon ve DeX aynı anda çalıyor (ortak gecikme ≈ ${synced.target_ms} ms).` };
  }
  return { tone: 'warn', text: 'Telefon bu uygulamada hizalanamadı; ses telefonda anlık çalıyor (DeX\'ten önce duyulur).' };
}

/** The laptop's microphone hears the phone and DeX play a test chirp each and the fine tune is set from the gap it hears. */
function AutoCalibrate({ supported }) {
  const [run, setRun] = useState({ phase: 'idle', result: null });
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const busy = run.phase !== 'idle';

  const start = async () => {
    setRun({ phase: 'mic', result: null });
    let result = await runCalibration({
      probeClock: () => useAudioMixerStore.getState().probeClock(),
      onPhase: (phase) => mounted.current && setRun({ phase, result: null }),
    });
    if (result.ok) {
      const value = Math.max(FINE_TUNE_MIN, Math.min(FINE_TUNE_MAX, result.offsetMs));
      try {
        await updateSettings({ audio_sync_offset_ms: value });
      } catch {
        result = { ok: false, reason: 'failed' };
      }
    }
    if (mounted.current) setRun({ phase: 'idle', result });
  };

  return (
    <div className="pt-1.5">
      <button
        type="button"
        disabled={busy || !supported}
        onClick={start}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-md bg-foreground/[0.08] px-2.5 text-[11px] font-semibold transition-colors',
          busy || !supported ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-foreground/[0.14]',
        )}
        data-testid="audio-sync-auto"
      >
        <Mic className="size-3.5" />
        Mikrofonla otomatik ayarla
      </button>
      <p className={cn('pt-1 text-[9.5px] leading-snug', run.result && !run.result.ok ? 'text-destructive' : 'text-muted-foreground')} aria-live="polite" data-testid="audio-sync-auto-status">
        {busy
          ? PHASE_TEXT[run.phase]
          : run.result
            ? calibrationMessage(run.result)
            : 'Telefonu dizüstünün yanına koyun, medyayı duraklatın; DeX sesi hoparlörden çıksın. Ölçülen fark ince ayara yazılır.'}
      </p>
    </div>
  );
}

export default function SyncFineTune({ className }) {
  const sync = useAudioMixerStore((s) => s.sync);
  const apps = useAudioMixerStore((s) => s.apps);
  const live = useLiveSettings();
  const offset = live?.audio_sync_offset_ms ?? sync?.offset_ms ?? 0;
  const status = syncStatus(sync, apps);

  return (
    <div className={cn('px-2 py-1.5', className)} data-testid="audio-sync">
      <p className="pb-1 text-[11px] font-semibold">Telefon–DeX ince ayarı</p>
      <PrecisionSlider
        value={offset}
        min={FINE_TUNE_MIN}
        max={FINE_TUNE_MAX}
        step={5}
        unit="ms"
        label="Telefon–DeX ince ayarı"
        auto={offset === 0}
        autoLabel="Oto"
        onAuto={() => updateSettings({ audio_sync_offset_ms: 0 }).catch(() => {})}
        onCommit={(v) => updateSettings({ audio_sync_offset_ms: v }).catch(() => {})}
      />
      <p className={cn('pt-1 text-[9.5px] leading-snug', status.tone === 'warn' ? 'text-destructive' : 'text-muted-foreground')} role="status">
        {status.text}
      </p>
      <p className="pt-0.5 text-[9.5px] leading-snug text-muted-foreground">
        Oto: iki çıkış ortak bir zaman çizgisine göre kendiliğinden hizalanır. Telefonu yine de önde/geride duyuyorsanız
        aşağıdaki ölçümü çalıştırın ya da kaydırın (+ telefonu geciktirir, − öne alır).
      </p>
      <AutoCalibrate supported={sync?.supported !== false} />
    </div>
  );
}
