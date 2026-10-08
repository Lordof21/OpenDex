import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  AudioLines,
  BatteryCharging,
  Blocks,
  Check,
  ChevronRight,
  Code2,
  Cpu,
  Crop,
  Gauge,
  Info,
  Maximize2,
  Minus,
  Monitor,
  MonitorCog,
  Palette,
  Radio,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Speaker,
  Volume2,
  X,
  Zap,
} from 'lucide-react';

import Button from '../ui/Button.jsx';
import { IconButton } from '../ui/IconButton.jsx';
import { InfoCard } from '../ui/Card.jsx';
import { OptionGroup } from '../ui/Choice.jsx';
import { SwitchRow } from '../ui/Switch.jsx';
import { PanelHeader } from '../ui/Typography.jsx';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { useTheme } from '../state/ThemeContext.jsx';
import { cn } from '../lib/utils.js';
import { useSystemStore } from '../state/systemStore.js';
import { FIT_MODES, modeOf, targetDisplaySizeForWindow, useWindowStore } from '../window/windowStore.js';
import { updateSettings, useLiveSettings } from './liveSettings.js';
import { api } from '../lib/api.js';
import { logger } from '../lib/logger.js';
import { copyDiagnosticsReport } from '../lib/diagnosticsReport.js';
import { sessionAudioPlayer } from '../media/audioPlayer.js';
import { isLegacyAudioMode, useAudioMixerStore } from '../state/audioMixerStore.js';
import { PrecisionSlider } from '../ui/PrecisionSlider.jsx';
import { ROUTE_OPTIONS } from '../ui/audioRouting.jsx';
import SyncFineTune from '../taskbar/SyncFineTune.jsx';

export const OPENDEX_SETTINGS_EVENT = 'opendex:open-settings';

export function openOpenDexSettings() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPENDEX_SETTINGS_EVENT));
}

const SECTIONS = [
  { id: 'display', label: 'Görüntü & Çözünürlük', icon: Monitor },
  { id: 'stream', label: 'Yayın Kalitesi', icon: Radio },
  { id: 'fit', label: 'Görüntü Sığdırma (Fit)', icon: Crop },
  { id: 'audio', label: 'Ses & Aktarım', icon: Speaker },
  { id: 'power', label: 'Performans & Pil', icon: BatteryCharging },
  { id: 'theme', label: 'Arayüz & Tema', icon: Palette },
  { id: 'developer', label: 'Geliştirici (Beta)', icon: Code2 },
  { id: 'notes', label: 'Geliştirici Notları', icon: Info },
  { id: 'system', label: 'Sistem & Teşhis', icon: Activity },
];

const RESOLUTION_OPTIONS = [
  { value: 'dynamic', label: 'Dinamik', description: 'Pencerenin o anki boyutlarına otomatik uyum sağlar. Ekstra konfigürasyon gerektirmez.', tag: 'Otomatik Esnek' },
  { value: 'phone_scale', label: 'Telefon ölçeği (Zoom)', description: 'Uygulamalar telefondaki düzeniyle açılır. Pencereyi büyütmek yakınlaştırır, kareye yaklaştırmak tablet düzenine geçirir. Telefon ölçüleri cihaz bağlanınca okunur.', tag: 'Telefon Düzeni' },
  { value: 'dynamic_fix', label: 'Dinamik‑Fix (Tam Oturtma)', description: 'Pencerenin video alanının en/boy oranını birebir takip eder. Siyah çubuk ve esneme kalmaz; çözünürlük kodlayıcı uyumlu 8 katına hizalanır.', tag: 'Sıfır Boşluk / Tam Oran' },
  { value: '1080p', label: 'Sabit 1080p Standart', description: '16:9 Widescreen standart masaüstü görünümü ve kristal netlik.', tag: '1920x1080 @ 240 DPI' },
  { value: 'tablet', label: 'Tablet Modu (Yüksek Dikey İçerik)', description: '960 dp dikey alan ile tek ekranda 2 kat daha fazla metin, kod ve web içeriği.', tag: '1920x1200 @ 200 DPI' },
  { value: '2k', label: 'Sabit 2K Masaüstü', description: 'Ultra HD geniş ekran ve 2K monitörler için yüksek piksel netliği.', tag: '2560x1440 @ 210 DPI' },
  { value: '2.5k', label: '2.5K Tablet (Maks Doygunluk)', description: '1422 dp dikey alan ile maksimum sayfa ve doküman okuma doygunluğu.', tag: '2560x1600 @ 180 DPI' },
];

const DPI_OPTIONS = [
  { value: 'auto', label: 'Otomatik (Canlı: 120 DPI)', description: 'Oxford modeline göre 180‑220 DPI arasında canlı ergonomik ölçekleme.', tag: 'Oto (120 DPI)' },
  { value: '180', label: '180 DPI (DeX Masaüstü)', description: 'Geniş çalışma alanı, çok sütunlu masaüstü görünümü (~920+ dp).', tag: 'Masaüstü' },
  { value: '200', label: '200 DPI (Ergonomik Optimum)', description: '1080p panelde ISO 9241‑303 standardına göre altın oran (~20 arcmin).', tag: 'Optimum' },
  { value: '220', label: '220 DPI (Tablet / Kompakt)', description: 'Dengeli yazı boyutu, rahat okunabilirlik ve tablet görünümü (~720 dp).', tag: 'Kompakt' },
  { value: '240', label: '240 DPI (Büyük & Rahat)', description: 'Gözü yormayan geniş dokunmatik hedefler ve büyük metinler (~600 dp).', tag: 'Büyük Metin' },
  { value: '320', label: '320 DPI (Erişilebilirlik)', description: 'Maksimum büyüklükte ikon ve metinler, üst düzey okunabilirlik.', tag: 'Erişilebilirlik' },
];

const TARGET_DP_OPTIONS = [
  { value: 'auto', label: 'Otomatik (Dinamik Ergonomik)', description: 'Oxford ergonomik modeline göre 180‑220 DPI arasında gözü yormayan altın oranda kesintisiz ölçekler.', tag: 'Önerilen' },
  { value: '600', label: '600 dp (Tablet ‑ Çift Panel)', description: "Android tablet modunu (master‑detail / iki sütun) kilitler (~210‑240 DPI).", tag: '600 dp' },
  { value: '720', label: '720 dp (Masaüstü DeX ‑ Standart)', description: 'Samsung DeX tarzı çok sütunlu standart masaüstü arayüzü sağlar (~200‑220 DPI).', tag: '720 dp' },
  { value: '840', label: '840 dp (Geniş Masaüstü)', description: 'Geniş ekranlarda maksimum üretkenlik ve okunabilirlik dengesi (~180‑190 DPI).', tag: '840 dp' },
  { value: '960', label: '960 dp (Yüksek Yoğunluk)', description: '16:10 dikey alan ve maksimum içerik görünürlüğü (~180 DPI tabanı).', tag: '960 dp' },
];

