// OpenDeX Ayarları penceresi: yüzen, sürüklenip boyutlandırılabilen kabuk + ayarların kendisi.
//
// Yerleşim üç biçimde (pencere genişliğine göre — görünüm penceresine değil, çünkü pencere yüzer):
//   wide    etiketli, gruplu kenar çubuğu + sürekli görünen arama (masaüstü / DeX)
//   rail    yalnız ikonlu ray (orta boy pencere)
//   narrow  telefon: kategori listesi → ayrıntı sayfası, geri düğmesiyle (iOS/Android ayarları gibi)
// Ekran 640 px'in altındaysa pencere tam ekran sayfaya dönüşür (sürükleme/boyutlandırma yok).
//
// Arama (Ctrl/⌘+K): tüm ayarlarda başlık, açıklama, anahtar sözcük ve kartların İÇİNDEKİ seçeneklerde ("16 Mbps", "200 DPI")
// aksan duyarsız arar; sonuca basınca ilgili bölüme gider, satıra (seçenek bulunduysa o karta) kayar ve kısa süre vurgular.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AppWindow,
  BatteryCharging,
  ChevronLeft,
  ChevronRight,
  Info,
  LayoutDashboard,
  Maximize2,
  Minus,
  Monitor,
  Palette,
  Radio,
  Search,
  SearchX,
  Speaker,
  Stethoscope,
  X,
} from 'lucide-react';

import { IconButton } from '../ui/IconButton.jsx';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { cn } from '../lib/utils.js';
import { windowStackZ } from '../ui/zIndex.js';
import { useSystemStore } from '../state/systemStore.js';
import { useWindowStore } from '../window/windowStore.js';
import { TASKBAR_H } from '../window/windowMath.js';
import { Chip, Highlight, SettingsUiProvider } from './controls.jsx';
import { useSettingsController } from './useSettingsController.js';
import { useLiveSettings } from './liveSettings.js';
import {
  DEFAULT_SECTION,
  SECTIONS,
  SECTION_GROUPS,
  isSection,
  layoutForWidth,
  recommendations,
  searchSettings,
  sectionSummary,
} from './settingsModel.js';
import { OverviewSection } from './sections/overview.jsx';
import { DisplaySection } from './sections/display.jsx';
import { AudioSection, StreamSection } from './sections/stream.jsx';
import { AppearanceSection, PowerSection, WindowsSection } from './sections/windows.jsx';
import { AboutSection, AdvancedSection } from './sections/system.jsx';
import { t } from '../i18n/index.js';

export const OPENDEX_SETTINGS_EVENT = 'opendex:open-settings';

/** Opens the settings window; `target` = { section, item? } lands on a section (and flashes one card), e.g. the mixer chip → Sound. */
export function openOpenDexSettings(target = null) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPENDEX_SETTINGS_EVENT, { detail: target }));
}

const SECTION_ICONS = {
  overview: LayoutDashboard,
  display: Monitor,
  stream: Radio,
  audio: Speaker,
  windows: AppWindow,
  appearance: Palette,
  power: BatteryCharging,
  advanced: Stethoscope,
  about: Info,
};

const MIN_W = 460;
const MIN_H = 340;
const SHEET_MAX_VIEWPORT_PX = 640;
const FLASH_MS = 1700;

/** Görev çubuğu görünürken alt şeridi (TASKBAR_H) ayırır; tam ekran bir pencere çubuğu gizleyince ayrılmaz (Taskbar.jsx `hasFullscreenWindow`). */
const taskbarReserve = () => (useWindowStore.getState().windows.some((w) => w.fullscreen && !w.minimized) ? 0 : TASKBAR_H);

/** Ayar penceresinin kullanabileceği alan = ekran − görev çubuğu: "ekranı kapla" çubuğun ALTINA taşmaz. */
const viewport = () => ({
  width: typeof window !== 'undefined' ? window.innerWidth : 1200,
  height: typeof window !== 'undefined' ? Math.max(MIN_H, window.innerHeight - taskbarReserve()) : 800,
});

