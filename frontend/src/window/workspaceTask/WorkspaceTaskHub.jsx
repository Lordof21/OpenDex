// Workspace görev hub'ı — başlık çubuğundaki ⚙ düğmesinin ya da başlığa SAĞ TIK'ın açtığı tek panel.
// Başlıkta yalnızca sık kullanılan birkaç kontrol durur; geri kalan her şey burada, üç bölümde ve aynı sırayla:
//
//   Aktar       Telefona aktar → Tam ekran | Serbest pencere (Ayarlar'daki varsayılan işaretli; seçim yalnız bu aktarım için)
//               · telefondaysa: Çalışma alanına geri al
//   Pencere     Kapla / Geri yükle · Ayrı PiP · DeX'te pencere · Masaüstüne çıkar   (2×2 döşeme)
//   Yoğunluk    Oto + hazır DPI değerleri + ince ayar kaydırıcısı (yalnız canlı görevde)
//
// Panel kabuğu ui/FloatingPanel (konum, Esc, dışarı basış). Bu bileşen yalnız içeriktir: görevi bilmez, `actions` çağırır.

import React, { useState } from 'react';
import {
  AppWindow,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  ChevronLeft,
  Copy,
  Maximize2,
  PictureInPicture2,
  Smartphone,
  Square,
  X,
} from 'lucide-react';
import AppIcon from '../../ui/AppIcon.jsx';
import FloatingPanel from '../../ui/FloatingPanel.jsx';
import { PrecisionSlider } from '../../ui/PrecisionSlider.jsx';
import { cn } from '../../lib/utils.js';
import { DPI_PRESETS, describeTask, taskMetrics } from './taskMetrics.js';
import { t } from '../../i18n/index.js';

export const HUB_WIDTH_PX = 296;

const HANDOFF_ROWS = [
  { value: 'fullscreen', label: t('common.tam_ekran'), icon: Maximize2, detail: t('window.telefonun_ekranini_doldurur') },
  { value: 'freeform', label: t('common.serbest_pencere'), icon: AppWindow, detail: t('window.kucuk_tasinabilir_pencere') },
];

function SectionTitle({ children }) {
  return (
    <p className="px-2 pb-1 pt-2 text-[9.5px] font-semibold uppercase leading-none tracking-[0.14em] text-foreground/60">
      {children}
    </p>
  );
}

function IconChip({ icon: Icon, active = false, destructive = false }) {
  return (
    <span
      className={cn(
        'grid size-[26px] shrink-0 place-items-center rounded-lg transition-colors duration-150',
        active ? 'bg-[var(--media-ink)] text-[var(--media-on-ink)]' : 'bg-foreground/[0.06] text-foreground/70',
        destructive && 'bg-destructive/10 text-destructive',
      )}
      aria-hidden="true"
    >
      <Icon className="size-3.5" strokeWidth={1.9} />
    </span>
  );
}

function Row({ icon, label, detail, checked = false, choice = false, destructive = false, compact = false, onClick, testId }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={choice ? checked : undefined}
      title={compact ? detail : undefined}
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-1.5 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'h-8' : 'h-[42px]',
        checked ? 'bg-[var(--media-ink-faint)]' : 'hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05]',
        destructive && 'hover:bg-destructive/10',
      )}
    >
      <IconChip icon={icon} active={checked} destructive={destructive} />
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[12px] font-semibold leading-[15px]', destructive ? 'text-destructive' : 'text-foreground')}>{label}</span>
        {detail && !compact && <span className="block truncate text-[10.5px] leading-[13px] text-muted-foreground">{detail}</span>}
      </span>
      {checked && (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-[var(--media-ink)] text-[var(--media-on-ink)]" aria-hidden="true">
          <Check className="size-2.5" strokeWidth={3.5} />
        </span>
      )}
    </button>
  );
}

function Tile({ icon: Icon, label, active = false, compact = false, onClick, testId }) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex min-w-0 cursor-pointer items-center justify-center rounded-[10px] px-1 text-center outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'h-8 flex-row gap-1.5' : 'h-[58px] flex-col gap-1',
        active ? 'bg-[var(--media-ink-faint)] text-foreground' : 'bg-foreground/[0.05] text-foreground/80 hover:bg-foreground/[0.09]',
      )}
    >
      <Icon className={cn('size-4', active && 'text-[var(--media-ink)]')} strokeWidth={1.9} aria-hidden="true" />
      <span className="w-full truncate text-[10.5px] font-semibold leading-[13px]">{label}</span>
    </button>
  );
}

/**
 * `boundary`: () => dikdörtgen — hub'ın kalacağı kutu (Workspace tuvali); panel onun içinde konumlanır ve daralır.
 * `compact`: küçük Workspace penceresi — açıklamasız satırlar, tek satırlık döşemeler (içerik yine de kaydırılabilir).
 */
