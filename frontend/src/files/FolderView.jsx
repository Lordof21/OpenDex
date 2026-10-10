// Bir bölmenin klasör görünümü — dosya yöneticisinin kalbi. Sanallaştırılmış liste/ızgara, tek olay temsilcisi, lastik bant,
// pencere içi sürükle-bırak, klavye, bağlam menüsü, boş/yükleniyor/hata durumları.
//
// Performans sözleşmesi:
//   * DOM'da yalnızca görünen satırlar + 4 satır pay (≈40 düğüm) — 50 000 girdide de.
//   * Kaydırma, GÖRÜNÜR ARALIK değişmedikçe React'e hiç girmez (`onScroll` yalnız sınır aşılınca state yazar).
//   * Satırlar `memo`; satır başına işleyici YOK — tüm işaretçi/klavye olayları bu bileşendeki tek temsilciden geçer.
//   * Her işleyici durumu `useFilesStore.getState()` ile TAZE okur: işleyiciler kararlı, satır özellikleri kararlıdır.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/utils.js';
import ColumnHeader, { HEADER_HEIGHT } from './ColumnHeader.jsx';
import FileContextMenu from './FileContextMenu.jsx';
import { FileRow, ROW_HEIGHT } from './FileRow.jsx';
import { FileTile, ZOOM_SPEC } from './FileTile.jsx';
import { EmptyState, ErrorState, SkeletonRows } from './FolderStates.jsx';
import { buildMenu, tidy } from './contextMenu.js';
import { armDrag, justDragged, registerDropTarget } from './dragManager.js';
import { acceptsDrop } from './dragRules.js';
import {
  copySelection, createFolder, commitRename, cutSelection, deleteSelected, dropOnFolder, entryLoc, openEntry, paneFolder, paste,
  showProperties, transferToOtherPane,
} from './filesCommands.js';
import { effectiveView, keyOf, recalledScroll, rememberScroll, useFilesStore } from './filesStore.js';
import { countLabel } from './formatters.js';
import { resolveKey } from './keymap.js';
import { FOCUS_PATH_EVENT, FOCUS_SEARCH_EVENT, emitFocus, runMenuAction } from './menuActions.js';
import { baseName, locKey } from './paths.js';
import { previewKind } from './fileTypes.js';
import { columnsFor, useContainerSize } from './useContainerSize.js';
import { useMarquee } from './useMarquee.js';
import { typeAheadIndex } from './sortEntries.js';
import {
  contentHeight, gridGeometry, indexAtPoint, keyboardTarget, listGeometry, rectOf, scrollTopToReveal, visibleRange,
} from './virtual.js';

const OVERSCAN = 4;
const TYPE_AHEAD_MS = 900;
const LONG_PRESS_MS = 450;
const TAP_SLOP_PX = 10;


function useCoarsePointer() {
  const [coarse, setCoarse] = useState(() => (typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : false));
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const query = matchMedia('(pointer: coarse)');
    const on = (e) => setCoarse(e.matches);
    query.addEventListener?.('change', on);
    return () => query.removeEventListener?.('change', on);
  }, []);
  return coarse;
}

