import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  X,
  Square,
  Copy,
  ArrowUpRight,
  ChevronLeft,
  SlidersHorizontal,
  Check,
  Smartphone,
  PictureInPicture2,
  ArrowDownToLine,
  AppWindow,
} from 'lucide-react';
import { WindowControl } from '../ui/IconButton.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { MenuSurface } from '../ui/Menu.jsx';
import AudioButton from './titlebar/AudioButton.jsx';
import { api } from '../lib/api.js';
import { useWindowStore } from './windowStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { cn } from '../lib/utils.js';
import { computeWorkspaceViewport } from './WorkspaceCanvas.jsx';
import { calculateWorkspaceTaskDpi, applySubpixelRule, resolveTaskDensity } from './windowMath.js';
import {
  openWorkspaceTaskPip,
  closeWorkspaceTaskPip,
  useWorkspaceTaskPipOpen,
} from './workspacePip/workspacePipHost.js';
import { logger } from '../lib/logger.js';
import { PrecisionSlider } from '../ui/PrecisionSlider.jsx';

const MIN_TASK_W = 100;
const MIN_TASK_H = 80;

const DPI_PRESETS = [
  { label: 'Auto (Dinamik-Fix)', value: 'auto' },
  { label: '160 DPI (Ultra Kompakt)', value: 160 },
  { label: '220 DPI (Kompakt Tablet)', value: 220 },
  { label: '260 DPI (Standart Tablet)', value: 260 },
  { label: '300 DPI (Büyük & Okunaklı)', value: 300 },
  { label: '340 DPI (Telefon Modu - Büyük İkonlar)', value: 340 },
  { label: '400 DPI (Ekstra Büyük)', value: 400 },
];

