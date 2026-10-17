// Fareyle bakış rozetinin durumu: kullanıcı fareyi neden "kaybettiğini" ve geri nasıl alacağını görsün.
//   idle   Ayarlarda açık ama fare henüz yakalanmadı → "tıklayın"
//   locked yakalı: hareket bakışı çevirir          → "Ctrl: serbest bırak"
//   free   Ctrl basılı: imleç serbest              → "bırakınca bakış sürer"
//   refused tarayıcı yakalamayı reddetti           → "yeniden tıklayın"
import React from 'react';
import { Crosshair, MousePointer2 } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';

const TEXT = {
  idle: () => t('keymapper.fareyi_yakalamak_icin_tiklayin'),
  locked: () => t('keymapper.fare_yakalandi_ctrl_serbest_birak'),
  free: () => t('keymapper.fare_serbest_birakinca_bakis_surer'),
  refused: () => t('keymapper.fare_yakalanamadi_yeniden_tiklayin'),
};

export default function MouseLookBadge({ status, className }) {
  if (!status || status === 'off') return null;
  const Icon = status === 'locked' ? Crosshair : MousePointer2;
  return (
    <div
      role="status"
      data-mouse-look={status}
      className={cn(
        'pointer-events-none absolute bottom-3 left-3 z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-full border border-border/70 bg-popover/85 px-2.5 py-1 text-[10.5px] font-medium text-popover-foreground shadow-sm backdrop-blur-md select-none',
        status === 'locked' && 'border-primary/50 text-primary',
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{TEXT[status]()}</span>
    </div>
  );
}
