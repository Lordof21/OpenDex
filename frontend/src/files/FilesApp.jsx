// Dosyalar uygulaması — bir pencerenin tüm içeriği. Kendi içinde uyum sağlar: kapsayıcı genişliğine göre
//   geniş  (≥ 900 px) : kenar çubuğu + (tek ya da çift bölme) + durum çubuğu
//   orta   (≥ 560 px) : kenar çubuğu (kapatılabilir) + tek bölme
//   dar    (< 560 px) : telefon düzeni — tek bölme, iki satırlı liste, alt sekmeler, yerler alttan sayfa
// Tüm durum `useFilesStore`/`useTransferStore`'dadır; bu bileşen yalnız yerleşimi, yaşam döngüsünü ve pencere düzeyindeki
// şeyleri (dış sürükleme, odak, canlı bölge) bağlar.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils.js';
import { Dialog } from '../ui/Dialog.jsx';
import { useSystemStore } from '../state/systemStore.js';
import CompactTabs from './CompactTabs.jsx';
import DragGhost from './DragGhost.jsx';
import FilesDialogs from './FilesDialogs.jsx';
import FilesSidebar from './FilesSidebar.jsx';
import FilesToolbar, { PaneHeader } from './FilesToolbar.jsx';
import FolderView from './FolderView.jsx';
import PreviewOverlay from './PreviewOverlay.jsx';
import StatusBar from './StatusBar.jsx';
import TransferTray from './TransferTray.jsx';
import { defaultLocation, useFilesStore } from './filesStore.js';
import { useContainerSize, useLayoutMode } from './useContainerSize.js';
import { useTransferStore } from './transferStore.js';
import { useExternalDrop } from './useExternalDrop.js';

export default function FilesApp({ win }) {
  const winId = win.id;
  const store = useFilesStore;
  const ready = useFilesStore((s) => Boolean(s.wins[winId]));
  const [rootRef, size] = useContainerSize();
  const mode = useLayoutMode(size.width);
  const [placesOpen, setPlacesOpen] = useState(false);
  const [externalHover, setExternalHover] = useState(false);
  const recent = useRef({});

  // Yaşam döngüsü: durumu oluştur; pencere kapanınca (bileşen sökülünce) akışları iptal edip sil.
  useLayoutEffect(() => {
    store.getState().ensureWindow(winId, win.initialLoc ?? null);
    if (win.initialLoc) store.getState().load(winId, 0, { mode: 'navigate' });
    return () => store.getState().closeWindowState(winId);
  }, [winId]);                                                       // eslint-disable-line react-hooks/exhaustive-deps

  // Yerler: ilk açılışta, telefon bağlantısı değişince yenilenir. Konumsuz bölme varsayılan konuma gider.
  const connection = useSystemStore((s) => s.connectionState);
  const placesStatus = useFilesStore((s) => s.placesStatus);
  useEffect(() => {
    store.getState().loadPlaces(store.getState().places.device).catch(() => {});
  }, [connection, store]);

  const layout = useFilesStore((s) => s.wins[winId]?.layout);
  const activePane = useFilesStore((s) => s.wins[winId]?.activePane ?? 0);
  const sidebarOpen = useFilesStore((s) => s.wins[winId]?.sidebarOpen);
  const provider = useFilesStore((s) => s.wins[winId]?.panes[activePane]?.loc?.provider);
  const loc = useFilesStore((s) => s.wins[winId]?.panes[activePane]?.loc);
  const paneCount = useFilesStore((s) => s.wins[winId]?.panes.length ?? 0);
  const needsLoc = useFilesStore((s) => s.wins[winId]?.panes.some((p) => !p.loc));

  useEffect(() => {
    if (!needsLoc || placesStatus !== 'ready') return;
    const s = store.getState();
    s.wins[winId]?.panes.forEach((p, pi) => {
      if (!p.loc) {
        const dest = defaultLocation(s.places, pi === 0 ? 'phone' : 'pc');
        if (dest) s.navigate(winId, pi, dest);
      }
    });
  }, [needsLoc, placesStatus, winId, store]);

  useEffect(() => { if (loc) recent.current[loc.provider] = loc; }, [loc]);

  const onHover = useCallback((v) => setExternalHover(v), []);
  useExternalDrop(winId, rootRef, { onHover });

  const pickProvider = (next) => {
    const s = store.getState();
    const dest = recent.current[next] || defaultLocation(s.places, next);
    if (dest) s.navigate(winId, activePane, dest);
    useTransferStore.getState().setTrayOpen(false);
  };

  if (!ready) return <div ref={rootRef} className="h-full w-full bg-background" />;

  const compact = mode === 'compact';
  const dual = layout === 'dual' && mode === 'wide' && paneCount >= 2;
  const showSidebar = !compact && sidebarOpen;
  const shown = dual ? [0, 1] : [activePane];

  return (
    <div
      ref={rootRef}
      data-files-root
      data-win-id={winId}
      data-layout={mode}
      className={cn('relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-background text-foreground', externalHover && 'ring-2 ring-inset ring-primary/60')}
    >
      <FilesToolbar winId={winId} layoutMode={mode} onOpenPlaces={() => setPlacesOpen(true)} />
      <div className="flex min-h-0 flex-1">
        {showSidebar && <FilesSidebar winId={winId} />}
        <div className={cn('flex min-w-0 flex-1', dual && 'divide-x divide-border/70')}>
          {shown.map((pi) => (
            <div key={pi} className="flex min-w-0 flex-1 flex-col" onPointerDownCapture={() => store.getState().setActivePane(winId, pi)}>
              <PaneHeader winId={winId} pi={pi} layoutMode={mode} />
              <FolderView winId={winId} pi={pi} layoutMode={mode} active={activePane === pi} dual={dual} />
            </div>
          ))}
        </div>
      </div>
      {compact && <CompactTabs provider={provider} onPick={pickProvider} />}
      <StatusBar winId={winId} layoutMode={mode} />
      <TransferTray compact={compact} />
      <PreviewOverlay winId={winId} compact={compact} />
      <FilesDialogs winId={winId} focused={Boolean(win.focused)} />
      <Dialog open={placesOpen} onClose={() => setPlacesOpen(false)} label="Yerler" position="absolute" align="top" className="max-w-sm p-1">
        <FilesSidebar winId={winId} variant="sheet" onNavigated={() => setPlacesOpen(false)} />
      </Dialog>
      <DragGhost />
    </div>
  );
}