export function WorkspaceTaskHub({ anchor, boundary, compact = false, task, parked = false, pipOpen = false, maximized = false, defaultWindowing = 'fullscreen', onClose, actions }) {
  const metrics = taskMetrics(task);
  const [sliderDpi, setSliderDpi] = useState(typeof task.density === 'number' ? task.density : metrics.dpi);
  const auto = task.densityMode !== 'manual';
  const run = (fn) => (event) => {
    event?.stopPropagation?.();
    onClose();
    fn();
  };

  return (
    <FloatingPanel anchor={anchor} width={HUB_WIDTH_PX} boundary={boundary} label={t('window.gorev_hub_i')} onClose={onClose} data-testid="workspace-task-hub">
      <div className="flex items-center gap-2.5 px-2 pb-1.5 pt-1.5">
        <AppIcon pkg={task.package} displayName={task.title} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold leading-[16px] text-foreground">{task.title || task.package}</span>
          <span className="block truncate font-mono text-[10px] leading-[13px] text-muted-foreground" data-testid="workspace-task-hub-metrics">
            {parked ? t('window.telefonun_ekraninda_calisiyor') : describeTask(task)}
          </span>
        </span>
        {!parked && (
          <span className="shrink-0 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[9.5px] font-semibold text-foreground/70" title={t('window.gorevin_dp_cinsinden_en_kucuk_kenari')}>
            {t('window.layout_swdpdp', { layout: metrics.layout, swDp: metrics.swDp })}
          </span>
        )}
      </div>

      <SectionTitle>{t('window.aktar')}</SectionTitle>
      {parked ? (
        <Row
          icon={ArrowDownToLine}
          label={t('window.calisma_alanina_geri_al')}
          detail={t('window.kaldigi_yerden_eski_yerinde_devam_eder')}
          compact={compact}
          onClick={run(actions.reclaim)}
          testId="hub-reclaim"
        />
      ) : (
        <div className="flex flex-col gap-px" role="group" aria-label={t('common.telefona_aktar')}>
          {HANDOFF_ROWS.map((row) => (
            <Row
              key={row.value}
              icon={row.icon}
              label={t('window.telefona_aktar_label', { label: row.label })}
              detail={row.value === defaultWindowing ? t('window.detail_varsayilan', { detail: row.detail }) : row.detail}
              checked={row.value === defaultWindowing}
              choice
              compact={compact}
              onClick={run(() => actions.handoff(row.value))}
              testId={`hub-handoff-${row.value}`}
            />
          ))}
        </div>
      )}

      <SectionTitle>{t('common.pencere')}</SectionTitle>
      <div className="grid grid-cols-2 gap-1 px-0.5">
        <Tile
          icon={maximized ? Copy : Square}
          label={maximized ? t('common.geri_yukle') : t('window.alani_kapla')}
          active={maximized}
          compact={compact}
          onClick={run(actions.toggleMaximize)}
          testId="hub-maximize"
        />
        {!parked && (
          <Tile
            icon={PictureInPicture2}
            label={pipOpen ? t('window.pip_i_kapat') : t('window.ayri_pip')}
            active={pipOpen}
            compact={compact}
            onClick={run(actions.togglePip)}
            testId="hub-pip"
          />
        )}
        {!parked && <Tile icon={AppWindow} label={t('window.dex_te_pencere')} compact={compact} onClick={run(actions.openCrop)} testId="hub-crop" />}
        {!parked && <Tile icon={ArrowUpRight} label={t('window.masaustune_cikar')} compact={compact} onClick={run(actions.popOut)} testId="hub-popout" />}
      </div>

      {!parked && (
        <>
          <SectionTitle>{t('window.yogunluk_dpi')}</SectionTitle>
          <div className="flex flex-wrap gap-1 px-1.5" role="group" aria-label={t('window.hazir_yogunluk_degerleri')}>
            {DPI_PRESETS.map((preset) => {
              const active = preset.value === 'auto' ? auto : !auto && task.density === preset.value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  title={preset.detail}
                  aria-pressed={active}
                  data-testid={`hub-dpi-${preset.value}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (preset.value === 'auto') actions.setDensityAuto();
                    else {
                      setSliderDpi(preset.value);
                      actions.setDensity(preset.value);
                    }
                  }}
                  className={cn(
                    'h-7 min-w-[38px] cursor-pointer rounded-lg px-2 text-[11px] font-semibold outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-[var(--media-ink)] text-[var(--media-on-ink)]'
                      : 'bg-foreground/[0.06] text-foreground/75 hover:bg-foreground/[0.1]',
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <div className="px-2 pb-1 pt-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10.5px] font-semibold text-muted-foreground">{t('window.ince_ayar')}</span>
              <span className="font-mono text-[11px] text-foreground">{t('window.sliderdpi_dpi', { sliderDpi })}</span>
            </div>
            <PrecisionSlider
              value={sliderDpi}
              min={120}
              max={480}
              step={4}
              showButtons={false}
              onChange={setSliderDpi}
              onCommit={actions.setDensity}
              label={t('window.dpi_ince_ayar_kaydiricisi')}
              unit="DPI"
            />
          </div>
        </>
      )}

      <div className="mt-1 border-t border-foreground/10 pt-1">
        {!parked && <Row icon={ChevronLeft} label={t('window.android_geri')} detail={t('window.uygulamada_bir_adim_geri')} compact={compact} onClick={run(actions.back)} testId="hub-back" />}
        <Row icon={X} label={t('window.gorevi_kapat')} detail={t('window.uygulama_kapatilir')} destructive compact={compact} onClick={run(actions.closeTask)} testId="hub-close" />
      </div>
    </FloatingPanel>
  );
}

export default WorkspaceTaskHub;