/** Başlangıç çerçevesi: küçük ekranda tam ekran sayfa (`sheet`), aksi hâlde ortalanmış yüzen pencere. */
function defaultFrame() {
  const { width: sw, height: sh } = viewport();
  if (sw < SHEET_MAX_VIEWPORT_PX) return { x: 0, y: 0, width: sw, height: sh, sheet: true };
  const width = Math.min(1080, Math.max(MIN_W, sw - 48));
  const height = Math.min(720, Math.max(MIN_H, sh - 120));
  return {
    x: Math.max(12, Math.round((sw - width) / 2)),
    y: Math.max(12, Math.round((sh - height) / 2 - 20)),
    width,
    height,
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────── Bölüm gövdesi

// Denetleyici (pencere deposuna abone) yalnız pencere AÇIKKEN bağlanır: kapalı ayarlar penceresi her pencere
// hareketinde yeniden çizilmez.
function ControlledSection({ section, go }) {
  const ctl = useSettingsController();
  return <SectionBody section={section} ctl={ctl} go={go} />;
}

function SectionBody({ section, ctl, go }) {
  switch (section) {
    case 'display': return <DisplaySection ctl={ctl} />;
    case 'stream': return <StreamSection ctl={ctl} />;
    case 'audio': return <AudioSection ctl={ctl} />;
    case 'windows': return <WindowsSection ctl={ctl} />;
    case 'appearance': return <AppearanceSection ctl={ctl} />;
    case 'power': return <PowerSection ctl={ctl} />;
    case 'advanced': return <AdvancedSection ctl={ctl} />;
    case 'about': return <AboutSection />;
    default: return <OverviewSection ctl={ctl} go={go} />;
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────── Arama

function SearchField({ value, onChange, inputRef, onSubmit, compact = false, autoFocus = false }) {
  return (
    <label className={cn('relative flex min-w-0 items-center', compact ? 'w-full' : 'w-full max-w-[400px]')}>
      <span className="sr-only">{t('settings.ayarlarda_ara')}</span>
      <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit?.();
        }}
        placeholder={t('settings.ayarlarda_ara_2')}
        autoComplete="off"
        spellCheck={false}
        className="h-8 w-full rounded-lg border border-border/70 bg-background/80 pl-8 pr-14 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50 focus:bg-background focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label={t('common.aramayi_temizle')}
          onClick={() => onChange('')}
          className="absolute right-1.5 grid size-5 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" />
        </button>
      ) : (
        !compact && <kbd className="pointer-events-none absolute right-2 rounded border border-border/70 bg-muted/60 px-1 font-mono text-[9px] font-semibold text-muted-foreground">{t('settings.ctrl_k')}</kbd>
      )}
    </label>
  );
}

const OPTION_CHIPS_SHOWN = 4;

const SEARCH_SUGGESTIONS =['DPI', 'FPS', t('settings.ses'), t('settings.tema'), t('settings.telefona_aktar'), t('common.pil_2')];

