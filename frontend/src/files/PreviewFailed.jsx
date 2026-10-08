import React from 'react';
import { FileWarning } from 'lucide-react';

/** Önizleme açılamadı: neden (varsa) ve "Bilgisayarda aç" çıkışı. Hızlı önizlemenin her gövdesi aynı kartı kullanır. */
export default function PreviewFailed({ message, onOpen }) {
  return (
    <div role="alert" className="flex max-w-xs flex-col items-center gap-2 text-center text-scrim-foreground">
      <FileWarning className="size-9 opacity-70" strokeWidth={1.4} aria-hidden="true" />
      <p className="text-sm font-semibold">Önizleme yüklenemedi</p>
      {message && <p className="text-[11px] opacity-80">{message}</p>}
      {onOpen && <button type="button" onClick={onOpen} className="rounded-md border border-scrim-foreground/40 px-3 py-1 text-xs hover:bg-scrim-foreground/15 cursor-pointer">Bilgisayarda aç</button>}
    </div>
  );
}
