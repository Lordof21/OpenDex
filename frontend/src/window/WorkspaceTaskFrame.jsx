import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import { useWindowStore } from './windowStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { useLiveSettings } from '../settings/liveSettings.js';
import { cn } from '../lib/utils.js';
import { computeWorkspaceViewport } from './WorkspaceCanvas.jsx';
import { calculateWorkspaceTaskDpi, applySubpixelRule, resolveTaskDensity } from './windowMath.js';
import {
  openWorkspaceTaskPip,
  closeWorkspaceTaskPip,
  useWorkspaceTaskPipOpen,
} from './workspacePip/workspacePipHost.js';
import { logger } from '../lib/logger.js';
import WorkspaceTaskHeader from './workspaceTask/WorkspaceTaskHeader.jsx';
import WorkspaceTaskHub from './workspaceTask/WorkspaceTaskHub.jsx';
import ParkedOnPhoneOverlay from './canvas-overlays/ParkedOnPhoneOverlay.jsx';
import KeymapperOverlay from '../keymapper/KeymapperOverlay.jsx';
import { layoutKey, useKeymapStore } from '../keymapper/keymapStore.js';
import { headerDensityFor } from './workspaceTask/taskMetrics.js';
import { t as tt } from '../i18n/index.js';

const MIN_TASK_W = 100;
const MIN_TASK_H = 80;
// Hub'ın kalacağı kutu (görev penceresi) bundan küçükse hub sıkı (compact) düzende açılır: açıklamasız satırlar, tek sıra döşeme.
const HUB_COMPACT_BELOW_H = 560;
const HUB_COMPACT_BELOW_W = 340;
// Görev penceresi bundan küçükse hub onu sınır almaz (menuPosition.limitBox'ın en küçük kutusu: 200+16 × 160+16).
const HUB_MIN_FRAME_W = 216;
const HUB_MIN_FRAME_H = 176;

// Kenarlar (z-40) + köşeler (z-50, kenarların üstünde); başlıklar testlerde getByTitle ile aranır.
const RESIZE_HANDLES = [
  { dir: 'n', title: tt('window.yukari_boyutlandir'), className: '-top-1 left-3 right-3 h-2 cursor-ns-resize z-40' },
  { dir: 's', title: tt('window.asagi_boyutlandir'), className: '-bottom-1 left-3 right-3 h-2 cursor-ns-resize z-40' },
  { dir: 'w', title: tt('window.sola_boyutlandir'), className: 'top-3 bottom-3 -left-1 w-2 cursor-ew-resize z-40' },
  { dir: 'e', title: tt('window.saga_boyutlandir'), className: 'top-3 bottom-3 -right-1 w-2 cursor-ew-resize z-40' },
  { dir: 'nw', title: tt('window.sol_ust_boyutlandir'), className: '-top-1.5 -left-1.5 size-3.5 cursor-nwse-resize z-50 rounded-sm' },
  { dir: 'ne', title: tt('window.sag_ust_boyutlandir'), className: '-top-1.5 -right-1.5 size-3.5 cursor-nesw-resize z-50 rounded-sm' },
  { dir: 'sw', title: tt('window.sol_alt_boyutlandir'), className: '-bottom-1.5 -left-1.5 size-3.5 cursor-nesw-resize z-50 rounded-sm' },
  { dir: 'se', title: tt('window.sag_alt_boyutlandir'), className: '-bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize z-50 rounded-sm' },
];