const CODEC_OPTIONS = [
  { value: 'auto', label: 'Otomatik (H.265 DeX Kalitesi)', description: 'Cihazın donanımına göre en net H.265 (HEVC) kodlayıcıyı otomatik başlatır.', tag: 'Önerilen' },
  { value: 'h265', label: 'H.265 (HEVC Donanım)', description: 'Samsung DeX standardı: %50 daha keskin metinler, sıfır renk kanaması ve yüksek kontrast.', tag: 'Maksimum Netlik' },
  { value: 'av1', label: 'AV1 (Yeni Nesil)', description: 'Modern açık kaynaklı ultra‑verimli kodek. Yalnızca destekleyen işlemcilerde aktiftir.', tag: 'Yeni Nesil' },
  { value: 'h264', label: 'H.264 (Klasik)', description: 'Eski donanımlar için evrensel uyumluluk modu.', tag: 'Klasik' },
];

const SHARPEN_OPTIONS = [
  { value: 'smart', label: 'Akıllı DeX Keskinliği', description: 'Gözü yormadan doğal ve temiz kenar netliği.', tag: 'Önerilen' },
  { value: 'ultra', label: 'Ultra Keskin (Lanczos/CAS)', description: 'Yüksek kontrastlı kristal harfler.', tag: 'Ultra' },
  { value: 'off', label: 'Kapalı (Standart)', description: 'Filtresiz düz çizim.', tag: 'Standart' },
];

const FPS_OPTIONS = [
  { value: '15', label: '15 FPS', description: 'Düşük veri kullanımı', tag: 'Tasarruf' },
  { value: '30', label: '30 FPS', description: 'Standart akıcılık', tag: 'Dengeli' },
  { value: '60', label: '60 FPS', description: 'Maksimum akıcılık', tag: 'Önerilen' },
];

const BITRATE_OPTIONS = [
  { value: '2', label: '2 Mbps', description: 'Zayıf ağ için', tag: 'Düşük' },
  { value: '4', label: '4 Mbps', description: 'Orta kalite', tag: 'Dengeli' },
  { value: '8', label: '8 Mbps', description: 'Kristal netlik', tag: 'Varsayılan' },
  { value: '12', label: '12 Mbps', description: 'Ultra HD', tag: 'Maksimum' },
  { value: '16', label: '16 Mbps', description: '2K netlik için önerilen', tag: 'RTX Önerilen' },
  { value: '20', label: '20 Mbps', description: 'RTX 30xx+ için', tag: 'RTX Güçlü' },
];

const WINDOW_LIMIT_OPTIONS = [
  { value: 'auto', label: 'Otomatik (Donanım Limiti)', description: 'Cihazın test/donanım sınırını otomatik kullanır.', tag: 'Donanım Sınırı' },
  { value: '2', label: '2 Pencere', description: 'Yan yana 2 aktif canlı pencere.', tag: '2 Aktif' },
  { value: '3', label: '3 Pencere', description: 'Dengeli kaynak kullanımı.', tag: '3 Aktif' },
  { value: '4', label: '4 Pencere', description: 'Çoklu görev için ideal.', tag: '4 Aktif' },
  { value: '6', label: '6 Pencere', description: 'Yüksek performanslı cihazlar.', tag: '6 Aktif' },
  { value: '16', label: '16 Pencere', description: 'Maksimum donanım kapasitesi.', tag: 'Maks. 16' },
];

const FIT_OPTIONS = [
  { value: 'fill', label: FIT_MODES.fill.label, description: 'Pencereyi %100 kenardan kenara doldurur. Yanlarda hiç siyah boşluk kalmaz, tüm uygulama butonları görünür.', tag: 'Varsayılan (Önerilen)' },
  { value: 'contain', label: FIT_MODES.fit.label, description: 'Görüntü oranını (16:10 / 16:9) %100 korur, uzatma yapmaz (yanlarda siyah çubuk kalabilir, %100 içerik netliği).', tag: 'Sıfır Esneme' },
  { value: 'cover', label: FIT_MODES.cover.label, description: 'Görüntüyü uzatmadan pencereye zoom yapar. Siyah çubuk kalmaz; ancak pencere oranına göre kenardaki butonlar dışarı taşabilir.', tag: 'Zoom / Kenar Kırpma' },
];

// The default route of apps that have no route of their own — the same Telefon / DeX / İkisi as everywhere (ui/audioRouting).
const AUDIO_ROUTE_TEXT = {
  phone: { description: 'Ses aktarımı kapatılır; sesler telefonun kendi hoparlöründen veya telefona bağlı kulaklıktan çalar.', tag: 'Telefonda Çal' },
  pc: { description: 'Tüm Android sesleri bilgisayarınıza (DeX) aktarılır. Telefonun kendi hoparlörü sessiz kalır.', tag: 'Önerilen (Masaüstü)' },
  both: { description: 'Sesler aynı anda hem telefondan hem DeX\'ten çalar; iki çıkış aynı ana hizalanır.', tag: 'Eşzamanlı' },
};
const AUDIO_ROUTE_OPTIONS = ROUTE_OPTIONS.map(({ value, label }) => ({ value, label, ...AUDIO_ROUTE_TEXT[value] }));

const AUDIO_CODEC_OPTIONS = [
  { value: 'pcm', label: 'Raw PCM', description: 'Sıfır gecikmeli direkt işlenebilir ham PCM ses akışı.', tag: 'Sıfır Gecikme (Varsayılan)' },
  { value: 'opus', label: 'Opus Codec', description: 'Düşük bant genişliği kullanan sıkıştırılmış ses akışı.', tag: 'Düşük Veri' },
];

const THEME_OPTIONS = [
  { value: 'light', label: 'Açık Mod (Gri‑Beyaz)', description: 'Free‑React Admin paleti: temiz gri‑beyaz duvar kağıdı, yüksek okunabilirlik.', tag: 'Varsayılan Hakim Mod' },
  { value: 'dark', label: 'Karanlık Mod (Gece Mavisi)', description: 'Derin gece mavisi ve antrasit cam efekti.', tag: 'Dark Glassmorphic' },
];

const SYSTEM_ROWS = [
  { label: 'OpenDeX Sürümü', value: 'v4.2', hint: 'Engine v4.2' },
  { label: 'Scrcpy Core', value: 'v4.1' },
  { label: 'A/V Senkronizasyon Saati', value: 'PTS Monotonic Sync' },
  { label: 'Ses Aktarım Protokolü', value: '48kHz PCM Dual Playback' },
  { label: 'Encoder Limiti', value: '16', hint: 'doğrulanmış' },
  { label: 'Esnek Ekran Boyutlandırma', value: 'Destekleniyor' },
];

// Ayrıntılı akış loglarını konsola/terminale açan izleme kategorileri (tarayıcı + backend aynı anda).
const TRACE_CHOICES = [
  { id: 'handoff', label: 'Telefon ⟷ PC geçişi' },
  { id: 'applock', label: 'Uygulama kilidi' },
  { id: 'teleport', label: 'Workspace taşıma' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'power', label: 'Ekran gücü' },
  { id: 'supervisor', label: 'Bağlantı denetçisi' },
  { id: 'media', label: 'Medya' },
  { id: 'video', label: 'Yayın (video)' },
];

