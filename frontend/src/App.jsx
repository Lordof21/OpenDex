// Composition root: desktop ground + panels + taskbar + overlays, plus the two
// global input layers (WM shortcuts before injection) and startup
// wiring (capability check, event stream, session audio, notices).

import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import Desktop from './desktop/Desktop.jsx';
import WindowFrame from './window/WindowFrame.jsx';
import Taskbar from './taskbar/Taskbar.jsx';
import DexQuickPanelHost from './taskbar/DexQuickPanelHost.jsx';
import SettingsPanel from './settings/SettingsPanel.jsx';
import QrPairing from './wireless/QrPairing.jsx';
import Toasts from './ui/Toasts.jsx';
import NoticeDialog from './ui/NoticeDialog.jsx';
import ToastContainer from './notifications/ToastContainer.jsx';
import { useWindowStore } from './window/windowStore.js';
import { useSystemStore } from './state/systemStore.js';
import { connectEventStream } from './events/eventStream.js';
import { installFilesEvents } from './files/filesEvents.js';
import { focusedAudioWindowId as focusedAudioWindowIdOf } from './window/audioFocus.js';
import { runStartupChecks, resolveEffectiveVideoCodec } from './startup/capabilityCheck.js';
import { checkPendingNotices } from './startup/firstRunNotices.js';
import { getSettings } from './settings/settingsApi.js';
import { useLiveSettings } from './settings/liveSettings.js';
import { sessionAudioPlayer } from './media/audioPlayer.js';
import { isLegacyAudioMode, useAudioMixerStore } from './state/audioMixerStore.js';

import BootSplash from './startup/BootSplash.jsx';
import WallpaperLayer from './desktop/wallpaper/WallpaperLayer.jsx';
import { useWallpaper, useWallpaperSlideshow } from './desktop/wallpaper/useWallpaper.js';
import PipApp from './window/PipApp.jsx';
import WorkspacePipApp from './window/workspacePip/WorkspacePipApp.jsx';
import SnapIndicator from './window/SnapIndicator.jsx';
import AltTabSwitcher from './window/AltTabSwitcher.jsx';
import { useHeldTrue } from './ui/useHeldTrue.js';

