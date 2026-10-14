// Bildirim merkezinin süzgeç çubuğu: [Tümü] [Okunmamış] │ uygulama çipleri (ikon + sayı). Tek dokunuşla süzer, tekrar dokununca kaldırır.
// Gereksiz çip gösterilmez: tek uygulama varsa uygulama çipleri, okunmamış yoksa "Okunmamış" çıkmaz.
import React, { useRef } from 'react';
import AppIcon from '../ui/AppIcon.jsx';
import { useHorizontalWheel } from './useHorizontalWheel.js';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';

const CHIP = 'notif-chip flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-95 cursor-pointer';

function Count({ children }) {
  return <span className="font-mono text-[11px] font-semibold tabular-nums opacity-65">{children}</span>;
}

export default function NotificationToolbar({ total, unread, filter, onFilter, facets, app, onApp }) {
  const stripRef = useRef(null);
  useHorizontalWheel(stripRef); // fare tekerleği çip satırını yatay kaydırır (Shift gerekmez)
  const showUnread = unread > 0 || filter === 'unread';
  const showApps = facets.length > 1;
  if (!showUnread && !showApps) return null;
  const everything = filter === 'all' && !app;

  return (
    <div
      ref={stripRef}
      role="toolbar"
      aria-label={t('notifications.bildirimleri_sirala')}
      className="no-scrollbar -mx-4 mt-2.5 flex items-center gap-1.5 overflow-x-auto px-4 pb-0.5"
      style={{ maskImage: 'linear-gradient(to right, transparent, #000 16px, #000 calc(100% - 16px), transparent)' }}
    >
      <button type="button" className={CHIP} aria-pressed={everything} onClick={() => { onFilter('all'); onApp(null); }}>
        {t('notifications.tumu')}
        <Count>{total}</Count>
      </button>
      {showUnread && (
        <button type="button" className={CHIP} aria-pressed={filter === 'unread'} onClick={() => onFilter(filter === 'unread' ? 'all' : 'unread')}>
          {t('notifications.okunmamis')}
          <Count>{unread}</Count>
        </button>
      )}
      {showApps && <span className="mx-0.5 h-4 w-px shrink-0 bg-notification-border/70" aria-hidden="true" />}
      {showApps &&
        facets.map((facet) => (
          <button
            key={facet.key}
            type="button"
            className={cn(CHIP, 'pl-1.5')}
            aria-pressed={app === facet.key}
            aria-label={`${facet.appName} ${facet.count}`}
            title={facet.appName}
            onClick={() => onApp(app === facet.key ? null : facet.key)}
          >
            <AppIcon pkg={facet.pkg} displayName={facet.appName} size={18} className="rounded-[28%]" />
            <Count>{facet.count}</Count>
          </button>
        ))}
    </div>
  );
}
