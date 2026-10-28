// Çekmecedeki bir uygulama düğmesi (ızgara hücresi ya da liste satırı). Combobox deseninin "option"ı: odak arama kutusunda kalır,
// ok tuşları `activeKey`i değiştirir (aria-activedescendant); tıklama açar; sağ tık / basılı tut / menü tuşu bağlam menüsünü açar.

import React, { memo } from 'react';
import { Smartphone, Star } from 'lucide-react';
import AppIcon from '../../ui/AppIcon.jsx';
import { Highlight, Chip } from '../../settings/controls.jsx';
import { useLongPress } from '../../ui/useLongPress.js';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { appId, appName } from './launcherModel.js';

/** Aynı uygulama birden çok bölümde (Favoriler, Sık kullanılanlar, A–Z) görünür: seçim bölüm + paketle anahtarlanır. */
export const optionKey = (section, app) => `${section}:${appId(app)}`;
export const optionDomId = (key) => `launcher-opt-${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}`;

export const LauncherTile = memo(function LauncherTile({ app, section, letter, layout = 'grid', isOpen, onPhone, favorite, active, query = '', onOpen, onMenu }) {
  const key = optionKey(section, app);
  const name = appName(app);
  const press = useLongPress({ onClick: () => onOpen(app), onLongPress: (element) => onMenu(app, element) });
  const label = [name, isOpen && t('launcher.acik'), onPhone && t('launcher.telefonda'), favorite && t('launcher.favori')].filter(Boolean).join(', ');
  const common = {
    type: 'button',
    role: 'option',
    id: optionDomId(key),
    'data-launcher-option': '',
    'data-key': key,
    'data-letter': letter,                     // A–Z listesinde harfin ilk uygulaması: harf dizininin atlama hedefi
    'aria-selected': active,
    'aria-label': label,
    tabIndex: -1,
    ...press,
  };

  if (layout === 'list') {
    return (
      <button
        {...common}
        className={cn(
          'flex h-11 w-full min-w-0 cursor-pointer select-none items-center gap-3 rounded-lg px-2.5 text-left outline-none transition-colors hover:bg-accent/50',
          active && 'bg-accent/70 ring-2 ring-inset ring-ring',
        )}
      >
        <span className="relative shrink-0">
          <AppIcon app={app} size={28} />
          {isOpen && <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-status-active ring-2 ring-popover" aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium leading-4 text-foreground"><Highlight text={name} query={query} /></span>
          <span className="block truncate font-mono text-[10px] leading-4 text-muted-foreground">{appId(app)}</span>
        </span>
        {onPhone && <Chip tone="primary"><Smartphone className="size-2.5" aria-hidden="true" />{t('launcher.telefonda')}</Chip>}
        {favorite && <Star className="size-3.5 shrink-0 fill-current text-warning" aria-hidden="true" />}
      </button>
    );
  }

  return (
    <button
      {...common}
      className={cn(
        'group/tile relative flex min-h-[96px] min-w-0 cursor-pointer select-none flex-col items-center gap-1.5 rounded-xl px-1 pb-2 pt-2.5 outline-none transition-colors hover:bg-accent/60',
        active && 'bg-accent/70 ring-2 ring-ring',
      )}
    >
      <span className="relative transition-transform duration-150 group-hover/tile:-translate-y-0.5 group-active/tile:scale-95">
        <AppIcon app={app} size="launcher" />
        {favorite && (
          <span className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-popover text-warning shadow-sm ring-1 ring-border" aria-hidden="true">
            <Star className="size-2.5 fill-current" />
          </span>
        )}
        {onPhone && (
          <span className="absolute -left-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm" aria-hidden="true">
            <Smartphone className="size-2.5" />
          </span>
        )}
        {isOpen && <span className="absolute -bottom-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-status-active shadow-sm" aria-hidden="true" />}
      </span>
      <span className="w-full truncate text-center text-[11px] font-medium leading-4 text-foreground">
        <Highlight text={name} query={query} />
      </span>
    </button>
  );
});
