// Küçük geri bildirim parçaları (connectivityParts'tan taşındı): EmptyNote, ConfirmStrip, KeyValueRow.
import React from 'react';
import { cn } from '../lib/utils.js';
import Button from './Button.jsx';

export function EmptyNote({ children, className }) {
  return <p className={cn('px-1 py-2 text-[10px] leading-snug text-muted-foreground', className)}>{children}</p>;
}

/** Satır içi "emin misin?" şeridi — yıkıcı eylemler ilk dokunuşta çalışmaz. */
export function ConfirmStrip({ message, confirmLabel = 'Unut', onConfirm, onCancel }) {
  return (
    <div role="alertdialog" aria-label={message} className="my-1 rounded-md border border-destructive/30 bg-destructive/5 p-2">
      <p className="text-[10px] leading-snug text-foreground">{message}</p>
      <div className="mt-1.5 flex justify-end gap-1">
        <Button size="2xs" variant="ghost" onClick={onCancel}>Vazgeç</Button>
        <Button size="2xs" variant="destructive-ghost" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/** Etiket ⟷ değer satırı (connectivityParts InfoRow). Değer boşsa hiç çizilmez. */
export function KeyValueRow({ label, value, className }) {
  if (value == null || value === '') return null;
  return (
    <div className={cn('flex items-baseline justify-between gap-3 border-b border-border/40 py-1 last:border-b-0', className)}>
      <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-[10px] tabular-nums text-foreground" title={String(value)}>
        {value}
      </span>
    </div>
  );
}
