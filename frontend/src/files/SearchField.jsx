// Arama kutusu. Yazarken bu klasörü ANINDA süzer (istemci tarafı); Enter alt klasörlerde de arar (backend). Esc: önce metni,
// sonra aramayı kapatır. Dar kipte yalnız simge; açılınca araç çubuğunu kaplar.
import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { IconButton } from '../ui/IconButton.jsx';
import { useFilesStore } from './filesStore.js';
import { FOCUS_SEARCH_EVENT } from './menuActions.js';
import { locKey } from './paths.js';

export default function SearchField({ winId, compact }) {
  const pi = useFilesStore((s) => s.wins[winId]?.activePane ?? 0);
  const pane = useFilesStore((s) => s.wins[winId]?.panes[pi]);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const input = useRef(null);
  const store = useFilesStore;
  const here = locKey(pane?.loc);
  const expanded = !compact || open || text !== '';

  // Başka klasöre geçince arama sıfırlanır (store de sorguyu temizler).
  useEffect(() => { setText(''); setOpen(false); }, [here, pi]);

  useEffect(() => {
    const on = (e) => {
      if (e.detail.winId !== winId) return;
      setOpen(true);
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, on);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, on);
  }, [winId]);

  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const clear = () => {
    setText('');
    const p = store.getState().wins[winId]?.panes[pi];
    if (p?.search) store.getState().clearSearch(winId, pi);
    else store.getState().setQuery(winId, pi, '');
  };

  if (!expanded) {
    return <IconButton label="Ara" size="md" onClick={() => setOpen(true)}><Search /></IconButton>;
  }

  const deep = pane?.search;
  return (
    <div className={cn('relative flex min-w-0 items-center', compact ? 'flex-1' : 'w-56 shrink-0')} role="search">
      <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden="true" />
      <input
        ref={input}
        type="search"
        value={text}
        placeholder={compact ? 'Ara' : 'Bu klasörde ara'}
        aria-label="Dosyalarda ara"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => { setText(e.target.value); store.getState().setQuery(winId, pi, e.target.value); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && text.trim()) { e.preventDefault(); store.getState().searchDeep(winId, pi, text); }
          else if (e.key === 'Escape') { e.preventDefault(); if (text || deep) clear(); else { setOpen(false); input.current?.blur(); } }
        }}
        onBlur={() => { if (!text) setOpen(false); }}
        className="h-8 w-full rounded-md border border-border/70 bg-background pl-8 pr-14 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {text && (
        <span className="absolute right-1 flex items-center gap-0.5">
          {!deep && <kbd className="rounded-sm border border-border/70 px-1 text-[9px] text-muted-foreground" title="Alt klasörlerde de ara">↵</kbd>}
          <IconButton label="Aramayı temizle" size="xs" onClick={clear}><X /></IconButton>
        </span>
      )}
    </div>
  );
}
