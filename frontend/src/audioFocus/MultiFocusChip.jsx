// A small "Multi-app sound is off" pill for the places where the user is mixing sound (the Çok Kanallı Mikser). Shown ONLY when the
// flag was read and is off — never on a guess, and not at all when it is on (no noise). One tap lands on the Settings › Sound card.

import React from 'react';
import { Layers } from 'lucide-react';
import { useAudioFocusStore } from '../state/audioFocusStore.js';
import { openOpenDexSettings } from '../settings/SettingsPanel.jsx';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { showOffHint } from './focusText.js';

export const MULTI_FOCUS_TARGET = Object.freeze({ section: 'audio', item: 'audioMultiFocus' });

export default function MultiFocusChip({ className }) {
  const snap = useAudioFocusStore((s) => s.snap);
  if (!showOffHint(snap)) return null;
  return (
    <button
      type="button"
      data-testid="multi-focus-chip"
      title={t('audio_focus.chip_ipucu')}
      onClick={() => openOpenDexSettings(MULTI_FOCUS_TARGET)}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-muted/60 px-2.5 py-1 text-[10px] font-medium',
        'text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Layers className="size-3" aria-hidden="true" />
      {t('audio_focus.chip_kapali')}
    </button>
  );
}
