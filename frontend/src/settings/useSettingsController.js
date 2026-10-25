// Ayarlar penceresinin TEK davranış katmanı: canlı ayarı arayüz değerlerine çevirir (backend ⟷ arayüz dönüşümleri tek
// yerde) ve her değişikliği doğru kayıt akışına bağlar. Bölüm bileşenleri yalnız bu hook'un çıktısını çizer; böylece
// aynı ayar aramadan, profilden ya da bölümden değişse de aynı yamayı (tek atomik kayıt) üretir.

import { useCallback, useRef } from 'react';
import { useTheme } from '../state/ThemeContext.jsx';
import { useSystemStore } from '../state/systemStore.js';
import { modeOf, targetDisplaySizeForWindow, useWindowStore } from '../window/windowStore.js';
import { isLegacyAudioMode, useAudioMixerStore } from '../state/audioMixerStore.js';
import { sessionAudioPlayer } from '../media/audioPlayer.js';
import { updateSettings, useLiveSettings } from './liveSettings.js';

const DPI_FALLBACK = 206;

function boxOf(win) {
  return {
    w: win.w || (typeof window !== 'undefined' ? window.innerWidth : 1920),
    h: win.h || (typeof window !== 'undefined' ? window.innerHeight - 50 : 1030),
  };
}

