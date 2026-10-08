import React, { useState } from 'react';
import {
  Activity,
  AudioLines,
  ChevronDown,
  ExternalLink,
  Film,
  Gauge,
  GripHorizontal,
  Layers,
  Lock,
  Maximize2,
  Monitor,
  MonitorCog,
  MonitorOff,
  Palette,
  Ruler,
  ScanSearch,
  Smartphone,
  Sparkles,
  Zap,
} from 'lucide-react';
import { PanelShell } from './PanelShell.jsx';
import Button from '../ui/Button.jsx';
import { SettingsGroup } from '../ui/Card.jsx';
import { ChoiceChip, ChoiceGrid, IconTile } from '../ui/Choice.jsx';
import { SegmentedControl } from '../ui/SegmentedControl.jsx';
import { SwitchRow } from '../ui/Switch.jsx';
import { PanelHeader } from '../ui/Typography.jsx';
import { cn } from '../lib/utils.js';
import { useTheme } from '../state/ThemeContext.jsx';
import { useSystemStore } from '../state/systemStore.js';
import {
  BACKEND_FIT,
  FIT_CYCLE,
  FIT_MODES,
  GLOBAL_FIT_CHOICES,
  HEADER_MODES,
  HEADER_MODE_LABELS,
  dpiPolicyOf,
  globalFitFromBackend,
  modeOf,
  normalizeFitMode,
  normalizeHeaderMode,
  normalizeWindowOverrides,
  targetDisplaySizeForWindow,
  useWindowStore,
} from '../window/windowStore.js';
import { updateSettings, useLiveSettings } from '../settings/liveSettings.js';
import { openOpenDexSettings } from '../settings/SettingsPanel.jsx';
import { PrecisionSlider } from '../ui/PrecisionSlider.jsx';
import AppIcon from '../ui/AppIcon.jsx';
import { isMirrorPackage } from '../window/mirrorPackage.js';

const WINDOW_MODES = [
  { value: 'eco', label: 'Eko Çalışma Alanı', hint: 'Paylaşımlı, 1 encoder', icon: Zap },
  { value: 'independent', label: 'Bağımsız Ekranlar', hint: 'Her pencere kendi VD\'si', icon: Monitor },
  { value: 'hybrid', label: 'Hibrit (Otomatik)', hint: 'Kapasiteye göre', icon: Sparkles },
];

const RESOLUTION_OPTIONS = [
  { value: 'dynamic', label: 'Dinamik', tag: 'dynamic_fit' },
  { value: 'dynamic_fix', label: 'Dinamik‑Fix', tag: 'dynamic_fix' },
  { value: 'phone_scale', label: 'Telefon ölçeği', tag: 'zoom' },
  { value: '1080p', label: '1080p (16:9)', tag: '1920×1080' },
  { value: 'tablet', label: 'Tablet (16:10)', tag: '1920×1200' },
  { value: '2k', label: '2K Masaüstü', tag: '2560×1440' },
  { value: '2.5k', label: '2.5K Tablet (16:10)', tag: '2560×1600' },
];

// Görüntü ölçeği: TEK sözlük (window/fitModes.js) — Hub ve Ayarlar ile aynı adlar.
const CANVAS_FIT = GLOBAL_FIT_CHOICES.map((value) => ({ value, label: FIT_MODES[value].label }));
// Pencere başına: genel ayarın üç kipi + yakınlaştırmalar; 'auto' = "Genele uy" (window/fitModes.js).
const WINDOW_FIT = FIT_CYCLE.filter((value) => value !== 'auto').map((value) => ({ value, label: FIT_MODES[value].label }));
const FOLLOW = 'follow';
const THEME_SEGMENTS = [
  { value: 'dark', label: 'Koyu' },
  { value: 'light', label: 'Açık' },
];

const DPI_PRESETS = [
  { value: '180', label: '180 DPI', hint: 'DeX' },
  { value: '200', label: '200 DPI', hint: 'Optimum' },
  { value: '240', label: '240 DPI', hint: 'Rahat' },
];

const DPI_PRESETS_EXTRA = [
  { value: '220', label: '220 DPI', hint: 'Tablet' },
  { value: '340', label: '340 DPI', hint: 'Erişim' },
];

const DPI_MIN = 160;
const DPI_MAX = 340;
const DPI_STEP = 2;
const DPI_AUTO = 206;

