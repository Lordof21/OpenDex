// Workspace görev hub'ı — başlık çubuğundaki ⚙ düğmesinin ya da başlığa SAĞ TIK'ın açtığı tek panel.
// Başlıkta yalnızca sık kullanılan birkaç kontrol durur; geri kalan her şey burada, üç bölümde ve aynı sırayla:
//
//   Aktar       Telefona aktar → Tam ekran | Serbest pencere (Ayarlar'daki varsayılan işaretli; seçim yalnız bu aktarım için)
//               · telefondaysa: Çalışma alanına geri al
//   Pencere     Kapla / Geri yükle · Ayrı PiP · DeX'te pencere · Masaüstüne çıkar   (2×2 döşeme)
//   Yoğunluk    Oto + hazır DPI değerleri + ince ayar kaydırıcısı (yalnız canlı görevde)
//
// Görsel dil: pencere hub'ı (window/titlebar/HubPanel) ile AYNI — başlık bandı, büyük harf bölüm etiketi, aynı satır (HubAction) ve
// döşeme (HubTile) bileşenleri, seçili = birincil renk. Panel kabuğu ui/FloatingPanel (konum, Esc, dışarı basış); yüzeyi burada
// pencere hub'ınınkine çevrilir. Bu bileşen yalnız içeriktir: görevi bilmez, `actions` çağırır.

import React, { useState } from 'react';
import { Switch } from '../../ui/Switch.jsx';
import {
  AppWindow,
  ArrowDownToLine,
  ArrowUpRight,
  ChevronLeft,
  Copy,
  Keyboard,
  Maximize2,
  PictureInPicture2,
  Square,
  X,
} from 'lucide-react';
import AppIcon from '../../ui/AppIcon.jsx';
import FloatingPanel from '../../ui/FloatingPanel.jsx';
import { PrecisionSlider } from '../../ui/PrecisionSlider.jsx';
import { cn } from '../../lib/utils.js';
import { HubAction, HubTile } from '../titlebar/HubPanel.jsx';
import { DPI_PRESETS, describeTask, taskMetrics } from './taskMetrics.js';
import { t } from '../../i18n/index.js';

export const HUB_WIDTH_PX = 320;

const HANDOFF_ROWS = [
  { value: 'fullscreen', label: t('common.tam_ekran'), icon: Maximize2, detail: t('window.telefonun_ekranini_doldurur') },
  { value: 'freeform', label: t('common.serbest_pencere'), icon: AppWindow, detail: t('window.kucuk_tasinabilir_pencere') },
];

// Pencere hub'ının yüzeyi (HubPanel): popover/95 + bulanık arka plan, köşe 6, iç boşluk yok (başlık bandı kenara kadar uzanır).
const PANEL_SURFACE = 'rounded-md border-border bg-popover/95 p-0 backdrop-blur-2xl';

function SectionTitle({ children }) {
  return <p className="px-2 pb-1 pt-1 text-[9px] font-semibold uppercase text-muted-foreground">{children}</p>;
}

/**
 * `boundary`: () => dikdörtgen — hub'ın kalacağı kutu (Workspace tuvali); panel onun içinde konumlanır ve daralır.
 * `compact`: küçük Workspace penceresi — açıklamasız satırlar, tek satırlık döşemeler (içerik yine de kaydırılabilir).
 */
