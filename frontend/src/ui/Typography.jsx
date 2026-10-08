// Başlıklar: SectionLabel (büyük harf "eyebrow"), PanelHeader (PanelTitle / SectionHeading / QuickSubHeader yerine).
import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { IconButton } from './IconButton.jsx';

export function SectionLabel({ children, action, className }) {
  return (
    <div className={cn('mt-2.5 mb-1 flex h-5 items-center justify-between px-1', className)}>
      <h3 className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
      {action}
    </div>
  );
}

const ICON_BOX = {
  solid: 'size-9 bg-primary text-primary-foreground [&_svg]:size-4', // taskbar panelleri (eski PanelTitle)
  soft: 'size-8 bg-primary/10 text-primary [&_svg]:size-4', // SettingsPanel bölüm başlığı (eski SectionHeading)
};

const TITLE_SIZE = { sm: 'text-[12px]', md: 'text-[13px] leading-tight', lg: 'text-sm' };

/**
 * icon → solda ikon kutusu · onBack → solda geri butonu (eski QuickSubHeader) · action → sağda.
 * size: sm (alt görünüm başlığı) | md (ayar bölümü) | lg (taskbar paneli)
 */
export function PanelHeader({ icon: Icon, iconTone = 'solid', size = 'lg', title, subtitle, onBack, backLabel = 'Geri', action, className }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      {onBack && (
        <IconButton label={backLabel} tooltip={false} size="md" onClick={onBack} className="text-foreground">
          <ChevronLeft />
        </IconButton>
      )}
      {Icon && (
        <span className={cn('grid shrink-0 place-items-center rounded-md', ICON_BOX[iconTone] || ICON_BOX.solid)}>
          <Icon />
        </span>
      )}
      <div className="min-w-0">
        <h2 className={cn('truncate font-semibold text-foreground', TITLE_SIZE[size] || TITLE_SIZE.lg)}>{title}</h2>
        {subtitle && <p className={cn('truncate text-muted-foreground', size === 'sm' ? 'text-[9px]' : 'text-[10px]')}>{subtitle}</p>}
      </div>
      {action && <div className="ml-auto flex shrink-0 items-center pr-1">{action}</div>}
    </div>
  );
}
