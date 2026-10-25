// Settings › Sound: the phone's "several apps play at once" flag. One card is the whole story — its state (read from the phone, with
// the time of that reading and a "Check again" button, so nothing stale lingers), the one-click fix, and when OpenDeX may apply it.
// The same snapshot feeds the mixer chip and the DeX panel shortcut; all three speak through audioFocus/focusText.js.

import React, { useEffect } from 'react';
import { Layers, RefreshCw } from 'lucide-react';
import Button from '../ui/Button.jsx';
import { SegmentedControl } from '../ui/SegmentedControl.jsx';
import { Chip, useSettingsUi } from '../settings/controls.jsx';
import { updateSettings, useLiveSettings } from '../settings/liveSettings.js';
import { useAudioFocusStore } from '../state/audioFocusStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { canTurnOn, checkedText, detailText, statusOf } from './focusText.js';

const POLICIES = ['ask', 'always', 'never'];

function policyOptions() {
  return [
    { value: 'ask', label: t('audio_focus.politika_sor'), hint: t('audio_focus.politika_sor_aciklama') },
    { value: 'always', label: t('audio_focus.politika_her_zaman'), hint: t('audio_focus.politika_her_zaman_aciklama') },
    { value: 'never', label: t('audio_focus.politika_hicbir_zaman'), hint: t('audio_focus.politika_hicbir_zaman_aciklama') },
  ];
}

export default function MultiFocusCard() {
  const { flashId } = useSettingsUi();
  const snap = useAudioFocusStore((s) => s.snap);
  const pending = useAudioFocusStore((s) => s.pending);
  const requestError = useAudioFocusStore((s) => s.requestError);
  const connected = useSystemStore((s) => s.connectionState === 'connected');
  const live = useLiveSettings();
  const policy = POLICIES.includes(live?.multi_audio_focus_policy) ? live.multi_audio_focus_policy : snap.policy || 'ask';

  // A card that opens shows a FRESH reading, not whatever was pushed when the phone was bound.
  useEffect(() => {
    if (connected) useAudioFocusStore.getState().recheck();
  }, [connected]);

  // "Never" says OpenDeX must not change the phone; an explicit "Turn on" is the user taking that back for now.
  const turnOn = async () => {
    if (policy === 'never') await updateSettings({ multi_audio_focus_policy: 'ask' }).catch(() => {});
    return useAudioFocusStore.getState().enable();
  };

  const status = statusOf(snap, pending);
  const detail = detailText(snap, requestError);
  const options = policyOptions();
  const busy = Boolean(pending) || snap.busy;
  const ours = snap.state === 'on' && snap.owner === 'opendex';

  return (
    <section
      data-setting-id="audioMultiFocus"
      data-testid="multi-focus-card"
      className={cn(
        'rounded-xl border border-border/70 bg-muted/30 p-3.5 transition-colors',
        flashId === 'audioMultiFocus' && 'settings-flash',
      )}
    >
      <div className="flex items-start gap-2.5">
        <Layers className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[12.5px] font-semibold leading-[17px] text-foreground">{t('audio_focus.baslik')}</h3>
          <p className="mt-0.5 text-[11.5px] leading-[16px] text-muted-foreground">{t('audio_focus.aciklama')}</p>
        </div>
        <Chip tone={status.tone} className="mt-0.5" data-testid="multi-focus-status" role="status">
          {status.label}
        </Chip>
      </div>

      {detail.text && (
        <p
          className={cn('mt-2 text-[11px] leading-[15px]', detail.tone === 'warn' ? 'font-medium text-warning' : 'text-muted-foreground')}
          aria-live="polite"
          data-testid="multi-focus-detail"
        >
          {detail.text}
        </p>
      )}

      {(snap.state === 'on' || snap.state === 'off') && (
        <p className="mt-1.5 text-[10.5px] leading-[14px] text-muted-foreground" data-testid="multi-focus-ram-tip">
          {t('audio_focus.ram_ipucu')}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !connected}
          aria-busy={pending === 'recheck'}
          data-testid="multi-focus-recheck"
          startIcon={<RefreshCw className={cn('size-3.5', pending === 'recheck' && 'animate-spin')} aria-hidden="true" />}
          onClick={() => useAudioFocusStore.getState().recheck()}
        >
          {pending === 'recheck' ? t('audio_focus.kontrol_ediliyor') : t('audio_focus.yeniden_kontrol')}
        </Button>

        {ours ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-busy={pending === 'disable'}
            data-testid="multi-focus-toggle"
            onClick={() => useAudioFocusStore.getState().disable()}
          >
            {t('audio_focus.kapat')}
          </Button>
        ) : (
          snap.state !== 'on' && (
            <Button
              size="sm"
              disabled={busy || !connected || !canTurnOn(snap)}
              aria-busy={pending === 'enable'}
              data-testid="multi-focus-toggle"
              onClick={turnOn}
            >
              {t('audio_focus.etkinlestir')}
            </Button>
          )
        )}

        <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground" data-testid="multi-focus-checked">
          {checkedText(snap.checked_at)}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3">
        <span className="text-[11.5px] font-medium text-foreground">{t('audio_focus.politika_baslik')}</span>
        <SegmentedControl
          label={t('audio_focus.politika_baslik')}
          options={options.map(({ value, label, hint }) => ({ value, label, title: hint }))}
          value={policy}
          onChange={(value) => updateSettings({ multi_audio_focus_policy: value }).catch(() => {})}
          size="md"
        />
      </div>
      <p className="mt-1.5 text-[10.5px] leading-[14px] text-muted-foreground" data-testid="multi-focus-policy-hint">
        {options.find((o) => o.value === policy)?.hint}
      </p>
    </section>
  );
}
