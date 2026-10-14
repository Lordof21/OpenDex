// "İkisi" (Telefon + DeX at the same instant): the by-ear fine tune. The two outputs are put on ONE timeline by the
// backend (device clock, presentation time — see streams/app_audio.py), so normally nothing needs touching; this slider
// is for the last few milliseconds a particular headset/speaker or a particular room can still add. + delays the phone,
// − brings it forward. The status line says what the alignment is doing right now, read from the apps on "İkisi".

import React, { useEffect, useRef, useState } from 'react';
import { Mic, Loader2, X } from 'lucide-react';
import { updateSettings, useLiveSettings } from '../settings/liveSettings.js';
import { calibrationMessage, runCalibration } from '../media/syncCalibration.js';
import { useAudioMixerStore } from '../state/audioMixerStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { cn } from '../lib/utils.js';
import { PrecisionSlider } from '../ui/PrecisionSlider.jsx';
import { t } from '../i18n/index.js';

const FINE_TUNE_MIN = -300;
const FINE_TUNE_MAX = 500;
const PHASE_TEXT = {
  mic: t('taskbar.mikrofon_aciliyor'),
  clock: t('taskbar.telefonun_saati_olculuyor'),
  listen: t('taskbar.dinleniyor_telefon_ve_dex_olcu_sesi'),
  analyze: t('taskbar.cozumleniyor'),
};

/** What the alignment is doing, in words — `apps` = the store's apps, `sync` = what the backend says about it. */
export function syncStatus(sync, apps) {
  const both = Object.values(apps || {}).filter((a) => a.live_route === 'both');
  if (sync && sync.supported === false) {
    return { tone: 'warn', text: t('taskbar.telefon_yardimcisi_guncel_degil_ikisi') };
  }
  if (both.length === 0) return { tone: 'idle', text: t('taskbar.ikisi_secili_bir_uygulama_yok') };
  const synced = both.find((a) => a.synced);
  if (synced) {
    return { tone: 'ok', text: t('taskbar.telefon_ve_dex_ayni_anda_caliyor', { target_ms: synced.target_ms }) };
  }
  return { tone: 'warn', text: t('taskbar.telefon_bu_uygulamada_hizalanamadi') };
}

/** The laptop's microphone hears the phone and DeX play a test chirp each and the fine tune is set from the gap it hears. */
function AutoCalibrate({ supported }) {
  const [run, setRun] = useState({ phase: 'idle', result: null });
  const mounted = useRef(true);
  const abortRef = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const busy = run.phase !== 'idle';

  const cancel = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setRun({ phase: 'idle', result: { ok: false, reason: 'cancelled' } });
    useSystemStore.getState().pushToast?.(t('common.olcum_iptal_edildi_mikrofon_kapatildi'), {
      tone: 'info',
      title: t('taskbar.ses_hizalama'),
    });
  };

  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRun({ phase: 'mic', result: null });
    useSystemStore.getState().pushToast?.(t('taskbar.ses_olcumu_basladi_telefon_ve_dex'), {
      tone: 'info',
      title: t('taskbar.ses_hizalama'),
    });

    let result = await runCalibration({
      probeClock: (opts) => useAudioMixerStore.getState().probeClock(opts),
      onPhase: (phase) => {
        if (!controller.signal.aborted && mounted.current) {
          setRun({ phase, result: null });
        }
      },
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      return;
    }

    if (result.ok) {
      const value = Math.max(FINE_TUNE_MIN, Math.min(FINE_TUNE_MAX, result.offsetMs));
      try {
        await updateSettings({ audio_sync_offset_ms: value });
      } catch {
        result = { ok: false, reason: 'failed' };
      }
    }
    abortRef.current = null;
    if (mounted.current) {
      setRun({ phase: 'idle', result });
    }

    if (result.ok) {
      useSystemStore.getState().pushToast?.(
        t('taskbar.ses_hizalandi_ince_ayar_valueoffsetms', { value: result.offsetMs > 0 ? '+' : '', offsetMs: result.offsetMs }),
        { tone: 'success', title: t('taskbar.hizalama_basarili') },
      );
    } else if (result.reason !== 'cancelled') {
      useSystemStore.getState().pushToast?.(
        calibrationMessage(result),
        { tone: 'warn', title: t('taskbar.ses_hizalama') },
      );
    }
  };

  return (
    <div className="pt-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={busy || !supported}
          onClick={start}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold transition-colors',
            busy
              ? 'bg-primary/15 text-primary cursor-default'
              : !supported
                ? 'cursor-default opacity-60 bg-foreground/[0.08]'
                : 'cursor-pointer bg-foreground/[0.08] hover:bg-foreground/[0.14]',
          )}
          data-testid="audio-sync-auto"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin text-primary" />
          ) : (
            <Mic className="size-3.5" />
          )}
          {busy ? (PHASE_TEXT[run.phase] || t('common.olculuyor')) : t('taskbar.mikrofonla_otomatik_ayarla')}
        </button>

        {busy && (
          <button
            type="button"
            onClick={cancel}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[10.5px] text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
            title={t('taskbar.olcumu_iptal_et_ve_mikrofonu_kapat')}
            data-testid="audio-sync-auto-cancel"
          >
            <X className="size-3" />
            {t('common.iptal')}
          </button>
        )}
      </div>

      <p
        className={cn(
          'pt-1 text-[9.5px] leading-snug',
          run.result && !run.result.ok
            ? 'text-destructive font-medium'
            : run.result && run.result.ok
              ? 'text-success font-medium'
              : 'text-muted-foreground',
        )}
        aria-live="polite"
        data-testid="audio-sync-auto-status"
      >
        {busy
          ? PHASE_TEXT[run.phase]
          : run.result
            ? calibrationMessage(run.result)
            : t('taskbar.telefonu_dizustunun_yanina_koyun')}
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
      <p className="pb-1 text-[11px] font-semibold">{t('common.telefon_dex_ince_ayari')}</p>
      <PrecisionSlider
        value={offset}
        min={FINE_TUNE_MIN}
        max={FINE_TUNE_MAX}
        step={5}
        unit="ms"
        label={t('common.telefon_dex_ince_ayari')}
        auto={offset === 0}
        autoLabel={t('common.oto')}
        onAuto={() => updateSettings({ audio_sync_offset_ms: 0 }).catch(() => {})}
        onCommit={(v) => updateSettings({ audio_sync_offset_ms: v }).catch(() => {})}
      />
      <p className={cn('pt-1 text-[9.5px] leading-snug', status.tone === 'warn' ? 'text-destructive' : 'text-muted-foreground')} role="status">
        {status.text}
      </p>
      <p className="pt-0.5 text-[9.5px] leading-snug text-muted-foreground">
        {t('taskbar.oto_iki_cikis_ortak_bir_zaman')}
      </p>
      <AutoCalibrate supported={sync?.supported !== false} />
    </div>
  );
}
