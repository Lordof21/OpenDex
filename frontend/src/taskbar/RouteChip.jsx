// Media Center badge: where is the playing app's sound right now? (Media Center holds NO level
// control; that lives in the mixer.)
//   Click        : the quick flip, Telefon ⇄ DeX.
//   Press & hold : (or right-click) a menu below the chip with all three — Telefon, DeX, İkisi — so "İkisi" (the phone and
//                  DeX at the same instant) is one gesture away without lengthening the click cycle.
//
// An app WITHOUT a window plays on the phone as it always did — and the chip says so, offering "DeX'e al": the sound of an
// app that never needed a DeX window can still be heard on DeX (the backend gives it a channel of its own). Back again with
// the same chip. Not offered where there is no per-app audio (Android ≤12 / no daemon): nothing to move.

import React, { useState } from 'react';
import { useAudioMixerStore } from '../state/audioMixerStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { audioErrorText, routeOption } from '../ui/audioRouting.jsx';
import { RouteMenu } from './media-center/RouteMenu.jsx';
import { useLongPress } from '../ui/useLongPress.js';
import { cn } from '../lib/utils.js';

const CHIP = 'inline-flex h-6 items-center gap-1.5 rounded-full bg-foreground/[0.08] px-2.5 text-[11px] font-semibold transition-colors';

export default function RouteChip({ pkg, className }) {
  const app = useAudioMixerStore((s) => (pkg ? s.apps[pkg] : null));
  const supported = useAudioMixerStore((s) => s.supported);
  const setRoute = useAudioMixerStore((s) => s.setRoute);
  const transferToPc = useAudioMixerStore((s) => s.transferToPc);
  const [busy, setBusy] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(null);       // the chip's element while the menu is open

  const hasWindow = Boolean(app?.windows?.length);
  const live = (hasWindow && app.live_route) || 'phone';
  const handedOff = hasWindow && Boolean(app.on_phone);

  /** Moves the app to `route`; an app without a window is first brought over (it needs a channel of its own). */
  const moveTo = async (route) => {
    if (hasWindow) {
      setRoute(pkg, route);
      return;
    }
    if (route === 'phone') return;                           // it is on the phone already
    setBusy(true);
    try {
      const res = await transferToPc(pkg, route);
      if (!res.ok) useSystemStore.getState().pushToast?.(audioErrorText(res.error) || 'Ses DeX\'e alınamadı.');
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || handedOff;
  // The quick flip: the phone ↔ DeX (from "İkisi" back to the phone, as before)
  const flipTo = live === 'phone' ? 'pc' : 'phone';
  const press = useLongPress({
    disabled,
    onClick: () => moveTo(flipTo),
    onLongPress: (element) => setMenuAnchor(element),
  });
  const closeMenu = React.useCallback(() => setMenuAnchor(null), []);

  if (!pkg) return null;
  if (!hasWindow && !supported) return null;     // no per-app capture here: the app plays on the phone and that is all there is

  const { icon: Icon, label } = routeOption(live);
  const title = handedOff
    ? 'Uygulama telefona devredildi; sesi onunla birlikte telefonda'
    : `Bu uygulamanın sesi: ${label} — tıkla: ${flipTo === 'pc' ? "DeX'e al" : 'telefona gönder'} · basılı tut: Telefon / DeX / İkisi`;
  const notice = live === 'both' && hasWindow && app.synced === false
    ? 'Telefon sesi DeX ile hizalanamadı (telefon yardımcısı güncel değil olabilir).'
    : null;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        {...press}
        className={cn(CHIP, disabled ? 'cursor-default opacity-70' : 'cursor-pointer hover:bg-foreground/[0.14]', menuAnchor && 'bg-foreground/[0.14]', className)}
        title={title}
        aria-label={`Ses: ${label}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(menuAnchor)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !disabled) {
            event.preventDefault();
            setMenuAnchor(event.currentTarget);
          }
        }}
      >
        <Icon className="size-3.5" />
        {label}
      </button>
      {menuAnchor && (
        <RouteMenu
          anchor={menuAnchor}
          current={live}
          notice={notice}
          onClose={closeMenu}
          onPick={(route) => {
            closeMenu();
            moveTo(route);
          }}
        />
      )}
    </>
  );
}
