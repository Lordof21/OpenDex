import React, { useEffect, useState } from 'react';
import { useWindowStore, getSavedAppGeometry, settingsForWindow, targetDisplaySizeForMode } from './windowStore.js';
import { connectEventStream } from '../events/eventStream.js';
import BootSplash from '../startup/BootSplash.jsx';
import TitleBar from './TitleBar.jsx';
import VideoCanvas from './VideoCanvas.jsx';
import { getSettings } from '../settings/settingsApi.js';
import { api } from '../lib/api.js';

export default function PipApp({ winId }) {
  const [backendHealthy, setBackendHealthy] = useState(false);
  const [settings, setSettings] = useState(null);
  const win = useWindowStore((s) => s.windows.find((w) => w.id === winId));

  useEffect(() => {
    if (!backendHealthy) return;
    connectEventStream();
    getSettings().then(setSettings).catch(() => {});

    Promise.all([
      api.get('/api/windows').catch(() => []),
      api.get('/api/apps').catch(() => []),
    ])
      .then(([windowsList, appsList]) => {
        const found = Array.isArray(windowsList) && windowsList.find((w) => w.window_id === winId);
        if (found) {
          const appMeta = Array.isArray(appsList) && appsList.find((a) => a.package === found.package);
          const displayTitle = appMeta?.display_name || found.package;

          useWindowStore.setState((s) => {
            if (s.windows.some((w) => w.id === winId)) return s;
            return {
              windows: [
                ...s.windows,
                {
                  id: found.window_id,
                  package: found.package,
                  title: displayTitle,
                  x: 0,
                  y: 0,
                  w: window.innerWidth,
                  h: window.innerHeight,
                  zIndex: 1,
                  minimized: false,
                  maximized: true,
                  focused: true,
                  fps: found.fps || 0,
                  frozen: found.frozen || false,
                  wsUrl: `/ws/video/${found.window_id}`,
                  deviceW: found.width,
                  deviceH: found.height,
                  dpi: null,
                  resolutionLocked: false,
                  pinned: true,
                },
              ],
            };
          });
        }
      })
      .catch((err) => {
        console.error('[PipApp] Failed to fetch window details:', err);
      });
  }, [backendHealthy, winId]);

  useEffect(() => {
    if (!backendHealthy || !win) return;

    const triggerPipResize = () => {
      // The PiP webview has no main-window store: the window's own settings come from its persisted geometry.
      const own = settingsForWindow({ overrides: getSavedAppGeometry(win.package)?.overrides }, settings);
      const mode = own?.resolution_mode || 'dynamic_fit';
      const target = targetDisplaySizeForMode(
        mode,
        settings?.custom_dpi || 0,
        settings?.target_dp || 0,
        window.innerWidth,
        window.innerHeight,
      );
      if (target) {
        const store = useWindowStore.getState();
        const current = store.windows.find((w) => w.id === winId);
        if (current && !current.resolutionLocked) {
          store.commitResize(winId, target.w, target.h, target.dpi, { settings }).catch((e) => {
            console.warn('[PipApp] Dynamic resolution resize error:', e);
          });
        }
      }
    };

    triggerPipResize();

    let resizeTimeout;
    const onResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(triggerPipResize, 300);
    };

    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(resizeTimeout);
      window.removeEventListener('resize', onResize);
    };
  }, [backendHealthy, winId, !!win]);

  if (!backendHealthy) {
    return <BootSplash onReady={() => setBackendHealthy(true)} />;
  }

  if (!win) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-video-backdrop text-scrim-foreground/60 text-sm">
        Bağlantı bekleniyor...
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-video-backdrop">
      <TitleBar 
        win={win} 
        onDragStart={() => {}} 
        frameRef={{ current: null }} 
        pipWindow={window} 
        setPipWindow={(w) => {
          if (w === null) {
            if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_IPC__) {
              import('@tauri-apps/api/webviewWindow').then(m => m.getCurrentWebviewWindow().close()).catch(() => window.close());
            } else {
              window.close();
            }
          }
        }} 
        isPip={true} 
      />
      <VideoCanvas win={win} settings={settings} />
    </div>
  );
}
