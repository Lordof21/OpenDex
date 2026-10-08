// Satır içi yeniden adlandırma: uzantı HARİÇ seçili açılır (Gezgin gibi), Enter uygular, Esc vazgeçer, odak kaybı uygular.
// Sunucu reddederse (zaten var / geçersiz ad) kutu açık kalır, hata altında gösterilir.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils.js';
import { renameSelection } from './fileNames.js';

export default function InlineRename({ entry, onCommit, onCancel, centered = false }) {
  const ref = useRef(null);
  const [value, setValue] = useState(entry.name);
  const [error, setError] = useState(null);
  const busy = useRef(false);

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const [from, to] = renameSelection(entry.name, entry.kind === 'dir');
    input.setSelectionRange(from, to);
  }, [entry.name, entry.kind]);

  // Dışarı tıklama = uygula. Satır yeniden çizilirken blur'un iki kez ateşlenmesine karşı `busy` koruması.
  const commit = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await onCommit(value);
    } catch (err) {
      setError(err.message || 'Yeniden adlandırılamadı.');
      busy.current = false;
      ref.current?.focus();
    }
  };

  useEffect(() => () => { busy.current = true; }, []);

  return (
    <span className={cn('relative min-w-0 flex-1', centered && 'w-full')}>
      <input
        ref={ref}
        value={value}
        aria-label="Yeni ad"
        aria-invalid={Boolean(error)}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => { setValue(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          e.stopPropagation();                                   // klasör kısayolları (Delete, F2, ok tuşları) metni etkilemesin
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        onBlur={() => { if (!error) commit(); else onCancel(); }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cn(
          'w-full min-w-0 rounded-sm border bg-background px-1.5 py-0.5 text-xs font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring',
          centered && 'text-center text-[11px]',
          error ? 'border-destructive' : 'border-ring',
        )}
      />
      {error && (
        <span role="alert" className="absolute left-0 top-full z-10 mt-1 w-max max-w-64 rounded-md border border-destructive/40 bg-popover px-2 py-1 text-[10px] text-destructive shadow-xs">
          {error}
        </span>
      )}
    </span>
  );
}
