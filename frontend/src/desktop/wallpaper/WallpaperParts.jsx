// WallpaperDialog'un parçaları: seçim karoları (klavye ile gezilen ızgara), canlı önizleme, küçük resim URL'leri.
// Mantık prefs.js / wallpaperStore.js'te; burada yalnız çizim ve etkileşim vardır.
import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { imageStore } from './imageStore.js';
import { artStyle, blurStyle, dimStyle } from './layerStyle.js';

// ── Klavye ile gezilen seçim ızgarası ───────────────────────────────────────────────────────────────────────

/**
 * Aynı sütuna en yakın, bir alt/üst satırdaki karo; düzen bilgisi yoksa (ör. jsdom: tüm konumlar 0) null.
 * Konum ekran koordinatıyla ölçülür: karolar `relative` bir sarmalayıcının içindedir, `offsetTop` sarmalayıcıya göredir (hepsi 0).
 */
function verticalNeighbour(items, at, dir) {
  const rects = items.map((item) => item.getBoundingClientRect());
  const rows = [...new Set(rects.map((rect) => Math.round(rect.top)))].sort((a, b) => a - b);
  const next = rows[rows.indexOf(Math.round(rects[at].top)) + dir];
  if (next === undefined) return null;
  let best = null;
  rects.forEach((rect, index) => {
    if (Math.round(rect.top) !== next) return;
    if (best === null || Math.abs(rect.left - rects[at].left) < Math.abs(rects[best].left - rects[at].left)) best = index;
  });
  return best;
}

/**
 * Tek seçimli karo ızgarası (role="listbox"). Ok tuşları ODAĞI taşır (seçmez): bir kapağı seçmek canlı bir geçiş başlatır,
 * gezinirken her karede geçiş olmasın; Enter/Boşluk (düğme) seçer. Yalnız seçili (yoksa ilk) karo Tab ile erişilir.
 */
export function ChoiceGrid({ label, className, children }) {
  const onKeyDown = (event) => {
    const items = [...event.currentTarget.querySelectorAll('[role="option"]')];
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    let to = null;
    if (event.key === 'ArrowRight') to = at + 1;
    else if (event.key === 'ArrowLeft') to = at - 1;
    else if (event.key === 'ArrowDown') to = verticalNeighbour(items, at, 1);
    else if (event.key === 'ArrowUp') to = verticalNeighbour(items, at, -1);
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = items.length - 1;
    else return;
    event.preventDefault();
    if (to !== null && items[to]) items[to].focus();
  };
  return (
    <div role="listbox" aria-label={label} onKeyDown={onKeyDown} className={className}>
      {children}
    </div>
  );
}

/** Izgaradaki karolardan hangisi Tab ile erişilir: seçili olan; hiçbiri seçili değilse ilk. */
export const focusableIndex = (selectedFlags) => {
  const at = selectedFlags.indexOf(true);
  return at >= 0 ? at : 0;
};

export function Tile({ name, caption, selected, focusable, onSelect, actions, children }) {
  return (
    <div className="group relative min-w-0">
      <button
        type="button"
        role="option"
        aria-selected={selected}
        aria-label={name}
        tabIndex={focusable ? 0 : -1}
        onClick={onSelect}
        className={cn(
          'relative block aspect-video w-full cursor-pointer overflow-hidden rounded-lg ring-1 ring-border/70 transition-shadow hover:ring-2 hover:ring-primary/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected && 'ring-2 ring-primary hover:ring-primary',
        )}
      >
        {children}
        {selected && (
          <span className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-md" aria-hidden="true">
            <Check className="size-3" strokeWidth={3} />
          </span>
        )}
      </button>
      <span aria-hidden="true" className="mt-1 block truncate px-0.5 text-[10px] leading-4 text-muted-foreground">{caption ?? name}</span>
      {actions}
    </div>
  );
}

// ── Küçük resimler ──────────────────────────────────────────────────────────────────────────────────────────

const loadThumbBlob = async (id) => (await imageStore.thumb(id)) ?? imageStore.blob(id);