export function WorkspaceTaskHub({ anchor, boundary, compact = false, task, parked = false, keymapCount = 0, keymapEnabled = true, pipOpen = false, maximized = false, defaultWindowing = 'fullscreen', onClose, actions }) {
  const metrics = taskMetrics(task);
  const [sliderDpi, setSliderDpi] = useState(typeof task.density === 'number' ? task.density : metrics.dpi);
  const auto = task.densityMode !== 'manual';
  const run = (fn) => (event) => {
    event?.stopPropagation?.();
    onClose();
    fn();
  };

  return (
    <FloatingPanel
      anchor={anchor}
      width={HUB_WIDTH_PX}
      boundary={boundary}
      label={t('window.gorev_hub_i')}
      onClose={onClose}
      className={PANEL_SURFACE}
      data-testid="workspace-task-hub"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <AppIcon pkg={task.package} displayName={task.title} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold">{task.title || task.package}</span>
            <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground" data-testid="workspace-task-hub-metrics">
              {parked ? t('window.telefonun_ekraninda_calisiyor') : describeTask(task)}
            </span>
          </span>
        </div>
        {!parked && (
          <span className="shrink-0 rounded-sm bg-muted px-2 py-1 font-mono text-[9px] font-semibold text-muted-foreground" title={t('window.gorevin_dp_cinsinden_en_kucuk_kenari')}>
            {t('window.layout_swdpdp', { layout: metrics.layout, swDp: metrics.swDp })}
          </span>
        )}
      </div>

      <div className="bg-background/50 p-2">
        <SectionTitle>{t('window.aktar')}</SectionTitle>
        {parked ? (
          <HubAction
            icon={<ArrowDownToLine className="size-4" />}
            label={t('window.calisma_alanina_geri_al')}
            detail={t('window.kaldigi_yerden_eski_yerinde_devam_eder')}
            compact={compact}
            onClick={run(actions.reclaim)}
            testId="hub-reclaim"
          />
        ) : (
          <div role="group" aria-label={t('common.telefona_aktar')}>
            {HANDOFF_ROWS.map((row) => {
              const Icon = row.icon;
              return (
                <HubAction
                  key={row.value}
                  icon={<Icon className="size-4" />}
                  label={t('window.telefona_aktar_label', { label: row.label })}
                  detail={row.value === defaultWindowing ? t('window.detail_varsayilan', { detail: row.detail }) : row.detail}
                  choice
                  checked={row.value === defaultWindowing}
                  compact={compact}
                  onClick={run(() => actions.handoff(row.value))}
                  testId={`hub-handoff-${row.value}`}
                />
              );
            })}
          </div>
        )}

        <div className="my-2 h-px bg-border" />

        <SectionTitle>{t('common.pencere')}</SectionTitle>
        <div className="grid grid-cols-2 gap-1.5 px-1">
          <HubTile
            icon={maximized ? <Copy className="size-4" /> : <Square className="size-4" />}
            label={maximized ? t('common.geri_yukle') : t('window.alani_kapla')}
            active={maximized}
            compact={compact}
            onClick={run(actions.toggleMaximize)}
            testId="hub-maximize"
          />
          {!parked && (
            <HubTile
              icon={<PictureInPicture2 className="size-4" />}
              label={pipOpen ? t('window.pip_i_kapat') : t('window.ayri_pip')}
              active={pipOpen}
              compact={compact}
              onClick={run(actions.togglePip)}
              testId="hub-pip"
            />
          )}
          {!parked && (
            <HubTile icon={<AppWindow className="size-4" />} label={t('window.dex_te_pencere')} active={false} compact={compact} onClick={run(actions.openCrop)} testId="hub-crop" />
          )}
          {!parked && (
            <HubTile icon={<ArrowUpRight className="size-4" />} label={t('window.masaustune_cikar')} active={false} compact={compact} onClick={run(actions.popOut)} testId="hub-popout" />
          )}
        </div>

        {!parked && actions.openKeymap && (
          // Satırın kendisi düzenleyiciyi açar; sağdaki anahtar düzeni geçici aç/kapar (sohbet yazarken gibi — düzen silinmez).
          <div className="mt-1 flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <HubAction
                icon={<Keyboard className="size-4" />}
                label={t('window.tus_duzeni')}
                detail={keymapCount === 0
                  ? t('window.klavye_tuslarini_dokunmaya_esle')
                  : keymapEnabled
                    ? t('window.keymapcount_tus_tanimli', { keymapCount })
                    : t('window.tus_duzeni_kapali_keymapcount_tus', { keymapCount })}
                compact={compact}
                onClick={run(actions.openKeymap)}
                testId="hub-keymap"
              />
            </div>
            {keymapCount > 0 && actions.toggleKeymap && (
              <span data-testid="hub-keymap-toggle" className="shrink-0 pr-1">
                <Switch checked={keymapEnabled} label={t('window.tus_duzeni')} size="sm" onChange={(event) => { event?.stopPropagation?.(); actions.toggleKeymap(); }} />
              </span>
            )}
          </div>
        )}

        {!parked && (
          <>
            <div className="my-2 h-px bg-border" />

            <SectionTitle>{t('window.yogunluk_dpi')}</SectionTitle>
            <div className="flex flex-wrap gap-1.5 px-1" role="group" aria-label={t('window.hazir_yogunluk_degerleri')}>
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
                      'h-7 min-w-[38px] cursor-pointer rounded-md px-2 text-[11px] font-semibold outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90'
                        : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
            <div className="px-2 pb-1 pt-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-muted-foreground">{t('window.ince_ayar')}</span>
                <span className="font-mono text-[10px] text-foreground">{t('window.sliderdpi_dpi', { sliderDpi })}</span>
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

        <div className="my-2 h-px bg-border" />
        {!parked && (
          <HubAction
            icon={<ChevronLeft className="size-4" />}
            label={t('window.android_geri')}
            detail={t('window.uygulamada_bir_adim_geri')}
            compact={compact}
            onClick={run(actions.back)}
            testId="hub-back"
          />
        )}
        <HubAction
          icon={<X className="size-4" />}
          label={t('window.gorevi_kapat')}
          detail={t('window.uygulama_kapatilir')}
          destructive
          compact={compact}
          onClick={run(actions.closeTask)}
          testId="hub-close"
        />
      </div>
    </FloatingPanel>
  );
}

export default WorkspaceTaskHub;
