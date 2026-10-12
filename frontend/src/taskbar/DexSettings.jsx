import React, { useCallback, useRef, useState, forwardRef } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AppWindow,
  AudioLines,
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
  SlidersHorizontal,
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

// Tek sıra, artan: beş hazır yoğunluk 372 px'lik satıra sığar (eskiden 3+2 iki satırdı).
const DPI_PRESETS = [
  { value: '180', label: '180 DPI', hint: 'DeX' },
  { value: '200', label: '200 DPI', hint: 'Optimum' },
  { value: '220', label: '220 DPI', hint: 'Tablet' },
  { value: '240', label: '240 DPI', hint: 'Rahat' },
  { value: '340', label: '340 DPI', hint: 'Erişim' },
];

const DPI_MIN = 130;
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
  { value: '600', label: '600 dp', hint: 'Tablet' },
  { value: '720', label: '720 dp', hint: 'Masaüstü' },
  { value: '840', label: '840 dp', hint: 'Geniş DeX' },
  { value: '960', label: '960 dp', hint: 'Yoğun' },
];

// Telefona aktarılan uygulamanın pencereleme kipi: tek GLOBAL ayar (pencere başına değil).
const HANDOFF_WINDOWING = [
  { value: 'fullscreen', label: 'Tam ekran', hint: 'Önerilen' },
  { value: 'freeform', label: 'Serbest pencere', hint: 'Küçük pencere' },
];

// Pencerenin uygulaması TELEFONDA kapatılınca: pencere kapanır ya da yeniden açma kartı gösterir.
const APP_CLOSED_BEHAVIOR = [
  { value: 'close', label: 'Pencereyi kapat', hint: 'Varsayılan' },
  { value: 'badge', label: 'Pencerede göster', hint: 'Yeniden aç' },
];

const DP_MIN = 350;
const DP_MAX = 1120;
const DP_STEP = 10;
const DP_AUTO = 720;

