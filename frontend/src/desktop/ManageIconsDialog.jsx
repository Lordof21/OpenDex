// Masaüstü → sağ tık → "Simgeleri yönet". Telefondaki uygulamalardan hangilerinin masaüstünde duracağını seçtirir.
//
//   - Her satır TEK anahtar (role="switch"): tıklayınca masaüstüne eklenir / kaldırılır; sonuç anında masaüstünde görünür.
//   - Arama (ad + paket), süzgeç (Tümü / Masaüstünde / Eklenmemiş), A–Z harf grupları, OpenDeX uygulamaları üstte.
//   - Doluluk çubuğu: 119 hücrenin kaçı dolu. Dolu masaüstüne ekleme reddedilir ve nedeni söylenir.
//   - Her değişiklik "Geri al" ile döner (toplu işlemler ve "Önerilen düzen" dahil) — onay penceresi gerekmez.
//   - Klavye: arama ↔ liste ok tuşlarıyla, Boşluk/Enter anahtarı çevirir, listedeyken yazmak aramaya geçer, Esc önce aramayı
//     temizler sonra kapatır.
// Mantık manageIcons.js'te (saf, testli); bu dosya yalnız çizim ve etkileşimdir.
import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CheckCheck, Folder, Minus, PackageOpen, Plus, RotateCcw, Search, SearchX, SlidersHorizontal, Undo2, X } from 'lucide-react';
import AppIcon from '../ui/AppIcon.jsx';
import { Button } from '../ui/Button.jsx';
import { Dialog } from '../ui/Dialog.jsx';
import { IconButton } from '../ui/IconButton.jsx';
import { SegmentedControl } from '../ui/SegmentedControl.jsx';
import { SwitchThumb } from '../ui/Switch.jsx';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { cn } from '../lib/utils.js';
import {
  appName,
  buildSections,
  countLabel,
  desktopStats,
  filterCounts,
  flatten,
  folderMembership,
  packagesOnDesktop,
  placeApps,
  removeApps,
  trLower,
  withCustomKept,
} from './manageIcons.js';

const STATUS_MS = 8000;
const PAGE_STEP = 8;

