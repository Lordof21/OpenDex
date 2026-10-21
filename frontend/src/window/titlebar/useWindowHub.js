// Pencere Hub'ının tek kaynağı: açık/kapalı durumu, dışarı tıklayınca / Esc ile kapanma ve panelin tüm eylemleri.
// DeX içindeki pencere (WindowFrame) ile Tauri'de ayrı açılan PiP penceresi (PipApp) AYNI Hub'ı bu kancayla kurar — PiP'te
// Hub'ın "tıklanamaz" kalmasının nedeni PiP'in bu mantığın hiçbirini taşımamasıydı.
//
// Pencereye özgü üç eylem dışarıdan verilir (DeX'te uygulama içi pencere, PiP'te işletim sistemi penceresi demektir):
// `onFullscreen`, `onPip`, `onAlwaysOnTop`; ayrıca isteğe bağlı `onSend` (Workspace'e gönder).

import { useCallback, useEffect, useRef, useState } from 'react';
import { restartDoneToast, restartFailedToast } from '../appRestart.js';
import { reloadPageWithToast, useWebReloadAvailable } from '../webReload.js';
import { isCropWindow } from '../cropWindow.js';
import { isFilesWindow } from '../filesWindow.js';
import { isFrontendOnlyWindow } from '../frontendOnly.js';
import { isMirrorPackage } from '../mirrorPackage.js';
import { layoutKey, useKeymapStore } from '../../keymapper/keymapStore.js';
import {
  HEADER_MODE_LABELS,
  dynamicDpStatusOf,
  fitLabel,
  nextFitMode,
  nextHeaderMode,
  normalizeHeaderMode,
  useWindowStore,
} from '../windowStore.js';
import { useSystemStore } from '../../state/systemStore.js';
import { logger } from '../../lib/logger.js';
import { t } from '../../i18n/index.js';