export const DexSettings = forwardRef(function DexSettings({ onClose, ...motionProps }, ref) {
  const { theme, setTheme } = useTheme();
  // Sekme: seçilmediyse odaktaki pencere ayarlanabiliyorsa "Yoğunluk", değilse "Genel" (aşağıda `tab`).
  const [pickedTab, setPickedTab] = useState(null);
  const scrollRef = useRef(null);

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
  const liveGeometry = activeWindow
    ? targetDisplaySizeForWindow(
        activeWindow,
        { resolution_mode: resolution || 'dynamic_fit', header_hover_mode: dragTitle },
        {
          w: activeWindow.w || (typeof window !== 'undefined' ? window.innerWidth : 1920),
          h: activeWindow.h || (typeof window !== 'undefined' ? window.innerHeight - 50 : 1030),
        },
        { mode: modeOf(activeWindow), policy: policy.mode === 'target' || policy.mode === 'phone' ? policy : { mode: 'auto' } },
      )
    : null;
  const liveCalculatedDpi = liveGeometry?.dpi || DPI_AUTO;

  const dpiValue = policy.mode === 'custom' ? policy.dpi : (activeWindow?.dpi || liveCalculatedDpi || DPI_AUTO);
  const effectiveDpi = dpiAuto ? liveCalculatedDpi : dpiValue;
  // Etkin "en küçük genişlik" (sw dp) = min(en, boy) px × 160 / DPI: Target DP'nin ölçtüğü ve Android'in sw niteleyicisinin
  // (sw600dp…) baktığı değer — GENİŞLİK dp'si değil (windowMath.densityForTabletTarget aynı formülü kullanır).
  const liveSwDp = liveGeometry?.w > 0 && liveGeometry?.h > 0 && effectiveDpi > 0
    ? Math.round((Math.min(liveGeometry.w, liveGeometry.h) * 160) / effectiveDpi)
    : null;

  // Kapsam: "Bu pencere" bölümü odaktaki pencereye, "Tüm pencereler" genel varsayılanlara aittir.
  const windowName = activeWindow ? activeWindow.title || activeWindow.package || 'Pencere' : null;
  const canTuneWindow = Boolean(activeWindow) && !activeWindow.isEcoWorkspace;
  const tab = pickedTab ?? (canTuneWindow ? 'density' : 'general');
  const selectTab = useCallback((id) => {
    setPickedTab(id);
    scrollRef.current?.scrollTo?.({ top: 0 });   // yeni sekme hep başından açılır (jsdom'da scrollTo yok)
  }, []);
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
      ref={ref} {...motionProps}
      className="right-4 flex h-[min(620px,calc(100vh-82px))] w-[min(400px,calc(100vw-32px))] flex-col p-0 sm:right-28"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-3 pb-1.5 pt-2.5">
        <PanelHeader
          icon={MonitorCog}
          iconTone="soft"
          size="md"
          title="DeX ayarları"
          subtitle="Bu pencere ve tüm pencereler"
        />
        <span className="rounded-full bg-muted px-2 py-1 font-mono text-[9px] font-semibold tabular-nums text-muted-foreground" title="Bu cihazın destekleyebildiği bağımsız pencere sayısı">
          ~16 VD
        </span>
      </div>

      <DexTabs
        tabs={DEX_TABS}
        active={tab}
        onChange={selectTab}
        windowIcon={
          canTuneWindow ? (
            <AppIcon pkg={activeWindow.package} displayName={windowName} size={14} />
          ) : (
            <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
          )
        }
        windowName={windowName}
      />

      <div ref={scrollRef} className="dex-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2.5">
        {/* ─── Bu pencere · Yoğunluk ─── */}
        <TabPane id="density" active={tab === 'density'}>
          {canTuneWindow ? (
            <>
              {!smartResize && (
                <p className="rounded-md border border-dashed border-border/70 px-2.5 py-1.5 text-[9px] leading-[12px] text-muted-foreground">
                  «Gerçek Çözünürlük» kapalı: DPI ve Target DP bu pencereye uygulanmaz. «Genel» sekmesinden açın.
                </p>
              )}
              <Readout
                items={[
                  { label: 'Etkin DPI', value: String(Math.round(effectiveDpi)), unit: 'DPI' },
                  { label: 'En küçük genişlik', value: liveSwDp ? String(liveSwDp) : '—', unit: 'dp' },
                  { label: 'Yoğunluk kipi', value: DENSITY_MODE_LABEL[policy.mode] || 'Oto' },
                ]}
              />

              <SettingsGroup dense icon={Gauge} title="Özel DPI Yoğunluğu" value={dpiLabel} mono>
                <ChoiceGrid
                  dense
                  columns={5}
                  options={DPI_PRESETS}
                  isActive={(item) => !dpiAuto && dpiValue === Number(item.value)}
                  onChange={(value) => setDpi(Number(value))}
                />
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
                  ticks={[130, 160, 180, 200, 220, 240, 280, 320, 340]}
                  className="mt-1.5"
                />
              </SettingsGroup>

              <SettingsGroup dense icon={Ruler} title="Mantıksal Alan (Target DP)" value={targetLabel} mono>
                <ChoiceGrid
                  dense
                  columns={4}
                  options={TARGET_DP}
                  isActive={(item) => !dpAuto && dpValue === Number(item.value)}
                  onChange={(value) => setDp(Number(value))}
                />
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
                  ticks={[350, 480, 600, 720, 840, 960, 1080]}
                  className="mt-1.5"
                />
              </SettingsGroup>

              <section className="overflow-hidden rounded-md border border-border/70 bg-muted/40">
                <SwitchRow
                  variant="row"
                  icon={Smartphone}
                  title="Telefon Ölçeği (Zoom)"
                  description={
                    phoneScaleActive
                      ? `Açık · ${liveCalculatedDpi} DPI — telefondaki düzenle`
                      : phoneMetricsReady
                        ? 'Telefondaki düzenle açılır · DPI/Target DP\'yi kapatır'
                        : 'Cihaz bağlanınca kullanılabilir'
                  }
                  checked={phoneScaleActive}
                  disabled={!phoneMetricsReady && !phoneScaleActive}
                  onToggle={togglePhoneScale}
                  className="border-t-0"
                />
              </section>

              {!resolutionLocked && (
                <InlineChoice
                  title="Flex DP Kilidi"
                  dataSetting="dp_lock_enabled"
                  options={[
                    { value: FOLLOW, label: 'Genele uy', hint: `Genel: ${flexLock ? 'Kilitli' : 'Serbest'}` },
                    { value: true, label: 'Kilitli' },
                    { value: false, label: 'Serbest' },
                  ]}
                  value={windowDpLock}
                  onChange={(value) => setWindowOverride('dp_lock_enabled', value)}
                />
              )}
            </>
          ) : (
            <p className="rounded-md border border-dashed border-border/70 px-2.5 py-2 text-[10px] leading-[14px] text-muted-foreground">
              {windowScopeHint}
            </p>
          )}
        </TabPane>

        {/* ─── Bu pencere · Pencere (çözünürlük, sığdırma, başlık) ─── */}
        <TabPane id="window" active={tab === 'window'}>
          {canTuneWindow ? (
            <>
              <SettingsGroup
                dense
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
                  <div className="grid grid-cols-3 gap-1" data-window-setting="resolution_mode">
                    <ChoiceChip
                      dense
                      label="Genele uy"
                      hint={`Genel: ${resolutionLabelOf(resolution)}`}
                      active={windowResolution === FOLLOW}
                      onClick={() => setWindowOverride('resolution_mode', FOLLOW)}
                    />
                    {RESOLUTION_OPTIONS.map((item) => (
                      <ChoiceChip
                        dense
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
                dense
                icon={Maximize2}
                title="Görüntü Sığdırma"
                value={windowFit === 'auto' ? `Genele uy · ${FIT_MODES[canvasFit]?.label ?? ''}` : FIT_MODES[windowFit].label}
              >
                <div className="grid grid-cols-3 gap-1" data-window-setting="video_fit_mode">
                  <ChoiceChip
                    dense
                    label="Genele uy"
                    hint={`Genel: ${FIT_MODES[canvasFit]?.label ?? ''}`}
                    active={windowFit === 'auto'}
                    onClick={() => setWindowFit('auto')}
                  />
                  {WINDOW_FIT.map((item) => (
                    <ChoiceChip
                      dense
                      key={item.value}
                      label={item.label}
                      active={windowFit === item.value}
                      onClick={() => setWindowFit(item.value)}
                    />
                  ))}
                </div>
              </SettingsGroup>

              <SettingsGroup dense icon={GripHorizontal} title="Başlık Çubuğu" value={headerLocked ? 'Gizli' : HEADER_MODE_LABELS[headerMode]}>
                {headerLocked ? (
                  <p className="text-[9px] leading-[12px] text-muted-foreground">
                    Telefon ekranı yansıtılırken başlık her zaman gizlidir.
                  </p>
                ) : (
                  <div className="grid grid-cols-3 gap-1">
                    {HEADER_MODES.map((mode) => (
                      <ChoiceChip
                        dense
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
        </TabPane>

        {/* ─── Tüm pencereler · Genel ─── */}
        <TabPane id="general" active={tab === 'general'}>
          <section className="overflow-hidden rounded-md border border-border/70 bg-muted/40">
            <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
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
              className="py-1.5"
            />
            <SwitchRow
              variant="row"
              icon={GripHorizontal}
              title="Sürükleyici Başlık (varsayılan)"
              description="«Genele uy» pencerelerde başlık hover ile açılır"
              checked={dragTitle}
              onToggle={handleDragTitleToggle}
              className="py-1.5"
            />
            <SwitchRow
              variant="row"
              icon={MonitorOff}
              title="Telefon Ekranını Kapat"
              description="DeX çalışırken telefon uyur"
              checked={phoneScreenOff}
              onToggle={handlePhoneScreenOffToggle}
              className="py-1.5"
            />
            <SwitchRow
              variant="row"
              icon={Lock}
              title="Varsayılan Flex DP Kilidi"
              description={flexLock ? 'Boyutlandırmada DPI sabit (Sıfır Donma)' : 'Boyutlandırmada DPI serbest'}
              checked={flexLock}
              onToggle={handleFlexLockToggle}
              className="py-1.5"
            />
          </section>

          <SettingsGroup dense icon={Monitor} title="Varsayılan Çözünürlük Stratejisi" value={resolutionTag} mono>
            <ChoiceGrid dense columns={3} options={RESOLUTION_OPTIONS} value={resolution} onChange={handleResolutionChange} />
          </SettingsGroup>

          <SettingsGroup
            dense
            icon={Maximize2}
            title="Varsayılan Görüntü Sığdırma"
            value={CANVAS_FIT.find((item) => item.value === canvasFit)?.label ?? ''}
          >
            <ChoiceGrid dense columns={3} options={CANVAS_FIT} value={canvasFit} onChange={handleCanvasFitChange} />
          </SettingsGroup>

          <p className="px-0.5 text-[9px] leading-[12px] text-muted-foreground">
            Bu sekme yeni açılan pencerelere, oturumun geneline ve «Genele uy» diyen pencerelere uygulanır.
          </p>
        </TabPane>

        {/* ─── Tüm pencereler · Akış ─── */}
        <TabPane id="stream" active={tab === 'stream'}>
          <Readout
            items={[
              { label: 'Kodek', value: CODEC_SHORT[codec] || 'Oto' },
              { label: 'Bit hızı', value: bitrate, unit: 'Mbps' },
              { label: 'Kare hızı', value: fps, unit: 'FPS' },
            ]}
          />
          <SettingsGroup dense icon={AudioLines} title="Video Bit Hızı" value={`${bitrate} Mbps`} mono>
            <ChoiceGrid dense columns={5} options={BITRATE_OPTIONS} value={bitrate} onChange={handleBitrateChange} />
          </SettingsGroup>
          <SettingsGroup dense icon={Activity} title="Maksimum FPS" value={`${fps} FPS`} mono>
            <ChoiceGrid dense columns={3} options={FPS_OPTIONS} value={fps} onChange={handleFpsChange} />
          </SettingsGroup>
          <SettingsGroup dense icon={Film} title="Video Kodek (DeX Kalitesi)" value={codecLabel}>
            <ChoiceGrid dense columns={4} options={CODECS} value={codec} onChange={handleCodecChange} />
          </SettingsGroup>
        </TabPane>

        {/* ─── Tüm pencereler · Sistem ─── */}
        <TabPane id="system" active={tab === 'system'}>
          <SettingsGroup dense icon={Smartphone} title="Telefona Aktarma Kipi">
            <ChoiceGrid dense columns={2} options={HANDOFF_WINDOWING} value={handoffWindowing} onChange={handleHandoffWindowingChange} />
            <p className="mt-1.5 text-[9px] leading-[12px] text-muted-foreground">
              Yalnız «Telefona aktar» düğmesinin varsayılanı. Tek seferlik seçim için pencere başlığına sağ tıkla; telefonda
              kendin açtığın uygulamalar her zaman tam ekran açılır. Serbest pencere HyperOS&apos;un kendi küçük penceresidir.
            </p>
          </SettingsGroup>

          <SettingsGroup dense icon={Smartphone} title="Uygulama Telefonda Kapatılınca">
            <ChoiceGrid dense columns={2} options={APP_CLOSED_BEHAVIOR} value={appClosedBehavior} onChange={handleAppClosedBehaviorChange} />
            <p className="mt-1.5 text-[9px] leading-[12px] text-muted-foreground">
              Son Kullanılanlar&apos;dan kapatılan uygulamanın penceresi kapanır ya da «Yeniden aç» kartı gösterir. Çalışma
              Alanı görevleri her zaman kapanır.
            </p>
          </SettingsGroup>

          <SettingsGroup
            dense
            icon={Layers}
            title="Varsayılan Pencereleme Davranışı"
            value={WINDOW_MODES.find((item) => item.value === windowMode)?.label ?? ''}
          >
            <div className="grid grid-cols-3 gap-1">
              {WINDOW_MODES.map((item) => (
                <IconTile
                  variant="outlined"
                  dense
                  key={item.value}
                  icon={item.icon}
                  title={item.label}
                  status={item.hint}
                  active={windowMode === item.value}
                  onClick={() => handleWindowModeChange(item.value)}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[9px] leading-[12px] text-muted-foreground">
              Bu cihaz <strong className="font-semibold text-foreground">~16</strong> bağımsız pencere destekliyor.
            </p>
          </SettingsGroup>

          <Button variant="outline" size="lg" className="w-full text-[11px]" startIcon={<ExternalLink className="size-3.5" />} onClick={handleOpenAllSettings}>
            Tüm OpenDeX Ayarlarını Aç
          </Button>
        </TabPane>
      </div>
    </PanelShell>
  );
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Sekmeler: sabit boyutlu panel uzun bir kaydırma listesi yerine beş odaklı sekmeye bölünür; her sekme tek ekrana sığar.
// İlk ikisi ODAKTAKİ pencereye, son üçü tüm pencerelere aittir (kapsam etiketi sekmelerin üstünde, hep görünür).
// Bütün sekme gövdeleri bağlı kalır (yalnız `hidden`): kaydırıcı/odak durumu sekme değişince kaybolmaz.

const DEX_TABS = [
  { id: 'density', scope: 'window', label: 'Yoğunluk', icon: Gauge },
  { id: 'window', scope: 'window', label: 'Pencere', icon: AppWindow },
  { id: 'general', scope: 'global', label: 'Genel', icon: SlidersHorizontal },
  { id: 'stream', scope: 'global', label: 'Akış', icon: Activity },
  { id: 'system', scope: 'global', label: 'Sistem', icon: Smartphone },
];

const DENSITY_MODE_LABEL = { auto: 'Oto', custom: 'Özel', target: 'Target', phone: 'Telefon' };
const CODEC_SHORT = { auto: 'Oto', h265: 'H.265', av1: 'AV1', h264: 'H.264' };

function DexTabs({ tabs, active, onChange, windowIcon, windowName }) {
  const activeScope = tabs.find((t) => t.id === active)?.scope;
  const onKeyDown = (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const at = tabs.findIndex((t) => t.id === active);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="shrink-0 border-b border-border/70 px-3">
      <div className="grid grid-cols-[2fr_3fr]">
        <ScopeLabel scope="window" active={activeScope === 'window'} icon={windowIcon} title="Bu pencere" name={windowName} />
        <ScopeLabel
          scope="global"
          active={activeScope === 'global'}
          title="Tüm pencereler"
          hint="Yeni açılan pencerelere, oturumun geneline ve «Genele uy» diyen pencerelere uygulanır."
        />
      </div>
      <div role="tablist" aria-label="DeX ayar bölümleri" onKeyDown={onKeyDown} className="grid grid-cols-5">
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`dex-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`dex-pane-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              className={cn(
                'relative flex h-8 cursor-pointer items-center justify-center gap-1 text-[10px] font-semibold outline-none transition-colors focus-visible:bg-accent/60',
                selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                index === 2 && 'border-l border-border/70',
              )}
            >
              <Icon className="size-3.5 shrink-0" strokeWidth={selected ? 2.2 : 1.8} />
              <span>{tab.label}</span>
              {selected && (
                <motion.span
                  layoutId="dex-tab-indicator"
                  transition={{ type: 'spring', stiffness: 520, damping: 40 }}
                  className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ScopeLabel({ scope, icon, title, name, hint, active }) {
  return (
    <div data-scope={scope} title={hint} className={cn('flex min-w-0 items-center gap-1.5 pb-1 pr-2 transition-opacity', active ? 'opacity-100' : 'opacity-55')}>
      {icon}
      <h3 className="flex min-w-0 items-baseline gap-1.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
        <span className="shrink-0">{title}</span>
        {name && <span className="truncate text-[10.5px] font-semibold normal-case tracking-normal text-foreground">{name}</span>}
      </h3>
    </div>
  );
}

function TabPane({ id, active, children }) {
  // `hidden` kökte kalır (bir display sınıfı onu ezmesin); düzen iç sarmalayıcıdadır.
  return (
    <div role="tabpanel" id={`dex-pane-${id}`} aria-labelledby={`dex-tab-${id}`} hidden={!active}>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

/** Üç hücrelik canlı okuma şeridi: etkin değerler ayarın hemen üstünde, kaydırmadan görünür. */
function Readout({ items }) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {items.map(({ label, value, unit }) => (
        <div key={label} className="min-w-0 rounded-md border border-border/60 bg-background/70 px-2 py-1">
          <div className="truncate text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="flex items-baseline gap-0.5 truncate font-mono text-[13px] font-semibold leading-[17px] tabular-nums">
            {value}
            {unit && <span className="text-[8px] font-medium text-muted-foreground">{unit}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Başlık solda, 3 seçenek sağda: tek satırlık üç durumlu ayar (<section>: başlık ve seçenekler aynı kapsayıcıda). */
function InlineChoice({ title, options, value, onChange, dataSetting }) {
  return (
    <section className="flex items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/40 p-2">
      <h3 className="min-w-0 shrink text-[11px] font-semibold leading-[13px]">{title}</h3>
      <div className="grid w-[236px] shrink-0 grid-cols-3 gap-1" data-window-setting={dataSetting}>
        {options.map((option) => (
          <ChoiceChip
            dense
            key={String(option.value)}
            label={option.label}
            hint={option.hint}
            active={value === option.value}
            onClick={() => onChange(option.value)}
          />
        ))}
      </div>
    </section>
  );
}

export default DexSettings;
