// Pencere araç çubuğu (etkin bölme üzerinde çalışır) + bölme başlığı (gezinme düğmeleri + adres çubuğu).
//   geniş/orta : [kenar çubuğu] [yeni klasör] ····· [arama] [sırala] [görünüm] [çift bölme] [⋮]
//   dar (telefon): [yerler] [arama simgesi → tam genişlik] [sırala] [⋮ (görünüm, yeni klasör, gizli, …)]
import React from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpDown, Columns2, Copy, Ellipsis, Eye, EyeOff, FolderPlus, LayoutGrid, List, ListChecks,
  PanelLeft, PanelLeftClose, RefreshCw, Scissors, Trash2, X,
} from 'lucide-react';
import { IconButton } from '../ui/IconButton.jsx';
import { MenuItem, MenuLabel, MenuSeparator } from '../ui/Menu.jsx';
import Breadcrumbs from './Breadcrumbs.jsx';
import DropdownMenu from './DropdownMenu.jsx';
import SearchField from './SearchField.jsx';
import { buildMenu, tidy } from './contextMenu.js';
import { copySelection, createFolder, cutSelection, deleteSelected } from './filesCommands.js';
import { countLabel } from './formatters.js';
import { runMenuAction } from './menuActions.js';
import { effectiveView, keyOf, useFilesStore, ZOOMS } from './filesStore.js';
import { SORT_KEYS, SORT_LABELS } from './sortEntries.js';

const ZOOM_LABEL = { S: 'Küçük simgeler', M: 'Orta simgeler', L: 'Büyük simgeler' };

/** Bölmenin gezinme düğmeleri + adres çubuğu. */
export function PaneHeader({ winId, pi, layoutMode }) {
  const pane = useFilesStore((s) => s.wins[winId]?.panes[pi]);
  const store = useFilesStore;
  const canBack = pane.hi > 0;
  const canForward = pane.hi < pane.history.length - 1;
  return (
    <div className="flex items-center gap-1 px-2 py-1.5" data-pane-header={pane.id}>
      {layoutMode !== 'compact' && (
        <>
          <IconButton label="Geri (Alt+←)" size="md" disabled={!canBack} onClick={() => store.getState().goBack(winId, pi)}><ArrowLeft /></IconButton>
          <IconButton label="İleri (Alt+→)" size="md" disabled={!canForward} onClick={() => store.getState().goForward(winId, pi)}><ArrowRight /></IconButton>
        </>
      )}
      <IconButton label="Üst klasör (Alt+↑)" size="md" onClick={() => store.getState().goUp(winId, pi)}><ArrowUp /></IconButton>
      <Breadcrumbs winId={winId} pi={pi} layoutMode={layoutMode} />
      <IconButton label="Yenile (F5)" size="md" onClick={() => store.getState().reload(winId, pi)}><RefreshCw className={pane.status === 'refreshing' || pane.status === 'loading' ? 'animate-spin motion-reduce:animate-none' : undefined} /></IconButton>
    </div>
  );
}

