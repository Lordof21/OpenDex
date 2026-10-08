// Görev çubuğu pencere önizlemesi (Windows tarzı): üstte [ikon · ad · kapat], altında pencerenin TAM karesi.
//
//   - Kutu pencerenin GERÇEK en-boy oranındadır (dikey telefon dar-uzun, yatay pencere geniş) ve kare asla kırpılmaz. Eskiden sabit
//     128 px'lik bir ızgara hücresine konan dikey kare kırpılıp yalnız üst kısmı ("başı") görünüyordu.
//   - Tuval, ekrandaki GERÇEK piksel boyutunda (CSS boyutu × devicePixelRatio) yüksek kaliteli, çok adımlı küçültmeyle çizilir; tarayıcıya
//     büyük bir tuvali CSS ile küçülttürmek (tırtık/titreme) ve her karede tam çözünürlük kopyalamak (60 fps × 1080p) kalktı. Canlı pencerede
//     ~15 fps yeter; küçültülmüş pencerede önbellekteki son kare bir kez çizilir.
//   - Sahte pencere başlığı (üç nokta + ad) yok: ikon + ad kartın başlık satırında zaten var.
//   - Önizlemeye tıklamak görev çubuğu düğmesiyle AYNI eylemdir: açık pencere küçülür, küçültülmüş pencere geri yüklenir, arkadaki öne gelir.
import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { PanelShell } from './PanelShell.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { useWindowStore } from '../window/windowStore.js';
import { iconPackageOf } from '../window/workspacePackage.js';
import { getWindowThumbnail, subscribeThumbnail } from '../state/windowThumbnailCache.js';
import { drawDownscaled } from '../lib/downscale.js';
import { ACTION_LABEL, cardLeft, cardWidthFor, clampAspect, fitBox, toggleActionFor } from './taskbarModel.js';

const LIVE_INTERVAL_MS = 66; // ~15 fps: küçük bir önizleme için yeterli, 60 fps tam çözünürlük kopyalamaya göre çok ucuz
const ASPECT_EPSILON = 0.012; // kaynak oranı bu kadar değişmeden kutu yeniden boyutlanmaz (sürekli yeniden yerleşimi önler)

/** Canlı video tuvali (VideoCanvas / WorkspaceCanvas `data-window-id` taşır). Kimlik karşılaştırması DOM'da yapılır, seçici kurulmaz. */
function findLiveCanvas(windowId) {
  for (const canvas of document.querySelectorAll('canvas[data-window-id]')) {
    if (canvas.dataset.windowId === windowId && canvas.width > 0 && canvas.height > 0) return canvas;
  }
  return null;
}

/** Çizilecek kaynak: açık pencerede canlı tuval; küçültülmüşte önbellekteki son kare (tuval yoksa/karşıtı yedek). */
export function pickSource(windowId, minimized) {
  if (!windowId) return null;
  const cached = getWindowThumbnail(windowId);
  const live = findLiveCanvas(windowId);
  return minimized ? cached || live : live || cached;
}

function initialAspect(win, windowId) {
  const cached = windowId ? getWindowThumbnail(windowId) : null;
  if (cached) return clampAspect(cached.width / cached.height);
  if (win?.deviceW > 0 && win?.deviceH > 0) return clampAspect(win.deviceW / win.deviceH);
  return 16 / 9;
}