/** Aranan metni kalın gösterir. Küçük harfe çevirmek uzunluğu değiştirirse (nadir Unicode durumları) vurgusuz döner. */
function Highlight({ text, needle }) {
  if (!needle) return text;
  const lower = trLower(text);
  const at = lower.length === text.length ? lower.indexOf(needle) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-primary/15 px-px font-bold text-foreground">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

const AppRow = memo(function AppRow({ app, on, folderNames, needle, onToggle }) {
  const name = appName(app);
  return (
    <li>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={name}
        data-manage-row=""
        title={[app.package, folderNames && `Klasörde: ${folderNames.join(', ')}`].filter(Boolean).join(' · ')}
        onClick={() => onToggle(app)}
        className="group flex w-full scroll-mt-8 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors [contain-intrinsic-size:auto_52px] [content-visibility:auto] hover:bg-accent/50 active:bg-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <AppIcon pkg={app.package} displayName={name} size={36} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold leading-4"><Highlight text={name} needle={needle} /></span>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-[10px] leading-4 text-muted-foreground">{app.package}</span>
            {folderNames && (
              <span className="inline-flex max-w-[45%] shrink-0 items-center gap-0.5 rounded-sm bg-muted px-1 text-[9px] leading-4 text-muted-foreground">
                <Folder className="size-2.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{folderNames.join(', ')}</span>
              </span>
            )}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          <span className={cn('text-[10px] font-semibold max-[480px]:hidden', on ? 'text-primary' : 'text-muted-foreground')}>
            {on ? 'Masaüstünde' : 'Eklenmedi'}
          </span>
          <SwitchThumb checked={on} />
        </span>
      </button>
    </li>
  );
});

function EmptyState({ icon: Icon, title, hint, action }) {
  return (
    <div className="grid h-full min-h-48 place-items-center px-6 py-8 text-center">
      <div className="max-w-xs">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
          <Icon className="size-6" strokeWidth={1.6} aria-hidden="true" />
        </span>
        <p className="mt-3 text-sm font-semibold">{title}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

function ManageIconsBody({ onClose, apps, layout, custom, cells, getDefaultLayout, onLayoutChange }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [status, setStatus] = useState(null); // { text, tone: 'info' | 'warn', undo?: düzen }
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const headingId = useId();

  // Olay işleyicileri her çizimde değişmesin diye güncel değerler ref'te: AppRow memo kalır, 300 satır boşuna çizilmez.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const queryRef = useRef(query);
  queryRef.current = query;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const onSet = useMemo(() => packagesOnDesktop(layout), [layout]);
  const stats = useMemo(() => desktopStats(apps, layout, cells), [apps, layout, cells]);
  const counts = useMemo(() => filterCounts(apps, onSet), [apps, onSet]);
  const folders = useMemo(() => folderMembership(custom), [custom]);
  const needle = trLower(query).trim();
  const sections = useMemo(() => buildSections(apps, { query, filter, onSet }), [apps, query, filter, onSet]);
  const visible = useMemo(() => flatten(sections), [sections]);
  const addable = useMemo(() => visible.filter((app) => !onSet.has(app.package)), [visible, onSet]);
  const removable = useMemo(() => visible.filter((app) => onSet.has(app.package)), [visible, onSet]);

  // Esc: önce arama temizlenir, ikinci Esc kapatır (Dialog'un kendi Esc'i kapalı — ikisi çakışmasın).
  useEffect(
    () =>
      pushEscapeHandler(() => {
        if (queryRef.current) {
          setQuery('');
          searchRef.current?.focus();
        } else {
          closeRef.current();
        }
      }),
    [],
  );

  // Açılışta arama odakta (dokunmatik cihazda ekran klavyesi açılmasın diye atlanır).
  useEffect(() => {
    if (window.matchMedia?.('(pointer: coarse)')?.matches) return undefined;
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Durum satırı kendiliğinden kapanır; "Geri al" fırsatı bu sürede.
  useEffect(() => {
    if (!status) return undefined;
    const timer = setTimeout(() => setStatus(null), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const commit = useCallback(
    (next, text, tone = 'info') => {
      setStatus({ text, tone, undo: layoutRef.current });
      onLayoutChange(next);
    },
    [onLayoutChange],
  );

  const toggle = useCallback(
    (app) => {
      const current = layoutRef.current;
      const name = appName(app);
      if (packagesOnDesktop(current).has(app.package)) {
        commit(removeApps(current, [app.package]).layout, `«${name}» masaüstünden kaldırıldı.`);
        return;
      }
      const { layout: next, placed } = placeApps(current, [app.package], cells);
      if (!placed) {
        setStatus({ text: 'Masaüstü dolu — önce bir simgeyi kaldırın.', tone: 'warn' });
        return;
      }
      commit(next, `«${name}» masaüstüne eklendi.`);
    },
    [cells, commit],
  );

  const addAll = () => {
    const { layout: next, placed, skipped } = placeApps(layoutRef.current, addable.map((app) => app.package), cells);
    if (!placed) {
      setStatus({ text: 'Masaüstü dolu — önce bir simgeyi kaldırın.', tone: 'warn' });
      return;
    }
    commit(
      next,
      skipped ? `${countLabel(placed)} eklendi · ${countLabel(skipped)} için yer kalmadı.` : `${countLabel(placed)} masaüstüne eklendi.`,
      skipped ? 'warn' : 'info',
    );
  };

  const removeAll = () => {
    const { layout: next, removed } = removeApps(layoutRef.current, removable.map((app) => app.package));
    if (removed) commit(next, `${countLabel(removed)} masaüstünden kaldırıldı.`);
  };

  const resetDefaults = () => {
    commit(withCustomKept(getDefaultLayout(), layoutRef.current, cells), 'Önerilen düzen uygulandı.');
  };

  const undo = () => {
    if (!status?.undo) return;
    onLayoutChange(status.undo);
    setStatus({ text: 'Değişiklik geri alındı.', tone: 'info' });
  };

  const rows = () => [...(listRef.current?.querySelectorAll('[data-manage-row]') ?? [])];

  const onListKeyDown = (event) => {
    const { key } = event;
    if (key.length === 1 && key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      searchRef.current?.focus(); // yazmaya başlamak aramaya geçirir; karakter yeni odağa yazılır
      return;
    }
    const all = rows();
    const at = all.indexOf(document.activeElement);
    if (at < 0) return;
    let to = null;
    if (key === 'ArrowDown') to = Math.min(all.length - 1, at + 1);
    else if (key === 'ArrowUp') to = at - 1;
    else if (key === 'PageDown') to = Math.min(all.length - 1, at + PAGE_STEP);
    else if (key === 'PageUp') to = Math.max(0, at - PAGE_STEP);
    else if (key === 'Home') to = 0;
    else if (key === 'End') to = all.length - 1;
    else return;
    event.preventDefault();
    if (to < 0) searchRef.current?.focus();
    else all[to]?.focus();
  };

  const filtered = Boolean(query.trim()) || filter !== 'all';
  const fullness = cells > 0 ? Math.min(100, (stats.used / cells) * 100) : 0;
  const nearlyFull = stats.used / cells >= 0.9;

  let empty = null;
  if (apps.length === 0) {
    empty = <EmptyState icon={PackageOpen} title="Uygulama listesi boş" hint="Telefon bağlıyken uygulamalar burada listelenir." />;
  } else if (visible.length === 0 && query.trim()) {
    empty = (
      <EmptyState
        icon={SearchX}
        title={`«${query.trim()}» ile eşleşen uygulama yok`}
        hint="Ad veya paket adının bir bölümünü yazmayı deneyin."
        action={<Button size="sm" variant="outline" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>Aramayı temizle</Button>}
      />
    );
  } else if (visible.length === 0 && filter === 'off') {
    empty = (
      <EmptyState
        icon={CheckCheck}
        title="Tüm uygulamalar masaüstünde"
        hint="Kaldırdığınız uygulamalar burada listelenir."
        action={<Button size="sm" variant="outline" onClick={() => setFilter('all')}>Tümünü göster</Button>}
      />
    );
  } else if (visible.length === 0) {
    empty = (
      <EmptyState
        icon={PackageOpen}
        title="Masaüstünde uygulama yok"
        hint="Eklemek için «Eklenmemiş» sekmesine bakın."
        action={<Button size="sm" variant="outline" onClick={() => setFilter('off')}>Eklenmemişleri göster</Button>}
      />
    );
  }

  return (
    <>
      <header className="flex items-start gap-3 px-5 pb-3 pt-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/30">
          <SlidersHorizontal className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-sm font-semibold leading-5">Simgeleri yönet</h2>
          <p className="text-[11px] leading-4 text-muted-foreground [@media(max-height:560px)]:hidden">
            Hangi uygulamaların masaüstünde görüneceğini seçin. Kaldırdıklarınıza Uygulama Çekmecesi'nden ulaşırsınız.
          </p>
        </div>
        <IconButton label="Kapat" size="sm" onClick={onClose}><X /></IconButton>
      </header>

      <div className="px-5">
        <div className="flex items-baseline justify-between gap-3 text-[11px]">
          <span><b className="font-semibold tabular-nums">{stats.onDesktop}</b> uygulama masaüstünde</span>
          <span className={cn('tabular-nums', nearlyFull ? 'text-warning' : 'text-muted-foreground')}>
            {stats.used} / {cells} yer dolu
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Masaüstü doluluğu"
          aria-valuemin={0}
          aria-valuemax={cells}
          aria-valuenow={stats.used}
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
        >
          <div className={cn('h-full rounded-full transition-[width] duration-300', nearlyFull ? 'bg-warning' : 'bg-primary')} style={{ width: `${fullness}%` }} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-5 pb-2.5 pt-3">
        <div className="relative min-w-44 flex-1" role="search">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Uygulama ara"
            aria-label="Uygulama ara"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                rows()[0]?.focus();
              }
            }}
            className="h-8 w-full rounded-md border border-border/70 bg-background pl-8 pr-8 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <span className="absolute right-1 top-1/2 -translate-y-1/2">
              <IconButton label="Aramayı temizle" size="xs" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><X /></IconButton>
            </span>
          )}
        </div>
        <SegmentedControl
          label="Gösterilecek uygulamalar"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `Tümü ${counts.all}` },
            { value: 'on', label: `Masaüstünde ${counts.on}` },
            { value: 'off', label: `Eklenmemiş ${counts.off}` },
          ]}
        />
      </div>

      <div className="flex items-center justify-between gap-2 border-y border-border/60 bg-muted/30 px-5 py-1">
        <span className="text-[11px] text-muted-foreground">
          {countLabel(visible.length, filtered ? 'sonuç' : 'uygulama')}
        </span>
        <span className="flex items-center gap-0.5">
          <Button size="2xs" variant="ghost" disabled={addable.length === 0} onClick={addAll} startIcon={<Plus className="size-3" />}>
            {filtered ? 'Görünenleri ekle' : 'Tümünü ekle'} ({addable.length})
          </Button>
          <Button size="2xs" variant="ghost" disabled={removable.length === 0} onClick={removeAll} startIcon={<Minus className="size-3" />}>
            {filtered ? 'Görünenleri kaldır' : 'Tümünü kaldır'} ({removable.length})
          </Button>
        </span>
      </div>

      <div ref={listRef} onKeyDown={onListKeyDown} className="dex-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
        {empty ??
          sections.map((section) => (
            <section key={section.key} aria-label={section.label}>
              <h3 className="sticky top-0 z-10 bg-popover/95 px-5 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground backdrop-blur">
                {section.label}
              </h3>
              <ul className="px-2">
                {section.apps.map((app) => (
                  <AppRow key={app.package} app={app} on={onSet.has(app.package)} folderNames={folders.get(app.package)} needle={needle} onToggle={toggle} />
                ))}
              </ul>
            </section>
          ))}
      </div>

      <footer className="border-t border-border/70 px-5 pb-3 pt-2">
        <div className="flex min-h-6 items-center gap-2 text-[11px]" role="status" aria-live="polite">
          {status && (
            <>
              <span className={cn('min-w-0 truncate', status.tone === 'warn' ? 'text-warning' : 'text-muted-foreground')}>{status.text}</span>
              {status.undo && (
                <Button size="2xs" variant="ghost" onClick={undo} startIcon={<Undo2 className="size-3" />}>Geri al</Button>
              )}
            </>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={resetDefaults} startIcon={<RotateCcw className="size-3.5" />}>Önerilen düzen</Button>
          <Button size="sm" onClick={onClose}>Bitti</Button>
        </div>
      </footer>
    </>
  );
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {{ package: string, display_name?: string, isBuiltin?: boolean }[]} props.apps
 * @param {Record<number, string>} props.layout     hücre → paket | 'custom-…'
 * @param {{ id: string, name: string, appIds?: string[] }[]} props.custom  masaüstü klasörleri
 * @param {number} props.cells                       masaüstü hücre sayısı (119)
 * @param {() => Record<number, string>} props.getDefaultLayout  "Önerilen düzen" için varsayılan yerleşim
 * @param {(next: Record<number, string>) => void} props.onLayoutChange  yeni düzeni kaydeder (Desktop.persistLayout)
 */
export default function ManageIconsDialog({ open, onClose, ...body }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      closeOnEscape={false}
      label="Simgeleri yönet"
      className="flex h-[min(86vh,680px)] max-w-xl flex-col overflow-hidden"
    >
      {/* Gövde yalnız açıkken kurulur: arama/süzgeç/durum her açılışta temiz başlar; çıkış animasyonunda eski gövde kalır. */}
      {open && <ManageIconsBody onClose={onClose} {...body} />}
    </Dialog>
  );
}
