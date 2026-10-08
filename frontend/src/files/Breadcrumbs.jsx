// Adres çubuğu: tıklanabilir dilimler (Dahili depolama › DCIM › Camera) ve düzenlenebilir yol (boş alana tıkla, Ctrl+L ya da
// çift tıkla). Uzun yolda baştaki dilimler "…" menüsüne toplanır; dilimlere dosya BIRAKILABİLİR (sürükle-bırak hedefi).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Ellipsis } from 'lucide-react';
import { cn } from '../lib/utils.js';
import DropdownMenu from './DropdownMenu.jsx';
import { registerDropTarget } from './dragManager.js';
import { dropOnFolder } from './filesCommands.js';
import { useFilesStore } from './filesStore.js';
import { FOCUS_PATH_EVENT } from './menuActions.js';
import { breadcrumbs, collapseCrumbs, locKey, parsePathInput } from './paths.js';
import { acceptsDrop } from './dragRules.js';
import { MenuItem } from '../ui/Menu.jsx';

const MAX = { compact: 2, medium: 4, wide: 6 };

function Crumb({ crumb, last, paneKey, onGo }) {
  return (
    <button
      type="button"
      data-drop-id={`crumb:${paneKey}`}
      data-crumb={locKey(crumb.loc)}
      onClick={() => onGo(crumb.loc)}
      aria-current={last ? 'page' : undefined}
      className={cn(
        'max-w-44 shrink-0 truncate rounded-sm px-1.5 py-1 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer',
        last ? 'min-w-0 shrink text-foreground' : 'text-muted-foreground',
      )}
      title={crumb.loc.path}
    >
      {crumb.label}
    </button>
  );
}

export default function Breadcrumbs({ winId, pi, layoutMode }) {
  const pane = useFilesStore((s) => s.wins[winId]?.panes[pi]);
  const places = useFilesStore((s) => s.places);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const input = useRef(null);
  const store = useFilesStore;
  const paneKey = pane.id;

  const folder = pane.loc && { ...pane.loc, path: pane.canonical || pane.loc.path };
  const crumbs = useMemo(
    () => breadcrumbs(folder, [...places.pc, ...places.phone]),
    [folder?.path, folder?.provider, folder?.device, places.pc, places.phone], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const { head, hidden, tail } = collapseCrumbs(crumbs, MAX[layoutMode] ?? MAX.wide);

  const go = (loc) => store.getState().navigate(winId, pi, loc);

  // Dilimlere bırakma: TEK kayıt, `resolve` dilimden konumu çözer.
  useEffect(() => registerDropTarget(`crumb:${paneKey}`, {
    resolve(el) {
      const p = store.getState().wins[winId]?.panes[pi];
      const f = p?.loc && { ...p.loc, path: p.canonical || p.loc.path };
      const target = breadcrumbs(f, [...store.getState().places.pc, ...store.getState().places.phone]).find((c) => locKey(c.loc) === el.getAttribute('data-crumb'));
      return target ? { loc: target.loc, name: target.label } : null;
    },
    accepts: acceptsDrop,
    onDrop: (sources, mods, dest) => dropOnFolder({ sources, dest, ...mods }),
  }), [paneKey, winId, pi, store]);

  // Ctrl+L (FolderView yayınlar) → düzenleme kipi.
  useEffect(() => {
    const on = (e) => { if (e.detail.winId === winId && e.detail.pi === pi) beginEdit(); };
    window.addEventListener(FOCUS_PATH_EVENT, on);
    return () => window.removeEventListener(FOCUS_PATH_EVENT, on);
  });

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  function beginEdit() {
    setDraft(folder?.path ?? '');
    setError(null);
    setEditing(true);
  }

  async function commit() {
    const loc = parsePathInput(draft, folder);
    if (!loc) { setEditing(false); return; }
    if (locKey(loc) === locKey(folder)) { setEditing(false); return; }
    // Yolu SUNUCU doğrular: kutu hata ile açık kalır (yazım hatası düzeltilebilsin), başarıda çubuk kapanır.
    await store.getState().navigate(winId, pi, loc);
    const after = store.getState().wins[winId]?.panes[pi];
    if (after?.status === 'error') {
      setError(after.error?.code === 'outside_roots' ? 'Bu konuma erişim izni yok.' : after.error?.code === 'not_found' ? 'Böyle bir klasör yok.' : after.error?.message || 'Açılamadı.');
      await store.getState().goBack(winId, pi);
      return;
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="relative min-w-0 flex-1">
        <input
          ref={input}
          value={draft}
          aria-label="Konum"
          aria-invalid={Boolean(error)}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          }}
          onBlur={() => { if (!error) setEditing(false); }}
          className={cn('h-8 w-full rounded-md border bg-background px-2.5 font-mono text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring', error ? 'border-destructive' : 'border-ring')}
        />
        {error && <p role="alert" className="absolute left-0 top-full z-40 mt-1 rounded-md border border-destructive/40 bg-popover px-2 py-1 text-[10px] text-destructive shadow-xs">{error}</p>}
      </div>
    );
  }

  return (
    <nav
      aria-label="Klasör yolu"
      className="flex h-8 min-w-0 flex-1 cursor-text items-center overflow-hidden rounded-md border border-transparent px-0.5 transition-colors hover:border-border/70 hover:bg-background/60"
      onClick={(e) => { if (e.target === e.currentTarget) beginEdit(); }}
      onDoubleClick={beginEdit}
    >
      {head && (
        <>
          <Crumb crumb={head} paneKey={paneKey} onGo={go} />
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
          {hidden.length > 0 && (
            <>
              <DropdownMenu
                label="Gizlenen üst klasörler"
                trigger={(t) => (
                  <button type="button" {...t} aria-label="Gizlenen üst klasörler" className="grid h-6 w-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer">
                    <Ellipsis className="size-3.5" />
                  </button>
                )}
              >
                {({ close }) => [...hidden].reverse().map((c) => (
                  <MenuItem key={locKey(c.loc)} label={c.label} onClick={() => { close(); go(c.loc); }} />
                ))}
              </DropdownMenu>
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
            </>
          )}
        </>
      )}
      {tail.map((c, i) => (
        <React.Fragment key={locKey(c.loc)}>
          {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />}
          <Crumb crumb={c} last={i === tail.length - 1} paneKey={paneKey} onGo={go} />
        </React.Fragment>
      ))}
    </nav>
  );
}
