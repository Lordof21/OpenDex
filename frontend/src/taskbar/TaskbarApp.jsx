// Görev çubuğundaki TEK uygulama düğmesi (bir pencere = bir düğme).
//
// Geometri (taskbarModel.js ile aynı ızgara): 44 × 44 dokunma hedefi, içinde dikey yığın 4 · 30 (ikon) · 3 (ara) · 3 (gösterge) · 4 px —
// gösterge ikonla çakışmaz, yığın tam ortalıdır. Düğmeler arası 4 px. Köşe yarıçapı 10 px (çubuktaki tüm düğmelerle aynı).
//
// Etkileşimler:
//   · tıklama            → Windows davranışı (küçült / geri yükle / öne getir), taskbarModel.toggleActionFor
//   · basılı tut / sağ tık → bağlam menüsü (useLongPress: basılı tutuş sonrası gelen tıklama yutulur)
//   · üzerine gel        → pencere önizlemesi (Taskbar: niyet gecikmesiyle); klavye odağı anında açar
//   · yatay sürükle      → yeniden sıralama (useTaskbarReorder)
//   · rozet              → o uygulamanın okunmamış bildirimi; telefon rozeti → uygulama şu an telefonda
import React from 'react';
import { Smartphone } from 'lucide-react';

import AppIcon from '../ui/AppIcon.jsx';
import { useLongPress } from '../ui/useLongPress.js';
import { cn } from '../lib/utils.js';
import { TASKBAR_ICON_PX, badgeLabel } from './taskbarModel.js';
import { t } from '../i18n/index.js';

const chain = (...handlers) => (event) => {
  for (const handler of handlers) handler?.(event);
};

export function TaskbarApp({
  app,
  isOpen,
  isActive,
  isMinimized = false,
  onPhone = false,
  badge = 0,
  menuOpen = false,
  dragging = false,
  reorder,
  style,
  className,
  onActivate,
  onMenu,
  onPreview,
  onLeave,
}) {
  const name = app.name || app.display_name || t('taskbar.uygulama');
  const targetPkg = app.package || app.id;
  const press = useLongPress({ onLongPress: (el) => onMenu?.(el), onClick: onActivate });
  const label = badgeLabel(badge);

  const state = [
    onPhone ? 'telefonda' : null,
    isMinimized ? t('taskbar.kucultulmus') : isOpen ? t('common.acik') : null,
    label !== null ? `${badge} bildirim` : null,
  ].filter(Boolean).join(', ');

  return (
    <button
      type="button"
      data-taskbar-item={app.id}
      className={cn(
        // `className` ile gelen görünürlük sınıfı DISPLAY'i değiştirmemeli: düzen sabit flex + ortalama, gizleme bir eşikle sağlanır.
        'group/app relative flex h-[44px] w-[44px] shrink-0 touch-none cursor-pointer select-none flex-col items-center justify-center gap-[3px] rounded-[10px] outline-none',
        'transition-colors duration-150 hover:bg-accent/65 focus-visible:ring-2 focus-visible:ring-ring',
        isActive && 'bg-accent/80 shadow-xs',
        menuOpen && !isActive && 'bg-accent/50',
        dragging && 'bg-accent/80 shadow-md hover:bg-accent/80',
        className,
      )}
      style={style}
      aria-label={state ? `${name}, ${state}` : name}
      aria-current={isActive ? 'true' : undefined}
      aria-haspopup="menu"
      aria-expanded={menuOpen || undefined}
      {...press}
      onPointerDown={chain(press.onPointerDown, reorder?.onPointerDown)}
      onPointerMove={chain(press.onPointerMove, reorder?.onPointerMove)}
      onPointerUp={chain(press.onPointerUp, reorder?.onPointerUp)}
      onPointerCancel={chain(press.onPointerCancel, reorder?.onPointerCancel)}
      onPointerLeave={chain(press.onPointerLeave, onLeave)}
      onClickCapture={chain(reorder?.onClickCapture, press.onClickCapture)}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') onPreview?.(event.currentTarget);
      }}
      onFocus={(event) => {
        // Yalnız KLAVYEYLE gelen odak kartı hemen açar; fareyle tıklayınca odak da gelir ve tıklamadan sonra kart açılmamalı.
        // Menüden Esc/seçimle dönen odak da kartı açmamalı (menü zaten bir seçim yaptı).
        if (event.relatedTarget?.closest?.('[data-taskbar-menu]')) return;
        let keyboard = false;
        try { keyboard = event.currentTarget.matches(':focus-visible'); } catch { keyboard = false; }
        if (keyboard) onPreview?.(event.currentTarget, { immediate: true });
      }}
      onBlur={onLeave}
    >
      <span
        className={cn(
          'pointer-events-none flex items-center justify-center transition-transform duration-150 ease-out motion-reduce:transition-none',
          !dragging && 'group-hover/app:scale-[1.06] group-active/app:scale-95',
          isMinimized && 'opacity-70',
        )}
      >
        <AppIcon app={app} pkg={targetPkg} displayName={name} size={TASKBAR_ICON_PX} />
      </span>

      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none h-[3px] rounded-full shadow-sm transition-[width,background-color,opacity] duration-200 ease-out',
          !isOpen && 'w-[6px] opacity-0',
          isOpen && isActive && 'w-[18px] bg-status-active',
          isOpen && !isActive && !isMinimized && 'w-[6px] bg-status-active/90',
          isOpen && !isActive && isMinimized && 'w-[4px] bg-status-active/50',
        )}
      />

      {label !== null && (
        label === '' ? (
          <span
            aria-hidden="true"
            data-testid="taskbar-badge"
            className="pointer-events-none absolute right-[3px] top-[1px] size-[9px] rounded-full bg-primary ring-[1.5px] ring-taskbar"
          />
        ) : (
          <span
            aria-hidden="true"
            data-testid="taskbar-badge"
            className="pointer-events-none absolute right-px top-0 grid h-[14px] min-w-[14px] place-items-center rounded-full bg-primary px-[3px] text-[9px] font-bold leading-none text-primary-foreground ring-[1.5px] ring-taskbar"
          >
            {label}
          </span>
        )
      )}

      {onPhone && (
        <span
          aria-hidden="true"
          data-testid="taskbar-phone-badge"
          className="pointer-events-none absolute right-[3px] top-[24px] grid size-3 place-items-center rounded-full bg-taskbar text-status-active ring-1 ring-status-active/45"
        >
          <Smartphone className="size-[7px]" strokeWidth={2.6} />
        </span>
      )}
    </button>
  );
}

export default TaskbarApp;