export default function FolderView({ winId, pi, layoutMode, active, dual = false }) {
  const pane = useFilesStore((s) => s.wins[winId]?.panes[pi]);
  const clipboard = useFilesStore((s) => s.clipboard);
  const phoneConnected = useFilesStore((s) => s.places.phone.length > 0);
  const store = useFilesStore;
  const coarse = useCoarsePointer();

  const [scrollRef, size] = useContainerSize({ client: true });
  const sectionRef = useRef(null);
  const [hasFocus, setHasFocus] = useState(false);
  const [menu, setMenu] = useState(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [announce, setAnnounce] = useState('');

  const compact = layoutMode === 'compact';
  const touchy = compact || coarse;
  const paneKey = pane.id;
  const folder = useMemo(() => paneFolder(pane), [pane.loc, pane.canonical]); // eslint-disable-line react-hooks/exhaustive-deps
  const folderId = locKey(folder);
  const now = useMemo(() => Date.now(), [pane.loadedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Görünüm / geometri ─────────────────────────────────────────────────────────────────────────────────
  const autoView = useRef('list');
  const settled = pane.status === 'ready' || pane.status === 'refreshing';
  const decided = useMemo(() => (pane.view === 'auto' ? (settled ? effectiveView(pane) : null) : pane.view), [pane.view, pane.entries, settled]); // eslint-disable-line react-hooks/exhaustive-deps
  if (decided) autoView.current = decided;
  const view = decided || autoView.current;
  const grid = view === 'grid';
  const showHeader = !grid && !compact;
  const headerH = showHeader ? HEADER_HEIGHT : 0;
  const rowH = compact ? ROW_HEIGHT.compact : touchy ? ROW_HEIGHT.touch : ROW_HEIGHT.comfortable;
  const spec = ZOOM_SPEC[pane.zoom] || ZOOM_SPEC.M;
  const count = pane.visible.length;
  const g = useMemo(
    () => (grid ? gridGeometry({ count, width: size.width, minCell: spec.minCell, cellH: spec.cellH }) : listGeometry({ count, rowH })),
    [grid, count, size.width, spec.minCell, spec.cellH, rowH],
  );
  const geometryRef = useRef(g);
  geometryRef.current = g;
  const headerRef = useRef(headerH);
  headerRef.current = headerH;
  const viewportH = Math.max(0, size.height - headerH);
  const range = visibleRange(g, scrollTop, viewportH, OVERSCAN);
  const rangeRef = useRef(range);
  rangeRef.current = range;

  // Geometri/boyut değişince (yeniden boyutlandırma, görünüm değişimi) kaydırma durumunu gerçek değerle eşle.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, [g, viewportH, scrollRef]);

  const onScroll = useCallback((e) => {
    const top = e.currentTarget.scrollTop;
    rememberScroll(`${paneKey}|${folderId}`, top);
    const next = visibleRange(geometryRef.current, top, Math.max(0, e.currentTarget.clientHeight - headerRef.current), OVERSCAN);
    const cur = rangeRef.current;
    if (next.start !== cur.start || next.end !== cur.end) setScrollTop(top);
  }, [paneKey, folderId]);

  // Klasör değişince kaydırma konumunu hatırla/geri yükle; liste hazır olunca (içerik yüksekliği oluştuktan sonra) bir kez.
  const restoredFor = useRef('');
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !settled || restoredFor.current === folderId) return;
    restoredFor.current = folderId;
    el.scrollTop = recalledScroll(`${paneKey}|${folderId}`);
    setScrollTop(el.scrollTop);
  }, [settled, folderId, paneKey, scrollRef]);

  // Yükleme bitince odaktaki girdi (üst klasöre dönüş, yeni klasör) görünür olsun.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const at = pane.selection.focus != null ? pane.indexMap.get(pane.selection.focus) : undefined;
    if (!el || at === undefined || !settled) return;
    const top = scrollTopToReveal(geometryRef.current, at, el.scrollTop, el.clientHeight - headerRef.current);
    if (top !== el.scrollTop) {
      el.scrollTop = top;
      setScrollTop(top);
    }
  }, [pane.loadedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const reveal = useCallback((index) => {
    const el = scrollRef.current;
    if (!el) return;
    const top = scrollTopToReveal(geometryRef.current, index, el.scrollTop, el.clientHeight - headerRef.current);
    if (top !== el.scrollTop) el.scrollTop = top;
  }, [scrollRef]);

  // ── Seçim özeti (ekran okuyucu) ────────────────────────────────────────────────────────────────────────
  const selectedCount = pane.selection.ids.size;
  useEffect(() => {
    const t = setTimeout(() => setAnnounce(selectedCount ? `${countLabel(selectedCount)} seçili` : ''), 300);
    return () => clearTimeout(t);
  }, [selectedCount]);

  // ── Yardımcılar (hep taze durum) ───────────────────────────────────────────────────────────────────────
  const cur = () => store.getState().wins[winId]?.panes[pi];

  const indexFromEvent = useCallback((e) => {
    const holder = e.target.closest?.('[data-index]');
    if (holder) return Number(holder.dataset.index);
    const el = scrollRef.current;
    if (!el) return -1;
    const b = el.getBoundingClientRect();
    return indexAtPoint(geometryRef.current, e.clientX - b.left + el.scrollLeft, e.clientY - b.top + el.scrollTop - headerRef.current);
  }, [scrollRef]);

  const focusScroller = useCallback(() => scrollRef.current?.focus({ preventScroll: true }), [scrollRef]);

  const openMenuAt = useCallback((x, y, targets) => {
    const b = sectionRef.current?.getBoundingClientRect();
    // Menü bölmenin içinde (overflow-hidden) açılır: konum ve taşma sınırı bölmeye göredir.
    setMenu({ x: x - (b?.left ?? 0), y: y - (b?.top ?? 0), targets, bounds: { width: b?.width, height: b?.height } });
  }, []);

  // ── Sürükle-bırak kayıtları: satırlar için TEK kayıt (resolve), bölme zemini için bir kayıt ─────────────
  useEffect(() => {
    const offRow = registerDropTarget(`row:${paneKey}`, {
      resolve(el) {
        const p = cur();
        const entry = p?.visible[Number(el.getAttribute('data-index'))];
        return entry?.kind === 'dir' ? { loc: entryLoc(p, entry), name: entry.name } : null;
      },
      accepts: acceptsDrop,
      onDrop: (sources, mods, dest) => dropOnFolder({ sources, dest, ...mods }),
    });
    const offPane = registerDropTarget(`pane:${paneKey}`, {
      get loc() { return paneFolder(cur()); },
      get name() { return baseName(paneFolder(cur()) || {}) || 'Klasör'; },
      accepts: (sources, mods) => acceptsDrop(sources, mods, paneFolder(cur())),
      onDrop: (sources, mods) => dropOnFolder({ sources, dest: paneFolder(cur()), ...mods }),
    });
    return () => { offRow(); offPane(); };
  }, [paneKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Lastik bant ────────────────────────────────────────────────────────────────────────────────────────
  const marqueeBase = useRef(null);
  const { rect: marqueeRect, begin: beginMarquee } = useMarquee({
    scrollRef,
    geometryRef,
    headerRef,
    onSelect: (indices, additive) => store.getState().marquee(winId, pi, marqueeBase.current, indices, additive),
  });

  // ── İşaretçi ───────────────────────────────────────────────────────────────────────────────────────────
  const pending = useRef(null);        // fare: sürüklenmeden bırakılırsa uygulanacak seçim sadeleştirmesi
  const touch = useRef(null);          // dokunma: { x, y, index, timer, longPressed }

  const dragPayload = (key) => () => {
    const p = cur();
    if (!p) return null;
    const entries = store.getState().selectedEntries(winId, pi);
    if (!entries.length || !p.selection.ids.has(key)) return null;
    return {
      sources: entries.map((e) => entryLoc(p, e)),
      count: entries.length,
      label: entries.length === 1 ? entries[0].name : countLabel(entries.length),
      kind: entries.length === 1 ? entries[0].kind : 'mixed',
    };
  };

  const onPointerDown = (e) => {
    store.getState().setActivePane(winId, pi);
    if (menu) setMenu(null);
    if (e.target.closest?.('input,textarea,button')) return;
    const index = indexFromEvent(e);

    // `touchy` (telefon yoğunluğu `compact` VEYA gerçek kaba işaretçi) de buraya girer: dar/telefon düzeninde fare
    // kullanılsa bile tek tık yerine basılı tutmayla seçim beklenir — yalnız `pointerType==='touch'`e bakmak, bu
    // davranışı sadece gerçek dokunmatik donanımda tetikler ve masaüstünde telefon genişliğinde tek tık hemen seçerdi.
    if (e.pointerType === 'touch' || touchy) {
      const state = { x: e.clientX, y: e.clientY, index, longPressed: false, timer: null };
      if (index >= 0) {
        state.timer = setTimeout(() => {
          state.longPressed = true;
          const p = cur();
          if (p?.visible[index]) store.getState().click(winId, pi, keyOf(p.visible[index]), { ctrl: true });
          navigator.vibrate?.(8);
        }, LONG_PRESS_MS);
      }
      touch.current = state;
      return;
    }

    if (e.button === 2) return;                                 // sağ tık → contextmenu olayı
    if (e.button !== 0) return;
    const S = store.getState();
    const p = cur();
    const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };

    if (index < 0 || !p.visible[index]) {
      // Boş alan: seçimi temizle (Ctrl/Shift yoksa), lastik bant başlat.
      marqueeBase.current = mods.ctrl || mods.shift ? p.selection : { ids: new Set(), anchor: null, focus: p.selection.focus };
      if (!mods.ctrl && !mods.shift) S.clearSelection(winId, pi);
      beginMarquee(e, { additive: mods.ctrl || mods.shift });
      return;
    }

    const key = keyOf(p.visible[index]);
    const selected = p.selection.ids.has(key);
    pending.current = null;
    if (selected && !mods.shift && (mods.ctrl || p.selection.ids.size > 1)) {
      // Seçili öğeye basıldı: sürükleme olabilir → karar bırakılınca (sürüklenmediyse) verilir.
      pending.current = { key, mods };
    } else {
      S.click(winId, pi, key, mods);
    }
    armDrag(e, dragPayload(key));
    window.addEventListener('pointerup', () => {
      const todo = pending.current;
      pending.current = null;
      if (!todo || justDragged()) return;
      store.getState().click(winId, pi, todo.key, todo.mods);
    }, { once: true });
  };

  const onPointerMove = (e) => {
    const t = touch.current;
    if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) > TAP_SLOP_PX) {
      clearTimeout(t.timer);
      touch.current = null;
    }
  };

  const onPointerUp = (e) => {
    const t = touch.current;
    // `touch.current` yalnız onPointerDown'ın dokunma-benzeri dalında (touch VEYA touchy) kurulur; burada
    // pointerType'ı AYRICA touch'a kilitlemek o dalı farenin (touchy'de) tetiklediği durumlarda yanlışlıkla atlardı.
    if (!t) return;
    clearTimeout(t.timer);
    touch.current = null;
    if (t.longPressed || t.index < 0) return;
    const p = cur();
    const entry = p?.visible[t.index];
    if (!entry) return;
    // Seçim kipindeyken dokunuş aç/kapar; değilken açar (telefondaki Dosyalarım gibi).
    if (p.selection.ids.size > 0) store.getState().click(winId, pi, keyOf(entry), { ctrl: true });
    else openEntry(winId, pi, entry);
  };

  const onPointerCancel = () => {
    if (touch.current) clearTimeout(touch.current.timer);
    touch.current = null;
  };

  const onDoubleClick = (e) => {
    // touchy'de açma zaten onPointerUp'ın tek-tıkla-aç mantığından gelir (bkz. yukarı); burada da işlemek art arda
    // tıklamada openEntry'yi ikinci kez (ve büyük ihtimalle yanlış girdi için, dizin o sırada kaymışsa) tetikler.
    if (e.pointerType === 'touch' || touchy || e.target.closest?.('input')) return;
    const index = indexFromEvent(e);
    const entry = cur()?.visible[index];
    if (entry) openEntry(winId, pi, entry);
  };

  const onContextMenu = (e) => {
    e.preventDefault();
    store.getState().setActivePane(winId, pi);
    const S = store.getState();
    const p = cur();
    const index = indexFromEvent(e);
    const entry = p.visible[index];
    if (entry && !p.selection.ids.has(keyOf(entry))) S.click(winId, pi, keyOf(entry), {});
    else if (!entry) S.clearSelection(winId, pi);
    openMenuAt(e.clientX, e.clientY, entry ? S.selectedEntries(winId, pi) : []);
  };

  // ── Klavye ─────────────────────────────────────────────────────────────────────────────────────────────
  const typed = useRef({ buffer: '', timer: 0 });

  const onKeyDown = (e) => {
    if (e.target.closest?.('input,textarea')) return;
    const S = store.getState();
    const p = cur();
    if (!p) return;
    const cmd = resolveKey(e, { dual });
    if (!cmd) return;
    const focusIndex = p.selection.focus != null ? p.indexMap.get(p.selection.focus) ?? -1 : -1;
    const focusEntry = p.visible[focusIndex] || S.selectedEntries(winId, pi)[0] || null;
    const done = () => { e.preventDefault(); e.stopPropagation(); };

    switch (cmd.type) {
      case 'move': {
        done();
        const target = keyboardTarget(geometryRef.current, focusIndex, cmd.key, scrollRef.current?.clientHeight - headerRef.current || 0);
        if (target < 0) return;
        S.focusAt(winId, pi, target, { ctrl: cmd.ctrl, shift: cmd.shift });
        reveal(target);
        return;
      }
      case 'open': done(); if (focusEntry) openEntry(winId, pi, focusEntry); return;
      case 'preview':
        done();
        if (focusEntry && previewKind(focusEntry)) S.openPreview(winId, pi, keyOf(focusEntry));
        return;
      case 'toggle': done(); S.toggleFocused(winId, pi); return;
      case 'up': done(); S.goUp(winId, pi, { select: !compact }); return;
      case 'back': done(); S.goBack(winId, pi); return;
      case 'forward': done(); S.goForward(winId, pi); return;
      case 'rename': done(); if (focusEntry && p.selection.ids.size <= 1) S.startRename(winId, pi, keyOf(focusEntry)); return;
      case 'delete': done(); deleteSelected(winId, pi, { permanent: cmd.permanent }); return;
      case 'copy': done(); copySelection(winId, pi); return;
      case 'cut': done(); cutSelection(winId, pi); return;
      case 'paste': done(); paste(winId, pi); return;
      case 'select-all': done(); S.selectAll(winId, pi); return;
      case 'new-folder': done(); createFolder(winId, pi); return;
      case 'reload': done(); S.reload(winId, pi); return;
      case 'transfer': done(); transferToOtherPane(winId, cmd.op); return;
      case 'focus-path': done(); emitFocus(FOCUS_PATH_EVENT, winId, pi); return;
      case 'focus-search': done(); emitFocus(FOCUS_SEARCH_EVENT, winId, pi); return;
      case 'toggle-hidden': done(); S.toggleHidden(winId, pi); return;
      case 'properties': done(); if (focusEntry) showProperties(winId, pi, focusEntry); return;
      case 'escape':
        if (menu) { done(); setMenu(null); } else if (p.query) { done(); S.setQuery(winId, pi, ''); } else if (p.selection.ids.size) { done(); S.clearSelection(winId, pi); }
        return;
      case 'menu': {
        done();
        const el = scrollRef.current;
        const b = el.getBoundingClientRect();
        const r = focusIndex >= 0 ? rectOf(geometryRef.current, focusIndex) : { x: 24, y: 8 };
        const targets = focusEntry && p.selection.ids.size ? S.selectedEntries(winId, pi) : [];
        openMenuAt(b.left + r.x + 24, b.top + headerRef.current + r.y - el.scrollTop + 16, targets);
        return;
      }
      case 'type': {
        const t = typed.current;
        clearTimeout(t.timer);
        t.buffer += cmd.char;
        t.timer = setTimeout(() => { t.buffer = ''; }, TYPE_AHEAD_MS);
        const at = typeAheadIndex(p.visible, t.buffer, t.buffer.length > 1 ? focusIndex - 1 : focusIndex);
        if (at >= 0) { S.focusAt(winId, pi, at, {}); reveal(at); }
        e.preventDefault();
        break;
      }
      default:
    }
  };

  // ── Boş alan / içerik ──────────────────────────────────────────────────────────────────────────────────
  const menuEntries = menu ? tidy(buildMenu({
    targets: menu.targets, provider: pane.loc?.provider, hasClipboard: Boolean(clipboard), dual, phoneConnected, showHidden: pane.showHidden,
  })) : null;

  const cutKeys = useMemo(
    () => (clipboard?.op === 'cut' ? new Set(clipboard.items.map((i) => locKey(i.loc))) : null),
    [clipboard],
  );

  const onSort = useCallback((key) => store.getState().setSort(winId, pi, key), [winId, pi]);
  const onCancelRename = useCallback(() => store.getState().stopRename(winId, pi), [winId, pi]);
  const columns = useMemo(() => columnsFor(size.width, layoutMode), [size.width, layoutMode]);   // bölmenin KENDİ genişliği
  const showCheck = touchy && selectedCount > 0;
  const focusedKey = hasFocus ? pane.selection.focus : null;
  const rowId = (i) => `${paneKey}:item:${i}`;
  const focusIdx = pane.selection.focus != null ? pane.indexMap.get(pane.selection.focus) : undefined;

  const items = [];
  for (let i = range.start; i < range.end; i += 1) {
    const entry = pane.visible[i];
    const key = keyOf(entry);
    const common = {
      entry,
      index: i,
      selected: pane.selection.ids.has(key),
      focused: focusedKey === key,
      cut: cutKeys ? cutKeys.has(locKey(entryLoc(pane, entry))) : false,
      loc: folder,
      rowId: rowId(i),
      renaming: pane.renaming === key,
      onRename: pane.renaming === key ? (value) => commitRename(winId, pi, entry, value) : undefined,
      onCancelRename: pane.renaming === key ? onCancelRename : undefined,
      showCheck,
      dropId: `row:${paneKey}`,
    };
    if (grid) {
      const r = rectOf(g, i);
      items.push(<FileTile key={key} {...common} x={r.x} y={r.y} w={g.cellW} h={g.rowH} zoom={pane.zoom} />);
    } else {
      items.push(<FileRow key={key} {...common} top={g.pad + i * g.rowH} height={g.rowH} columns={columns} compact={compact} now={now} />);
    }
  }

  const loading = pane.status === 'loading' && pane.visible.length === 0;
  const failed = pane.status === 'error';
  const empty = settled && pane.visible.length === 0;
  const hiddenCount = pane.entries.length - pane.visible.length;
  const busyTop = (pane.status === 'loading' && pane.visible.length > 0) || pane.status === 'refreshing';

  return (
    <section
      ref={sectionRef}
      aria-label={folder ? baseName(folder) || 'Klasör' : 'Klasör'}
      data-pane={paneKey}
      className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', dual && (active ? 'ring-1 ring-inset ring-ring/60' : 'opacity-[0.97]'))}
    >
      {busyTop && <div aria-hidden="true" className="absolute inset-x-0 top-0 z-20 h-0.5 animate-pulse bg-primary/70 motion-reduce:animate-none" />}
      <div
        ref={scrollRef}
        data-files-scroll
        data-drop-id={`pane:${paneKey}`}
        role={grid ? 'listbox' : 'grid'}
        aria-label="Dosyalar"
        aria-multiselectable="true"
        aria-rowcount={grid ? undefined : count + 1}
        aria-busy={pane.status === 'loading'}
        aria-activedescendant={hasFocus && focusIdx !== undefined && focusIdx >= range.start && focusIdx < range.end ? rowId(focusIdx) : undefined}
        tabIndex={0}
        onScroll={onScroll}
        onFocus={() => setHasFocus(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setHasFocus(false); }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        className="files-scroll relative min-h-0 flex-1 touch-pan-y select-none overflow-y-auto overflow-x-hidden outline-none"
      >
        {showHeader && <ColumnHeader sort={pane.sort} columns={columns} showCheck={showCheck} onSort={onSort} />}
        <div className="relative" style={{ height: contentHeight(g) }} role={grid ? undefined : 'rowgroup'}>
          {items}
          {marqueeRect && <div aria-hidden="true" className="files-marquee pointer-events-none absolute" style={{ left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.width, height: marqueeRect.height }} />}
        </div>
        {loading && <SkeletonRows rowH={rowH} />}
      </div>
      {failed && <ErrorState error={pane.error} onRetry={() => store.getState().reload(winId, pi)} />}
      {empty && !failed && (
        <EmptyState
          filtered={pane.entries.length > 0}
          query={pane.query}
          hiddenCount={hiddenCount}
          onShowHidden={() => store.getState().toggleHidden(winId, pi)}
          onNewFolder={() => createFolder(winId, pi)}
        />
      )}
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      {menuEntries && (
        <FileContextMenu
          menu={menuEntries}
          x={menu.x}
          y={menu.y}
          bounds={menu.bounds}
          onClose={() => { setMenu(null); focusScroller(); }}
          onPick={(id) => runMenuAction(id, { winId, pi, entries: menu.targets })}
        />
      )}
    </section>
  );
}