export function useWindowHub({
  win,
  effectiveSettings,
  pipOpen = false,
  onPip,
  onFullscreen,
  onAlwaysOnTop,
  onSend,
}) {
  const [hubOpen, setHubOpen] = useState(false);
  const hubButtonRef = useRef(null);
  const hubPanelRef = useRef(null);
  const [workspaceSent, setWorkspaceSent] = useState(false);
  const [restartingApp, setRestartingApp] = useState(false);
  const [reloadingPage, setReloadingPage] = useState(false);

  // Close the Hub on an outside press / Escape.
  useEffect(() => {
    if (!hubOpen) return undefined;
    const handleClickOutside = (e) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (!hubPanelRef.current?.contains(target) && !hubButtonRef.current?.contains(target)) setHubOpen(false);
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setHubOpen(false);
    };
    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [hubOpen]);

  const toggleHub = useCallback(() => setHubOpen((open) => !open), []);

  const cycleImageMode = useCallback(() => {
    useWindowStore.getState().setWindowFitMode(win.id, nextFitMode(win.videoFitMode));
  }, [win.id, win.videoFitMode]);

  // "Ekran kilidi": akışın (sanal ekranın) px + DPI'ını sabitler. React penceresi serbest kalır — istenen boyuta getirilir, görüntü
  // pencereye "Görüntü ölçeği"ne göre sığdırılır.
  const toggleDisplayLock = useCallback(() => {
    useWindowStore.getState().toggleResolutionLock(win.id);
  }, [win.id]);

  // Pencerenin arkasında gerçek bir Android uygulaması + kendi akışı var (Workspace kabı, Dosyalar/kırpma ve ayna değil).
  const hasAppSession = !win.isEcoWorkspace && !isFrontendOnlyWindow(win) && !isMirrorPackage(win.package);

  // "Uygulamayı yeniden başlat": takılan / siyah kalan uygulamayı AYNI pencerede yeniler. Sonuç arka uçta doğrulanır — toast gerçeği söyler.
  const restartApp = useCallback(async () => {
    if (restartingApp) return;
    setRestartingApp(true);
    try {
      const result = await useWindowStore.getState().restartWindowApp(win.id);
      useSystemStore.getState().pushToast?.(restartDoneToast(result));
    } catch (err) {
      useSystemStore.getState().pushToast?.(restartFailedToast(err));
    } finally {
      setRestartingApp(false);
      setHubOpen(false);
    }
  }, [win.id, restartingApp]);

  // "Sayfayı yenile": Chromium tabanlı tarayıcıda açık sekmeyi normal yenileme ile yeniden yükler (kullanıcı isteğiyle). Satır yalnız
  // Hub açıkken telefona sorulur ve yalnız web sayfası olan pencerede görünür.
  const webReloadAvailable = useWebReloadAvailable(win.id, hubOpen && hasAppSession);
  const reloadPage = useCallback(async () => {
    if (reloadingPage) return;
    setReloadingPage(true);
    await reloadPageWithToast(win.id);
    setReloadingPage(false);
    setHubOpen(false);
  }, [win.id, reloadingPage]);

  // "Tuş düzeni": editör VideoCanvas'ta yaşar; yalnız onu çizen pencere sunar (Workspace kabı, kırpma ve Dosyalar değil).
  const hasKeymapEditor = !win.isEcoWorkspace && !isCropWindow(win) && !isFilesWindow(win);
  const keymapCount = useKeymapStore((s) => s.presets[layoutKey(s, win.id, win.package)]?.length || 0);
  // Düzen kapatılabilir (sohbet yazarken gibi): düzen silinmez, yalnız motor ve rozetler onu yok sayar.
  const keymapEnabled = useKeymapStore((s) => !s.layoutOff[layoutKey(s, win.id, win.package)]);
  const toggleKeymapEnabled = useCallback(() => {
    const store = useKeymapStore.getState();
    const key = layoutKey(store, win.id, win.package);
    store.setLayoutEnabled(key, Boolean(store.layoutOff[key]));
  }, [win.id, win.package]);
  const openKeymapEditor = useCallback(() => {
    useKeymapStore.getState().setEditWindowId(win.id);
    setHubOpen(false);
  }, [win.id]);

  const cycleHeaderMode = useCallback(() => {
    useWindowStore.getState().setHeaderMode(win.id, nextHeaderMode(win.headerMode));
  }, [win.id, win.headerMode]);

  const handleSendToWorkspace = useCallback(async () => {
    setWorkspaceSent(true);
    logger.trace(`[OpenDeX:HUB 🏠] handleSendToWorkspace tetiklendi -> winId=${win.id} pkg=${win.package}`);
    try {
      if (onSend) await onSend();
      else await useWindowStore.getState().dockToWorkspace(win.id);
      useSystemStore.getState().pushToast?.(t('window.pencere_calisma_alanina_aktarildi'));
    } catch (err) {
      console.error('[OpenDeX:HUB ❌] dockToWorkspace başarısız:', err);
      useSystemStore.getState().pushToast?.(t('window.calisma_alanina_aktarma_basarisiz'));
    } finally {
      setTimeout(() => setWorkspaceSent(false), 1800);
      setHubOpen(false);
    }
  }, [win.id, win.package, onSend]);

  // Genel "Gerçek çözünürlük" kapalıyken karo "Açık" göstermez (dynamicDpStatusOf).
  const dpStatus = dynamicDpStatusOf(win, effectiveSettings);

  const panelProps = {
    panelRef: hubPanelRef,
    compact: (win.w || 480) < 380,
    imageLabel: fitLabel(win.videoFitMode, effectiveSettings?.video_fit_mode),
    onCycleImage: cycleImageMode,
    absoluteFullscreen: Boolean(win.fullscreen),
    onFullscreen,
    pipOpen,
    onPip,
    alwaysOnTop: Boolean(win.pinned),
    onAlwaysOnTop,
    displayLocked: Boolean(win.resolutionLocked),
    onDisplayLock: hasAppSession ? toggleDisplayLock : undefined,
    onRestartApp: hasAppSession ? restartApp : undefined,
    restartingApp,
    onReloadPage: hasAppSession && webReloadAvailable ? reloadPage : undefined,
    reloadingPage,
    dynamicDp: dpStatus.active,
    dynamicDpMode: dpStatus.mode,
    dynamicDpLocked: dpStatus.locked,
    dynamicResolutionOff: dpStatus.resolutionOff,
    onDynamicDp: () => useWindowStore.getState().cycleDynamicDp(win.id),
    onKeymap: hasKeymapEditor ? openKeymapEditor : undefined,
    keymapCount,
    keymapEnabled,
    onToggleKeymap: hasKeymapEditor ? toggleKeymapEnabled : undefined,
    headerModeLabel: HEADER_MODE_LABELS[normalizeHeaderMode(win.headerMode)],
    headerModeActive: normalizeHeaderMode(win.headerMode) !== 'follow',
    onCycleHeader: cycleHeaderMode,
    workspaceSent,
    onSend: handleSendToWorkspace,
    variant: isFrontendOnlyWindow(win) ? 'workspace-crop' : 'video',
  };

  return { hubOpen, setHubOpen, toggleHub, hubButtonRef, hubPanelRef, hasAppSession, panelProps };
}