const CODECS = [
  { value: 'auto', label: 'Oto (265)' },
  { value: 'h265', label: 'H.265' },
  { value: 'av1', label: 'AV1' },
  { value: 'h264', label: 'H.264' },
];

const BITRATE_OPTIONS = [
  { value: '4', label: '4 Mbps', hint: 'Dengeli' },
  { value: '8', label: '8 Mbps', hint: 'Varsayılan' },
  { value: '12', label: '12 Mbps', hint: 'Ultra HD' },
  { value: '16', label: '16 Mbps', hint: '2K Netlik' },
  { value: '20', label: '20 Mbps', hint: 'Maksimum' },
];

const FPS_OPTIONS = [
  { value: '15', label: '15 FPS', hint: 'Tasarruf' },
  { value: '30', label: '30 FPS', hint: 'Dengeli' },
  { value: '60', label: '60 FPS', hint: 'Akıcı' },
];

const TARGET_DP = [
  { value: '600', label: '600 dp (Tablet)' },
  { value: '720', label: '720 dp (Masaüstü)' },
  { value: '840', label: '840 dp (Geniş DeX)' },
  { value: '960', label: '960 dp (Yoğun)' },
];

// Telefona aktarılan uygulamanın pencereleme kipi: tek GLOBAL ayar (pencere başına değil).
const HANDOFF_WINDOWING = [
  { value: 'fullscreen', label: 'Tam ekran', hint: 'Önerilen' },
  { value: 'freeform', label: 'Serbest pencere', hint: 'Deneysel' },
];

// Pencerenin uygulaması TELEFONDA kapatılınca: pencere kapanır ya da yeniden açma kartı gösterir.
const APP_CLOSED_BEHAVIOR = [
  { value: 'close', label: 'Pencereyi kapat', hint: 'Varsayılan' },
  { value: 'badge', label: 'Pencerede göster', hint: 'Yeniden aç' },
];

const DP_MIN = 480;
const DP_MAX = 1120;
const DP_STEP = 20;
const DP_AUTO = 720;