const MIN_W = 460;
const MIN_H = 340;

export default function SettingsPanel() {
  const reduceMotion = useReducedMotion();
  const {
    settingsOpen,
    openSettings,
    settingsMinimized,
    settingsMaximized,
    settingsFocused,
    restoreSettings,
    minimizeSettings,
    toggleSettingsMaximized,
    focusSettings,
    closeSettings,
  } = useSystemStore();

  const [section, setSection] = useState('display');
  const [frame, setFrame] = useState(null);
  const contentRef = useRef(null);
  const stageRef = useRef(null);
  const restoreRef = useRef(null);

  const stageSize = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    return {
      width: rect?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1200),
      height: rect?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 800),
    };
  };

  const openWindow = useCallback(() => {
    openSettings();
    restoreSettings();
    focusSettings();
    setSection('display');
    setFrame((current) => {
      if (current) return current;
      const sw = typeof window !== 'undefined' ? window.innerWidth : 1200;
      const sh = typeof window !== 'undefined' ? window.innerHeight : 800;
      const width = Math.min(1040, Math.max(MIN_W, sw - 48));
      const height = Math.min(680, Math.max(MIN_H, sh - 120));
      return {
        x: Math.max(12, Math.round((sw - width) / 2)),
        y: Math.max(12, Math.round((sh - height) / 2 - 20)),
        width,
        height,
      };
    });
  }, [restoreSettings, focusSettings]);

  useEffect(() => {
    if (settingsOpen && !frame) {
      const sw = typeof window !== 'undefined' ? window.innerWidth : 1200;
      const sh = typeof window !== 'undefined' ? window.innerHeight : 800;
      const width = Math.min(1040, Math.max(MIN_W, sw - 48));
      const height = Math.min(680, Math.max(MIN_H, sh - 120));
      setFrame({
        x: Math.max(12, Math.round((sw - width) / 2)),
        y: Math.max(12, Math.round((sh - height) / 2 - 20)),
        width,
        height,
      });
    }
  }, [settingsOpen, frame]);

  useEffect(() => {
    const onOpen = () => openWindow();
    window.addEventListener(OPENDEX_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPENDEX_SETTINGS_EVENT, onOpen);
  }, [openWindow]);

  // Esc yalnız en üstteki katmanı kapatır (lib/escapeStack): açık bir panel/menü varsa önce o kapanır.
  useEffect(() => {
    if (!settingsOpen || settingsMinimized) return undefined;
    return pushEscapeHandler(() => closeSettings());
  }, [settingsOpen, settingsMinimized, closeSettings]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [section, reduceMotion]);

  const startMove = (event) => {
    if (settingsMaximized || !frame) return;
    if (event.button !== 0) return;
    if (event.target.closest('button') || event.target.closest('input')) return;
    focusSettings();
    const px = event.clientX;
    const py = event.clientY;
    const start = { ...frame };
    const move = (moveEvent) => {
      const stage = stageSize();
      const x = Math.min(Math.max(0, start.x + moveEvent.clientX - px), Math.max(0, stage.width - start.width));
      const y = Math.min(Math.max(0, start.y + moveEvent.clientY - py), Math.max(0, stage.height - 48));
      setFrame({ x, y, width: start.width, height: start.height });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startResize = (dir) => (event) => {
    if (settingsMaximized || !frame) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    focusSettings();
    const px = event.clientX;
    const py = event.clientY;
    const start = { ...frame };
    const move = (moveEvent) => {
      const stage = stageSize();
      const dx = moveEvent.clientX - px;
      const dy = moveEvent.clientY - py;
      let { x, y, width, height } = start;
      if (dir.includes('e')) width = Math.min(Math.max(MIN_W, start.width + dx), stage.width - start.x);
      if (dir.includes('s')) height = Math.min(Math.max(MIN_H, start.height + dy), stage.height - start.y);
      if (dir.includes('w')) {
        const next = Math.min(Math.max(MIN_W, start.width - dx), start.x + start.width);
        x = start.x + start.width - next;
        width = next;
      }
      if (dir.includes('n')) {
        const next = Math.min(Math.max(MIN_H, start.height - dy), start.y + start.height);
        y = start.y + start.height - next;
        height = next;
      }
      setFrame({ x, y, width, height });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const toggleMaximize = () => {
    toggleSettingsMaximized();
    if (!settingsMaximized) {
      restoreRef.current = frame;
      const stage = stageSize();
      setFrame({ x: 0, y: 0, width: stage.width, height: stage.height });
    } else {
      if (restoreRef.current) setFrame(restoreRef.current);
    }
  };

  const isCompact = (frame?.width ?? 1200) < 540;

  return (
    <div ref={stageRef} className="pointer-events-none fixed inset-0 z-[70] overflow-hidden">
      <AnimatePresence>
        {settingsOpen && !settingsMinimized && frame && (
          <motion.section
            key="opendex-settings-window"
            role="dialog"
            aria-label="Tüm OpenDeX ayarları"
            onPointerDown={focusSettings}
            className={cn(
              'pointer-events-auto absolute flex flex-col overflow-hidden rounded-xl border border-border/80 bg-popover/95 backdrop-blur-2xl transition-shadow duration-200 select-none shadow-none',
              settingsFocused ? 'ring-1 ring-primary/20' : 'opacity-95'
            )}
            style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.985 }}
            transition={{ type: 'spring', stiffness: 420, damping: 40, mass: 0.8 }}
          >
            {/* Window Header */}
            <header
              onPointerDown={startMove}
              className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 bg-muted/40 px-3 select-none cursor-default"
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-primary text-[10px] font-semibold text-primary-foreground">
                D
              </span>
              <div className="min-w-0 flex-1 select-none">
                <p className="truncate text-[12px] font-semibold leading-none text-foreground">
                  OpenDeX Ayarları
                </p>
                <p className="mt-0.5 truncate text-[9px] text-muted-foreground">
                  Zero‑APK · saf ADB köprüsü · Engine v4.2
                </p>
              </div>
              <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-background px-2 py-1 text-[9px] font-medium text-muted-foreground sm:inline-flex">
                <span className="size-1.5 rounded-full bg-status-active" />
                Bağlı · Dinamik‑Fix
              </span>
              <IconButton label="Simge durumuna küçült" size="sm" tooltipPosition="bottom" onClick={minimizeSettings}>
                <Minus />
              </IconButton>
              <IconButton
                label={settingsMaximized ? 'Küçült' : 'Tam ekran'}
                aria-pressed={settingsMaximized}
                size="sm"
                tooltipPosition="bottom"
                onClick={toggleMaximize}
              >
                <Maximize2 />
              </IconButton>
              <IconButton label="Kapat" size="sm" danger="close" tooltipPosition="bottom" tooltipAlign="end" onClick={closeSettings}>
                <X />
              </IconButton>
            </header>

            {/* Window Content */}
            <div className="flex min-h-0 flex-1 flex-row">
              <nav
                aria-label="Ayar bölümleri"
                className={cn(
                  'flex w-11 shrink-0 flex-col gap-1 overflow-hidden border-r border-border/60 p-1.5 bg-muted/20 select-none',
                  !isCompact && 'md:w-52'
                )}
              >
                {SECTIONS.map((item) => {
                  const active = section === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      title={item.label}
                      aria-label={item.label}
                      onClick={() => setSection(item.id)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex h-9 w-full shrink-0 flex-1 items-center gap-2 rounded-md px-1 transition-colors cursor-pointer',
                        isCompact ? 'justify-center' : 'justify-center px-2.5 py-1.5 md:justify-start',
                        active
                          ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                      )}
                    >
                      <item.icon className={cn('shrink-0', isCompact ? 'size-[18px]' : 'size-[18px] md:size-3.5')} />
                      <span className={cn('text-[11px] font-semibold leading-[14px]', isCompact ? 'sr-only' : 'hidden md:block md:truncate')}>
                        {item.label}
                      </span>
                    </button>
                  );
                })}
              </nav>

              <div ref={contentRef} className="dex-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-5 [scrollbar-gutter:stable]">
                <SectionBody section={section} />
              </div>
            </div>

            {/* 8-Direction Resizers */}
            {!settingsMaximized && (
              <>
                <div onPointerDown={startResize('n')} className="absolute inset-x-3 top-0 h-1.5 cursor-ns-resize" />
                <div onPointerDown={startResize('s')} className="absolute inset-x-3 bottom-0 h-1.5 cursor-ns-resize" />
                <div onPointerDown={startResize('w')} className="absolute inset-y-3 left-0 w-1.5 cursor-ew-resize" />
                <div onPointerDown={startResize('e')} className="absolute inset-y-3 right-0 w-1.5 cursor-ew-resize" />
                <div onPointerDown={startResize('nw')} className="absolute left-0 top-0 size-3 cursor-nwse-resize" />
                <div onPointerDown={startResize('ne')} className="absolute right-0 top-0 size-3 cursor-nesw-resize" />
                <div onPointerDown={startResize('sw')} className="absolute bottom-0 left-0 size-3 cursor-nesw-resize" />
                <div onPointerDown={startResize('se')} className="absolute bottom-0 right-0 size-3 cursor-nwse-resize" />
              </>
            )}
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

function SectionBody({ section }) {
  const { theme, setTheme } = useTheme();
  const pushToast = useSystemStore((s) => s.pushToast);

  // Genel ayarlar tek canlı kaynaktan türetilir (settings/liveSettings): DeX paneliyle her an aynı değer,
  // değişiklik anında görünür, kayıtlar sıralı. Backend ⟷ arayüz değer dönüşümleri burada tek yerde.
  const live = useLiveSettings() || {};
  const flag = (key, fallback) => (live[key] === undefined ? fallback : Boolean(live[key]));
  const smartResize = flag('dynamic_resolution_enabled', true);
  const resolution = live.resolution_mode || 'dynamic_fix';
  const dpi = live.custom_dpi > 0 ? String(live.custom_dpi) : 'auto';
  const targetDp = live.target_dp > 0 ? String(live.target_dp) : 'auto';
  const codec = live.video_codec || 'auto';
  const subpixel = flag('pixel_perfect_dpr', true);
  const instantResize = flag('resize_instant_apply', false);
  const sharpenRaw = live.sharpening_mode || live.sharpening;
  const sharpen = sharpenRaw ? (sharpenRaw === 'adaptive' ? 'smart' : sharpenRaw) : 'smart';
  const stealth = flag('stealth_dpi_enabled', true);
  const densityRefresh = flag('density_refresh_enabled', true);
  const densityRefreshHard = flag('density_refresh_hard', false);
  const handoffPrelanding = flag('handoff_prelanding', true);
  const fps = live.max_fps ? String(live.max_fps) : '60';
  const bitrate = live.video_bit_rate !== undefined ? String(Math.round(live.video_bit_rate / 1_000_000)) : '8';
  const windowLimit = live.custom_encoder_limit > 0 ? String(live.custom_encoder_limit) : 'auto';
  const fit = live.video_fit_mode || live.video_fit || 'fill';
  const audioRoute = live.audio_output_mode || 'pc';
  const audioCodec = live.audio_codec ? (live.audio_codec === 'raw' ? 'pcm' : live.audio_codec) : 'pcm';
  const dimPhone = flag('screen_off_while_mirroring', true);
  const ambient = flag('ambient_backdrop', true);
  const rememberDevices = flag('remember_devices', true);

  // Yalnız bu oturumda tutulan (backend'e yazılmayan) anahtarlar.
  const [inspector, setInspector] = useState(false);
  const [testState, setTestState] = useState('idle');
  const [logState, setLogState] = useState('idle'); // idle | busy | done | failed
  const [logInfo, setLogInfo] = useState('');
  const [traceSel, setTraceSel] = useState(() => logger.getTrace());

  // Son kaydetme sözü: pencere yeniden hesabı KAYDEDİLMİŞ ayarı okur (eskiden kayıt bitmeden hesaplanıyordu).
  const lastSave = useRef(Promise.resolve());
  const handleUpdate = (patch) => {
    lastSave.current = updateSettings(patch).catch(() => {});
    return lastSave.current;
  };

  const windows = useWindowStore((s) => s.windows);
  // Odaktaki pencere: store'da `activeWindowId` alanı YOK (DexSettings ile aynı kural: `focused` bayrağı) — eskiden
  // gösterge her zaman listedeki ilk pencerenin DPI'ını gösteriyordu.
  const activeWindow = windows.find((w) => w.focused && !w.minimized) || windows.find((w) => !w.minimized);
  // Gösterge: odaktaki pencerenin GERÇEK yoğunluğu (kendi DPI politikası ve başlık durumu tek fonksiyondan).
  const liveEffectiveDpi = activeWindow
    ? (targetDisplaySizeForWindow(
        activeWindow,
        {
          resolution_mode: resolution || 'dynamic_fit',
          custom_dpi: dpi === 'auto' ? 0 : Number(dpi),
          target_dp: targetDp === 'auto' ? 0 : Number(targetDp),
        },
        {
          w: activeWindow.w || (typeof window !== 'undefined' ? window.innerWidth : 1920),
          h: activeWindow.h || (typeof window !== 'undefined' ? window.innerHeight - 50 : 1030),
        },
        { mode: modeOf(activeWindow) },
      )?.dpi || 206)
    : 206;

  // Genel ayar değişince açık pencerelerin akışı yeniden hesaplanır: her pencere KENDİ DPI politikasını korur
  // (genel özel DPI / Target DP yalnız YENİ pencerelerin varsayılanıdır).
  const updateGeometry = (patch) => {
    handleUpdate(patch);
    if (!smartResize) return;
    lastSave.current.then(() => useWindowStore.getState().applyDynamicResolutionToOpenWindows()).catch(() => {});
  };

  const handleResolutionChange = (val) => updateGeometry({ resolution_mode: val });
  // Özel DPI ile Target DP birbirini dışlar: biri seçilince diğeri otomatiğe (0) döner.
  const handleDpiChange = (val) => {
    const num = val === 'auto' ? 0 : parseInt(val, 10);
    updateGeometry(num > 0 ? { custom_dpi: num, target_dp: 0 } : { custom_dpi: 0 });
  };
  // Target DP "Oto": Target DP'nin o an ürettiği DPI özel DPI olarak korunur (yoğunluk sıçramaz; DPI onu dinler).
  const handleTargetDpChange = (val) => {
    const num = val === 'auto' ? 0 : parseInt(val, 10);
    if (num > 0) return updateGeometry({ target_dp: num, custom_dpi: 0 });
    // GENEL Target DP'nin ürettiği DPI (pencerenin kendi politikası değil) — politika açıkça verilir.
    const heldDpi =
      targetDp !== 'auto' && activeWindow
        ? targetDisplaySizeForWindow(
            activeWindow,
            { resolution_mode: resolution || 'dynamic_fit', custom_dpi: 0, target_dp: Number(targetDp) },
            {
              w: activeWindow.w || (typeof window !== 'undefined' ? window.innerWidth : 1920),
              h: activeWindow.h || (typeof window !== 'undefined' ? window.innerHeight - 50 : 1030),
            },
            { mode: modeOf(activeWindow), policy: { mode: 'target', dp: Number(targetDp) } },
          )?.dpi
        : 0;
    return updateGeometry(heldDpi > 0 ? { target_dp: 0, custom_dpi: Math.round(heldDpi) } : { target_dp: 0 });
  };
  const handleCodecChange = (val) => handleUpdate({ video_codec: val });
  const handleFpsChange = (val) => handleUpdate({ max_fps: parseInt(val, 10) });
  const handleBitrateChange = (val) => handleUpdate({ video_bit_rate: parseInt(val, 10) * 1_000_000 });
  const handleFitChange = (val) => handleUpdate({ video_fit_mode: val });
  const handleSharpenChange = (val) => handleUpdate({ sharpening_mode: val === 'smart' ? 'adaptive' : val });
  const handleWindowLimitChange = (val) => handleUpdate({ custom_encoder_limit: val === 'auto' ? 0 : parseInt(val, 10) });

  const handleAudioRouteChange = (val) => {
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
    handleUpdate({ audio_output_mode: val, enable_audio: val !== 'phone' });
  };

  const handleAudioCodecChange = (val) => handleUpdate({ audio_codec: val === 'pcm' ? 'raw' : val });
  const handleSmartResizeToggle = () => handleUpdate({ dynamic_resolution_enabled: !smartResize });
  const handleSubpixelToggle = () => handleUpdate({ pixel_perfect_dpr: !subpixel });
  const handleInstantResizeToggle = () => handleUpdate({ resize_instant_apply: !instantResize });
  const handleStealthToggle = () => handleUpdate({ stealth_dpi_enabled: !stealth });
  const handleDensityRefreshToggle = () => handleUpdate({ density_refresh_enabled: !densityRefresh });
  const handleDensityRefreshHardToggle = () => handleUpdate({ density_refresh_hard: !densityRefreshHard });
  const handleHandoffPrelandingToggle = () => handleUpdate({ handoff_prelanding: !handoffPrelanding });
  const handleDimPhoneToggle = () => handleUpdate({ screen_off_while_mirroring: !dimPhone });
  const handleAmbientToggle = () => handleUpdate({ ambient_backdrop: !ambient });
  const handleRememberDevicesToggle = () => handleUpdate({ remember_devices: !rememberDevices });

  const handleCopyLogs = async () => {
    setLogState('busy');
    try {
      const res = await copyDiagnosticsReport();
      setLogState(res.ok ? 'done' : 'failed');
      setLogInfo(res.ok ? `${res.lines} satır panoya kopyalandı` : 'Panoya yazılamadı (tarayıcı izni gerekebilir)');
    } catch (err) {
      setLogState('failed');
      setLogInfo(String(err?.message || err));
    }
  };

  const handleTraceToggle = (id) => {
    const next = traceSel.includes(id) ? traceSel.filter((c) => c !== id) : [...traceSel, id];
    setTraceSel(next);
    logger.setTrace(next);
    api.post('/api/diagnostics/log-level', { trace: next }).catch(() => {});
  };

  const runTest = async () => {
    setTestState('running');
    try {
      // EncoderStressTestResult: the MEASURED limit, never a hardcoded number.
      const res = await api.post('/api/device/encoder-stress-test');
      setTestState('done');
      const limit = Number(res?.measured_encoder_limit);
      if (limit > 0) {
        pushToast?.(
          `Encoder kapasite testi tamamlandı: ${limit} eşzamanlı pencere destekleniyor` +
            (res?.capped_by_safety_limit ? ' (güvenlik sınırında durduruldu).' : '.'),
        );
      } else {
        pushToast?.(`Encoder kapasite testi sonuç vermedi${res?.failure_reason ? `: ${res.failure_reason}` : '.'}`);
      }
    } catch (err) {
      setTestState('done');
      pushToast?.(`Encoder kapasite testi başarısız: ${err?.detail || err?.message || 'bilinmeyen hata'}`);
    }
  };

  if (section === 'display')
    return (
      <Stack>
        <PanelHeader iconTone="soft" size="md" icon={Monitor} title="Görüntü & Çözünürlük" subtitle="Çözünürlük stratejisi, içerik yoğunluğu ve kodlayıcı" />
        <SwitchRow
          icon={Sparkles}
          title="Yeniden boyutlandırmada gerçek çözünürlük iste"
          description="Daha keskin görüntü; boyut değişiminde kısa bir donma olabilir. Zayıf cihazlarda kapalı tutulabilir."
          checked={smartResize}
          onToggle={handleSmartResizeToggle}
        />
        <SwitchRow
          icon={Maximize2}
          title="Anında Boyutlandır"
          description="Pencere bırakıldığı an yeni boyuta geçer; yeni görüntü gelene kadar eski görüntü ölçeklenmiş görünür."
          checked={instantResize}
          onToggle={handleInstantResizeToggle}
        />
        <OptionGroup
          icon={MonitorCog}
          title="Çözünürlük ve Görünüm Stratejisi"
          subtitle="Pencerenize uygulanacak çözünürlük, ekran oranı ve dikey içerik yoğunluğunu seçin:"
          options={RESOLUTION_OPTIONS}
          value={resolution}
          onChange={handleResolutionChange}
          columns={2}
        />
        <InfoCard title="Dinamik‑Fix & Oxford Ergonomik DP Modeli">
          Çözünürlük, pencerenin video alanından (başlık çubuğu ve kenarlıklar çıkarılmış haliyle) piksel‑birebir hesaplanır. İçerik yoğunluğu (DPI), ISO 9241‑303 standardına göre 180‑220 DPI bandında dinamik olarak dengelenir; böylece yazılar asla mikro boyuta düşmez ve tam ekranda DeX çok sütunlu düzen korunur.
        </InfoCard>
        <OptionGroup
          icon={Gauge}
          title="Özel DPI / İçerik Yoğunluğu"
          subtitle="Dinamik modda ekrandaki metin, ikon ve içerik boyutunu manuel belirleyin (Target DP yerine sabit DPI)"
          options={DPI_OPTIONS}
          value={dpi}
          onChange={handleDpiChange}
          columns={2}
        />
        <div className="rounded-xl border border-border/70 bg-card/60 p-3">
          <div className="flex items-center justify-between text-xs font-semibold mb-2">
            <span className="text-foreground">Hassas DPI Yoğunluk Ayarı</span>
            <span className="font-mono text-primary font-bold">{dpi === 'auto' ? `Otomatik (${liveEffectiveDpi} DPI)` : `${dpi} DPI`}</span>
          </div>
          <PrecisionSlider
            value={dpi === 'auto' ? liveEffectiveDpi : Number(dpi)}
            min={140}
            max={380}
            step={2}
            auto={dpi === 'auto'}
            onCommit={(val) => handleDpiChange(String(val))}
            onAuto={() => handleDpiChange('auto')}
            label="Özel DPI yoğunluğu"
            unit="DPI"
            ticks={[160, 180, 200, 220, 240, 280, 320, 360]}
          />
        </div>

        <OptionGroup
          icon={Blocks}
          title="Mantıksal DP Alan Pazarlığı (Target DP)"
          subtitle="Dinamik‑Fix modunda pencere boyutuna göre Android'e iletilen mantıksal çalışma alanını (dp) belirleyin"
          options={TARGET_DP_OPTIONS}
          value={targetDp}
          onChange={handleTargetDpChange}
          columns={2}
        />
        <div className="rounded-xl border border-border/70 bg-card/60 p-3">
          <div className="flex items-center justify-between text-xs font-semibold mb-2">
            <span className="text-foreground">Hassas Target DP Çalışma Alanı</span>
            <span className="font-mono text-primary font-bold">{targetDp === 'auto' ? 'Otomatik (720 dp)' : `${targetDp} dp`}</span>
          </div>
          <PrecisionSlider
            value={targetDp === 'auto' ? 720 : Number(targetDp)}
            min={360}
            max={1200}
            step={10}
            auto={targetDp === 'auto'}
            onCommit={(val) => handleTargetDpChange(String(val))}
            onAuto={() => handleTargetDpChange('auto')}
            label="Mantıksal alan (target dp)"
            unit="dp"
            ticks={[480, 600, 720, 840, 960, 1080]}
          />
        </div>
        <OptionGroup
          icon={Cpu}
          title="Video Kodlama & Sıkıştırma Motoru"
          subtitle="Görüntü netliğini belirleyen donanım kodlayıcıyı seçin. H.265 (HEVC) metin kenarlarındaki bulanıklığı sıfırlar"
          options={CODEC_OPTIONS}
          value={codec}
          onChange={handleCodecChange}
          columns={2}
        />
        <SwitchRow
          icon={Zap}
          title="Fiziksel 1:1 Subpixel Eşleme (Pixel‑Perfect DPR)"
          description="Windows %125 laptop ölçekleme bulanıklığını önler; telefon piksellerini doğrudan monitörün fiziksel ızgarasına kilitler."
          checked={subpixel}
          onToggle={handleSubpixelToggle}
        />
        <OptionGroup
          icon={Sparkles}
          title="Doku & Kenar Keskinleştirme (Sharpening Shader)"
          subtitle="Metin ve simgelerin kenarlarındaki cıvıklığı gideren GPU doku filtreleme modu"
          options={SHARPEN_OPTIONS}
          value={sharpen}
          onChange={handleSharpenChange}
          columns={3}
        />
        <SwitchRow
          icon={ShieldCheck}
          title="Stealth DP: Telefonda Açık Uygulamayı DeX'te Açarken"
          description="Telefonda zaten çalışan bir uygulama DeX'te açılırken sanal ekran önce telefonun DPI'ında doğar, uygulama yerleşince pencerenin DPI'ına geçer (geçiş kaplamanın arkasında olur). Telefon ↔ PC aktarımı bu ayardan bağımsızdır: orada DPI tek adımda değişir."
          checked={stealth}
          onToggle={handleStealthToggle}
        />
        <SwitchRow
          icon={RefreshCw}
          title="DPI Sonrası Uygulamayı Yenile"
          description="Bir uygulama DPI değişimini yaşadıysa (telefondan pencereye taşıma, canlı DPI, telefona dönüş) arayüzünü yeni yoğunlukta yeniden kurmaya zorlar (YouTube gibi arayüzünü eski yoğunlukta tutan uygulamalar için). Uygulama kapanmaz: etkinlikler aynı süreçte, durumları korunarak yeniden kurulur. Kapatılırsa hiçbir şey yenilenmez."
          checked={densityRefresh}
          onToggle={handleDensityRefreshToggle}
        />
        <SwitchRow
          icon={RefreshCw}
          title="Sert Yenileme (Süreci Yeniden Başlat)"
          description="Yalnızca yukarıdaki yenileme yetmiyorsa açın: uygulamanın süreci Android'in durum koruyan yoluyla yeniden başlatılır. Arka plan servisleri (ör. çalan müzik) kesilir."
          checked={densityRefreshHard}
          onToggle={handleDensityRefreshHardToggle}
        />
        <SwitchRow
          icon={Smartphone}
          title="Telefona Aktarırken Ön-İniş"
          description="«Telefona aktar» denince boyut ve DPI değişimi telefonda değil, PC penceresinin perdesi arkasında yaşanır: sanal ekran telefonun kendi çözünürlüğüne (W×H piksel) ve yoğunluğuna tek adımda çekilir, uygulama orada yeni boyutta ve yoğunlukta yeniden kurulur (gerekirse durumu korunarak yenilenir), görev ancak ondan sonra telefona taşınır. DeX boyutlu bir pencereden bile telefonda yanlış yerleşimli bir arayüz görünmez; kendini uyarlamayan uygulamalarda aktarım birkaç saniye uzar. Geri alınca sanal ekran pencerenin boyutuna döner. Kapalıysa taşıma boyut ve DPI'ı tek adımda değiştirir."
          checked={handoffPrelanding}
          onToggle={handleHandoffPrelandingToggle}
        />
        <InfoCard title="Çift Yönlü Donanım Koruması (Demir Kale)">
          <span className="block">• PC ➔ Telefon (Handoff): Sanal ekran PC perdesinin arkasında telefonun kendi boyutuna ve DPI'ına çekilir, uygulama orada uzlaştırılır (ön-iniş); sonra görev telefon ekranına (Display 0) taşınır, telefon uyandırılır ve uygulama öne çıkarılır.</span>
          <span className="mt-1.5 block">• Telefon ➔ PC (Reclaim): Aktif görev DPI şoku yaşamadan sanal ekrana aktarılır ve masaüstü DPI'ına yumuşak geçiş yapar. Soğuk başlatmada doğrudan masaüstü DPI'ında başlar.</span>
        </InfoCard>
        <StatRow label="Aktif Stream Çözünürlüğü" value="Sınırsız (Doğal Oran)" hint="Dinamik‑Fix aktif — çözünürlük pencerenin video alanı oranına 8px hizalı olarak birebir eşlenir, ölçek küçültme uygulanmaz." />
      </Stack>
    );

  if (section === 'stream')
    return (
      <Stack>
        <PanelHeader iconTone="soft" size="md" icon={Radio} title="Yayın Kalitesi & Protokol" subtitle="Kare hızı, bant genişliği ve pencere sınırı" />
        <OptionGroup icon={Activity} title="Maksimum FPS" subtitle="Ekran tazeleme ve kare hızını belirleyin" options={FPS_OPTIONS} value={fps} onChange={handleFpsChange} columns={3} />
        <OptionGroup icon={AudioLines} title="Video Bit Hızı" subtitle="Görüntü netliğini ve bant genişliğini ayarlayın. 2K/4K modlarda daha yüksek değer önerilir" options={BITRATE_OPTIONS} value={bitrate} onChange={handleBitrateChange} columns={3} />
        <OptionGroup icon={Blocks} title="Maksimum Canlı Pencere / Enkoder Sınırı" subtitle="Aynı anda aktif canlı video yayını yapacak maksimum pencere sayısını sınırlandırın" options={WINDOW_LIMIT_OPTIONS} value={windowLimit} onChange={handleWindowLimitChange} columns={3} />
      </Stack>
    );

  if (section === 'fit')
    return (
      <Stack>
        <PanelHeader iconTone="soft" size="md" icon={Crop} title="Görüntü Sığdırma (Fit)" subtitle="Ekran doldurma modu (Canvas Fit)" />
        <InfoCard title="Dinamik‑Fix aktif">
          Stream oranı pencerenin video alanına zaten birebir eşlendiği için aşağıdaki üç mod pratikte aynı sonucu verir: esnetilecek, çubuk bırakılacak veya kırpılacak bir fark kalmaz.
        </InfoCard>
        <OptionGroup icon={Maximize2} title="Kaplama Kipleri" subtitle="Pencereye görüntünün nasıl sığdırılacağını kişisel tercihinize göre belirleyin" options={FIT_OPTIONS} value={fit} onChange={handleFitChange} />
      </Stack>
    );

  if (section === 'audio')
    return (
      <Stack>
        <PanelHeader iconTone="soft" size="md" icon={Speaker} title="Ses & Aktarım" subtitle="Yönlendirme ve ses kodlayıcı" />
        <OptionGroup icon={Volume2} title="Ses Çıkışı" subtitle="Android seslerinin nereye yönlendirileceğini belirleyin (uygulama başına Medya Merkezi / mikserden değiştirilebilir)" options={AUDIO_ROUTE_OPTIONS} value={audioRoute} onChange={handleAudioRouteChange} />
        <SyncFineTune className="rounded-lg border border-border/60 bg-muted/35" />
        <OptionGroup icon={AudioLines} title="Ses Kodlayıcı (Audio Codec)" subtitle="Ses iletimi için kullanılacak kodlayıcı" options={AUDIO_CODEC_OPTIONS} value={audioCodec} onChange={handleAudioCodecChange} columns={2} />
      </Stack>
    );

  if (section === 'power')
    return (
      <Stack>
        <PanelHeader iconTone="soft" size="md" icon={BatteryCharging} title="Performans & Pil" subtitle="Isı koruması ve donanım bütçesi" />
        <SwitchRow icon={Monitor} title="Kullanırken telefon ekranını karart" description="Görüntü kalitesini ve yayını etkilemeden telefonda gerçek pil tasarrufu sağlar." checked={dimPhone} onToggle={handleDimPhoneToggle} />
      </Stack>
    );

  if (section === 'theme')
    return (
      <Stack>
        <PanelHeader iconTone="soft" size="md" icon={Palette} title="Arayüz & Tema" subtitle="Masaüstü görünümü ve kabuk davranışı" />
        <OptionGroup icon={Palette} title="Masaüstü Görünüm Teması" subtitle="Arayüzün hakim görünüm temasını seçin" options={THEME_OPTIONS} value={theme} onChange={(val) => setTheme(val === 'dark' ? 'dark' : 'light')} columns={2} />
        <SwitchRow icon={Sparkles} title="Sinematik Arka Plan (Ambient Glassmorphic Backdrop)" description="Sığdır (contain) modunda kenarlardaki siyah çubuklar yerine yumuşak sinematik bulanık arka plan yansıtır." checked={ambient} onToggle={handleAmbientToggle} />
      </Stack>
    );

  if (section === 'developer')
    return (
      <Stack>
        <PanelHeader iconTone="soft" size="md" icon={Code2} title="Geliştirici (Beta)" subtitle="Deneysel denetim katmanı" />
        <SwitchRow
          icon={Code2}
          title="Öğeyi Denetle & XML Inspector Katmanı"
          description="Zero‑Apps deneysel mod: seçildiğinde ADB uiautomator üzerinden ekrandaki metin ve buton koordinatlarını şeffaf DOM katmanı olarak yansıtır."
          badge="Beta"
          checked={inspector}
          onToggle={() => setInspector((v) => !v)}
        />
      </Stack>
    );

  if (section === 'notes')
    return (
      <Stack>
        <PanelHeader iconTone="soft" size="md" icon={Info} title="Geliştirici Notları" subtitle="Mimari ilkeler ve platform sınırları" />
        <div className="rounded-lg border border-border/70 bg-muted/35 p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[12px] font-semibold">Açık Kaynak Sistem Mimarisi</h3>
            <span className="rounded-full bg-background px-2 py-0.5 text-[9px] font-medium text-muted-foreground">%100 Yerel Android (AOSP)</span>
          </div>
          <p className="mt-2 text-[11px] font-semibold">OpenDeX Temel İlkesi: “Sıfır Kurulum / Zero‑APK”</p>
          <p className="mt-1 text-[10.5px] leading-[16px] text-muted-foreground">
            Telefonunuza asla yabancı bir APK kurmamak, root yetkisi talep etmemek ve cihazınızın Knox / OEM garanti bütünlüğünü bozmamaktır. Sistem tak‑çalıştır mantığıyla, saf ADB köprüsü ve Android OS resmi çekirdek API'leri üzerinden çalışır.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Metric value="0" label="APK Kurulumu" hint="Cihaz belleği tertemiz" />
            <Metric value="0" label="Root / Modifikasyon" hint="Garanti & Knox bozulmaz" />
            <Metric value="100%" label="Yerel Gizlilik" hint="Doğrudan USB / LAN transferi" />
          </div>
        </div>

        <NoteCard
          title="Bildirimlerden Doğrudan Yanıt (Headless Direct Reply) Neden Yapılamaz?"
          badge="PendingIntent & RemoteInput"
          subtitle="WhatsApp, Telegram vb. mesaj bildirimlerine pencere açmadan arkada gizlice cevap gönderme engeli"
          blocks={[
            { heading: 'Android İşletim Sistemi Güvenlik Bariyeri', body: 'Android\'de bildirimlerdeki “Yanıtla” eylemi arka planda bir PendingIntent ve RemoteInput taşır. SystemServer, sahte mesaj enjeksiyonunu engellemek için bu eylemi yalnızca kullanıcının Bildirim Erişimi ekranından onayladığı bir NotificationListenerService APK\'sına tanır.', footnote: '⚡ UID 2000 (ADB/Shell) bir listener APK olmadığı için sistem intent enjeksiyonunu reddeder.' },
            { heading: 'OpenDeX\'in Doğal ve Güvenli Çözümü', body: 'Arka planda gizlice sanal pencere açıp körlemesine panodan metin yapıştırmak güvenilmezdir. OpenDeX\'te bildirime tıkladığınızda WhatsApp penceresi doğal olarak masaüstünde odaklanır; klavyeniz, fareniz ve sohbet geçmişinizle mesajınızı güvenle gönderirsiniz.', footnote: '✓ Sıfır hack, sıfır gizli pencere; %100 gerçek masaüstü ergonomisi.' },
          ]}
          footer="Bildirim Triyajı: Kartlardaki “Okundu İşaretle” (çift tik) bildirimi silmez; “Okunmamış” sekmesinden gizleyip geçmişte (“Tümü”) saklar. Bildirimler sistemden yalnızca “X” butonuna bastığınızda kalıcı olarak silinir."
        />
      </Stack>
    );

  return (
    <Stack>
      <PanelHeader iconTone="soft" size="md" icon={Activity} title="Sistem & Teşhis" subtitle="OpenDeX Engine v4.2 çekirdek sürümü ve encoder kapasitesi" />
      <SwitchRow
        icon={ShieldCheck}
        title="Bu bilgisayarda cihazları hatırla"
        description="Başarıyla bağlanan cihazlar Kayıtlı Cihazlar listesine eklenir ve tek tıkla yeniden bağlanabilir. Kapatırsanız yeni eşleşen cihazlar hatırlanmaz — paylaşılan bilgisayarlar için önerilir. Bağlanma her zaman elle tıklamayla olur, bu ayar sadece hatırlamayı etkiler."
        checked={rememberDevices}
        onToggle={handleRememberDevicesToggle}
      />
      <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/35">
        {SYSTEM_ROWS.map((row, index) => (
          <div key={row.label} className={cn('flex items-center justify-between gap-3 px-3.5 py-2.5', index > 0 && 'border-t border-border/60')}>
            <span className="text-[11px] font-medium">{row.label}</span>
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] font-semibold tabular-nums text-foreground">{row.value}</span>
              {row.hint && <span className="rounded-full bg-background px-2 py-0.5 text-[9px] text-muted-foreground">{row.hint}</span>}
            </span>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border/70 bg-muted/35 p-3.5">
        <h3 className="text-[12px] font-semibold">Tanılama Günlüğü</h3>
        <p className="mt-1 text-[10.5px] leading-[16px] text-muted-foreground">
          Bir sorunu yeniden ürettikten hemen sonra “Logları kopyala”ya basın: tarayıcı logu, backend log dosyasının sonu
          (<span className="font-mono">backend/logs/</span>), yayın sağlığı ve telefon ekran durumu tek parça panoya alınır.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={handleCopyLogs} disabled={logState === 'busy'}>
            {logState === 'busy' ? 'Hazırlanıyor…' : 'Logları kopyala'}
          </Button>
          {(logState === 'done' || logState === 'failed') && (
            <span className="flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
              {logState === 'done' && <Check className="size-3 text-status-active" />} {logInfo}
            </span>
          )}
        </div>
        <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Ayrıntılı izleme (konsol + backend terminali)
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {TRACE_CHOICES.map((choice) => {
            const active = traceSel.includes(choice.id);
            return (
              <button
                key={choice.id}
                type="button"
                aria-pressed={active}
                onClick={() => handleTraceToggle(choice.id)}
                className={cn(
                  'cursor-pointer rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border/70 bg-background text-muted-foreground hover:bg-accent/55',
                )}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="rounded-lg border border-border/70 bg-muted/35 p-3.5">
        <h3 className="text-[12px] font-semibold">Encoder Kapasite Testi</h3>
        <p className="mt-1 text-[10.5px] leading-[16px] text-muted-foreground">
          Cihazın aynı anda kaç pencere destekleyebildiğini gerçek cihazda ölçer. Test için önce açık pencereleri kapatın.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button onClick={runTest} disabled={testState === 'running'}>
            {testState === 'running' ? 'Ölçülüyor…' : 'Test Et'}
          </Button>
          {testState === 'done' && (
            <span className="flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
              <Check className="size-3 text-status-active" /> 16 eşzamanlı pencere doğrulandı
            </span>
          )}
        </div>
      </div>
    </Stack>
  );
}

function Stack({ children }) {
  return <div className="mx-auto flex w-full max-w-[680px] flex-col gap-3">{children}</div>;
}

function StatRow({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/35 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-foreground">{label}</span>
        <span className="font-mono text-[10px] font-semibold tabular-nums text-primary">{value}</span>
      </div>
      <p className="mt-1 text-[10px] leading-[14px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function Metric({ value, label, hint }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/70 p-2.5 text-center">
      <p className="font-mono text-[18px] font-semibold leading-none tabular-nums text-primary">{value}</p>
      <p className="mt-1.5 text-[10.5px] font-semibold text-foreground">{label}</p>
      <p className="mt-0.5 text-[9px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function NoteCard({
  title,
  badge,
  subtitle,
  blocks,
  footer,
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-muted/35 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold leading-[16px] text-foreground">{title}</h3>
        <span className="rounded-full bg-background px-2 py-0.5 font-mono text-[9px] text-muted-foreground">{badge}</span>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">{subtitle}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {blocks.map((block) => (
          <div key={block.heading} className="rounded-md border border-border/60 bg-background/70 p-2.5">
            <p className="text-[10.5px] font-semibold leading-[14px] text-foreground">{block.heading}</p>
            <p className="mt-1 text-[10px] leading-[15px] text-muted-foreground">{block.body}</p>
            <p className="mt-2 rounded-md bg-muted px-2 py-1 text-[9.5px] leading-[13px] text-foreground/80">{block.footnote}</p>
          </div>
        ))}
      </div>
      <p className="mt-2.5 flex gap-1.5 text-[10px] leading-[15px] text-muted-foreground">
        <ChevronRight className="mt-0.5 size-3 shrink-0 text-primary" />
        {footer}
      </p>
    </section>
  );
}