// Kenarlar (z-40) + köşeler (z-50, kenarların üstünde); başlıklar testlerde getByTitle ile aranır.
const RESIZE_HANDLES = [
  { dir: 'n', title: 'Yukarı Boyutlandır', className: '-top-1 left-3 right-3 h-2 cursor-ns-resize z-40' },
  { dir: 's', title: 'Aşağı Boyutlandır', className: '-bottom-1 left-3 right-3 h-2 cursor-ns-resize z-40' },
  { dir: 'w', title: 'Sola Boyutlandır', className: 'top-3 bottom-3 -left-1 w-2 cursor-ew-resize z-40' },
  { dir: 'e', title: 'Sağa Boyutlandır', className: 'top-3 bottom-3 -right-1 w-2 cursor-ew-resize z-40' },
  { dir: 'nw', title: 'Sol-Üst Boyutlandır', className: '-top-1.5 -left-1.5 size-3.5 cursor-nwse-resize z-50 rounded-sm' },
  { dir: 'ne', title: 'Sağ-Üst Boyutlandır', className: '-top-1.5 -right-1.5 size-3.5 cursor-nesw-resize z-50 rounded-sm' },
  { dir: 'sw', title: 'Sol-Alt Boyutlandır', className: '-bottom-1.5 -left-1.5 size-3.5 cursor-nesw-resize z-50 rounded-sm' },
  { dir: 'se', title: 'Sağ-Alt Boyutlandır', className: '-bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize z-50 rounded-sm' },
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
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const prevBoundsRef = useRef(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showDpiMenu, setShowDpiMenu] = useState(false);
  const [sliderDpi, setSliderDpi] = useState(
    typeof task.density === 'number' ? task.density : 260
  );
  const hideTimerRef = useRef(null);
  // Telefona park edilmiş: Android task'ı Display 0'da; çerçeve Workspace'teki YERİNİ tutar.
  const isParked = Boolean(task.handoffToPhone);
  const pipOpen = useWorkspaceTaskPipOpen(task.windowId);

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

  // İnce ayar kaydırıcısı: sürüklerken YALNIZ etiket (`sliderDpi`) değişir; daemon'a
  // (setWorkspaceTaskDensity -> set_task_density) gerçek uygulama jest bitince TEK kez gider — sürükleme
  // sırasında 120 ms duraksama artık görevi yeniden yerleştirmez. Esc / iptal: eski değere döner, istek yok.
  const commitDensity = (value) => {
    useWindowStore.getState().setWorkspaceTaskDensity(task.windowId, value, 'manual');
  };

  const isHeaderVisible = isHeaderHovered || isDragging || isResizing;

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
    const { density: targetDpi, mode: densityMode } = resolveTaskDensity(task, wPx, hPx, effVdH || 1080, { scale });
    const isManual = densityMode === 'manual';

    const wDp = Math.round((wPx * 160) / targetDpi);
    const hDp = Math.round((hPx * 160) / targetDpi);
    const swDp = Math.min(wDp, hDp);
    const modeStr = swDp >= 720 ? 'Desktop (≥720dp)' : swDp >= 600 ? 'Tablet (≥600dp)' : 'Phone (<600dp)';

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
          .pushToast?.('ℹ️ Başlangıç noktasındasınız. Kapatmak için (X) butonunu kullanın.');
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

  return (
    <motion.div
      data-task-frame-id={task.windowId}
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

      {/* ─── Sleek Hover-Revealed TitleBar Header (OpenDeX Native Theme) ─── */}
      <div
        onMouseEnter={handleMouseEnterHeader}
        onMouseLeave={handleMouseLeaveHeader}
        onPointerDown={onHeaderPointerDown}
        onDoubleClick={toggleMaximizeInsideWorkspace}
        className={cn(
          'absolute top-0 left-0 right-0 h-8 rounded-t-[calc(var(--radius-window)-1px)] bg-frame/95 backdrop-blur-xl border-b border-frame-border pl-2.5 pr-1 flex items-center justify-between transition-all duration-200 z-40 select-none shadow-sm',
          isHeaderVisible
            ? 'opacity-100 translate-y-0 pointer-events-auto'
            : 'opacity-0 -translate-y-2 pointer-events-none',
          isFocused
            ? 'text-foreground'
            : 'text-frame-muted hover:text-foreground'
        )}
      >
        {/* LEFT: App Icon & Title */}
        <div className="flex min-w-0 items-center gap-2 pointer-events-none">
          <AppIcon pkg={task.package} displayName={task.title} size={20} />
          <span
            className="truncate font-mono text-[11px] text-frame-muted font-medium"
            title={task.title || task.package}
          >
            {task.title || task.package}
          </span>
          <span
            className={cn(
              'shrink-0 rounded px-1 text-[9px] font-medium',
              isParked ? 'bg-warning/15 text-warning' : 'bg-primary/10 text-primary',
            )}
            title={isParked ? 'Bu görev telefonun ekranında çalışıyor' : 'Bu görev paylaşımlı çalışma alanında'}
          >
            {isParked ? 'Telefonda' : 'Çalışma Alanı'}
          </span>
        </div>

        {/* RIGHT: Window Controls Matching TitleBar.jsx */}
        <div className="flex items-center gap-0.5" aria-label="Görev kontrolleri">
          {/* Android Back */}
          <WindowControl compact nativeTitle label="Geri" onClick={handleAndroidBack}>
            <ChevronLeft className="size-3.5" />
          </WindowControl>

          {/* Per-Task Isolated DPI Control */}
          <div className={cn('relative', isParked && 'hidden')}>
            <WindowControl compact nativeTitle
              label={
                task.density
                  ? `DPI: ${task.density} (${task.densityMode === 'manual' ? 'Manuel' : 'Auto'})`
                  : 'Görev DPI Yoğunluğu'
              }
              onClick={(e) => {
                e.stopPropagation();
                setShowDpiMenu((prev) => {
                  const next = !prev;
                  if (next) {
                    setSliderDpi(typeof task.density === 'number' ? task.density : 260);
                  }
                  return next;
                });
              }}
            >
              <SlidersHorizontal className="size-3.5" />
            </WindowControl>

            {showDpiMenu && (
              <MenuSurface
                aria-label="Görev yoğunluğu"
                className="absolute right-0 top-full z-50 mt-1 w-48 border-border/80 bg-popover/95 shadow-xl backdrop-blur-xl"
                onClick={(e) => e.stopPropagation()}
                // Menü başlık çubuğunun çocuğu: basış yukarı sızarsa görev sürüklenmeye başlar (kaydırıcıyı
                // tutunca pencere kayıyordu) ve bırakınca gereksiz bir resize-task isteği giderdi.
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border/50 mb-1">
                  Görev Yoğunluğu (DPI)
                </div>
                {DPI_PRESETS.map((preset) => {
                  const isAuto = task.densityMode !== 'manual';
                  const isActive =
                    preset.value === 'auto'
                      ? isAuto
                      : !isAuto && task.density === preset.value;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      className={cn(
                        'flex w-full items-center justify-between px-2 py-1.5 text-xs rounded-sm transition-colors text-left cursor-pointer',
                        isActive
                          ? 'bg-primary text-primary-foreground font-medium'
                          : 'hover:bg-accent hover:text-accent-foreground text-foreground'
                      )}
                      onClick={() => {
                        if (preset.value === 'auto') {
                          const [l, t, r, b] = task.bounds;
                          const autoDpi = calculateWorkspaceTaskDpi(
                            r - l,
                            b - t,
                            effVdH || 1080,
                            { scale },
                          );
                          useWindowStore
                            .getState()
                            .setWorkspaceTaskDensity(task.windowId, autoDpi, 'auto');
                        } else {
                          useWindowStore
                            .getState()
                            .setWorkspaceTaskDensity(
                              task.windowId,
                              preset.value,
                              'manual'
                            );
                        }
                        setShowDpiMenu(false);
                      }}
                    >
                      <span>{preset.label}</span>
                      {isActive && <Check className="size-3.5 shrink-0" />}
                    </button>
                  );
                })}

                {/* Fine-tune slider: continuous DPI between presets */}
                <div className="mt-1 border-t border-border/50 px-2 pt-2 pb-1">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                      İnce Ayar
                    </span>
                    <span className="font-mono text-[11px] text-foreground">
                      {sliderDpi} DPI
                    </span>
                  </div>
                  <PrecisionSlider
                    value={sliderDpi}
                    min={120}
                    max={480}
                    step={4}
                    showButtons={false}
                    onChange={setSliderDpi}
                    onCommit={commitDensity}
                    label="DPI ince ayar kaydırıcısı"
                    unit="DPI"
                  />
                </div>
              </MenuSurface>
            )}
          </div>

          {/* Telefon ⟷ Workspace: aynı fiil, yön görevin ŞU ANKİ konumundan gelir */}
          <WindowControl compact nativeTitle
            label={isParked ? "Çalışma Alanına Geri Al" : 'Telefona Aktar'}
            onClick={(e) => {
              e.stopPropagation();
              const store = useWindowStore.getState();
              if (isParked) store.reclaimWindow(task.windowId);
              else store.handoffWindowToPhone(task.windowId);
            }}
          >
            {isParked ? <ArrowDownToLine className="size-3.5 text-warning" /> : <Smartphone className="size-3.5" />}
          </WindowControl>

          {/* Workspace PiP: encoder maliyeti SIFIR — aynı akıştan yalnızca bu görevin kutusu */}
          {/* This task's own audio channel (Android 13+; hidden otherwise) */}
          <AudioButton windowId={task.windowId} compact />

          {!isParked && (
            <WindowControl compact nativeTitle
              label={pipOpen ? "PiP'i Kapat" : "PiP'e Al (Ayrı Pencere)"}
              onClick={(e) => {
                e.stopPropagation();
                if (pipOpen) closeWorkspaceTaskPip(task.windowId);
                else openWorkspaceTaskPip(task, { w: effVdW, h: effVdH });
              }}
            >
              <PictureInPicture2 className={cn('size-3.5', pipOpen && 'text-info')} />
            </WindowControl>
          )}

          {/* DeX içinde normal pencere: aynı akıştan kırpma, encoder maliyeti SIFIR */}
          {!isParked && (
            <WindowControl compact nativeTitle
              label="DeX'te Pencere Olarak Aç (Kırpılmış)"
              onClick={(e) => {
                e.stopPropagation();
                useWindowStore.getState().openWorkspaceCropWindow(task.windowId);
              }}
            >
              <AppWindow className="size-3.5" />
            </WindowControl>
          )}

          {/* Pop-Out to Native Desktop Window (kendi VD + encoder'ı ister) */}
          {!isParked && (
            <WindowControl compact nativeTitle
              label="Masaüstüne Çıkar (Pop-Out)"
              onClick={(e) => {
                e.stopPropagation();
                useWindowStore.getState().popOutToDesktop(task.windowId);
              }}
            >
              <ArrowUpRight className="size-3.5" />
            </WindowControl>
          )}

          {/* Maximize / Restore Toggle */}
          <WindowControl compact nativeTitle
            label={isSnappedMaximized ? 'Geri Yükle' : 'Çalışma Alanını Kapla'}
            onClick={toggleMaximizeInsideWorkspace}
          >
            {isSnappedMaximized ? (
              <Copy className="size-3 -scale-x-100" />
            ) : (
              <Square className="size-3" />
            )}
          </WindowControl>

          {/* Close Task */}
          <WindowControl compact nativeTitle
            label="Kapat"
            destructive
            onClick={(e) => {
              e.stopPropagation();
              useWindowStore.getState().closeWorkspaceTask(task.windowId);
            }}
          >
            <X className="size-3.5" />
          </WindowControl>
        </div>
      </div>

      {/* ─── Telefonda park kartı: çerçeve yerini korur, altındaki canvas'a tıklama SIZMAZ ─── */}
      {isParked && (
        <div
          className="pointer-events-auto absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-window border border-dashed border-warning/50 bg-scrim p-3 text-center backdrop-blur-sm"
          onPointerDown={(e) => {
            e.stopPropagation();
            onFocus?.(task.windowId);
          }}
        >
          <Smartphone className="size-6 text-warning" />
          <p className="text-xs font-semibold text-scrim-foreground">Telefonda çalışıyor</p>
          <p className="max-w-[220px] text-[10.5px] text-scrim-foreground/60">
            Geri aldığınızda bu yerinde, kaldığı yerden devam eder.
          </p>
          <button
            type="button"
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              useWindowStore.getState().reclaimWindow(task.windowId);
            }}
          >
            Çalışma Alanına Geri Al
          </button>
        </div>
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
        const { density: liveDpi, mode: liveMode } = resolveTaskDensity(task, liveW, liveH, effVdH || 1080, { scale });
        const isManual = liveMode === 'manual';
        const liveWDp = Math.round((liveW * 160) / liveDpi);
        const liveHDp = Math.round((liveH * 160) / liveDpi);
        return (
          <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-md bg-popover/95 border border-border text-[11px] font-mono text-popover-foreground shadow-lg pointer-events-none whitespace-nowrap z-50 flex items-center gap-2 backdrop-blur-md">
            <span className="font-semibold text-foreground">
              {Math.round(liveW)} × {Math.round(liveH)} px
            </span>
            <span className="text-muted-foreground">•</span>
            <span className="text-primary font-medium">
              {liveWDp} × {liveHDp} dp
            </span>
            <span className="text-muted-foreground text-[9px]">
              (@{liveDpi} DPI {isManual ? '🔒' : '⚡'})
            </span>
          </div>
        );
      })()}
    </motion.div>
  );
}
