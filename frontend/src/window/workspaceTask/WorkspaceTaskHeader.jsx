// Workspace görev başlığı. Gruplar sabit sırada, görevin ekrandaki genişliğine göre sadeleşir:
//
//   kimlik            uygulama ikonu · ad · (telefondaysa) "Telefonda" rozeti
//   sık kullanılanlar Geri · Ses · Telefona aktar         (yalnız geniş başlıkta; dar olanda hub'da)
//   pencere           ⚙ Hub · Kapla/Geri yükle · Kapat
//
// "Telefona aktar": tıkla = Ayarlar'daki varsayılan kip; basılı tut ya da sağ tık = Tam ekran | Serbest pencere seçimi
// (normal pencere başlığıyla aynı davranış). Başlığın BOŞ yerine sağ tık = görev hub'ı (imlecin yanında).
// Geri kalan her şey (DPI, PiP, DeX'te pencere, masaüstüne çıkar …) hub'dadır — başlık dokuz düğmeyle dolmaz.

import React, { useCallback, useState } from 'react';
import { ChevronLeft, Copy, Settings2, Smartphone, Square, ArrowDownToLine, X } from 'lucide-react';
import { WindowControl } from '../../ui/IconButton.jsx';
import AppIcon from '../../ui/AppIcon.jsx';
import { useLongPress } from '../../ui/useLongPress.js';
import AudioButton from '../titlebar/AudioButton.jsx';
import HandoffMenu from '../titlebar/HandoffMenu.jsx';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';

export default function WorkspaceTaskHeader({
  task,
  density,            // 'wide' | 'medium' | 'narrow' (taskMetrics.headerDensityFor)
  visible,
  focused,
  parked,
  maximized,
  hubOpen,
  actions,            // { toggleHub(button), openHubAt(point), back, handoff(windowing?), reclaim, toggleMaximize, closeTask }
  surfaceProps,       // sürükleme + hover: onPointerDown, onDoubleClick, onMouseEnter, onMouseLeave
}) {
  const [handoffAnchor, setHandoffAnchor] = useState(null);
  const closeHandoffMenu = useCallback(() => setHandoffAnchor(null), []);

  const phonePress = useLongPress({
    onClick: () => (parked ? actions.reclaim() : actions.handoff()),
    onLongPress: (element) => {
      if (!parked) setHandoffAnchor(element);
    },
  });

  const wide = density === 'wide';
  const narrow = density === 'narrow';

  return (
    <>
      <div
        role="toolbar"
        aria-label={t('window.gorev_kontrolleri')}
        {...surfaceProps}
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;      // düğmenin kendi sağ tık menüsü zaten açıldı
          event.preventDefault();
          event.stopPropagation();
          actions.openHubAt({ x: event.clientX, y: event.clientY });
        }}
        className={cn(
          'absolute left-0 right-0 top-0 z-40 flex h-8 select-none items-center justify-between gap-1 rounded-t-[calc(var(--radius-window)-1px)] border-b border-frame-border bg-frame/95 pl-2.5 pr-1 shadow-sm backdrop-blur-xl transition-all duration-200',
          visible ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none -translate-y-2 opacity-0',
          focused ? 'text-foreground' : 'text-frame-muted hover:text-foreground',
        )}
      >
        {/* kimlik */}
        <div className="pointer-events-none flex min-w-0 items-center gap-2">
          <AppIcon pkg={task.package} displayName={task.title} size={20} />
          {!narrow && (
            <span className="truncate font-mono text-[11px] font-medium text-frame-muted" title={task.title || task.package}>
              {task.title || task.package}
            </span>
          )}
          {parked && (
            <span className="shrink-0 rounded bg-warning/15 px-1 text-[9px] font-medium text-warning" title={t('window.bu_gorev_telefonun_ekraninda_calisiyor')}>
              {t('common.telefonda')}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {wide && !parked && (
            <WindowControl compact nativeTitle label={t('window.geri')} onClick={actions.back}>
              <ChevronLeft className="size-3.5" />
            </WindowControl>
          )}
          {wide && <AudioButton windowId={task.windowId} compact />}
          {!narrow && (
            <WindowControl
              compact
              nativeTitle
              label={parked ? t('window.calisma_alanina_geri_al_2') : t('window.telefona_aktar')}
              aria-haspopup={parked ? undefined : 'menu'}
              aria-expanded={parked ? undefined : Boolean(handoffAnchor)}
              {...phonePress}
            >
              {parked ? <ArrowDownToLine className="size-3.5 text-warning" /> : <Smartphone className="size-3.5" />}
            </WindowControl>
          )}

          <span className="mx-0.5 h-3.5 w-px bg-frame-border" aria-hidden="true" />

          <WindowControl
            compact
            nativeTitle
            label={t('window.gorev_hub_i')}
            aria-haspopup="dialog"
            aria-expanded={hubOpen}
            active={hubOpen}
            onClick={(event) => actions.toggleHub(event.currentTarget)}
          >
            <Settings2 className="size-3.5" />
          </WindowControl>
          {wide && (
            <WindowControl compact nativeTitle label={maximized ? t('window.geri_yukle') : t('window.calisma_alanini_kapla')} onClick={actions.toggleMaximize}>
              {maximized ? <Copy className="size-3 -scale-x-100" /> : <Square className="size-3" />}
            </WindowControl>
          )}
          <WindowControl compact nativeTitle label={t('common.kapat')} destructive onClick={actions.closeTask}>
            <X className="size-3.5" />
          </WindowControl>
        </div>
      </div>

      {/* Menü başlığın KARDEŞİ: portal olsa da React olayları üst ağaçtan geçer; başlığın sürükleme/çift tık işleyicileri menüye basışı sürükleme sanmasın. */}
      {handoffAnchor && (
        <HandoffMenu
          anchor={handoffAnchor}
          onClose={closeHandoffMenu}
          onPick={(windowing) => {
            closeHandoffMenu();
            actions.handoff(windowing);
          }}
        />
      )}
    </>
  );
}