export function DexSettings({ onClose, ...motionProps }) {
  const { theme, setTheme } = useTheme();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Genel ayarlar tek canlı kaynaktan türetilir (settings/liveSettings): Ayarlar penceresiyle her an aynı değer,
  // değişiklik anında görünür, kayıtlar sıralı (art arda iki değişiklik birbirini ezmez).
  const live = useLiveSettings() || {};
  const windowMode = live.windowing_mode ? (live.windowing_mode === 'hybrid_auto' ? 'hybrid' : live.windowing_mode) : 'hybrid';
  const resolution = live.resolution_mode || 'dynamic_fix';
  const canvasFit = live.video_fit_mode ? globalFitFromBackend(live.video_fit_mode) : 'fill';
  const codec = live.video_codec || 'h265';
  const fps = live.max_fps ? String(live.max_fps) : '60';
  const bitrate = live.video_bit_rate !== undefined ? String(Math.round(live.video_bit_rate / 1_000_000)) : '8';
  const flexLock = Boolean(live.dp_lock_enabled);
  const smartResize = live.dynamic_resolution_enabled === undefined ? true : Boolean(live.dynamic_resolution_enabled);
  const dragTitle = Boolean(live.header_hover_mode);
  const phoneScreenOff = Boolean(live.screen_off_while_mirroring);
  const handoffWindowing = live.phone_handoff_windowing || 'fullscreen';
  const appClosedBehavior = live.app_closed_behavior || 'close';
  const save = (patch) => updateSettings(patch).catch(() => {});

  const { settingsOpen, openSettings, restoreSettings, focusSettings, setDisplayPowerState } = useSystemStore();
  const phoneMetricsReady = useSystemStore((st) => Number(st.deviceProfile?.phone_density) > 0);

  const handleOpenAllSettings = () => {
    openSettings();
    openOpenDexSettings();
    onClose?.();
  };

  const windows = useWindowStore((s) => s.windows);
  // `s.activeWindowId` doesn't exist on this store (no slice ever sets it) —
  // this always fell through to "first non-minimized window in array order",
  // not the window the user actually last clicked/focused. `focused` is the
  // real per-window flag lifecycleSlice.js's _bumpFocus maintains.
  const activeWindow = windows.find((w) => w.focused && !w.minimized) || windows.find((w) => !w.minimized);

  // DPI politikası ODAKTAKİ PENCEREDEN türetilir (yerel state yok): odak değişince panel o pencerenin değerini
  // gösterir; özel DPI ve Target DP aynı anda var olamaz.
  const policy = dpiPolicyOf(activeWindow, null);
  const dpiAuto = policy.mode !== 'custom';
  const dpAuto = policy.mode !== 'target';
  const dpValue = policy.mode === 'target' ? policy.dp : DP_AUTO;

  // Otomatik (özel DPI olmadan) hesaplanan canlı DPI: pencerenin kendi kipi, başlık durumu ve Target DP'si dahil.
  const liveCalculatedDpi = activeWindow
    ? (targetDisplaySizeForWindow(
        activeWindow,
        { resolution_mode: resolution || 'dynamic_fit', header_hover_mode: dragTitle },
        {
          w: activeWindow.w || (typeof window !== 'undefined' ? window.innerWidth : 1920),
          h: activeWindow.h || (typeof window !== 'undefined' ? window.innerHeight - 50 : 1030),
        },
        { mode: modeOf(activeWindow), policy: policy.mode === 'target' || policy.mode === 'phone' ? policy : { mode: 'auto' } },
      )?.dpi || DPI_AUTO)
    : DPI_AUTO;

  const dpiValue = policy.mode === 'custom' ? policy.dpi : (activeWindow?.dpi || liveCalculatedDpi || DPI_AUTO);
  const effectiveDpi = dpiAuto ? liveCalculatedDpi : dpiValue;

  // Kapsam: "Bu pencere" bölümü odaktaki pencereye, "Tüm pencereler" genel varsayılanlara aittir.
  const windowName = activeWindow ? activeWindow.title || activeWindow.package || 'Pencere' : null;
  const canTuneWindow = Boolean(activeWindow) && !activeWindow.isEcoWorkspace;
  const headerMode = normalizeHeaderMode(activeWindow?.headerMode);
  const headerLocked = Boolean(activeWindow) && isMirrorPackage(activeWindow.package);
  // Pencerenin genel ayarın üstündeki kendi değerleri (windowModel.settingsForWindow): yoksa "Genele uy".
  const windowOverrides = normalizeWindowOverrides(activeWindow?.overrides);
  const windowResolution = windowOverrides.resolution_mode ?? FOLLOW;
  const windowDpLock = 'dp_lock_enabled' in windowOverrides ? windowOverrides.dp_lock_enabled : FOLLOW;
  const windowFit = normalizeFitMode(activeWindow?.videoFitMode);
  // Ayna (telefon ekranı) penceresinin akışı telefonun kendi ekranıdır: çözünürlük/DP kilidi ona uygulanmaz.
  const resolutionLocked = Boolean(activeWindow?.resolutionLocked) || headerLocked;
  // Kilit iki ayrı nedenle olabilir: ayna penceresi (akışı telefonun kendi ekranı) ya da kullanıcının Hub'daki "Ekran kilidi".
  const userDisplayLock = resolutionLocked && !headerLocked;
  const resolutionLabelOf = (value) => RESOLUTION_OPTIONS.find((item) => item.value === value)?.label ?? value;
  const windowScopeHint = !activeWindow
    ? 'Açık pencere yok. Bir pencere seçince DPI ve başlık ayarları burada o pencere için görünür.'
    : 'Çalışma Alanı görevlerinin yoğunluğu, her görevin kendi ⚙ menüsünden ayarlanır.';

  const resolutionTag = RESOLUTION_OPTIONS.find((item) => item.value === resolution)?.tag ?? 'dynamic_fit';
  const codecLabel =
    codec === 'h265'
      ? 'H.265 HEVC (Ultra‑Net)'
      : codec === 'av1'
      ? 'AV1 (Yeni Nesil)'
      : codec === 'h264'
      ? 'H.264 (Uyumlu)'
      : 'Oto (265)';
  const dpiLabel = dpiAuto
    ? (activeWindow
        ? `Oto (${liveCalculatedDpi} DPI · ${activeWindow.title || activeWindow.package || 'Aktif'})`
        : `Oto (${liveCalculatedDpi} DPI)`)
    : `${dpiValue} DPI`;
  const targetLabel = dpAuto ? `Otomatik (${dpValue} dp)` : `${dpValue} dp`;

  // Ayar kaydedildikten sonra açık pencerelerin akışı yeniden hesaplanır — her pencere KENDİ DPI politikası ve
  // başlık kipiyle (tek karar noktası: store.applyDynamicResolutionToOpenWindows).
  const applyGeometryChangeToWindows = () => {
    if (!smartResize) return;
    useWindowStore.getState().applyDynamicResolutionToOpenWindows().catch(() => {});
  };

  // DPI burada bilerek saveSettings() ile YAZILMAZ: genel ayar yalnız yeni pencerelerin varsayılanıdır ve
  // değişirse her açık pencereyi etkilerdi. Politika pencereye (win.dpiPolicy) yazılır; resize/reconcile/açılış
  // hepsi aynı politikayı okur — "resize yapınca gidiyor" hatasının kalıcı çözümü.
  // Politika DEĞİŞİKLİĞİ yalnız odaktaki pencereyi etkiler ve pencereye yazılır (kalıcı: yeniden açılınca hatırlanır).
  // Özel DPI ve Target DP tek bir politika alanıdır: birini seçmek diğerini otomatik siler.
  const applyPolicy = (next) => {
    if (!smartResize || !activeWindow || activeWindow.isEcoWorkspace) return;
    useWindowStore.getState().setWindowDpiPolicy(activeWindow.id, next).catch(() => {});
  };

  const setDpi = (value) => applyPolicy({ mode: 'custom', dpi: Number(value) });
  // "Telefon ölçeği": bu pencere telefondaki düzeniyle açılır; tekrar basınca otomatiğe döner.
  const phoneScaleActive = policy.mode === 'phone';
  const togglePhoneScale = () => applyPolicy(phoneScaleActive ? { mode: 'auto' } : { mode: 'phone' });
  const handleDpiAuto = () => applyPolicy({ mode: 'auto' });
  const setDp = (value) => applyPolicy({ mode: 'target', dp: Number(value) });
  // Target DP "Oto": Target DP'nin O AN ürettiği DPI (DPI kaydırıcısında görünen değer) özel DPI olarak korunur —
  // görüntü yoğunluğu sıçramaz, DPI bundan sonra bu değeri dinler. Target seçili değilse hiçbir şey değişmez.
  const handleDpAuto = () => {
    if (policy.mode !== 'target') return;
    applyPolicy(liveCalculatedDpi > 0 ? { mode: 'custom', dpi: Math.round(liveCalculatedDpi) } : { mode: 'auto' });
  };

  const setHeaderMode = (mode) => {
    if (!activeWindow) return;
    useWindowStore.getState().setHeaderMode(activeWindow.id, mode).catch(() => {});
  };

  const handleHandoffWindowingChange = (val) => save({ phone_handoff_windowing: val });
  const handleAppClosedBehaviorChange = (val) => save({ app_closed_behavior: val });
  const handleWindowModeChange = (val) => save({ windowing_mode: val === 'hybrid' ? 'hybrid_auto' : val });
  // Akış yeniden hesabı KAYDEDİLMİŞ ayarı okur → kayıt bittikten sonra.
  const handleResolutionChange = (val) =>
    updateSettings({ resolution_mode: val }).then(applyGeometryChangeToWindows).catch(() => {});

  // "Bu pencere": yalnız odaktaki pencerenin kendi değeri yazılır; genel ayar ve diğer pencereler değişmez.
  // Kaydedilir her zaman; akış yalnız «Gerçek Çözünürlük» açıkken yeniden müzakere edilir (DPI ile aynı kural).
  const setWindowOverride = (key, value) => {
    if (!activeWindow || activeWindow.isEcoWorkspace) return;
    useWindowStore
      .getState()
      .setWindowOverride(activeWindow.id, key, value === FOLLOW ? null : value, { apply: smartResize })
      .catch(() => {});
  };
  const setWindowFit = (mode) => {
    if (!activeWindow) return;
    useWindowStore.getState().setWindowFitMode(activeWindow.id, mode);
  };

  const handleCanvasFitChange = (val) => save({ video_fit_mode: BACKEND_FIT[val] });
  const handleCodecChange = (val) => save({ video_codec: val });
  const handleBitrateChange = (val) => save({ video_bit_rate: parseInt(val, 10) * 1_000_000 });
  const handleFpsChange = (val) => save({ max_fps: parseInt(val, 10) });
  const handleFlexLockToggle = () => save({ dp_lock_enabled: !flexLock });
  const handleSmartResizeToggle = () => save({ dynamic_resolution_enabled: !smartResize });
  const handleDragTitleToggle = () => save({ header_hover_mode: !dragTitle });
  const handlePhoneScreenOffToggle = () => {
    save({ screen_off_while_mirroring: !phoneScreenOff });
    setDisplayPowerState?.(phoneScreenOff); // ekran kapatılıyorsa (yeni değer true) → güç false
  };

  return (
    <PanelShell
      {...motionProps}
      className="right-4 flex h-[min(620px,calc(100vh-82px))] w-[min(400px,calc(100vw-32px))] flex-col p-0 sm:right-28"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-3.5 py-3">
        <PanelHeader
          icon={MonitorCog}
          title="DeX ayarları"
          subtitle="Bu pencere ve tüm pencereler"
        />
        <span className="rounded-full bg-muted px-2 py-1 font-mono text-[9px] font-semibold tabular-nums text-muted-foreground">
          ~16 VD
        </span>
      </div>

      <div className="dex-scroll min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3.5 py-3">
        {/* ─── Bu pencere: yalnız odaktaki pencereyi etkiler ─── */}
        <ScopeHeading
          scope="window"
          icon={
            canTuneWindow ? (
              <AppIcon pkg={activeWindow.package} displayName={windowName} size={18} />
            ) : (
              <Monitor className="size-4 shrink-0 text-muted-foreground" />
            )
          }
          title="Bu pencere"
          name={windowName}
        />
        {canTuneWindow ? (
          <>
            {!smartResize && (
              <p className="rounded-md border border-dashed border-border/70 px-2.5 py-1.5 text-[9px] leading-[12px] text-muted-foreground">
                «Gerçek Çözünürlük» kapalı: DPI ve Target DP bu pencereye uygulanmaz. Aşağıdaki «Tüm pencereler» bölümünden açın.
              </p>
            )}
            <SettingsGroup icon={Gauge} title="Özel DPI Yoğunluğu" value={dpiLabel} mono>
              <div className="grid grid-cols-3 gap-1.5">
                {DPI_PRESETS.map((item) => (
                  <ChoiceChip
                    key={item.value}
                    label={item.label}
                    hint={item.hint}
                    active={!dpiAuto && dpiValue === Number(item.value)}
                    onClick={() => setDpi(Number(item.value))}
                  />
                ))}
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                {DPI_PRESETS_EXTRA.map((item) => (
                  <ChoiceChip
                    key={item.value}
                    label={item.label}
                    hint={item.hint}
                    active={!dpiAuto && dpiValue === Number(item.value)}
                    onClick={() => setDpi(Number(item.value))}
                  />
                ))}
              </div>
              <PrecisionSlider
                value={effectiveDpi}
                min={DPI_MIN}
                max={DPI_MAX}
                step={DPI_STEP}
                auto={dpiAuto}
                onCommit={setDpi}
                onAuto={handleDpiAuto}
                label="Özel DPI yoğunluğu"
                unit="DPI"
                ticks={[160, 180, 200, 220, 240, 280, 320, 340]}
                className="mt-2"
              />
            </SettingsGroup>

            <SettingsGroup icon={Ruler} title="Mantıksal Alan (Target DP)" value={targetLabel} mono>
              <div className="grid grid-cols-2 gap-1.5">
                {TARGET_DP.map((item) => (
                  <ChoiceChip
                    key={item.value}
                    label={item.label}
                    active={!dpAuto && dpValue === Number(item.value)}
                    onClick={() => setDp(Number(item.value))}
                  />
                ))}
              </div>
              <PrecisionSlider
                value={dpValue}
                min={DP_MIN}
                max={DP_MAX}
                step={DP_STEP}
                auto={dpAuto}
                onCommit={setDp}
                onAuto={handleDpAuto}
                label="Mantıksal alan (target dp)"
                unit="dp"
                ticks={[480, 600, 720, 840, 960, 1080]}
                className="mt-2"
              />
            </SettingsGroup>

            <SettingsGroup
              icon={Smartphone}
              title="Telefon Ölçeği (Zoom)"
              value={phoneScaleActive ? `Açık · ${liveCalculatedDpi} DPI` : 'Kapalı'}
            >
              <ChoiceChip
                label={phoneScaleActive ? 'Telefon ölçeği açık' : 'Telefon ölçeğini aç'}
                hint={phoneMetricsReady ? 'Bu pencere' : 'Cihaz bağlanınca kullanılabilir'}
                active={phoneScaleActive}
                disabled={!phoneMetricsReady && !phoneScaleActive}
                onClick={togglePhoneScale}
              />
              <p className="mt-2 text-[9px] leading-[13px] text-muted-foreground">
                Uygulama telefondaki düzeniyle açılır. Pencereyi büyütmek yakınlaştırır, kareye yaklaştırmak tablet
                düzenine geçirir. Özel DPI ya da Target DP seçmek bunu kapatır.
              </p>
            </SettingsGroup>

            <SettingsGroup
              icon={Monitor}
              title="Çözünürlük Stratejisi"
              value={
                resolutionLocked
                  ? (userDisplayLock ? 'Ekran kilitli' : 'Telefon ekranı')
                  : windowResolution === FOLLOW
                    ? `Genele uy · ${resolutionLabelOf(resolution)}`
                    : resolutionLabelOf(windowResolution)
              }
            >
              {resolutionLocked ? (
                <p className="text-[9px] leading-[12px] text-muted-foreground">
                  {userDisplayLock
                    ? 'Bu pencerenin görüntü boyutu (px) ve DPI\'ı kilitli: pencereyi boyutlandırmak, kaplamak ya da ayar değiştirmek akışı değiştirmez. Kilidi pencere Hub\'ından (Ekran kilidi) kaldırabilirsin.'
                    : 'Bu pencere telefonun kendi ekranını gösterir; çözünürlüğü telefon belirler.'}
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-1.5" data-window-setting="resolution_mode">
                  <ChoiceChip
                    label="Genele uy"
                    hint={`Genel: ${resolutionLabelOf(resolution)}`}
                    active={windowResolution === FOLLOW}
                    onClick={() => setWindowOverride('resolution_mode', FOLLOW)}
                  />
                  {RESOLUTION_OPTIONS.map((item) => (
                    <ChoiceChip
                      key={item.value}
                      label={item.label}
                      active={windowResolution === item.value}
                      onClick={() => setWindowOverride('resolution_mode', item.value)}
                    />
                  ))}
                </div>
              )}
            </SettingsGroup>

            <SettingsGroup
              icon={Maximize2}
              title="Görüntü Sığdırma"
              value={windowFit === 'auto' ? `Genele uy · ${FIT_MODES[canvasFit]?.label ?? ''}` : FIT_MODES[windowFit].label}
            >
              <div className="grid grid-cols-3 gap-1.5" data-window-setting="video_fit_mode">
                <ChoiceChip
                  label="Genele uy"
                  hint={`Genel: ${FIT_MODES[canvasFit]?.label ?? ''}`}
                  active={windowFit === 'auto'}
                  onClick={() => setWindowFit('auto')}
                />
                {WINDOW_FIT.map((item) => (
                  <ChoiceChip
                    key={item.value}
                    label={item.label}
                    active={windowFit === item.value}
                    onClick={() => setWindowFit(item.value)}
                  />
                ))}
              </div>
            </SettingsGroup>

            {!resolutionLocked && (
              <SettingsGroup
                icon={Lock}
                title="Flex DP Kilidi"
                value={windowDpLock === FOLLOW ? `Genele uy · ${flexLock ? 'Kilitli' : 'Serbest'}` : windowDpLock ? 'Kilitli' : 'Serbest'}
              >
                <div className="grid grid-cols-3 gap-1.5" data-window-setting="dp_lock_enabled">
                  <ChoiceChip
                    label="Genele uy"
                    hint={`Genel: ${flexLock ? 'Kilitli' : 'Serbest'}`}
                    active={windowDpLock === FOLLOW}
                    onClick={() => setWindowOverride('dp_lock_enabled', FOLLOW)}
                  />
                  <ChoiceChip label="Kilitli" active={windowDpLock === true} onClick={() => setWindowOverride('dp_lock_enabled', true)} />
                  <ChoiceChip label="Serbest" active={windowDpLock === false} onClick={() => setWindowOverride('dp_lock_enabled', false)} />
                </div>
              </SettingsGroup>
            )}

            <SettingsGroup icon={GripHorizontal} title="Başlık Çubuğu" value={headerLocked ? 'Gizli' : HEADER_MODE_LABELS[headerMode]}>
              {headerLocked ? (
                <p className="text-[9px] leading-[12px] text-muted-foreground">
                  Telefon ekranı yansıtılırken başlık her zaman gizlidir.
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-1.5">
                  {HEADER_MODES.map((mode) => (
                    <ChoiceChip
                      key={mode}
                      label={HEADER_MODE_LABELS[mode]}
                      hint={mode === 'follow' ? `Genel: ${dragTitle ? 'Hover' : 'Sabit'}` : undefined}
                      active={headerMode === mode}
                      onClick={() => setHeaderMode(mode)}
                    />
                  ))}
                </div>
              )}
            </SettingsGroup>
          </>
        ) : (
          <p className="rounded-md border border-dashed border-border/70 px-2.5 py-2 text-[10px] leading-[14px] text-muted-foreground">
            {windowScopeHint}
          </p>
        )}

        {/* ─── Tüm pencereler: genel varsayılanlar ─── */}
        <ScopeHeading
          scope="global"
          icon={<Layers className="size-4 shrink-0 text-muted-foreground" />}
          title="Tüm pencereler"
          hint="Yeni açılan pencerelere, oturumun geneline ve «Genele uy» diyen pencerelere uygulanır."
        />

        <section className="overflow-hidden rounded-md border border-border/70 bg-muted/40">
          <div className="flex items-center justify-between gap-2 px-2.5 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <Palette className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-[11px] font-semibold">Görünüm Teması</span>
            </span>
            <SegmentedControl
              size="md"
              label="Görünüm teması"
              options={THEME_SEGMENTS}
              value={theme}
              onChange={setTheme}
            />
          </div>
          <SwitchRow
            variant="row"
            icon={ScanSearch}
            title="Gerçek Çözünürlük"
            description="Akıllı ekran yeniden boyutlama"
            checked={smartResize}
            onToggle={handleSmartResizeToggle}
          />
          <SwitchRow
            variant="row"
            icon={GripHorizontal}
            title="Sürükleyici Başlık (varsayılan)"
            description="«Genele uy» pencerelerde başlık hover ile açılır"
            checked={dragTitle}
            onToggle={handleDragTitleToggle}
          />
          <SwitchRow
            variant="row"
            icon={MonitorOff}
            title="Telefon Ekranını Kapat"
            description="DeX çalışırken telefon uyur"
            checked={phoneScreenOff}
            onToggle={handlePhoneScreenOffToggle}
          />
        </section>

        <SettingsGroup icon={Monitor} title="Varsayılan Çözünürlük Stratejisi" value={resolutionTag} mono>
          <ChoiceGrid columns={2} options={RESOLUTION_OPTIONS} value={resolution} onChange={handleResolutionChange} />
        </SettingsGroup>

        <SwitchRow
          variant="panel"
          icon={Lock}
          title="Varsayılan Flex DP Kilidi"
          description="Boyutlandırmada DPI'ı sabit tutar (Sıfır Donma)"
          state={flexLock ? 'Kilitli' : 'Serbest'}
          checked={flexLock}
          onToggle={handleFlexLockToggle}
        />

        <SettingsGroup
          icon={Maximize2}
          title="Varsayılan Görüntü Sığdırma"
          value={CANVAS_FIT.find((item) => item.value === canvasFit)?.label ?? ''}
        >
          <ChoiceGrid columns={3} options={CANVAS_FIT} value={canvasFit} onChange={handleCanvasFitChange} />
        </SettingsGroup>

        <SettingsGroup icon={AudioLines} title="Video Bit Hızı" value={`${bitrate} Mbps`} mono>
          <ChoiceGrid columns={5} options={BITRATE_OPTIONS} value={bitrate} onChange={handleBitrateChange} />
        </SettingsGroup>

        <SettingsGroup
          icon={Layers}
          title="Varsayılan Pencereleme Davranışı"
          value={WINDOW_MODES.find((item) => item.value === windowMode)?.label ?? ''}
        >
          <div className="grid grid-cols-3 gap-1.5">
            {WINDOW_MODES.map((item) => (
              <IconTile
                variant="outlined"
                key={item.value}
                icon={item.icon}
                title={item.label}
                status={item.hint}
                active={windowMode === item.value}
                onClick={() => handleWindowModeChange(item.value)}
              />
            ))}
          </div>
          <p className="mt-2 text-[9px] leading-[13px] text-muted-foreground">
            Bu cihaz <strong className="font-semibold text-foreground">~16</strong> bağımsız pencere destekliyor.
          </p>
        </SettingsGroup>

        <SettingsGroup
          icon={Smartphone}
          title="Telefona Aktarma Kipi"
          value={HANDOFF_WINDOWING.find((item) => item.value === handoffWindowing)?.label ?? ''}
        >
          <ChoiceGrid columns={2} options={HANDOFF_WINDOWING} value={handoffWindowing} onChange={handleHandoffWindowingChange} />
          <p className="mt-2 text-[9px] leading-[13px] text-muted-foreground">
            Tam ekran: uygulama telefonun ekranını tamamen kaplar. Serbest pencere deneyseldir; üretici ölçeği nedeniyle
            telefonda küçük görünebilir. Taşıma/boyutlandırma tutamacını OpenDeX değil telefonun kendi arayüzü çizer —
            üretici (ör. HyperOS) bu pencerelere tutamaç koymayabilir; pencere yine de ekranın ortasına yerleştirilir.
          </p>
        </SettingsGroup>

        <SettingsGroup
          icon={Smartphone}
          title="Uygulama Telefonda Kapatılınca"
          value={APP_CLOSED_BEHAVIOR.find((item) => item.value === appClosedBehavior)?.label ?? ''}
        >
          <ChoiceGrid columns={2} options={APP_CLOSED_BEHAVIOR} value={appClosedBehavior} onChange={handleAppClosedBehaviorChange} />
          <p className="mt-2 text-[9px] leading-[13px] text-muted-foreground">
            Pencerede açık bir uygulama telefonun Son Kullanılanlar ekranından kapatılırsa: pencere kapanır ya da
            üstünde "Yeniden aç" kartı gösterilir. Çalışma Alanı görevleri her zaman kapanır.
          </p>
        </SettingsGroup>

        {/* Gelişmiş Ayarlar: FPS + kodek — nadiren değiştirilir, varsayılan kapalı. */}
        <section className="overflow-hidden rounded-md border border-border/70 bg-muted/40">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            aria-expanded={advancedOpen}
            className="flex w-full items-center justify-between gap-2 px-2.5 py-2.5 text-left cursor-pointer"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Activity className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-[11px] font-semibold">Gelişmiş Ayarlar</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[9px] font-medium text-muted-foreground">
              {`${fps} FPS · ${codecLabel}`}
              <ChevronDown className={cn('size-3.5 transition-transform', advancedOpen && 'rotate-180')} />
            </span>
          </button>
          {advancedOpen && (
            <div className="space-y-2.5 border-t border-border/60 p-2.5">
              <SettingsGroup icon={Activity} title="Maksimum FPS" value={`${fps} FPS`} mono>
                <ChoiceGrid columns={3} options={FPS_OPTIONS} value={fps} onChange={handleFpsChange} />
              </SettingsGroup>

              <SettingsGroup icon={Film} title="Video Kodek (DeX Kalitesi)" value={codecLabel}>
                <ChoiceGrid columns={4} options={CODECS} value={codec} onChange={handleCodecChange} />
              </SettingsGroup>
            </div>
          )}
        </section>

        <Button variant="outline" size="lg" className="w-full text-[11px]" startIcon={<ExternalLink className="size-3.5" />} onClick={handleOpenAllSettings}>
          Tüm OpenDeX Ayarlarını Aç
        </Button>
      </div>
    </PanelShell>
  );
}

function ScopeHeading({ scope, icon, title, name, hint }) {
  return (
    <div data-scope={scope} className="pt-0.5">
      <div className="flex items-center gap-2 px-0.5">
        {icon}
        <h3 className="flex min-w-0 items-baseline gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          <span className="shrink-0">{title}</span>
          {name && (
            <span className="truncate text-[11px] font-semibold normal-case tracking-normal text-foreground">{name}</span>
          )}
        </h3>
        <span className="h-px min-w-4 flex-1 bg-border/70" aria-hidden="true" />
      </div>
      {hint && <p className="mt-0.5 px-0.5 text-[9px] leading-[12px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default DexSettings;
