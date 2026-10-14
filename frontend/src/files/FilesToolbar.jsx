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
import { t as tt } from '../i18n/index.js';

const ZOOM_LABEL = { S: tt('files.kucuk_simgeler'), M: tt('files.orta_simgeler'), L: tt('files.buyuk_simgeler') };

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
          <IconButton label={tt('files.geri_alt')} size="md" disabled={!canBack} onClick={() => store.getState().goBack(winId, pi)}><ArrowLeft /></IconButton>
          <IconButton label={tt('files.ileri_alt')} size="md" disabled={!canForward} onClick={() => store.getState().goForward(winId, pi)}><ArrowRight /></IconButton>
        </>
      )}
      <IconButton label={tt('files.ust_klasor_alt')} size="md" onClick={() => store.getState().goUp(winId, pi, { select: layoutMode !== 'compact' })}><ArrowUp /></IconButton>
      <Breadcrumbs winId={winId} pi={pi} layoutMode={layoutMode} />
      <IconButton label={tt('files.yenile_f5')} size="md" onClick={() => store.getState().reload(winId, pi)}><RefreshCw className={pane.status === 'refreshing' || pane.status === 'loading' ? 'animate-spin motion-reduce:animate-none' : undefined} /></IconButton>
    </div>
  );
}

function SortItems({ winId, pi, close }) {
  const pane = useFilesStore((s) => s.wins[winId]?.panes[pi]);
  const store = useFilesStore;
  return (
    <>
      <MenuLabel>{tt('files.sirala')}</MenuLabel>
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
      <MenuItem label={tt('files.klasorler_once')} active={pane.sort.foldersFirst} onClick={() => store.getState().setSortDirect(winId, pi, { foldersFirst: !pane.sort.foldersFirst })} />
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
      <MenuLabel>{tt('common.gorunum')}</MenuLabel>
      <MenuItem icon={<List className="size-3.5" />} label={tt('files.liste')} active={pane.view === 'list'} onClick={pick(() => store.getState().setView(winId, pi, 'list'))} />
      {ZOOMS.map((z) => (
        <MenuItem
          key={z}
          icon={<LayoutGrid className="size-3.5" />}
          label={ZOOM_LABEL[z]}
          active={pane.view === 'grid' && pane.zoom === z}
          onClick={pick(() => { store.getState().setZoom(winId, pi, z); store.getState().setView(winId, pi, 'grid'); })}
        />
      ))}
      <MenuItem label={tt('files.otomatik_medya_klasorleri_izgara_value', { value: pane.view === 'auto' ? tt('files.su_an_value', { value: view === 'grid' ? tt('files.izgara') : 'liste' }) : '' })} active={pane.view === 'auto'} onClick={pick(() => store.getState().setView(winId, pi, 'auto'))} />
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
    <div role="toolbar" aria-label={tt('files.secim_islemleri')} className="relative z-30 flex items-center gap-1 border-b border-border/70 bg-accent/40 px-2 py-1.5">
      <IconButton label={tt('files.secimi_kapat')} size="md" onClick={() => store.getState().clearSelection(winId, pi)}><X /></IconButton>
      <span className="min-w-0 flex-1 truncate text-xs font-semibold" aria-live="polite">{tt('files.countlabel_secili', { countLabel: countLabel(entries.length) })}</span>
      <IconButton label={tt('files.tumunu_sec')} size="md" onClick={() => store.getState().selectAll(winId, pi)}><ListChecks /></IconButton>
      <IconButton label={tt('files.kopyala')} size="md" onClick={() => copySelection(winId, pi)}><Copy /></IconButton>
      <IconButton label={tt('files.kes')} size="md" onClick={() => cutSelection(winId, pi)}><Scissors /></IconButton>
      <IconButton label={tt('common.sil')} size="md" danger="destructive" onClick={() => deleteSelected(winId, pi)}><Trash2 /></IconButton>
      <DropdownMenu label={tt('files.diger_secim_islemleri')} align="end" trigger={(t) => <IconButton label={tt('files.diger_secim_islemleri')} size="md" {...t}><Ellipsis /></IconButton>}>
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
    <div role="toolbar" aria-label={tt('files.dosya_araclari')} className="relative z-30 flex items-center gap-1 border-b border-border/70 px-2 py-1.5">
      {compact ? (
        <IconButton label={tt('files.yerler')} size="md" onClick={onOpenPlaces}><PanelLeft /></IconButton>
      ) : (
        <IconButton label={sidebarOpen ? tt('files.kenar_cubugunu_gizle') : tt('files.kenar_cubugunu_goster')} size="md" active={sidebarOpen} onClick={() => store.getState().toggleSidebar(winId)}>
          {sidebarOpen ? <PanelLeftClose /> : <PanelLeft />}
        </IconButton>
      )}
      {!compact && <IconButton label={tt('files.yeni_klasor_ctrl_shift_n')} size="md" onClick={() => createFolder(winId, pi)}><FolderPlus /></IconButton>}
      <div className="min-w-0 flex-1" />
      <SearchField winId={winId} compact={compact} />
      <DropdownMenu
        label={tt('files.sirala')}
        align="end"
        trigger={(t) => <IconButton label={tt('files.sirala')} size="md" {...t}><ArrowUpDown /></IconButton>}
      >
        {({ close }) => <SortItems winId={winId} pi={pi} close={close} />}
      </DropdownMenu>
      {!compact && (
        <DropdownMenu
          label={tt('common.gorunum')}
          align="end"
          trigger={(t) => <IconButton label={tt('common.gorunum')} size="md" {...t}>{view === 'grid' ? <LayoutGrid /> : <List />}</IconButton>}
        >
          {({ close }) => <ViewItems winId={winId} pi={pi} close={close} />}
        </DropdownMenu>
      )}
      {wide && (
        <IconButton
          label={layout === 'dual' ? tt('files.tek_bolmeye_don') : tt('files.iki_bolme')}
          size="md"
          active={layout === 'dual'}
          onClick={() => store.getState().setLayout(winId, layout === 'dual' ? 'single' : 'dual')}
        >
          <Columns2 />
        </IconButton>
      )}
      <DropdownMenu
        label={tt('files.diger_islemler')}
        align="end"
        trigger={(t) => <IconButton label={tt('files.diger_islemler')} size="md" {...t}><Ellipsis /></IconButton>}
      >
        {({ close }) => (
          <>
            {compact && (
              <>
                <MenuItem icon={<FolderPlus className="size-3.5" />} label={tt('files.yeni_klasor')} onClick={() => { close(); createFolder(winId, pi); }} />
                <MenuSeparator />
                <ViewItems winId={winId} pi={pi} close={close} />
                <MenuSeparator />
              </>
            )}
            <MenuItem
              icon={pane.showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              label={pane.showHidden ? tt('files.gizli_dosyalari_gizle') : tt('files.gizli_dosyalari_goster')}
              hint="Ctrl+H"
              onClick={() => { close(); store.getState().toggleHidden(winId, pi); }}
            />
            <MenuItem icon={<ListChecks className="size-3.5" />} label={tt('files.tumunu_sec')} hint="Ctrl+A" onClick={() => { close(); store.getState().selectAll(winId, pi); }} />
            <MenuItem label={tt('files.secimi_ters_cevir')} onClick={() => { close(); store.getState().invertSelection(winId, pi); }} />
            <MenuSeparator />
            <MenuItem icon={<Trash2 className="size-3.5" />} label={tt('files.telefonun_geri_donusum_kutusu')} onClick={() => { close(); store.getState().openDialog(winId, { type: 'trash' }); }} />
            <MenuItem label={tt('files.klavye_kisayollari')} onClick={() => { close(); store.getState().openDialog(winId, { type: 'shortcuts' }); }} />
          </>
        )}
      </DropdownMenu>
    </div>
  );
}
