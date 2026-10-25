// "Chrome started, YT Music stopped — turn multi-app sound on?" Asked ONCE per OpenDeX run, at the moment it matters, and only when
// the answer can change anything: the policy is "Ask", the flag was read and is off, the phone can set it. The card never takes the
// keyboard focus and goes away by itself (25 s) — it must not interrupt what the user is doing; "Not now" costs nothing and
// "Don't ask again" is the "Never" policy. The question comes from the media sessions the taskbar already has (focusNudge.js).

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layers } from 'lucide-react';
import Button from '../ui/Button.jsx';
import { Z_INDEX } from '../ui/zIndex.js';
import { updateSettings, useLiveSettings } from '../settings/liveSettings.js';
import { useAudioFocusStore } from '../state/audioFocusStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { t } from '../i18n/index.js';
import { createFocusNudgeDetector, lastMediaCommandAt } from './focusNudge.js';
import { reasonText } from './focusText.js';

export const NUDGE_VISIBLE_MS = 25_000;
const TASKBAR_CLEARANCE_PX = 62;

const nameOf = (sessions, key) => {
  const s = (sessions || []).find((x) => (x.package || x.id) === key);
  return s?.source || s?.package || key;
};

export default function MultiFocusNudge({ sessions }) {
  const snap = useAudioFocusStore((s) => s.snap);
  const nudged = useAudioFocusStore((s) => s.nudged);
  const live = useLiveSettings();
  const policy = live?.multi_audio_focus_policy || snap.policy || 'ask';
  const detector = useRef(null);
  if (!detector.current) detector.current = createFocusNudgeDetector();
  const [offer, setOffer] = useState(null); // { paused, started } display names
  const [working, setWorking] = useState(false);

  const eligible = policy === 'ask' && snap.state === 'off' && snap.can_set !== false && !nudged;

  useEffect(() => {
    const hit = detector.current.update(sessions, { eligible, lastCommandAt: lastMediaCommandAt() });
    if (!hit) return;
    useAudioFocusStore.getState().markNudged();
    setOffer({ paused: nameOf(sessions, hit.paused), started: nameOf(sessions, hit.started) });
  }, [sessions, eligible]);

  useEffect(() => {
    if (!offer) return undefined;
    const timer = setTimeout(() => setOffer(null), NUDGE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [offer]);

  if (!offer || typeof document === 'undefined') return null;

  const turnOn = async (always) => {
    setWorking(true);
    try {
      if (always) await updateSettings({ multi_audio_focus_policy: 'always' }).catch(() => {});
      const result = await useAudioFocusStore.getState().enable();
      const push = useSystemStore.getState().pushToast;
      if (result?.state === 'on') push?.(t('audio_focus.acildi_toast'), { tone: 'success', title: t('audio_focus.baslik') });
      else push?.(reasonText(result?.error || useAudioFocusStore.getState().requestError) || t('audio_focus.hata_uygulanmadi'), { tone: 'warning', title: t('audio_focus.baslik') });
    } finally {
      setWorking(false);
      setOffer(null);
    }
  };

  const never = () => {
    updateSettings({ multi_audio_focus_policy: 'never' }).catch(() => {});
    setOffer(null);
  };

  return createPortal(
    <div
      role="region"
      aria-label={t('audio_focus.nudge_baslik')}
      aria-live="polite"
      data-testid="multi-focus-nudge"
      className="fixed right-3 w-[320px] rounded-md border border-border bg-popover/95 p-3 text-popover-foreground shadow-window backdrop-blur-2xl"
      style={{ bottom: TASKBAR_CLEARANCE_PX, zIndex: Z_INDEX.toast }}
    >
      <div className="flex items-start gap-2">
        <Layers className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[12px] font-semibold leading-[16px]">{t('audio_focus.nudge_baslik')}</p>
          <p className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground">
            {t('audio_focus.nudge_metin', { paused: offer.paused, started: offer.started })}
          </p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Button size="xs" disabled={working} data-testid="multi-focus-nudge-session" onClick={() => turnOn(false)}>
          {t('audio_focus.nudge_bu_oturum')}
        </Button>
        <Button size="xs" variant="outline" disabled={working} data-testid="multi-focus-nudge-always" onClick={() => turnOn(true)}>
          {t('audio_focus.nudge_her_zaman')}
        </Button>
        <Button size="xs" variant="ghost" disabled={working} data-testid="multi-focus-nudge-later" onClick={() => setOffer(null)}>
          {t('audio_focus.nudge_simdi_degil')}
        </Button>
      </div>
      <button
        type="button"
        data-testid="multi-focus-nudge-never"
        disabled={working}
        onClick={never}
        className="mt-1.5 cursor-pointer text-[10px] text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('audio_focus.nudge_bir_daha_sorma')}
      </button>
    </div>,
    document.body,
  );
}