/** Kullanıcı resimlerinin küçük önizleme URL'leri ({ [id]: url }); kalkan/silinen için URL serbest bırakılır. */
export function useThumbUrls(images, loadThumb = loadThumbBlob) {
  const [urls, setUrls] = useState({});
  const owned = useRef(new Map()); // id → url | null (yükleniyor)
  const mounted = useRef(true);
  const loader = useRef(loadThumb);
  loader.current = loadThumb;

  useEffect(
    () => () => {
      mounted.current = false;
      owned.current.forEach((url) => url && URL.revokeObjectURL(url));
      owned.current.clear();
    },
    [],
  );

  useEffect(() => {
    const ids = new Set(images.map((img) => img.id));
    for (const [id, url] of [...owned.current]) {
      if (ids.has(id)) continue;
      if (url) URL.revokeObjectURL(url);
      owned.current.delete(id);
      setUrls((current) => {
        const { [id]: _gone, ...rest } = current;
        return rest;
      });
    }
    for (const img of images) {
      if (owned.current.has(img.id)) continue;
      owned.current.set(img.id, null);
      Promise.resolve(loader.current(img.id))
        .catch(() => null)
        .then((blob) => {
          if (!mounted.current || !owned.current.has(img.id)) return;
          const url = blob ? URL.createObjectURL(blob) : null;
          owned.current.set(img.id, url);
          if (url) setUrls((current) => ({ ...current, [img.id]: url }));
        });
    }
  }, [images]);

  return urls;
}

// ── Canlı önizleme ──────────────────────────────────────────────────────────────────────────────────────────

const MOCK_APPS = [
  ['Dosyalar', 'bg-app-files'],
  ['Tarayıcı', 'bg-app-browser'],
  ['Galeri', 'bg-app-gallery'],
  ['E-posta', 'bg-app-mail'],
  ['Ayarlar', 'bg-app-settings'],
  ['Notlar', 'bg-app-lovable'],
];

/**
 * Seçili kapağın küçük bir masaüstü maketi üzerinde görünümü: simge adları gerçek masaüstündeki `desktop-ink` ile yazılır
 * (kapak açık/koyuya göre okunur mu — kullanıcı burada görür), altta görev çubuğu, sağda bir pencere (karartma/bulanıklık etkisi).
 */
export function PreviewStage({ wallpaper, thumbUrl }) {
  return (
    <figure
      data-wallpaper-tone={wallpaper.tone}
      aria-label={`Önizleme: ${wallpaper.name}`}
      className="relative m-0 aspect-video w-full select-none overflow-hidden rounded-xl bg-muted shadow-sm ring-1 ring-border/70"
    >
      <div className="absolute" style={blurStyle(Math.round(wallpaper.blur * 0.3))}>
        <div className="absolute inset-0" style={artStyle(wallpaper, thumbUrl)} />
      </div>
      <div className="absolute inset-0" style={dimStyle(wallpaper.dim)} />

      <div className="absolute inset-x-[5%] top-[7%] grid grid-cols-6 gap-x-1 gap-y-1.5">
        {MOCK_APPS.map(([label, tone]) => (
          <span key={label} className="flex min-w-0 flex-col items-center gap-0.5">
            <span className={cn('size-[26px] rounded-[7px] shadow-sm ring-1 ring-black/10', tone)} />
            <span className="desktop-ink w-full truncate text-center text-[6px] font-medium leading-[8px]">{label}</span>
          </span>
        ))}
      </div>

      <div className="absolute bottom-[17%] right-[6%] h-[34%] w-[38%] overflow-hidden rounded-md border border-border/70 bg-popover/90 shadow-md backdrop-blur-sm">
        <div className="h-[5px] border-b border-border/60 bg-muted" />
        <div className="space-y-1 p-1.5">
          <div className="h-[3px] w-3/4 rounded-full bg-foreground/25" />
          <div className="h-[3px] w-1/2 rounded-full bg-foreground/15" />
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex h-[11%] items-center justify-center gap-1.5 border-t border-taskbar-border bg-taskbar backdrop-blur-md">
        {[0, 1, 2, 3].map((dot) => (
          <span key={dot} className="size-[6px] rounded-[2px] bg-taskbar-foreground/45" />
        ))}
      </div>
    </figure>
  );
}