export function useSettingsController() {
  const { theme, setTheme } = useTheme();
  const live = useLiveSettings() || {};
  const flag = (key, fallback) => (live[key] === undefined ? fallback : Boolean(live[key]));

  const smartResize = flag('dynamic_resolution_enabled', true);
  const resolution = live.resolution_mode || 'dynamic_fix';
  const dpi = live.custom_dpi > 0 ? String(live.custom_dpi) : 'auto';
  const targetDp = live.target_dp > 0 ? String(live.target_dp) : 'auto';
  const sharpenRaw = live.sharpening_mode || live.sharpening;
  const values = {
    smartResize,
    resolution,
    dpi,
    targetDp,
    codec: live.video_codec || 'auto',
    subpixel: flag('pixel_perfect_dpr', true),
    instantResize: flag('resize_instant_apply', false),
    sharpen: sharpenRaw ? (sharpenRaw === 'adaptive' ? 'smart' : sharpenRaw) : 'smart',
    stealth: flag('stealth_dpi_enabled', true),
    densityRefresh: flag('density_refresh_enabled', true),
    densityRefreshHard: flag('density_refresh_hard', false),
    handoffPrelanding: flag('handoff_prelanding', true),
    fps: live.max_fps ? String(live.max_fps) : '60',
    bitrate: live.video_bit_rate !== undefined ? String(Math.round(live.video_bit_rate / 1_000_000)) : '8',
    windowLimit: live.custom_encoder_limit > 0 ? String(live.custom_encoder_limit) : 'auto',
    fit: live.video_fit_mode || live.video_fit || 'fill',
    audioRoute: live.audio_output_mode || 'pc',
    audioCodec: live.audio_codec ? (live.audio_codec === 'raw' ? 'pcm' : live.audio_codec) : 'pcm',
    dimPhone: flag('screen_off_while_mirroring', false),
    rememberDevices: flag('remember_devices', true),
    usbStability: flag('usb_stability_guard', true),
    windowingMode: live.windowing_mode ? (live.windowing_mode === 'hybrid_auto' ? 'hybrid' : live.windowing_mode) : 'hybrid',
    handoffWindowing: live.phone_handoff_windowing || 'fullscreen',
    appClosed: live.app_closed_behavior || 'close',
    headerHover: flag('header_hover_mode', false),
    dpLock: flag('dp_lock_enabled', false),
    theme,
  };

  // Son kaydetme sözü: pencere yeniden hesabı KAYDEDİLMİŞ ayarı okur (eskiden kayıt bitmeden hesaplanıyordu).
  const lastSave = useRef(Promise.resolve());
  const save = useCallback((patch) => {
    lastSave.current = updateSettings(patch).catch(() => {});
    return lastSave.current;
  }, []);

  const windows = useWindowStore((s) => s.windows);
  // Odaktaki pencere: store'da `activeWindowId` alanı YOK — `focused` bayrağı gerçek kaynaktır (DexSettings ile aynı kural).
  const activeWindow = windows.find((w) => w.focused && !w.minimized) || windows.find((w) => !w.minimized);
  // Gösterge: odaktaki pencerenin GERÇEK yoğunluğu (kendi DPI politikası ve başlık durumu tek fonksiyondan).
  const liveEffectiveDpi = activeWindow
    ? (targetDisplaySizeForWindow(
        activeWindow,
        {
          resolution_mode: resolution || 'dynamic_fix',
          custom_dpi: dpi === 'auto' ? 0 : Number(dpi),
          target_dp: targetDp === 'auto' ? 0 : Number(targetDp),
        },
        boxOf(activeWindow),
        { mode: modeOf(activeWindow) },
      )?.dpi || DPI_FALLBACK)
    : DPI_FALLBACK;

  // Genel ayar değişince açık pencerelerin akışı yeniden hesaplanır: her pencere KENDİ DPI politikasını korur
  // (genel özel DPI / Target DP yalnız YENİ pencerelerin varsayılanıdır).
  const saveGeometry = useCallback((patch) => {
    const saved = save(patch);
    if (smartResize || patch.dynamic_resolution_enabled === true) {
      saved.then(() => useWindowStore.getState().applyDynamicResolutionToOpenWindows()).catch(() => {});
    }
    return saved;
  }, [save, smartResize]);

  const actions = {
    save,
    saveGeometry,
    setResolution: (val) => saveGeometry({ resolution_mode: val }),
    // Özel DPI ile Target DP birbirini dışlar: biri seçilince diğeri otomatiğe (0) döner.
    setDpi: (val) => {
      const num = val === 'auto' ? 0 : parseInt(val, 10);
      return saveGeometry(num > 0 ? { custom_dpi: num, target_dp: 0 } : { custom_dpi: 0 });
    },
    // Target DP "Oto": Target DP'nin o an ürettiği DPI özel DPI olarak korunur (yoğunluk sıçramaz; DPI onu dinler).
    setTargetDp: (val) => {
      const num = val === 'auto' ? 0 : parseInt(val, 10);
      if (num > 0) return saveGeometry({ target_dp: num, custom_dpi: 0 });
      // GENEL Target DP'nin ürettiği DPI (pencerenin kendi politikası değil) — politika açıkça verilir.
      const heldDpi =
        targetDp !== 'auto' && activeWindow
          ? targetDisplaySizeForWindow(
              activeWindow,
              { resolution_mode: resolution || 'dynamic_fix', custom_dpi: 0, target_dp: Number(targetDp) },
              boxOf(activeWindow),
              { mode: modeOf(activeWindow), policy: { mode: 'target', dp: Number(targetDp) } },
            )?.dpi
          : 0;
      return saveGeometry(heldDpi > 0 ? { target_dp: 0, custom_dpi: Math.round(heldDpi) } : { target_dp: 0 });
    },
    setCodec: (val) => save({ video_codec: val }),
    setFps: (val) => save({ max_fps: parseInt(val, 10) }),
    setBitrate: (val) => save({ video_bit_rate: parseInt(val, 10) * 1_000_000 }),
    setFit: (val) => save({ video_fit_mode: val }),
    setSharpen: (val) => save({ sharpening_mode: val === 'smart' ? 'adaptive' : val }),
    setWindowLimit: (val) => save({ custom_encoder_limit: val === 'auto' ? 0 : parseInt(val, 10) }),
    setAudioRoute: (val) => {
      // Legacy single stream (Android ≤12) only — started here so its AudioContext resumes inside this user gesture.
      // With per-app audio this setting is the default route of apps without their own and the legacy player stays
      // off (App.jsx owns that rule).
      if (isLegacyAudioMode(useAudioMixerStore.getState().mode)) {
        if (val !== 'phone') {
          sessionAudioPlayer.start();
          if (sessionAudioPlayer.ctx && sessionAudioPlayer.ctx.state === 'suspended') {
            sessionAudioPlayer.ctx.resume().catch(() => {});
          }
        } else {
          sessionAudioPlayer.stop();
        }
      }
      return save({ audio_output_mode: val, enable_audio: val !== 'phone' });
    },
    setAudioCodec: (val) => save({ audio_codec: val === 'pcm' ? 'raw' : val }),
    setWindowingMode: (val) => save({ windowing_mode: val === 'hybrid' ? 'hybrid_auto' : val }),
    setHandoffWindowing: (val) => save({ phone_handoff_windowing: val }),
    setAppClosed: (val) => save({ app_closed_behavior: val }),
    setTheme: (val) => setTheme(val === 'dark' ? 'dark' : 'light'),
    toggle: (key, current) => save({ [key]: !current }),
    applyPatch: (patch) => saveGeometry(patch),
  };

  const pushToast = useSystemStore((s) => s.pushToast);
  return { live, values, actions, activeWindow, liveEffectiveDpi, pushToast };
}