function SortItems({ winId, pi, close }) {
  const pane = useFilesStore((s) => s.wins[winId]?.panes[pi]);
  const store = useFilesStore;
  return (
    <>
      <MenuLabel>Sırala</MenuLabel>
      {SORT_KEYS.map((key) => (
        <MenuItem
          key={key}
          label={SORT_LABELS[key]}
          // Etkin anahtar: kalın ad + YÖN oku (tik değil — tik "klasörler önce" gibi aç/kapa ayarlara aittir).
          className={pane.sort.key === key ? 'font-semibold' : undefined}
          aria-current={pane.sort.key === key ? 'true' : undefined}
          right={pane.sort.key === key ? (pane.sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : null}
          onClick={() => { store.getState().setSort(winId, pi, key); close?.(); }}
        />
      ))}
      <MenuSeparator />
      <MenuItem label="Klasörler önce" active={pane.sort.foldersFirst} onClick={() => store.getState().setSortDirect(winId, pi, { foldersFirst: !pane.sort.foldersFirst })} />
    </>
  );
}

function ViewItems({ winId, pi, close }) {
  const pane = useFilesStore((s) => s.wins[winId]?.panes[pi]);
  const store = useFilesStore;
  const view = effectiveView(pane);
  const pick = (fn) => () => { fn(); close?.(); };
  return (
    <>
      <MenuLabel>Görünüm</MenuLabel>
      <MenuItem icon={<List className="size-3.5" />} label="Liste" active={pane.view === 'list'} onClick={pick(() => store.getState().setView(winId, pi, 'list'))} />
      {ZOOMS.map((z) => (
        <MenuItem
          key={z}
          icon={<LayoutGrid className="size-3.5" />}
          label={ZOOM_LABEL[z]}
          active={pane.view === 'grid' && pane.zoom === z}
          onClick={pick(() => { store.getState().setZoom(winId, pi, z); store.getState().setView(winId, pi, 'grid'); })}
        />
      ))}
      <MenuItem label={`Otomatik (medya klasörleri ızgara)${pane.view === 'auto' ? ` · şu an ${view === 'grid' ? 'ızgara' : 'liste'}` : ''}`} active={pane.view === 'auto'} onClick={pick(() => store.getState().setView(winId, pi, 'auto'))} />
    </>
  );
}

/**
 * Telefon düzeninde (sağ tık/Ctrl yok) seçim kipi çubuğu: seçilince araç çubuğunun yerini alır — seçim sayısı + sık işlemler +
 * "⋮" ile tam bağlam menüsü (sağ tık menüsüyle AYNI model).
 */
function SelectionBar({ winId, pi }) {
  const pane = useFilesStore((s) => s.wins[winId]?.panes[pi]);
  const clipboard = useFilesStore((s) => s.clipboard);
  const phoneConnected = useFilesStore((s) => s.places.phone.length > 0);
  const store = useFilesStore;
  const entries = pane.visible.filter((e) => pane.selection.ids.has(keyOf(e)));
  const menu = tidy(buildMenu({ targets: entries, provider: pane.loc?.provider, hasClipboard: Boolean(clipboard), dual: false, phoneConnected, showHidden: pane.showHidden }));
  return (
    <div role="toolbar" aria-label="Seçim işlemleri" className="relative z-30 flex items-center gap-1 border-b border-border/70 bg-accent/40 px-2 py-1.5">
      <IconButton label="Seçimi kapat" size="md" onClick={() => store.getState().clearSelection(winId, pi)}><X /></IconButton>
      <span className="min-w-0 flex-1 truncate text-xs font-semibold" aria-live="polite">{countLabel(entries.length)} seçili</span>
      <IconButton label="Tümünü seç" size="md" onClick={() => store.getState().selectAll(winId, pi)}><ListChecks /></IconButton>
      <IconButton label="Kopyala" size="md" onClick={() => copySelection(winId, pi)}><Copy /></IconButton>
      <IconButton label="Kes" size="md" onClick={() => cutSelection(winId, pi)}><Scissors /></IconButton>
      <IconButton label="Sil" size="md" danger="destructive" onClick={() => deleteSelected(winId, pi)}><Trash2 /></IconButton>
      <DropdownMenu label="Diğer seçim işlemleri" align="end" trigger={(t) => <IconButton label="Diğer seçim işlemleri" size="md" {...t}><Ellipsis /></IconButton>}>
        {({ close }) => menu.map((entry, i) => (entry.type === 'separator'
          ? <MenuSeparator key={`s${i}`} />
          : <MenuItem key={entry.id} icon={entry.icon && <entry.icon className="size-3.5" />} label={entry.label} destructive={entry.destructive} disabled={entry.disabled}
              onClick={() => { close(); runMenuAction(entry.id, { winId, pi, entries }); }} />))}
      </DropdownMenu>
    </div>
  );
}

export default function FilesToolbar({ winId, layoutMode, onOpenPlaces }) {
  const pi = useFilesStore((s) => s.wins[winId]?.activePane ?? 0);
  const pane = useFilesStore((s) => s.wins[winId]?.panes[pi]);
  const layout = useFilesStore((s) => s.wins[winId]?.layout);
  const sidebarOpen = useFilesStore((s) => s.wins[winId]?.sidebarOpen);
  const store = useFilesStore;
  const compact = layoutMode === 'compact';
  const wide = layoutMode === 'wide';
  const view = effectiveView(pane);
  const selecting = compact && pane.selection.ids.size > 0;

  if (selecting) return <SelectionBar winId={winId} pi={pi} />;

  return (
    <div role="toolbar" aria-label="Dosya araçları" className="relative z-30 flex items-center gap-1 border-b border-border/70 px-2 py-1.5">
      {compact ? (
        <IconButton label="Yerler" size="md" onClick={onOpenPlaces}><PanelLeft /></IconButton>
      ) : (
        <IconButton label={sidebarOpen ? 'Kenar çubuğunu gizle' : 'Kenar çubuğunu göster'} size="md" active={sidebarOpen} onClick={() => store.getState().toggleSidebar(winId)}>
          {sidebarOpen ? <PanelLeftClose /> : <PanelLeft />}
        </IconButton>
      )}
      {!compact && <IconButton label="Yeni klasör (Ctrl+Shift+N)" size="md" onClick={() => createFolder(winId, pi)}><FolderPlus /></IconButton>}
      <div className="min-w-0 flex-1" />
      <SearchField winId={winId} compact={compact} />
      <DropdownMenu
        label="Sırala"
        align="end"
        trigger={(t) => <IconButton label="Sırala" size="md" {...t}><ArrowUpDown /></IconButton>}
      >
        {({ close }) => <SortItems winId={winId} pi={pi} close={close} />}
      </DropdownMenu>
      {!compact && (
        <DropdownMenu
          label="Görünüm"
          align="end"
          trigger={(t) => <IconButton label="Görünüm" size="md" {...t}>{view === 'grid' ? <LayoutGrid /> : <List />}</IconButton>}
        >
          {({ close }) => <ViewItems winId={winId} pi={pi} close={close} />}
        </DropdownMenu>
      )}
      {wide && (
        <IconButton
          label={layout === 'dual' ? 'Tek bölmeye dön' : 'İki bölme'}
          size="md"
          active={layout === 'dual'}
          onClick={() => store.getState().setLayout(winId, layout === 'dual' ? 'single' : 'dual')}
        >
          <Columns2 />
        </IconButton>
      )}
      <DropdownMenu
        label="Diğer işlemler"
        align="end"
        trigger={(t) => <IconButton label="Diğer işlemler" size="md" {...t}><Ellipsis /></IconButton>}
      >
        {({ close }) => (
          <>
            {compact && (
              <>
                <MenuItem icon={<FolderPlus className="size-3.5" />} label="Yeni klasör" onClick={() => { close(); createFolder(winId, pi); }} />
                <MenuSeparator />
                <ViewItems winId={winId} pi={pi} close={close} />
                <MenuSeparator />
              </>
            )}
            <MenuItem
              icon={pane.showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              label={pane.showHidden ? 'Gizli dosyaları gizle' : 'Gizli dosyaları göster'}
              hint="Ctrl+H"
              onClick={() => { close(); store.getState().toggleHidden(winId, pi); }}
            />
            <MenuItem icon={<ListChecks className="size-3.5" />} label="Tümünü seç" hint="Ctrl+A" onClick={() => { close(); store.getState().selectAll(winId, pi); }} />
            <MenuItem label="Seçimi ters çevir" onClick={() => { close(); store.getState().invertSelection(winId, pi); }} />
            <MenuSeparator />
            <MenuItem icon={<Trash2 className="size-3.5" />} label="Telefonun geri dönüşüm kutusu" onClick={() => { close(); store.getState().openDialog(winId, { type: 'trash' }); }} />
            <MenuItem label="Klavye kısayolları" onClick={() => { close(); store.getState().openDialog(winId, { type: 'shortcuts' }); }} />
          </>
        )}
      </DropdownMenu>
    </div>
  );
}
