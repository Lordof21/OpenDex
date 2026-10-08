// Yerler: Telefon (depolama birimleri, kapasite çubuğuyla), Bilgisayar (bilinen klasörler + sürücüler + eklenenler) ve
// Favoriler. Etkin bölmenin konumunu içeren yer vurgulanır; yerlere dosya BIRAKILABİLİR (taşı/kopyala). Aynı içerik geniş
// kipte yan çubuk, dar kipte alttan açılan sayfadır (`variant`).
import React, { useEffect } from 'react';
import { FolderPlus, Smartphone, Star, Trash2, Unplug, Upload, X } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { MenuLabel } from '../ui/Menu.jsx';
import { registerDropTarget } from './dragManager.js';
import { acceptsDrop } from './dragRules.js';
import { addPcFolder, dropOnFolder, removeFavorite, uploadFromPc } from './filesCommands.js';
import { TONE_CLASS } from './fileTypes.js';
import { useFilesStore } from './filesStore.js';
import { formatSize } from './formatters.js';
import { isInside } from './paths.js';
import { activePlaceId, capacityOf, placeIcon } from './placeIcons.js';

const locOf = (p) => ({ provider: p.provider, path: p.path, ...(p.device ? { device: p.device } : {}) });

function Capacity({ place }) {
  const cap = capacityOf(place);
  if (!cap) return null;
  return (
    <span className="mt-1 block">
      <span className="block h-1 overflow-hidden rounded-full bg-border" aria-hidden="true">
        <span className={cn('block h-full rounded-full', cap.low ? 'bg-destructive' : 'bg-primary/80')} style={{ width: `${cap.used}%` }} />
      </span>
      <span className="mt-0.5 block text-[10px] text-muted-foreground tabular-nums">{formatSize(cap.free)} boş / {formatSize(cap.total)}</span>
    </span>
  );
}

function PlaceButton({ place, active, dropId, touch, onGo, onRemove }) {
  const { icon: Icon, tone } = place.favorite ? { icon: Star, tone: 'folder' } : placeIcon(place);
  return (
    <div className="group relative">
      <button
        type="button"
        data-place={place.id}
        data-drop-id={dropId}
        aria-current={active ? 'true' : undefined}
        onClick={() => onGo(place)}
        className={cn(
          'flex w-full items-start gap-2.5 rounded-md px-2.5 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer',
          touch ? 'py-3' : 'py-2',
          active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/60',
        )}
      >
        <Icon className={cn('mt-px size-4 shrink-0', TONE_CLASS[tone])} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{place.name}</span>
          <Capacity place={place} />
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`${place.name} favorilerden çıkar`}
          onClick={() => onRemove(place)}
          className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 cursor-pointer"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

export default function FilesSidebar({ winId, variant = 'rail', onNavigated }) {
  const pi = useFilesStore((s) => s.wins[winId]?.activePane ?? 0);
  const loc = useFilesStore((s) => s.wins[winId]?.panes[pi]?.loc);
  const places = useFilesStore((s) => s.places);
  const status = useFilesStore((s) => s.placesStatus);
  const store = useFilesStore;
  const touch = variant === 'sheet';
  const dropId = `place:${winId}`;

  useEffect(() => registerDropTarget(dropId, {
    resolve(el) {
      const id = el.getAttribute('data-place');
      const s = store.getState().places;
      const place = [...s.phone, ...s.pc, ...s.favorites.map((f) => ({ ...f, id: `fav:${f.id}` }))].find((p) => p.id === id);
      return place ? { loc: locOf(place), name: place.name } : null;
    },
    accepts: acceptsDrop,
    onDrop: (sources, mods, dest) => dropOnFolder({ sources, dest, ...mods }),
  }), [dropId, store]);

  const favorites = places.favorites.map((f) => ({ ...f, id: `fav:${f.id}`, favorite: true, rawId: f.id }));
  const all = [...places.pc, ...places.phone];
  const activeId = activePlaceId(loc, all, isInside);
  const go = (place) => {
    store.getState().navigate(winId, pi, locOf(place));
    onNavigated?.();
  };

  return (
    <nav aria-label="Yerler" className={cn('dex-scroll flex min-h-0 flex-col gap-3 overflow-y-auto overflow-x-hidden p-2', variant === 'rail' ? 'w-56 shrink-0 border-r border-border/70' : 'w-full')}>
      <section aria-label="Telefon">
        <MenuLabel>Telefon</MenuLabel>
        {places.phone.length === 0 ? (
          <p className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-muted-foreground">
            {status === 'loading' ? <Smartphone className="size-4" aria-hidden="true" /> : <Unplug className="size-4" aria-hidden="true" />}
            {status === 'loading' ? 'Telefon aranıyor…' : 'Telefon bağlı değil'}
          </p>
        ) : (
          places.phone.map((p) => <PlaceButton key={p.id} place={p} active={activeId === p.id} dropId={dropId} touch={touch} onGo={go} />)
        )}
      </section>
      <section aria-label="Bilgisayar">
        <MenuLabel>Bilgisayar</MenuLabel>
        {places.pc.map((p) => <PlaceButton key={p.id} place={p} active={activeId === p.id} dropId={dropId} touch={touch} onGo={go} />)}
      </section>
      {favorites.length > 0 && (
        <section aria-label="Favoriler">
          <MenuLabel>Favoriler</MenuLabel>
          {favorites.map((p) => <PlaceButton key={p.id} place={p} active={false} dropId={dropId} touch={touch} onGo={go} onRemove={() => removeFavorite(p.rawId)} />)}
        </section>
      )}
      <div className="mt-auto flex flex-col gap-0.5 border-t border-border/70 pt-2">
        <button type="button" onClick={() => addPcFolder()} className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground cursor-pointer">
          <FolderPlus className="size-4" aria-hidden="true" /> Klasör ekle…
        </button>
        <button type="button" onClick={() => uploadFromPc(winId, pi)} className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground cursor-pointer">
          <Upload className="size-4" aria-hidden="true" /> Dosya yükle…
        </button>
        <button type="button" onClick={() => { store.getState().openDialog(winId, { type: 'trash' }); onNavigated?.(); }} className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground cursor-pointer">
          <Trash2 className="size-4" aria-hidden="true" /> Geri dönüşüm kutusu
        </button>
      </div>
    </nav>
  );
}
