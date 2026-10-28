// Title-bar speaker of a window with its own audio channel. Click: mute/unmute this app on the
// PC. Right-click: level + output route. Same store as the mixer — two views of one state, never two states.

import React, { useEffect, useRef, useState } from 'react';
import { Smartphone, Volume2, VolumeX } from 'lucide-react';
import { effectiveRoute, selectAppForWindow, useAudioMixerStore } from '../../state/audioMixerStore.js';
import { RouteSelector, audioErrorText } from '../../ui/audioRouting.jsx';
import { MixerRow } from '../../taskbar/MixerRow.jsx';
import { pushEscapeHandler } from '../../lib/escapeStack.js';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';

export default function AudioButton({ windowId, compact = false }) {
  const app = useAudioMixerStore(selectAppForWindow(windowId));
  const toggleMuted = useAudioMixerStore((s) => s.toggleMuted);
  const setVolume = useAudioMixerStore((s) => s.setVolume);
  const setRoute = useAudioMixerStore((s) => s.setRoute);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    const removeEscape = pushEscapeHandler(() => setOpen(false));
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      removeEscape();
    };
  }, [open]);

  if (!app) return null;          // no own channel (Android ≤12, mirror window, or not tracked yet)

  const route = effectiveRoute(app);
  const onPhone = route === 'phone';
  const Icon = onPhone ? Smartphone : app.muted ? VolumeX : Volume2;
  const label = onPhone ? t('window.ses_telefonda_ses_ayarlari') : app.muted ? t('common.sesi_ac') : t('window.sessize_al');
  const errorText = audioErrorText(app.error);

  return (
    <div ref={rootRef} className="relative" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={cn(
          'grid place-items-center rounded-sm text-frame-muted transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer',
          compact ? 'size-6' : 'size-8',
          app.muted && !onPhone && 'text-destructive',
          open && 'bg-accent text-accent-foreground'
        )}
        onClick={(e) => {
          e.stopPropagation();
          if (onPhone) setOpen((o) => !o);
          else toggleMuted(app.package);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip={t('window.label_sag_tik_ses_ayarlari', { label })}
        data-tooltip-position="bottom"
      >
        <Icon className={compact ? 'size-3.5' : 'size-4'} />
        {errorText && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-destructive" aria-hidden="true" />}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('window.pencere_ses_ayarlari')}
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-window"
        >
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('window.ses_cikisi')}</p>
          <RouteSelector
            value={route}
            onChange={(next) => setRoute(app.package, next)}
            label={t('window.bu_pencerenin_ses_cikisi')}
            className="w-full justify-between"
          />
          {onPhone ? (
            <p className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Smartphone className="size-3" />
              {app.on_phone ? 'Uygulama telefona devredildi; sesi telefonda.' : t('window.bu_uygulamanin_sesi_telefonda_caliyor')}
            </p>
          ) : (
            <MixerRow
              icon={app.muted ? VolumeX : Volume2}
              value={Math.round((app.volume ?? 1) * 100)}
              max={100}
              onChange={(v) => setVolume(app.package, v / 100)}
              label={t('window.pencere_ses_duzeyi')}
              muted={app.muted}
              onToggleMute={() => toggleMuted(app.package)}
              className="mt-1 border-b-0 pb-0"
            />
          )}
          {errorText && <p className="mt-1.5 text-[9.5px] leading-snug text-destructive">{errorText}</p>}
        </div>
      )}
    </div>
  );
}