function SearchResults({ query, results, onOpen, onSuggest }) {
  if (!results.length) {
    return (
      <div className="mx-auto flex max-w-[460px] flex-col items-center gap-2 px-4 py-12 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground" aria-hidden="true">
          <SearchX className="size-6" strokeWidth={1.6} />
        </span>
        <p className="text-[14px] font-semibold text-foreground">{t('settings.trim_icin_sonuc_yok', { trim: query.trim() })}</p>
        <p className="text-[12px] leading-[17px] text-muted-foreground">{t('settings.farkli_bir_sozcuk_deneyin_ya_da_bir')}</p>
        <div className="mt-1 flex flex-wrap justify-center gap-1.5">
          {SEARCH_SUGGESTIONS.map((word) => (
            <button
              key={word}
              type="button"
              onClick={() => onSuggest(word)}
              className="cursor-pointer rounded-full border border-border/70 bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {word}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <section aria-label={t('settings.arama_sonuclari')} className="mx-auto w-full max-w-[720px] space-y-2">
      <p className="px-1 text-[11px] text-muted-foreground" role="status">
        {t('settings.count_sonuc', { count: results.length })}
      </p>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-muted/30">
        {results.map((result) => {
          const Icon = SECTION_ICONS[result.section];
          return (
            <li key={result.id}>
              <button
                type="button"
                onClick={() => onOpen(result)}
                className="flex w-full cursor-pointer items-start gap-3 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-background/80 text-muted-foreground" aria-hidden="true">
                  <Icon className="size-3.5" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-semibold leading-[17px] text-foreground">
                    <Highlight text={result.title} query={query} />
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-[16px] text-muted-foreground">
                    <Highlight text={result.description} query={query} />
                  </span>
                  {result.options?.length > 0 && (
                    <span className="mt-1.5 flex flex-wrap items-center gap-1" aria-label={t('settings.eslesen_secenekler')}>
                      {result.options.slice(0, OPTION_CHIPS_SHOWN).map((option) => (
                        <span
                          key={String(option.value)}
                          className="inline-flex items-center rounded-md border border-primary/25 bg-primary/[0.07] px-1.5 py-px text-[10.5px] font-medium leading-[15px] text-foreground"
                        >
                          <Highlight text={option.label} query={query} />
                        </span>
                      ))}
                      {result.options.length > OPTION_CHIPS_SHOWN && (
                        <span className="text-[10.5px] text-muted-foreground">+{result.options.length - OPTION_CHIPS_SHOWN}</span>
                      )}
                    </span>
                  )}
                </span>
                <Chip className="mt-0.5">{SECTIONS[result.section].label}</Chip>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────────────────── Gezinti

function NavButton({ id, active, layout, badge, onSelect }) {
  const Icon = SECTION_ICONS[id];
  const label = SECTIONS[id].label;
  const rail = layout === 'rail';
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect(id)}
      className={cn(
        'relative flex shrink-0 cursor-pointer items-center rounded-lg text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        rail ? 'size-9 justify-center' : 'h-9 w-full gap-2.5 px-2.5',
        active ? 'bg-primary/10 font-semibold text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" aria-hidden="true" />}
      <Icon className={cn('size-4 shrink-0', active && 'text-primary')} strokeWidth={active ? 2 : 1.8} aria-hidden="true" />
      {!rail && <span className="min-w-0 flex-1 truncate text-[12px] leading-[16px]">{label}</span>}
      {badge > 0 && (
        <span
          className={cn(
            'grid min-w-4 place-items-center rounded-full bg-warning/20 px-1 text-[9px] font-bold leading-4 text-warning',
            rail && 'absolute -right-0.5 -top-0.5',
          )}
          aria-label={t('settings.badge_oneri', { badge })}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

function SideNav({ layout, section, tipCount, onSelect }) {
  const onKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...event.currentTarget.querySelectorAll('button[aria-label]')];
    const at = items.indexOf(document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return (
    <nav
      aria-label={t('settings.ayar_bolumleri')}
      onKeyDown={onKeyDown}
      className={cn(
        'flex shrink-0 flex-col overflow-y-auto border-r border-border/60 bg-muted/20 select-none',
        layout === 'rail' ? 'w-[52px] items-center gap-1 p-1.5' : 'w-[232px] gap-3 p-2.5',
      )}
    >
      {SECTION_GROUPS.map((group) => (
        <div key={group.id} className={cn('flex flex-col', layout === 'rail' ? 'items-center gap-1' : 'gap-0.5')}>
          {group.label && layout !== 'rail' && (
            <p className="px-2.5 pb-1 pt-1 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">{group.label}</p>
          )}
          {group.label && layout === 'rail' && <span className="my-0.5 h-px w-5 bg-border/70" aria-hidden="true" />}
          {group.sections.map((id) => (
            <NavButton key={id} id={id} layout={layout} active={section === id} badge={id === 'overview' ? tipCount : 0} onSelect={onSelect} />
          ))}
        </div>
      ))}
      {layout === 'wide' && (
        <p className="mt-auto px-2.5 pt-2 text-[10px] leading-[14px] text-muted-foreground/80">{t('settings.opendex_engine_v4_2_scrcpy_v4_1')}</p>
      )}
    </nav>
  );
}

/** Telefon: kategori listesi. Her satır bölümün canlı özetini taşır; dokununca ayrıntı sayfası açılır. */
function MobileList({ live, tipCount, onSelect }) {
  return (
    <div className="space-y-4">
      {SECTION_GROUPS.map((group) => (
        <section key={group.id} aria-label={group.label || t('settings.ayarlar')} className="space-y-1.5">
          {group.label && <h3 className="px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{group.label}</h3>}
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-muted/30">
            {group.sections.map((id) => {
              const Icon = SECTION_ICONS[id];
              const summary = id === 'overview' ? (tipCount ? t('settings.tipcount_oneri', { tipCount }) : SECTIONS[id].subtitle) : sectionSummary(id, live) || SECTIONS[id].subtitle;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => onSelect(id)}
                    className="flex min-h-[52px] w-full cursor-pointer items-center gap-3 px-3.5 py-2 text-left outline-none transition-colors active:bg-accent/60 hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background/80 text-muted-foreground" aria-hidden="true">
                      <Icon className="size-4" strokeWidth={1.8} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold leading-[18px] text-foreground">{SECTIONS[id].label}</span>
                      <span className="block truncate text-[11px] leading-[15px] text-muted-foreground">{summary}</span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────────────── Pencere

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
    blurSettings,
    closeSettings,
  } = useSystemStore();
  const connectionState = useSystemStore((s) => s.connectionState);
  const taskbarHidden = useWindowStore((s) => s.windows.some((w) => w.fullscreen && !w.minimized));

  const live = useLiveSettings() || {};
  const tips = useMemo(() => recommendations(live), [live]);

  const [section, setSection] = useState(DEFAULT_SECTION);
  const [mobileScreen, setMobileScreen] = useState('list'); // narrow: 'list' | 'detail'
  const [query, setQuery] = useState('');
  const [flashId, setFlashId] = useState(null);
  const [flashOptions, setFlashOptions] = useState(null); // arama bir seçeneği bulduysa: o kartların değerleri
  const [frame, setFrame] = useState(null);
  const windowRef = useRef(null);
  const contentRef = useRef(null);
  const stageRef = useRef(null);
  const restoreRef = useRef(null);
  const searchRef = useRef(null);
  const queryRef = useRef('');
  queryRef.current = query;

  const stageSize = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    const vp = viewport();
    return { width: rect?.width || vp.width, height: rect?.height || vp.height };
  };

  const openWindow = useCallback(() => {
    openSettings();
    restoreSettings();
    focusSettings();
    setSection(DEFAULT_SECTION);
    setMobileScreen('list');
    setQuery('');
    setFrame((current) => current || defaultFrame());
  }, [openSettings, restoreSettings, focusSettings]);

  useEffect(() => {
    if (settingsOpen && !frame) setFrame(defaultFrame());
  }, [settingsOpen, frame]);

  // Ekran dönünce / yeniden boyutlanınca: tam ekran sayfa ekrana uyar; ekran büyüyünce yüzen pencereye döner.
  useEffect(() => {
    const onResize = () => {
      setFrame((current) => {
        if (!current) return current;
        const vp = viewport();
        if (vp.width < SHEET_MAX_VIEWPORT_PX) return { x: 0, y: 0, width: vp.width, height: vp.height, sheet: true };
        if (current.sheet) return defaultFrame();
        return current;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Büyütülmüş pencere sahneyi tam doldurur: ekran yeniden boyutlanınca ya da görev çubuğu belirip kaybolunca (tam ekran uygulama)
  // sahne değişir; çerçeve eski ölçüde kalmasın.
  useEffect(() => {
    if (!settingsMaximized) return undefined;
    const fit = () => {
      const stage = stageSize();
      setFrame((current) => (current && !current.sheet ? { x: 0, y: 0, width: stage.width, height: stage.height } : current));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsMaximized, taskbarHidden]);

  // Esc yalnız en üstteki katmanı kapatır (lib/escapeStack): önce arama temizlenir, sonra pencere kapanır.
  useEffect(() => {
    if (!settingsOpen || settingsMinimized) return undefined;
    return pushEscapeHandler(() => {
      if (queryRef.current) setQuery('');
      else closeSettings();
    });
  }, [settingsOpen, settingsMinimized, closeSettings]);

  // Ctrl/⌘+K: aramaya odaklan (pencere odaktayken; App.jsx o an başlatıcıyı açmaz). Başlatıcı açıksa kısayol onu kapatır.
  useEffect(() => {
    if (!settingsOpen || settingsMinimized) return undefined;
    const onKey = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      const sys = useSystemStore.getState();
      if (!sys.settingsFocused || sys.launchpadOpen) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen, settingsMinimized]);

  // Odak bir uygulama penceresine geçince (tıklama, Alt+Tab, yeni pencere: hepsi z sırasını artırır) ya da pencerenin dışına
  // (masaüstü) tıklanınca ayarlar odağı bırakır; Ctrl+K o andan sonra başlatıcıyı açar. Görev çubuğu tıklamaları odağı
  // değiştirmez: oradaki ayarlar düğmesi "odaktaysa küçült" kararını kendisi verir.
  useEffect(() => {
    if (!settingsOpen || settingsMinimized) return undefined;
    const blur = () => {
      if (useSystemStore.getState().settingsFocused) blurSettings();
    };
    const onPointerDown = (event) => {
      const target = event.target;
      if (!(target instanceof Element) || windowRef.current?.contains(target)) return;
      if (target.closest('[data-taskbar-root], [data-taskbar-portal]')) return;
      blur();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    const unsubscribe = useWindowStore.subscribe((state, prev) => {
      if (state.nextZ !== prev.nextZ && !claimingZ.current) blur();
    });
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      unsubscribe();
    };
  }, [settingsOpen, settingsMinimized, blurSettings]);

  // Pencere odağı alınca z sırasının en önüne geçer (pencerelerle AYNI sayaç): eskiden sabit z-[70] idi ve ilk birkaç
  // pencere odaklamasından sonra videoların arkasında kalıyordu. Odaktayken sabitlenmiş (pinli) pencerenin de önündedir
  // (windowStackZ); odak başka pencereye geçince normal sıraya, pinli pencerenin arkasına döner.
  const claimingZ = useRef(false);
  const [stackZ, setStackZ] = useState(1);
  useEffect(() => {
    if (!settingsOpen || settingsMinimized || !settingsFocused) return;
    claimingZ.current = true; // kendi sayaç artışımız odağı bırakma sayılmaz
    try {
      setStackZ(useWindowStore.getState().claimZ());
    } finally {
      claimingZ.current = false;
    }
  }, [settingsOpen, settingsMinimized, settingsFocused]);

  const layout = layoutForWidth(frame?.width ?? 1200);
  const sheet = Boolean(frame?.sheet);
  const searching = query.trim().length > 0;
  const results = useMemo(() => searchSettings(query), [query]);

  // Bölüm GERÇEKTEN değişince sayfa başa kaydırılır; arama sonucuna gidişte satıra kaydırma bunu ezer. Vurgunun sönmesi
  // (flashId → null) bir bölüm değişimi değildir: eskiden bu effect o anda da çalışıp sayfayı başa geri çekiyordu
  // ("özel dpi" → satıra iner, vurgulanır, 1,7 sn sonra yukarı kaçar).
  const pageKey = `${section}|${mobileScreen}`;
  const pageKeyRef = useRef(pageKey);
  useEffect(() => {
    if (pageKeyRef.current === pageKey) return;
    pageKeyRef.current = pageKey;
    if (flashId) return;
    contentRef.current?.scrollTo?.({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [pageKey, reduceMotion, flashId]);

  // Arama sonucundan gelinen ayar: satıra (bulunan seçenek varsa o karta) kaydır, kısa süre vurgula.
  useEffect(() => {
    if (!flashId) return undefined;
    const raf = requestAnimationFrame(() => {
      const row = contentRef.current?.querySelector(`[data-setting-id="${flashId}"]`);
      const option = flashOptions?.length ? row?.querySelector(`[data-option-value="${String(flashOptions[0])}"]`) : null;
      (option || row)?.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    });
    const timer = setTimeout(() => {
      setFlashId(null);
      setFlashOptions(null);
    }, FLASH_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [flashId, flashOptions, section, reduceMotion]);

  const go = useCallback((id, itemId = null, optionValues = null) => {
    if (!isSection(id)) return;
    setQuery('');
    setSection(id);
    setMobileScreen('detail');
    setFlashId(itemId);
    setFlashOptions(itemId && optionValues?.length ? optionValues : null);
  }, []);

  const openResult = useCallback(
    (result) => go(result.section, result.id, result.options?.map((option) => option.value)),
    [go],
  );

  // openOpenDexSettings(): the window opens on the overview, or — with a target — lands on that section and flashes one card.
  useEffect(() => {
    const onOpen = (event) => {
      openWindow();
      const target = event?.detail;
      if (target && target.section) go(target.section, target.item || null);
    };
    window.addEventListener(OPENDEX_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPENDEX_SETTINGS_EVENT, onOpen);
  }, [openWindow, go]);

  const startMove = (event) => {
    if (settingsMaximized || sheet || !frame) return;
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
    if (settingsMaximized || sheet || !frame) return;
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
    } else if (restoreRef.current) {
      setFrame(restoreRef.current);
    }
  };

  const narrow = layout === 'narrow';
  const showList = narrow && mobileScreen === 'list' && !searching;
  const connected = connectionState === 'connected';

  return (
    <div
      ref={stageRef}
      data-testid="settings-stage"
      className="pointer-events-none fixed inset-x-0 top-0 overflow-hidden"
      style={{
        bottom: taskbarHidden ? 0 : TASKBAR_H,
        zIndex: windowStackZ({ z: stackZ, focused: settingsFocused, raisedWhenFocused: true }),
      }}
    >
      <AnimatePresence>
        {settingsOpen && !settingsMinimized && frame && (
          <motion.section
            key="opendex-settings-window"
            ref={windowRef}
            role="dialog"
            aria-label={t('settings.tum_opendex_ayarlari')}
            onPointerDown={focusSettings}
            className={cn(
              'pointer-events-auto absolute flex flex-col overflow-hidden border border-border/80 bg-popover/95 backdrop-blur-2xl transition-shadow duration-200 select-none shadow-none',
              sheet ? 'rounded-none' : 'rounded-xl',
              settingsFocused ? 'ring-1 ring-primary/20' : 'opacity-95',
            )}
            style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.985 }}
            transition={{ type: 'spring', stiffness: 420, damping: 40, mass: 0.8 }}
          >
            {/* Üst çubuk: marka · (geniş/orta) arama · pencere denetimleri */}
            <header
              onPointerDown={startMove}
              className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-muted/40 px-3 select-none cursor-default"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-[11px] font-bold text-primary-foreground" aria-hidden="true">
                {t('common.d')}
              </span>
              <div className={cn('min-w-0 select-none', narrow ? 'flex-1' : layout === 'rail' ? 'w-[110px] shrink-0' : 'w-[170px] shrink-0')}>
                <p className="truncate text-[12.5px] font-semibold leading-none text-foreground">{narrow ? t('common.ayarlar') : t('common.opendex_ayarlari')}</p>
                {!narrow && <p className="mt-1 truncate text-[9.5px] leading-none text-muted-foreground">{t('settings.zero_apk_saf_adb_koprusu')}</p>}
              </div>
              {!narrow && (
                <div className="flex min-w-0 flex-1 justify-center">
                  <SearchField value={query} onChange={setQuery} inputRef={searchRef} onSubmit={() => results[0] && openResult(results[0])} />
                </div>
              )}
              {layout === 'wide' && (
                <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-[10px] font-medium text-muted-foreground lg:inline-flex">
                  <span className={cn('size-1.5 rounded-full', connected ? 'bg-status-active' : 'bg-muted-foreground')} />
                  {connected ? t('common.bagli') : t('settings.bagli_degil')}
                </span>
              )}
              <div className="flex shrink-0 items-center">
                <IconButton label={t('common.simge_durumuna_kucult')} size="sm" tooltipPosition="bottom" onClick={minimizeSettings}>
                  <Minus />
                </IconButton>
                {!sheet && (
                  <IconButton
                    label={settingsMaximized ? t('common.kucult') : t('common.tam_ekran')}
                    aria-pressed={settingsMaximized}
                    size="sm"
                    tooltipPosition="bottom"
                    onClick={toggleMaximize}
                  >
                    <Maximize2 />
                  </IconButton>
                )}
                <IconButton label={t('common.kapat')} size="sm" danger="close" tooltipPosition="bottom" tooltipAlign="end" onClick={closeSettings}>
                  <X />
                </IconButton>
              </div>
            </header>

            <div className="flex min-h-0 flex-1 flex-row">
              {!narrow && <SideNav layout={layout} section={section} tipCount={tips.length} onSelect={go} />}

              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {narrow && (
                  <div className="shrink-0 space-y-2 border-b border-border/60 bg-muted/20 px-3 py-2">
                    {!showList && !searching && (
                      <button
                        type="button"
                        onClick={() => setMobileScreen('list')}
                        className="-ml-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[12px] font-semibold text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ChevronLeft className="size-4" aria-hidden="true" />
                        {t('settings.ayarlar')}
                        <span className="ml-1 font-normal text-muted-foreground">/ {SECTIONS[section].label}</span>
                      </button>
                    )}
                    <SearchField value={query} onChange={setQuery} inputRef={searchRef} compact onSubmit={() => results[0] && openResult(results[0])} />
                  </div>
                )}

                <div
                  ref={contentRef}
                  className={cn('dex-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]', narrow ? 'p-3' : 'p-4 sm:p-6')}
                >
                  <SettingsUiProvider value={{ layout, flashId, flashOptions }}>
                    {/* Yalnız giriş animasyonu (opaklık + 6 px): çıkış beklenmez, geçiş anında yanıt verir. */}
                    <motion.div
                      key={searching ? 'search' : showList ? 'list' : section}
                      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                    >
                      {searching ? (
                        <SearchResults query={query} results={results} onOpen={openResult} onSuggest={setQuery} />
                      ) : showList ? (
                        <MobileList live={live} tipCount={tips.length} onSelect={go} />
                      ) : (
                        <ControlledSection section={section} go={go} />
                      )}
                    </motion.div>
                  </SettingsUiProvider>
                </div>
              </div>
            </div>

            {/* 8 yönlü boyutlandırma tutamaçları */}
            {!settingsMaximized && !sheet && (
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