export default function App() {
  const [backendHealthy, setBackendHealthy] = useState(false);
  const windows = useWindowStore((s) => s.windows);
  const snapSide = useWindowStore((s) => s.snapSide);
  const connectionState = useSystemStore((s) => s.connectionState);
  const settingsOpen = useSystemStore((s) => s.settingsOpen);
  const deviceIdentity = useSystemStore((s) => s.deviceIdentity);
  const audioMode = useAudioMixerStore((s) => s.mode);
  // The window whose audio "has focus" (ducking): a Workspace container's focused task, a crop window's source task.
  const focusedAudioWindowId = useWindowStore((s) => focusedAudioWindowIdOf(s.windows));
  // Canlı proje ayarları (tek kaynak); backend sağlıklı hâle gelince tazelenir.
  const settings = useLiveSettings(backendHealthy);
  const [notices, setNotices] = useState([]);

  const urlParams = new URLSearchParams(window.location.search);
  const pipWinId = urlParams.get('pip');
  const workspacePipTaskId = urlParams.get('wspip');

  // ---- startup: capabilities, event stream, initial device state -----------
  useEffect(() => {
    if (!backendHealthy) return;
    Promise.all([runStartupChecks(), getSettings().catch(() => null)]).then(
      ([{ engine, codecs }, projectSettings]) => {
        const effectiveCodec = resolveEffectiveVideoCodec(projectSettings?.video_codec);
        const kind = effectiveCodec === 'h265' ? 'hevc' : effectiveCodec === 'av1' ? 'av1' : 'h264';
        const codecSupported = codecs[kind];
        if (!codecSupported) {
          const label = { hevc: 'HEVC (H.265)', av1: 'AV1', h264: 'H.264' }[kind];
          useSystemStore
            .getState()
            .pushToast(`Bu webview (${engine}) ${label} decode desteklemiyor.`);
        }
      },
    );
    installFilesEvents();                                       // fs_transfer / fs_changed → aktarım ve klasör durumu
    connectEventStream();
    useWindowStore.getState().syncWindowsWithBackend();

    const onFocus = () => {
      useWindowStore.getState().syncWindowsWithBackend();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [backendHealthy]);

  // Device list and connection state are pushed by the backend (devices_changed) and read once whenever the event
  // stream (re)connects — wireless/deviceState.js. Nothing polls.

  // ---- audio -----------------------------------------------------------------------------------------------
  // Android 13+: every window has its own channel (audioMixerStore/appAudioMixer, driven by backend events).
  // Legacy (Android ≤12 / old daemon): ONE session stream, whenever the output mode sends phone sound to the laptop.
  // Never both at once — they would capture the same app twice (echo).
  useEffect(() => {
    if (backendHealthy) useAudioMixerStore.getState().refresh();
  }, [backendHealthy]);

  useEffect(() => {
    // Telefon (phone) is the only route that does not play on DeX; İkisi (both) and DeX (pc) do.
    const shouldPlayOnDex = settings?.audio_output_mode !== 'phone' && settings?.enable_audio !== false;
    if (backendHealthy && shouldPlayOnDex && isLegacyAudioMode(audioMode)) {
      sessionAudioPlayer.start();
    } else {
      sessionAudioPlayer.stop();
    }
    return () => {
      sessionAudioPlayer.stop();
    };
  }, [backendHealthy, settings?.enable_audio, settings?.audio_output_mode, audioMode]);

  useEffect(() => {
    useAudioMixerStore.getState().setFocusedWindow(focusedAudioWindowId);
  }, [focusedAudioWindowId]);

  // ---- one-time notices ----------------------------------------------------
  useEffect(() => {
    if (deviceIdentity?.android_id) {
      checkPendingNotices(deviceIdentity.android_id).then(setNotices);
    }
  }, [deviceIdentity?.android_id]);

  // ---- global keyboard routing & AppLauncher shortcut ---
  useEffect(() => {
    const onKeyDown = (e) => {
      // Cmd+K or Ctrl+K -> App launcher search palette
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useSystemStore.getState().toggleLaunchpad();
        return;
      }
      // Layer 1: window-manager shortcuts — consumed here, NEVER injected (keyboardInject.isWindowManagerShortcut
      // aynı tabloyu okur: canvas dinleyicileri tanınan tuşları telefona iletmez).
      useWindowStore.getState().handleWindowManagerShortcut(e);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const wallpaper = useWallpaper();
  useWallpaperSlideshow();
  const [pairingDismissed, setPairingDismissed] = useState(false);
  // The QR panel goes away only when the connection stays up: a bind that fails at once (an adb entry that is "offline")
  // passes through "connected" for a few milliseconds and would otherwise tear the panel down and restart its listener.
  const showPairing = useHeldTrue(connectionState === 'disconnected' && windows.length === 0 && !pairingDismissed, 1500);

  if (pipWinId) {
    return <PipApp winId={pipWinId} />;
  }

  if (workspacePipTaskId) {
    return <WorkspacePipApp taskWindowId={workspacePipTaskId} />;
  }

  return (
    <div
      data-wallpaper-tone={wallpaper.tone}
      className="desktop-wallpaper relative flex h-full w-full flex-col overflow-hidden select-none"
    >
      {/* Kapak resmi: ilk çocuk → diğer her şey DOM sırasıyla üstüne biner (desktop/wallpaper/). */}
      <WallpaperLayer wallpaper={wallpaper} />

      {/* Global GPU Sharpening SVG Filter Kernels (Adaptive & Ultra Lanczos/CAS) */}
      <svg className="pointer-events-none absolute size-0 opacity-0" aria-hidden="true">
        <defs>
          <filter id="dex-sharpen-adaptive" x="0%" y="0%" width="100%" height="100%">
            <feConvolveMatrix
              order="3"
              preserveAlpha="true"
              kernelMatrix="
                 0   -0.18   0
               -0.18  1.72 -0.18
                 0   -0.18   0"
            />
          </filter>
          <filter id="dex-sharpen-ultra" x="0%" y="0%" width="100%" height="100%">
            <feConvolveMatrix
              order="3"
              preserveAlpha="true"
              kernelMatrix="
               -0.15 -0.35 -0.15
               -0.35  3.00 -0.35
               -0.15 -0.35 -0.15"
            />
          </filter>
        </defs>
      </svg>

      <AnimatePresence>
        {!backendHealthy && (
          <BootSplash onReady={() => setBackendHealthy(true)} />
        )}
      </AnimatePresence>

      {backendHealthy && (
        <>
          {/* Main Desktop Stage & Workspace Area (Takes all height above taskbar) */}
          <div className="relative min-h-0 flex-1 w-full overflow-hidden">
            <Desktop />

            <AnimatePresence>
              {windows.map((win) => (
                <WindowFrame key={win.id} win={win} settings={settings} />
              ))}
            </AnimatePresence>

            <SnapIndicator snapSide={snapSide} />
          </div>

          {/* Physical Taskbar (takes real layout space h-[50px] shrink-0) */}
          <Taskbar />
          <DexQuickPanelHost />

          {/* Global Dialogs & Modals */}
          <AnimatePresence>
            {showPairing && <QrPairing onClose={() => setPairingDismissed(true)} />}
          </AnimatePresence>

          <SettingsPanel />
          <Toasts />
          <ToastContainer />
          <NoticeDialog
            androidId={deviceIdentity?.android_id}
            notice={notices[0]}
            onDone={() => setNotices((n) => n.slice(1))}
          />
          <AltTabSwitcher />
        </>
      )}
    </div>
  );
}