export default function WorkspaceTaskFrame({
  task,
  viewport,
  deviceW,
  deviceH,
  vdW,
  vdH,
  frameW,
  frameH,
  isFocused,
  onFocus,
}) {
  const frameRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const prevBoundsRef = useRef(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // Görev hub'ı: ⚙ düğmesine bağlı (anchor = düğme) ya da başlığa sağ tıkla imlecin yanında (anchor = {x, y}).
  const [hub, setHub] = useState(null);
  const defaultWindowing = useLiveSettings()?.phone_handoff_windowing || 'fullscreen';
  const hideTimerRef = useRef(null);
  // Telefona park edilmiş: Android task'ı Display 0'da; çerçeve Workspace'teki YERİNİ tutar.
  const isParked = Boolean(task.handoffToPhone);
  const pipOpen = useWorkspaceTaskPipOpen(task.windowId);
  // Tuş düzeni: bu görevin düzeni düzenleniyor mu / tanımlı mı. Düzenleyici görevin kutusunun İÇİNDE açılır (VD penceresindeki gibi).
  const keymapEditing = useKeymapStore((s) => s.editWindowId === task.windowId);
  // Görevin düzeni: kendi düzeni varsa o (`win:<id>`), yoksa uygulamanın düzeni.
  const keymapCount = useKeymapStore((s) => s.presets[layoutKey(s, task.windowId, task.package)]?.length || 0);
  const keymapEnabled = useKeymapStore((s) => !s.layoutOff[layoutKey(s, task.windowId, task.package)]);
  const overlayWin = useMemo(() => ({ id: task.windowId, package: task.package }), [task.windowId, task.package]);

  const handleMouseEnterHeader = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setIsHeaderHovered(true);
  };

  const handleMouseLeaveHeader = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setIsHeaderHovered(false);
    }, 280);
  };

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const isHeaderVisible = isHeaderHovered || isDragging || isResizing || hub !== null;

  // Use the normalized viewport from WorkspaceCanvas (letterbox offsets + uniform scale)
  const vp = viewport || computeWorkspaceViewport(frameW, frameH, vdW || deviceW, vdH || deviceH);
  const { offsetX, offsetY, scale, vdW: effVdW, vdH: effVdH } = vp;

  const [left, top, right, bottom] = task.bounds || [80, 40, 1600, 960];

  // Subpixel Yuvarlama Kuralı (Plan §1.2): Ofsetlerde floor, boyutlarda round
  const { x: boxLeft, y: boxTop, w: boxW, h: boxH } = applySubpixelRule(
    offsetX + left * scale,
    offsetY + top * scale,
    Math.max(80, (right - left) * scale),
    Math.max(60, (bottom - top) * scale)
  );

  // Determine if task is currently spanning almost the entire workspace
  const isSnappedMaximized =
    left <= 10 &&
    top <= 10 &&
    right >= (effVdW || 1920) - 10 &&
    bottom >= (effVdH || 1080) - 10;

  const commitBounds = (nextBoundsDevicePx) => {
    // Park halinde slot YALNIZCA yerelde tutulur (backend resize komutu Display 0'daki
    // tam ekran telefon uygulamasını bozardı); geri alınırken reclaim isteğiyle gönderilir.
    if (task.handoffToPhone) return;
    const [l, t, r, b] = nextBoundsDevicePx;
    const wPx = Math.max(50, r - l);
    const hPx = Math.max(50, b - t);

    // Yoğunluk kararı tek yerde (çerçeve, Sub-PiP, DeX-içi kırpma): manual → korunur, auto → boyuta göre.
    const { density: targetDpi, mode: densityMode } = resolveTaskDensity(task, wPx, hPx, effVdH || 1080);
    const isManual = densityMode === 'manual';

    const wDp = Math.round((wPx * 160) / targetDpi);
    const hDp = Math.round((hPx * 160) / targetDpi);
    const swDp = Math.min(wDp, hDp);
    const modeStr = swDp >= 720 ? tt('window.desktop_720dp') : swDp >= 600 ? tt('window.tablet_600dp') : 'Phone (<600dp)';

    logger.trace(
      `%c[TaskFrame 📐 COMMIT_RESIZE]%c ${task.title || task.package}\n` +
      `  📏 Piksel Boyut  : ${wPx}×${hPx} px (Bounds: [${nextBoundsDevicePx.join(', ')}])\n` +
      `  🎯 Dinamik DPI   : ${targetDpi} DPI (${isManual ? 'Manuel Kilitli' : 'Dinamik-Fix Oto'})\n` +
      `  📱 Android DP    : ${wDp}×${hDp} dp (smallestWidthDp = ${swDp} dp)\n` +
      `  🎨 Arayüz Düzeni : ${modeStr}`,
      'color: #ec4899; font-weight: bold;',
      'color: inherit;'
    );
    useWindowStore
      .getState()
      .commitWorkspaceTaskBounds(task.windowId, nextBoundsDevicePx, { density: targetDpi, densityMode });
  };

  // 1. Android Back Action
  const handleAndroidBack = async (e) => {
    e?.stopPropagation();
    try {
      const res = await api.post('/api/input/key', {
        window_id: task.windowId,
        kind: 'keycode',
        key: 'back',
      });
      if (res?.at_root || res?.status === 'at_root') {
        useSystemStore
          .getState()
          .pushToast?.(tt('window.baslangic_noktasindasiniz_kapatmak'));
      }
    } catch (err) {
      console.error('[WorkspaceTaskFrame] Back key injection failed:', err);
    }
  };

  // 2. Header Dragging (Move task position)
  const onHeaderPointerDown = (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus?.(task.windowId);
    setIsDragging(true);

    const [l0, t0, r0, b0] = task.bounds;
    logger.trace(
      `%c[TaskFrame 🖐️ DRAG START]%c ${task.title || task.package} başlangıç: [${l0}, ${t0}, ${r0}, ${b0}]`,
      'color: #38bdf8;',
      'color: inherit;'
    );
    dragRef.current = { startX: e.clientX, startY: e.clientY, l0, t0, r0, b0 };

    const onMove = (ev) => {
      const d = dragRef.current;
      if (!d) return;
      const dxDevice = Math.round((ev.clientX - d.startX) / scale);
      const dyDevice = Math.round((ev.clientY - d.startY) / scale);
      const w = d.r0 - d.l0;
      const h = d.b0 - d.t0;

      const nextL = Math.floor(d.l0 + dxDevice);
      const nextT = Math.floor(d.t0 + dyDevice);

      const nextBounds = [nextL, nextT, nextL + w, nextT + h];
      useWindowStore.getState().setWorkspaceTaskBounds(task.windowId, nextBounds);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragRef.current = null;
      setIsDragging(false);
      const current = useWindowStore
        .getState()
        .windows.find((w) => w.isEcoWorkspace)
        ?.tasks.find((t) => t.windowId === task.windowId);
      if (current) commitBounds(current.bounds);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 3. 8-Directional Resizing
  const onResizePointerDown = (e, direction) => {
    if (e.button !== 0 || isParked) return;
    e.stopPropagation();
    e.preventDefault();
    onFocus?.(task.windowId);
    setIsResizing(true);

    const [l0, t0, r0, b0] = task.bounds;
    logger.trace(
      `%c[TaskFrame ↔️ RESIZE START]%c ${task.title || task.package} yön=${direction}, başlangıç: [${l0}, ${t0}, ${r0}, ${b0}]`,
      'color: #f59e0b;',
      'color: inherit;'
    );
    resizeRef.current = { startX: e.clientX, startY: e.clientY, l0, t0, r0, b0, direction };

    const onMove = (ev) => {
      const r = resizeRef.current;
      if (!r) return;
      const dxDevice = Math.round((ev.clientX - r.startX) / scale);
      const dyDevice = Math.round((ev.clientY - r.startY) / scale);

      let newL = r.l0;
      let newT = r.t0;
      let newR = r.r0;
      let newB = r.b0;

      if (r.direction.includes('e')) {
        newR = Math.max(r.l0 + MIN_TASK_W, Math.round(r.r0 + dxDevice));
      }
      if (r.direction.includes('s')) {
        newB = Math.max(r.t0 + MIN_TASK_H, Math.round(r.b0 + dyDevice));
      }
      if (r.direction.includes('w')) {
        newL = Math.min(r.r0 - MIN_TASK_W, Math.floor(r.l0 + dxDevice));
      }
      if (r.direction.includes('n')) {
        newT = Math.min(r.b0 - MIN_TASK_H, Math.floor(r.t0 + dyDevice));
      }

      const nextBounds = [newL, newT, newR, newB];
      useWindowStore.getState().setWorkspaceTaskBounds(task.windowId, nextBounds);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      resizeRef.current = null;
      setIsResizing(false);
      const current = useWindowStore
        .getState()
        .windows.find((w) => w.isEcoWorkspace)
        ?.tasks.find((t) => t.windowId === task.windowId);
      if (current) commitBounds(current.bounds);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 4. Snap / Maximize Inside Workspace Toggle
  const toggleMaximizeInsideWorkspace = (e) => {
    e?.stopPropagation();
    onFocus?.(task.windowId);

    if (isSnappedMaximized && prevBoundsRef.current) {
      const restored = prevBoundsRef.current;
      prevBoundsRef.current = null;
      useWindowStore.getState().setWorkspaceTaskBounds(task.windowId, restored);
      commitBounds(restored);
    } else {
      prevBoundsRef.current = [...task.bounds];
      const maxBounds = [
        0,
        0,
        effVdW || 1920,
        effVdH || 1080,
      ];
      useWindowStore.getState().setWorkspaceTaskBounds(task.windowId, maxBounds);
      commitBounds(maxBounds);
    }
  };

  // ── Başlık ve hub eylemleri: tek yerde, ikisi de AYNI işlevleri çağırır ──
  const closeHub = useCallback(() => setHub(null), []);
  // Hub, GÖREVİN kendi penceresinin (çerçevenin) içinde kalır. Çerçeve hub'ı taşıyamayacak kadar küçükse (ekranda
  // ~216×176'dan az) Workspace tuvali sınırdır: panel hiçbir zaman erişilemez bir yere konmaz.
  const hubBox = useCallback(() => {
    const frame = frameRef.current?.getBoundingClientRect();
    if (frame && frame.width >= HUB_MIN_FRAME_W && frame.height >= HUB_MIN_FRAME_H) return frame;
    return frameRef.current?.closest('[data-workspace-canvas]')?.getBoundingClientRect() ?? null;
  }, []);
  const openHub = (anchor) => {
    const rect = hubBox();
    setHub({ anchor, compact: Boolean(rect) && (rect.height < HUB_COMPACT_BELOW_H || rect.width < HUB_COMPACT_BELOW_W) });
  };
  const store = () => useWindowStore.getState();
  const setDensityAuto = () => {
    const [l, t, r, b] = task.bounds;
    store().setWorkspaceTaskDensity(task.windowId, calculateWorkspaceTaskDpi(r - l, b - t, effVdH || 1080), 'auto');
  };
  const actions = {
    toggleHub: (button) => (hub ? setHub(null) : openHub(button)),
    openHubAt: (point) => openHub(point),
    back: handleAndroidBack,
    // `windowing` verilmezse Ayarlar'daki varsayılan kip; hub / başlık menüsünden seçilirse yalnız bu aktarım için.
    handoff: (windowing) => store().handoffWindowToPhone(task.windowId, windowing),
    reclaim: () => store().reclaimWindow(task.windowId),
    toggleMaximize: toggleMaximizeInsideWorkspace,
    togglePip: () => (pipOpen ? closeWorkspaceTaskPip(task.windowId) : openWorkspaceTaskPip(task, { w: effVdW, h: effVdH })),
    openCrop: () => store().openWorkspaceCropWindow(task.windowId),
    popOut: () => store().popOutToDesktop(task.windowId),
    closeTask: () => store().closeWorkspaceTask(task.windowId),
    openKeymap: () => useKeymapStore.getState().setEditWindowId(task.windowId),
    toggleKeymap: () => {
      const keymap = useKeymapStore.getState();
      const key = layoutKey(keymap, task.windowId, task.package);
      keymap.setLayoutEnabled(key, Boolean(keymap.layoutOff[key]));
    },
    setDensityAuto,
    setDensity: (value) => store().setWorkspaceTaskDensity(task.windowId, value, 'manual'),
  };

  return (
    <motion.div
      data-task-frame-id={task.windowId}
      ref={frameRef}
      onClick={() => onFocus?.(task.windowId)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        'absolute rounded-window pointer-events-none select-none transition-shadow duration-200',
        isFocused
          ? 'z-30 shadow-window'
          : 'z-10 shadow-window opacity-[0.98] hover:opacity-100'
      )}
      initial={false}
      animate={{
        left: boxLeft,
        top: boxTop,
        width: boxW,
        height: boxH,
      }}
      transition={
        isDragging || isResizing
          ? { duration: 0 }
          : { duration: 0.35, ease: [0.16, 1, 0.3, 1] }
      }
    >
      {/* ─── Window Frame Border (OpenDeX Theme System) ─── */}
      <div
        className={cn(
          'absolute inset-0 rounded-window pointer-events-none transition-all duration-200 border',
          isFocused
            ? 'border-primary/80 ring-1 ring-ring/30'
            : 'border-frame-border hover:border-frame-border/90'
        )}
      />

      {/* ─── Top Hover Trigger Zone ─── */}
      <div
        onMouseEnter={handleMouseEnterHeader}
        onMouseLeave={handleMouseLeaveHeader}
        className="absolute top-0 left-0 right-0 h-6 z-30 pointer-events-auto cursor-default"
      />

      {/* ─── Subtle Top Pill Handle Indicator (Visible when Header is Hidden) ─── */}
      <div
        className={cn(
          'absolute top-1 left-1/2 -translate-x-1/2 w-8 h-1 rounded-full bg-frame-border/80 transition-opacity duration-200 pointer-events-none z-20',
          isHeaderVisible ? 'opacity-0' : 'opacity-70'
        )}
      />

      {/* ─── Tuş düzeni: odaktaki görevde rozetler, düzenlenirken editör ─── */}
      {(keymapEditing || (isFocused && keymapCount > 0)) && !isParked && (
        <KeymapperOverlay
          win={overlayWin}
          isEditing={keymapEditing}
          onCloseEdit={() => useKeymapStore.getState().setEditWindowId(null)}
          isHeaderOpen={isHeaderVisible}
        />
      )}

      {/* ─── Görev başlığı: sık kullanılanlar burada, geri kalanı hub'da (sağ tık ya da ⚙) ─── */}
      <WorkspaceTaskHeader
        task={task}
        density={headerDensityFor(boxW)}
        visible={isHeaderVisible}
        focused={isFocused}
        parked={isParked}
        maximized={isSnappedMaximized}
        hubOpen={hub !== null}
        actions={actions}
        surfaceProps={{
          onMouseEnter: handleMouseEnterHeader,
          onMouseLeave: handleMouseLeaveHeader,
          onPointerDown: onHeaderPointerDown,
          onDoubleClick: toggleMaximizeInsideWorkspace,
        }}
      />

      {hub && (
        <WorkspaceTaskHub
          anchor={hub.anchor}
          boundary={hubBox}
          compact={hub.compact}
          task={task}
          parked={isParked}
          keymapCount={keymapCount}
          keymapEnabled={keymapEnabled}
          pipOpen={pipOpen}
          maximized={isSnappedMaximized}
          defaultWindowing={defaultWindowing}
          onClose={closeHub}
          actions={actions}
        />
      )}

      {/* ─── Telefonda park kartı: çerçeve yerini korur, altındaki canvas'a tıklama SIZMAZ ─── */}
      {isParked && (
        <ParkedOnPhoneOverlay
          onFocus={() => onFocus?.(task.windowId)}
          onReclaim={() => useWindowStore.getState().reclaimWindow(task.windowId)}
        />
      )}

      {/* ─── 8-Directional Interactive Resize Handles ───────────────────── */}
      {RESIZE_HANDLES.map(({ dir, title, className }) => (
        <div
          key={dir}
          title={title}
          onPointerDown={(e) => onResizePointerDown(e, dir)}
          className={`pointer-events-auto absolute ${className}`}
        />
      ))}

      {/* Resize dimension & live dynamic DP tooltip when dragging */}
      {isResizing && (() => {
        const liveW = Math.max(50, task.bounds[2] - task.bounds[0]);
        const liveH = Math.max(50, task.bounds[3] - task.bounds[1]);
        const { density: liveDpi, mode: liveMode } = resolveTaskDensity(task, liveW, liveH, effVdH || 1080);
        const isManual = liveMode === 'manual';
        const liveWDp = Math.round((liveW * 160) / liveDpi);
        const liveHDp = Math.round((liveH * 160) / liveDpi);
        return (
          <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-md bg-popover/95 border border-border text-[11px] font-mono text-popover-foreground shadow-lg pointer-events-none whitespace-nowrap z-50 flex items-center gap-2 backdrop-blur-md">
            <span className="font-semibold text-foreground">
             {tt('window.value_value2_px', { value: Math.round(liveW), value2: Math.round(liveH) })}
            </span>
            <span className="text-muted-foreground">•</span>
            <span className="text-primary font-medium">
             {tt('window.livewdp_livehdp_dp', { liveWDp, liveHDp })}
            </span>
            <span className="text-muted-foreground text-[9px]">
             {tt('window.livedpi_dpi_value', { liveDpi, value: isManual ? '🔒' : '⚡' })}
            </span>
          </div>
        );
      })()}
    </motion.div>
  );
}
