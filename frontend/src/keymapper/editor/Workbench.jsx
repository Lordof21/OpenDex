// Atölye: tuş düzenini DÜZENLEME modu. Videonun gerçek dikdörtgeninin üstünde sürükle-bırak, sağda denetçi, solda palet, üstte araç çubuğu.
// Tasarım ve kabul ölçütleri: docs/design/KEYMAPPER.md
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check,
  Crosshair,
  Gamepad2,
  Grid3x3,
  LayoutTemplate,
  Magnet,
  Move,
  MoreHorizontal,
  Power,
  PanelRight,
  PlayCircle,
  Play,
  Redo2,
  ScanEye,
  Undo2,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { pushEscapeHandler } from '../../lib/escapeStack.js';
import { t } from '../../i18n/index.js';
import { isWindowKey, useKeymapStore } from '../keymapStore.js';
import { nodesForKey } from '../keymapperEngine.js';
import { LIMITS, MOUSE_KEYS, findConflicts, hitPoint, normalizeKeyName, roundPosition } from '../model.js';
import FloatingPanel from './FloatingPanel.jsx';
import NodeView from './NodeView.jsx';
import { LayoutInspector, NodeInspector } from './Inspector.jsx';
import { isCapturingKey } from './KeyCapture.jsx';
import { CopyFromDialog, ImportDialog, TemplatesDialog } from './dialogs.jsx';
import { freeSpot, snapPosition } from './snapping.js';
import { useKeymapActivity } from './useKeymapActivity.js';
import { tip } from './tip.js';

const EMPTY = Object.freeze([]);
const NARROW_PX = 620;
const NUDGE = 0.005;
const NUDGE_FINE = 0.001;
const MOUSE_NAME_BY_BUTTON = Object.fromEntries(Object.entries(MOUSE_KEYS).map(([name, button]) => [button, name]));
const SIZE_FIELD = { tap: ['size', LIMITS.tapSize], dpad: ['radius', LIMITS.dpadRadius], look: ['radius', LIMITS.lookRadius] };
const isTyping = (target) => Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));

// `label` erişilebilir ad; ipucu varsayılan olarak aynı metindir (`tipText` ile kısaltılır). Uygulamanın kendi ipucu sistemi kullanılır.
function ToolButton({ icon: Icon, label, tipText, tipPosition = 'bottom', tipAlign, toggle = false, active = false, disabled = false, onClick, children, className, ...rest }) {
  return (
    <button
      type="button"
      {...tip(tipText || label, tipPosition, tipAlign)}
      aria-label={label}
      aria-pressed={toggle ? Boolean(active) : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 items-center gap-1.5 rounded-xl px-2 text-[11px] font-semibold transition-colors cursor-pointer disabled:cursor-default disabled:opacity-40',
        active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent',
        className,
      )}
      {...rest}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {children && <span className="hidden sm:inline">{children}</span>}
    </button>
  );
}

const Divider = () => <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-border/70" />;