export function WindowPreview({
  app,
  anchorX = null,
  onActivate,
  onClose,
  onEnter,
  onLeave,
  ...motionProps
}) {
  const canvasRef = useRef(null);

  const windows = useWindowStore((s) => s.windows);
  const targetWin = windows.find(
    (w) => w.id === app?.id || w.package === (app?.package || app?.id) || w.appId === (app?.id || app?.package),
  );
  const targetWinId = targetWin?.id || app?.id;
  const isMinimized = Boolean(targetWin?.minimized);
  const action = toggleActionFor(targetWin);

  const [aspect, setAspect] = useState(() => initialAspect(targetWin, targetWinId));
  const aspectRef = useRef(aspect);
  const [hasImage, setHasImage] = useState(false);
  const paintedRef = useRef(false);

  const box = fitBox(aspect);
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const pxW = Math.round(box.w * dpr);
  const pxH = Math.round(box.h * dpr);

  useEffect(() => {
    let alive = true;
    let raf = 0;
    let last = 0;

    const paint = () => {
      const dst = canvasRef.current;
      const src = pickSource(targetWinId, isMinimized);
      if (!alive || !dst || !src) return;
      const next = clampAspect(src.width / src.height);
      if (Math.abs(next - aspectRef.current) > ASPECT_EPSILON * aspectRef.current) {
        aspectRef.current = next;
        setAspect(next); // kutu değişir → tuval yeniden boyutlanır → efekt yeniden çalışıp çizer
        return;
      }
      if (drawDownscaled(dst, src) && !paintedRef.current) {
        paintedRef.current = true;
        setHasImage(true);
      }
    };

    paint();
    const unsubscribe = subscribeThumbnail((windowId) => {
      if (windowId === targetWinId && isMinimized) paint(); // küçültülmüşken canlı kare yok; yeni önbellek karesi gelince yenile
    });
    if (!isMinimized) {
      const loop = (now) => {
        if (!alive) return;
        if (now - last >= LIVE_INTERVAL_MS && !document.hidden) {
          last = now;
          paint();
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      unsubscribe();
    };
  }, [targetWinId, isMinimized, pxW, pxH]);

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const cardW = cardWidthFor(box.w);
  const positionStyle = { left: `${cardLeft(anchorX, cardW, vw)}px`, width: `${cardW}px` };

  const displayName = app?.name || targetWin?.title || targetWin?.package || 'Uygulama';
  const iconPkg = targetWin ? iconPackageOf(targetWin) : app?.package;

  return (
    <PanelShell
      {...motionProps}
      style={positionStyle}
      className="border border-border/80 bg-popover/95 p-2.5 shadow-2xl backdrop-blur-3xl rounded-xl"
    >
      <div onPointerEnter={onEnter} onPointerLeave={onLeave}>
        <div className="flex items-center gap-2 pb-2">
          <AppIcon app={app} pkg={iconPkg} displayName={displayName} size={24} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold leading-4">{displayName}</span>
            {isMinimized && <span className="block text-[10px] leading-3 text-muted-foreground">Küçültüldü</span>}
          </span>
          {app?.id !== 'lovable' && (
            <button
              type="button"
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
              onClick={onClose}
              aria-label={`${displayName} uygulamasını kapat`}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex justify-center">
          <button
            type="button"
            onClick={onActivate}
            aria-label={`${displayName}: ${ACTION_LABEL[action] ?? 'Aç'}`}
            data-testid="window-preview-thumb"
            className="group/thumb relative block cursor-pointer overflow-hidden rounded-lg bg-video-backdrop p-0 outline-none ring-1 ring-border/70 transition-shadow duration-150 hover:ring-2 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-ring"
            style={{ width: box.w, height: box.h }}
          >
            <canvas
              ref={canvasRef}
              width={pxW}
              height={pxH}
              style={{ width: box.w, height: box.h }}
              className={`block transition-opacity duration-150 ${hasImage ? 'opacity-100' : 'opacity-0'}`}
            />
            {!hasImage && (
              <span className="absolute inset-0 grid place-items-center bg-gradient-to-br from-muted/70 to-muted/20" aria-hidden="true">
                <AppIcon app={app} pkg={iconPkg} displayName={displayName} size={44} className="opacity-80" />
              </span>
            )}
            {action && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/55 to-transparent pb-1.5 pt-5 text-[10px] font-semibold text-image-foreground opacity-0 transition-opacity duration-150 group-hover/thumb:opacity-100 group-focus-visible/thumb:opacity-100"
              >
                {ACTION_LABEL[action]}
              </span>
            )}
          </button>
        </div>
      </div>
    </PanelShell>
  );
}

export default WindowPreview;
