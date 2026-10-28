// Çekmecenin görünüm seçici kenar çubuğu (Ayarlar'daki SideNav dili): Tümü · Favoriler · Sık kullanılanlar · Açık · Sistem · Gizli,
// her birinin sayısıyla. Geniş pencerede dikey sütun, dar pencerede yatay çip satırı.

import React from 'react';
import { EyeOff, History, LayoutGrid, Layers, Settings2, Star } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { VIEWS } from './launcherModel.js';

const ICONS = { all: LayoutGrid, favorites: Star, frequent: History, open: Layers, system: Settings2, hidden: EyeOff };

export const viewLabel = (view) => t(`launcher.v_${view}`);

export function LauncherRail({ view, counts, onSelect }) {
  return (
    <nav
      aria-label={t('launcher.gorunumler')}
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 bg-muted/20 px-3 py-2 md:w-[188px] md:flex-col md:gap-0.5 md:overflow-x-visible md:border-b-0 md:border-r md:px-2 md:py-3"
    >
      {VIEWS.map((id) => {
        const Icon = ICONS[id];
        const active = view === id;
        return (
          <button
            key={id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelect(id)}
            className={cn(
              'flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-primary/10 font-semibold text-primary' : 'font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="size-3.5 shrink-0" strokeWidth={active ? 2.1 : 1.8} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-left">{viewLabel(id)}</span>
            <span className={cn('rounded-full px-1.5 py-px text-[9.5px] font-semibold tabular-nums', active ? 'bg-primary/15' : 'bg-background/80')}>
              {counts[id] ?? 0}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export default LauncherRail;