export default function Workbench({ win, layoutKeyId, device, deviceKnown = true, frame, isHeaderOpen = false, onClose }) {
  // `pkg` = düzenin saklandığı anahtar: pencerenin kendi düzeni varsa `win:<id>`, yoksa uygulama paketi (win.package).
  const pkg = layoutKeyId || win.package;
  const ownLayout = isWindowKey(pkg);
  const nodes = useKeymapStore((s) => s.presets[pkg]) ?? EMPTY;
  const uiPrefs = useKeymapStore((s) => s.uiPrefs);
  const mousePrefs = useKeymapStore((s) => s.prefs);
  const canUndo = useKeymapStore((s) => (s.history[pkg]?.past.length ?? 0) > 0);
  const canRedo = useKeymapStore((s) => (s.history[pkg]?.future.length ?? 0) > 0);
  const setMousePrefs = useKeymapStore((s) => s.setMousePrefs);
  const setUiPrefs = useKeymapStore((s) => s.setUiPrefs);
  const userTemplates = useKeymapStore((s) => s.userTemplates);
  const layoutEnabled = useKeymapStore((s) => !s.layoutOff[pkg]);
  const setLayoutEnabled = useCallback((enabled) => useKeymapStore.getState().setLayoutEnabled(pkg, enabled), [pkg]);

  const frameRef = useRef(null);
  const [selectedId, setSelectedId] = useState(null);
  const [preview, setPreview] = useState(null); // { id, patch, guides } — sürükleme/boyutlandırma sırasında canlı gösterim
  const [testing, setTesting] = useState(false);
  // "Oyna": düzenleyici açıkken tuş ve fare GERÇEKTEN telefona gider (test modu gibi sahte değil); düğümler tutulmaz, denetçi açık kalır.
  const livePlay = useKeymapStore((s) => s.livePlayWindowId === win.id);
  const setLivePlay = useCallback((on) => useKeymapStore.getState().setLivePlayWindowId(on ? win.id : null), [win.id]);
  const passive = testing || livePlay;
  const [testActive, setTestActive] = useState(() => new Set());
  const [dialog, setDialog] = useState(null); // 'templates' | 'import' | 'copy'
  const [moreOpen, setMoreOpen] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [notice, setNotice] = useState(null);
  const [autoCaptureId, setAutoCaptureId] = useState(null);
  const narrow = frame.box.w > 0 && frame.box.w < NARROW_PX;
  // Dar pencerede (telefon boyutu) denetçi alt şerit olarak gelir; artık hep görünür (eskiden seçim yokken kayboluyordu) — sürüklenir ve
  // küçültülür, böylece düzenlenen noktaların üstünde engel olmaz.
  const [panelOpen, setPanelOpen] = useState(true);
  const panelVisible = !testing && panelOpen;

  const shown = useMemo(
    () => (preview ? nodes.map((n) => (n.id === preview.id ? { ...n, ...preview.patch } : n)) : nodes),
    [nodes, preview],
  );
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const conflicts = useMemo(() => findConflicts(shown), [shown]);
  const selected = shown.find((n) => n.id === selectedId) || null;
  const activity = useKeymapActivity(win.id);
  const hud = useMemo(
    () => ({ scale: uiPrefs.hudScale, opacity: uiPrefs.hudOpacity, showLabels: true }),
    [uiPrefs.hudScale, uiPrefs.hudOpacity],
  );

  useEffect(() => {
    if (selectedId && !nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [nodes, selectedId]);

  // Bildirim (kısa süreli ipucu) ve "temizle" onayı kendiliğinden söner.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!clearArmed) return undefined;
    const timer = setTimeout(() => setClearArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [clearArmed]);

  // Menü dışına basmak menüyü kapatır.
  useEffect(() => {
    if (!moreOpen) return undefined;
    const close = (e) => {
      if (!e.target?.closest?.('[data-more-menu]')) setMoreOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [moreOpen]);

  // ───────────────────────────────────────────────────────────────────────────────────────────── Düzen işlemleri
  const actions = useMemo(() => ({
    update: (patch, coalesce) => useKeymapStore.getState().updateNodeInPackage(pkg, selectedId, patch, coalesce ? { coalesce } : undefined),
    remove: () => {
      useKeymapStore.getState().removeNodeFromPackage(pkg, selectedId);
      setSelectedId(null);
    },
    duplicate: () => {
      const id = useKeymapStore.getState().duplicateNodeInPackage(pkg, selectedId);
      if (id) setSelectedId(id);
    },
  }), [pkg, selectedId]);

  const addNode = useCallback((type) => {
    const store = useKeymapStore.getState();
    const current = store.getKeymapForPackage(pkg);
    const existing = current.find((n) => n.type === type);
    if (type !== 'tap' && existing) {
      setSelectedId(existing.id); // joystick/bakıştan tek tane olur: var olanı seç
      return;
    }
    const defaults = {
      tap: { key: 'Space', label: '', ...freeSpot(current) },
      dpad: { key: 'WASD', label: t('keymapper.hareket_wasd'), ...freeSpot(current, { rx: 0.2, ry: 0.68 }) },
      look: { key: 'Mouse', label: t('keymapper.fareyle_bakis_alani'), ...freeSpot(current, { rx: 0.72, ry: 0.45 }) },
    };
    const id = store.addNodeToPackage(pkg, { type, ...defaults[type] });
    if (id) {
      setSelectedId(id);
      setPanelOpen(true);
      if (type === 'tap') setAutoCaptureId(id); // hemen "bir tuşa bas"
    }
  }, [pkg]);

  // Pencereye özel düzen: açınca uygulamanın düzeni KOPYALANIR ve bundan sonra yalnız bu pencereyi etkiler; kapatınca pencere düzeni silinir.
  const toggleOwnLayout = useCallback((owned) => {
    useKeymapStore.getState().setWindowLayoutOwned(win.id, win.package, owned);
    setSelectedId(null);
  }, [win.id, win.package]);
  const promoteLayout = useCallback(() => {
    if (useKeymapStore.getState().promoteWindowLayout(win.id, win.package)) setNotice(t('keymapper.uygulama_duzeni_guncellendi'));
  }, [win.id, win.package]);

  const runUndo = useCallback(() => useKeymapStore.getState().undoKeymap(pkg), [pkg]);
  const runRedo = useCallback(() => useKeymapStore.getState().redoKeymap(pkg), [pkg]);

  const exportLayout = async () => {
    setMoreOpen(false);
    const text = useKeymapStore.getState().exportLayout(pkg);
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t('keymapper.duzen_panoya_kopyalandi'));
    } catch {
      setNotice(t('keymapper.pano_kullanilamadi'));
    }
  };

  // ───────────────────────────────────────────────────────────────────────────────────────── Sürükle / boyutlandır
  const beginGesture = useCallback((e, node, compute) => {
    const el = frameRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const start = { x: e.clientX, y: e.clientY };
    let last = null;
    let moved = false;
    const onMove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      moved = true;
      last = compute(ev, rect);
      setPreview({ id: node.id, patch: last.patch, guides: last.guides });
    };
    const finish = (commit) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      setPreview(null);
      if (commit && moved && last) useKeymapStore.getState().updateNodeInPackage(pkg, node.id, last.patch);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }, [pkg]);

  const onNodePointerDown = useCallback((e, node) => {
    if (passive || e.button !== 0) return;
    if (e.target.closest?.('[data-resize-handle]')) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(node.id);
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    const grabX = e.clientX - (rect.left + node.rx * rect.width);
    const grabY = e.clientY - (rect.top + node.ry * rect.height);
    beginGesture(e, node, (ev, r) => {
      const snapped = snapPosition(
        { rx: (ev.clientX - grabX - r.left) / r.width, ry: (ev.clientY - grabY - r.top) / r.height },
        { nodes: shownRef.current, selfId: node.id, enabled: uiPrefs.snap && !ev.altKey, grid: uiPrefs.grid, frame: { w: r.width, h: r.height } },
      );
      return { patch: { rx: roundPosition(snapped.rx), ry: roundPosition(snapped.ry) }, guides: snapped.guides };
    });
  }, [beginGesture, passive, uiPrefs.grid, uiPrefs.snap]);

  const onResizeStart = useCallback((e, node) => {
    if (passive || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const [field, limits] = SIZE_FIELD[node.type];
    const short = Math.min(device.w, device.h) || 720;
    beginGesture(e, node, (ev, r) => {
      const centerX = r.left + node.rx * r.width;
      const devicePx = Math.abs(ev.clientX - centerX) / (r.width / (device.w || r.width));
      const value = Math.min(limits.max, Math.max(limits.min, devicePx / short));
      return { patch: { [field]: Math.round(value * 10000) / 10000 }, guides: { x: null, y: null } };
    });
  }, [beginGesture, device.h, device.w, passive]);

  // ──────────────────────────────────────────────────────────────────────────────────────────────────── Kısayollar
  useEffect(() => {
    if (passive || dialog) return undefined;
    const onKeyDown = (e) => {
      if (isCapturingKey() || isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) runRedo();
        else runUndo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        runRedo();
        return;
      }
      if (!selectedId) return;
      if (mod && key === 'd') {
        e.preventDefault();
        actions.duplicate();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        actions.remove();
      } else if (e.key.startsWith('Arrow') && !mod) {
        e.preventDefault();
        const node = shownRef.current.find((n) => n.id === selectedId);
        if (!node) return;
        const step = e.shiftKey ? NUDGE_FINE : NUDGE;
        const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
        const dy = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0;
        actions.update({ rx: roundPosition(node.rx + dx), ry: roundPosition(node.ry + dy) }, `nudge:${selectedId}`);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [actions, dialog, runRedo, runUndo, selectedId, passive]);

  // Esc önce "Oyna"dan çıkarır (test modu gibi): düzenleyici açık kalır.
  useEffect(() => {
    if (!livePlay) return undefined;
    return pushEscapeHandler(() => setLivePlay(false));
  }, [livePlay, setLivePlay]);

  // ───────────────────────────────────────────────────────────────────────────────────────────────── Test modu
  // Tuşa / fare düğmesine / tekerleğe basınca ilgili düğüm yanar; telefona HİÇBİR ŞEY gitmez. Esc önce test modundan çıkarır.
  useEffect(() => {
    if (!testing) return undefined;
    const light = (matches, on) => setTestActive((prev) => {
      const next = new Set(prev);
      for (const { node, direction, walk } of matches) {
        const ids = [node.id, direction && `${node.id}:${direction}`, walk && `${node.id}:walk`].filter(Boolean);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
      }
      return next;
    });
    const onKey = (on) => (e) => {
      if (isTyping(e.target)) return;
      const matches = nodesForKey(shownRef.current, normalizeKeyName(e.key));
      if (matches.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      light(matches, on);
    };
    const onDown = onKey(true);
    const onUp = onKey(false);
    const onPointer = (on) => (e) => {
      const name = MOUSE_NAME_BY_BUTTON[e.button];
      if (!name || e.target?.closest?.('[data-workbench-chrome]')) return;
      const matches = nodesForKey(shownRef.current, normalizeKeyName(name));
      if (matches.length === 0) return;
      e.preventDefault();
      light(matches, on);
    };
    const onWheel = (e) => {
      const matches = nodesForKey(shownRef.current, normalizeKeyName(e.deltaY < 0 ? 'WheelUp' : 'WheelDown'));
      if (matches.length === 0) return;
      e.preventDefault();
      light(matches, true);
      setTimeout(() => light(matches, false), 140);
    };
    const pointerDown = onPointer(true);
    const pointerUp = onPointer(false);
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointerup', pointerUp, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    const popEscape = pushEscapeHandler(() => setTesting(false));
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('pointerup', pointerUp, true);
      window.removeEventListener('wheel', onWheel, true);
      popEscape();
      setTestActive(new Set());
    };
  }, [testing]);

  // ───────────────────────────────────────────────────────────────────────────────────────────────────── Çizim
  const guides = preview?.guides;
  const pressed = testing ? testActive : activity;
  const sources = dialog === 'copy' ? useKeymapStore.getState().packagesWithLayouts(pkg) : EMPTY;

  return (
    <>
      {/* Çerçeve: videonun gerçekten çizildiği dikdörtgen. Düğümler bunun yüzdesidir. */}
      <div
        ref={frameRef}
        data-keymap-frame=""
        data-testid="keymap-frame"
        style={{ position: 'absolute', ...frame.style }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) setSelectedId(null);
        }}
        className={cn('outline-1 outline-dashed outline-primary/50', livePlay && 'pointer-events-none')}
      >
        {uiPrefs.grid && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: 'linear-gradient(to right, rgb(255 255 255 / 0.10) 1px, transparent 1px), linear-gradient(to bottom, rgb(255 255 255 / 0.10) 1px, transparent 1px)',
              backgroundSize: '2.5% 2.5%',
            }}
          />
        )}
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-primary/25" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-primary/25" />
        {guides?.x != null && <span aria-hidden="true" data-guide="x" className="pointer-events-none absolute inset-y-0 w-px bg-primary" style={{ left: `${guides.x * 100}%` }} />}
        {guides?.y != null && <span aria-hidden="true" data-guide="y" className="pointer-events-none absolute inset-x-0 h-px bg-primary" style={{ top: `${guides.y * 100}%` }} />}

        {shown.map((node) => {
          const point = hitPoint(node, device.w, device.h);
          return (
            <NodeView
              key={node.id}
              node={node}
              frame={{ w: frame.rect.width, h: frame.rect.height }}
              device={device}
              mode="edit"
              selected={node.id === selectedId && !passive}
              active={pressed}
              conflict={conflicts.has(node.id)}
              dimmed={!layoutEnabled}
              hud={hud}
              coordsText={node.id === selectedId && !passive ? (deviceKnown ? `${point.x} × ${point.y} px` : `${(node.rx * 100).toFixed(1)}% · ${(node.ry * 100).toFixed(1)}%`) : null}
              onPointerDown={passive ? undefined : onNodePointerDown}
              onResizeStart={onResizeStart}
            />
          );
        })}
      </div>

      {/* Boş düzen: nereden başlanacağını söyler. */}
      {nodes.length === 0 && !passive && (
        <div data-workbench-chrome="" className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="pointer-events-auto max-w-xs space-y-2 rounded-2xl border border-border/80 bg-popover/95 p-4 text-center shadow-2xl backdrop-blur-2xl">
            <Gamepad2 className="mx-auto size-6 text-primary" aria-hidden="true" />
            <p className="text-xs font-bold text-foreground">{t('keymapper.duzen_bos')}</p>
            <p className="text-[11px] leading-snug text-muted-foreground">{t('keymapper.bos_duzen_ipucu')}</p>
            <div className="flex justify-center gap-2 pt-1">
              <button type="button" onClick={() => setDialog('templates')} className="flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90 cursor-pointer">
                <LayoutTemplate className="size-3.5" aria-hidden="true" />
                {t('keymapper.sablonlar')}
              </button>
              <button type="button" onClick={() => addNode('tap')} className="flex h-8 items-center gap-1.5 rounded-xl border border-border/70 bg-muted px-3 text-[11px] font-semibold text-foreground hover:bg-accent cursor-pointer">
                {t('keymapper.tus_ekle')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Üst çubuk */}
      <FloatingPanel
        id="toolbar"
        as={motion.div}
        data-workbench-chrome=""
        data-testid="keymap-toolbar"
        title={t('keymapper.tus_duzenleyici')}
        icon={Gamepad2}
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        // Ortalama: framer-motion satır içi `transform` yazar, Tailwind 3'ün -translate-x-1/2'sini ezer (çubuk ortalanmayıp sağa taşardı).
        // Genişliği belli (w-max) mutlak öğe `inset-x-0 mx-auto` ile ortalanır. Üst geçişi yalnız başlık açılıp kapanınca: sürüklerken gecikme yapmasın.
        defaultClassName={cn('inset-x-0 mx-auto transition-[top] duration-300', isHeaderOpen ? 'top-12' : 'top-2')}
        className="absolute z-50 w-max max-w-[calc(100%-8px)] overflow-visible rounded-2xl border border-border/80 bg-popover/95 text-xs shadow-2xl backdrop-blur-2xl select-none"
        bodyClassName="flex flex-wrap items-center justify-center gap-0.5 overflow-visible p-1 pt-0"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="flex items-center gap-1 px-2 text-xs font-bold text-primary">
          <Gamepad2 className="size-4 shrink-0" aria-hidden="true" />
          <span className="hidden md:inline">{t('keymapper.tus_duzenleyici')}</span>
          {ownLayout && <span data-testid="own-layout-badge" className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-primary">{t('keymapper.bu_pencereye_ozel')}</span>}
        </span>
        <Divider />
        <ToolButton icon={Undo2} label={t('keymapper.geri_al_ctrl_z')} disabled={!canUndo || testing} onClick={runUndo} />
        <ToolButton icon={Redo2} label={t('keymapper.yinele_ctrl_y')} disabled={!canRedo || testing} onClick={runRedo} />
        <Divider />
        <ToolButton icon={Power} toggle label={t('keymapper.duzen_acik_kapali')} active={layoutEnabled} data-testid="layout-toggle" onClick={() => setLayoutEnabled(!layoutEnabled)} />
        <ToolButton icon={PlayCircle} toggle label={t('keymapper.test_modu_tuslara_bas_telefona_gitmez')} tipText={t('keymapper.test_modu_kisa')} active={testing} disabled={livePlay} onClick={() => setTesting((on) => !on)}>{t('keymapper.test')}</ToolButton>
        <ToolButton icon={Play} toggle label={t('keymapper.oyna_ipucu')} active={livePlay} disabled={testing} data-testid="live-play-toggle" onClick={() => setLivePlay(!livePlay)}>{t('keymapper.oyna')}</ToolButton>
        <ToolButton icon={Magnet} toggle label={t('keymapper.hizaya_yapis')} active={uiPrefs.snap} onClick={() => setUiPrefs({ snap: !uiPrefs.snap })} />
        <ToolButton icon={Grid3x3} toggle label={t('keymapper.izgarayi_goster_ve_yapis')} active={uiPrefs.grid} onClick={() => setUiPrefs({ grid: !uiPrefs.grid })} />
        <Divider />
        <ToolButton icon={LayoutTemplate} label={t('keymapper.sablonlar')} disabled={testing} onClick={() => setDialog('templates')}>{t('keymapper.sablonlar')}</ToolButton>
        <div className="relative" data-more-menu="">
          <ToolButton icon={MoreHorizontal} label={t('keymapper.daha_fazla')} active={moreOpen} disabled={testing} onClick={() => setMoreOpen((open) => !open)} />
          <AnimatePresence>
            {moreOpen && (
              <motion.ul
                role="menu"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute right-0 top-full z-50 mt-1 w-56 space-y-0.5 rounded-xl border border-border bg-popover p-1 shadow-2xl"
              >
                {[
                  [t('keymapper.disa_aktar_panoya'), exportLayout, 'export'],
                  [t('keymapper.ice_aktar'), () => { setMoreOpen(false); setDialog('import'); }, 'import'],
                  [t('keymapper.baska_uygulamadan_kopyala'), () => { setMoreOpen(false); setDialog('copy'); }, 'copy'],
                ].map(([text, run, id]) => (
                  <li key={id} role="none">
                    <button type="button" role="menuitem" data-menu={id} onClick={run} className="w-full rounded-lg px-2.5 py-1.5 text-left text-[11px] font-medium text-foreground transition-colors hover:bg-accent cursor-pointer">{text}</button>
                  </li>
                ))}
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    data-menu="clear"
                    onClick={() => {
                      if (!clearArmed) {
                        setClearArmed(true);
                        return;
                      }
                      useKeymapStore.getState().clearPackageKeymap(pkg);
                      setClearArmed(false);
                      setMoreOpen(false);
                      setSelectedId(null);
                      setNotice(t('keymapper.duzen_temizlendi_geri_alabilirsin'));
                    }}
                    className={cn('w-full rounded-lg px-2.5 py-1.5 text-left text-[11px] font-semibold transition-colors cursor-pointer', clearArmed ? 'bg-destructive text-destructive-foreground' : 'text-destructive hover:bg-destructive/10')}
                  >
                    {clearArmed ? t('keymapper.emin_misin_tekrar_tikla') : t('keymapper.tum_tuslari_temizle')}
                  </button>
                </li>
              </motion.ul>
            )}
          </AnimatePresence>
        </div>
        <ToolButton icon={PanelRight} toggle label={t('keymapper.denetci')} active={panelOpen} disabled={testing} onClick={() => setPanelOpen((open) => !open)} />
        <Divider />
        <button
          type="button"
          onClick={onClose}
          {...tip(t('keymapper.duzenlemeyi_kapat_esc'), 'bottom', 'end')}
          className="flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-[11px] font-bold text-primary-foreground shadow-sm hover:bg-primary/90 cursor-pointer"
        >
          <Check className="size-4" aria-hidden="true" />
          <span>{t('keymapper.bitti')}</span>
        </button>
      </FloatingPanel>

      {/* Palet: küçük, sürüklenebilir, küçültülebilir */}
      {!passive && (
        <FloatingPanel
          id="palette"
          data-workbench-chrome=""
          data-testid="keymap-palette"
          title={t('keymapper.tus_duzenleyici')}
          icon={Gamepad2}
          handleTipPosition="right"
          compact
          defaultClassName="left-2 top-1/2 -translate-y-1/2"
          className="absolute z-40 w-14 overflow-visible rounded-2xl border border-border/80 bg-popover/95 shadow-2xl backdrop-blur-2xl select-none"
          bodyClassName="flex flex-col gap-0.5 overflow-visible px-1 pb-1"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ToolButton icon={Crosshair} label={t('keymapper.tus_ekle')} tipPosition="right" data-add="tap" onClick={() => addNode('tap')} className="h-auto flex-col gap-0 px-1 py-1 text-[9.5px]">{t('keymapper.tus')}</ToolButton>
          <ToolButton icon={Move} label={t('keymapper.joystick_ekle')} tipPosition="right" data-add="dpad" onClick={() => addNode('dpad')} className="h-auto flex-col gap-0 px-1 py-1 text-[9.5px]">{t('keymapper.joystick')}</ToolButton>
          <ToolButton icon={ScanEye} label={t('keymapper.bakis_alani_ekle')} tipPosition="right" data-add="look" onClick={() => addNode('look')} className="h-auto flex-col gap-0 px-1 py-1 text-[9.5px]">{t('keymapper.bakis')}</ToolButton>
        </FloatingPanel>
      )}

      {/* Oyna bandı */}
      {livePlay && (
        <div data-workbench-chrome="" data-testid="live-play-band" className="absolute bottom-3 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-primary/60 bg-popover/95 px-3 py-1.5 text-[11px] font-semibold text-primary shadow-2xl backdrop-blur-2xl">
          <Play className="size-4" aria-hidden="true" />
          {t('keymapper.oyna_kipi_bandi')}
          <button type="button" onClick={() => setLivePlay(false)} className="rounded-full bg-primary px-2.5 py-0.5 text-primary-foreground cursor-pointer">{t('keymapper.oynamayi_bitir')}</button>
        </div>
      )}

      {/* Test modu bandı */}
      {testing && (
        <div data-workbench-chrome="" className="absolute bottom-3 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-primary/60 bg-popover/95 px-3 py-1.5 text-[11px] font-semibold text-primary shadow-2xl backdrop-blur-2xl">
          <PlayCircle className="size-4" aria-hidden="true" />
          {t('keymapper.test_modu_tuslara_bas_telefona_gitmez')}
          <button type="button" onClick={() => setTesting(false)} className="rounded-full bg-primary px-2.5 py-0.5 text-primary-foreground cursor-pointer">{t('keymapper.testi_bitir')}</button>
        </div>
      )}

      {/* Denetçi */}
      <AnimatePresence>
        {panelVisible && (
          <FloatingPanel
            key="inspector"
            id="inspector"
            as={motion.aside}
            data-workbench-chrome=""
            data-testid="keymap-inspector"
            title={t('keymapper.denetci')}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            className="absolute z-40 w-64 rounded-2xl border border-border/80 bg-popover/95 shadow-2xl backdrop-blur-2xl select-none"
            defaultClassName={cn(narrow ? 'inset-x-2 bottom-2 max-h-[45%] w-auto' : 'bottom-2 right-2', !narrow && (isHeaderOpen ? 'top-24' : 'top-14'))}
            collapsedClassName={narrow ? undefined : '!bottom-auto'}
            bodyClassName="px-3 pb-3"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              data-testid="inspector-live-play"
              aria-pressed={livePlay}
              onClick={() => setLivePlay(!livePlay)}
              className={cn(
                'mb-3 flex w-full items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-[11px] font-bold cursor-pointer transition-colors',
                livePlay ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-accent',
              )}
            >
              <Play className="size-3.5" aria-hidden="true" />
              {livePlay ? t('keymapper.oynamayi_bitir') : t('keymapper.pencerede_oyna')}
            </button>
            {selected ? (
              <NodeInspector
                node={selected}
                device={device}
                deviceKnown={deviceKnown}
                actions={actions}
                conflicts={conflicts}
                autoCapture={autoCaptureId === selected.id}
                onAutoCaptured={() => setAutoCaptureId(null)}
              />
            ) : (
              <LayoutInspector
                nodes={shown}
                conflicts={conflicts}
                prefs={mousePrefs}
                setMousePrefs={setMousePrefs}
                uiPrefs={uiPrefs}
                setUiPrefs={setUiPrefs}
                onSelect={setSelectedId}
                layoutEnabled={layoutEnabled}
                setLayoutEnabled={setLayoutEnabled}
                ownLayout={ownLayout}
                onToggleOwn={toggleOwnLayout}
                onPromote={ownLayout ? promoteLayout : undefined}
              />
            )}
          </FloatingPanel>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {notice && (
          <motion.div
            key="notice"
            role="status"
            data-workbench-chrome=""
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="absolute bottom-12 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border/80 bg-popover/95 px-3 py-1.5 text-[11px] font-medium text-foreground shadow-2xl"
          >
            {notice}
          </motion.div>
        )}
      </AnimatePresence>

      <TemplatesDialog
        open={dialog === 'templates'}
        onClose={() => setDialog(null)}
        hasLayout={nodes.length > 0}
        onApply={(id) => {
          useKeymapStore.getState().applyTemplate(pkg, id);
          setSelectedId(null);
          setDialog(null);
        }}
        userTemplates={userTemplates}
        canSave={nodes.length > 0}
        onSave={(name) => {
          const id = useKeymapStore.getState().saveUserTemplate(pkg, name);
          if (id) setNotice(t('keymapper.sablon_kaydedildi'));
          return Boolean(id);
        }}
        onApplyUser={(id) => {
          useKeymapStore.getState().applyUserTemplate(pkg, id);
          setSelectedId(null);
          setDialog(null);
        }}
        onRenameUser={(id, name) => useKeymapStore.getState().renameUserTemplate(id, name)}
        onDeleteUser={(id) => useKeymapStore.getState().deleteUserTemplate(id)}
      />
      <ImportDialog
        open={dialog === 'import'}
        onClose={() => setDialog(null)}
        onImport={(text) => {
          const result = useKeymapStore.getState().importLayout(pkg, text);
          if (result.ok) setSelectedId(null);
          return result;
        }}
      />
      <CopyFromDialog
        open={dialog === 'copy'}
        onClose={() => setDialog(null)}
        sources={sources}
        onCopy={(from) => {
          useKeymapStore.getState().copyLayout(from, pkg);
          setSelectedId(null);
          setDialog(null);
        }}
      />
    </>
  );
}
