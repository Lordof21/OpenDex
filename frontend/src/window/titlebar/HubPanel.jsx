// Pencere Hub'ı — başlıktaki ⚙ düğmesinin açtığı panel (DeX penceresi, akış PiP'i, Workspace PiP'i aynı paneli kullanır).
//
//   bant       uygulama ikonu · ad · akışın boyutu ve yoğunluğu
//   Görüntü    Ölçek (Oto | Sığdır | Uzat | Kırp | 1.25× | 1.5×) · Dinamik DP (Genele uy | Açık | Kapalı) · Tuş düzeni (satır + anahtar)
//   Pencere    Tam ekran · Ayrı PiP · Üstte tut · Ekran kilidi (tek sıra küçük karo) · Başlık (Genele uy | Sabit | Hover)
//   Telefona   Ön-iniş (Genele uy | Otomatik | Açık | Kapalı)
//   eylemler   Workspace'e gönder · Sayfayı yenile · Uygulamayı yeniden başlat (küçük karo)
//
// Birden çok değerli her ayar seçenekleriyle birlikte görünür (tek tıkla seçilir; eskiden "Döndür" ile sırayla dolaşılıyordu). "Genele uy"
// seçiliyken yanında o an geçerli olan yazar. Ayrıntı metinleri ipucundadır: panel ~750 px'ten ~470 px'e indi.

import React, { forwardRef } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  Globe,
  Keyboard,
  LockKeyhole,
  Maximize,
  PictureInPicture2,
  Pin,
  RotateCw,
  Send,
} from 'lucide-react';
import AppIcon from '../../ui/AppIcon.jsx';
import { SegmentedControl } from '../../ui/SegmentedControl.jsx';
import { Switch } from '../../ui/Switch.jsx';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { FIT_MODES } from '../fitModes.js';
import { HEADER_MODE_LABELS, PRELANDING_LABELS } from '../windowModel.js';

/** Hub's width (the Workspace task hub uses the same). */
export const HUB_PANEL_WIDTH_PX = 320;

const FIT_SHORT = {
  auto: () => t('window.oto'),
  fit: () => t('common.sigdir'),
  fill: () => t('window.uzat'),
  cover: () => t('window.kirp'),
  zoom125: () => '1.25×',
  zoom150: () => '1.5×',
};
const FIT_ORDER = ['auto', 'fit', 'fill', 'cover', 'zoom125', 'zoom150'];

/** The short name of a fit mode ("Sığdır"), for the segments and the "→ …" hint. */
export const fitShortLabel = (key) => (FIT_SHORT[key] || FIT_SHORT.fit)();

const arrow = (text) => `→ ${text}`;

export const HubPanel = forwardRef(function HubPanel(
  {
    panelRef,
    // Bant: pencerenin kimliği ve akışı ("1280×800 · 320 DPI"). Verilmezse panelin adı yazar.
    title,
    iconPkg,
    metrics,
    // Başlığın yüksekliği (DeX 44 px, PiP 32 px): panel hemen altında açılır.
    headerHeight = 44,
    // Görüntü ölçeği: pencerenin KENDİ seçimi ('auto' = genel ayar) ve "Oto"nun o an çözüldüğü mod.
    fitMode = 'auto',
    fitAuto = 'fit',
    onFitMode,
    absoluteFullscreen = false,
    onFullscreen,
    pipOpen = false,
    onPip,
    alwaysOnTop = false,
    onAlwaysOnTop,
    // "Ekran kilidi": akışın px + DPI'ı sabit; pencere serbest. Verilmezse (ayna / Dosyalar / kırpma / Workspace: akışı
    // pencereye bağlı olmayan pencereler) karo hiç gösterilmez.
    displayLocked = false,
    onDisplayLock,
    // "Uygulamayı yeniden başlat": takılan / siyah kalan uygulamayı aynı pencerede yeniler. Verilmezse (akışı olmayan
    // pencereler) karo hiç gösterilmez. `restartingApp`: işlem sürüyor.
    onRestartApp,
    restartingApp = false,
    // "Sayfayı yenile": Chromium tabanlı bir tarayıcı penceresinde açık sekmeyi yeniden yükler. Verilmezse (web sayfası yok) yok.
    onReloadPage,
    reloadingPage = false,
    // "Dinamik DP": `dynamicDpMode` = pencerenin kendi seçimi ('follow' | 'on' | 'off'), `dynamicDp` = şu an geçerli olan.
    // `dynamicDpOffAvailable`: "Kapalı" mevcut yoğunluğa sabitler — yoğunluk bilinmiyorsa seçilemez.
    dynamicDp = true,
    dynamicDpMode = 'on',
    dynamicDpLocked = false,
    dynamicResolutionOff = false,
    dynamicDpOffAvailable = true,
    onDynamicDp,
    // "Tuş düzeni": satır düzenleyiciyi açar, yanındaki anahtar düzeni geçici aç/kapar (düzen silinmez). Verilmezse (Dosyalar, Workspace,
    // kırpma penceresi: canvas'ında editör yok) satır yok.
    onKeymap,
    keymapCount = 0,
    keymapEnabled = true,
    onToggleKeymap,
    // "Ön-iniş" (telefona aktarırken): pencerenin kendi seçimi ve bu pencerede geçerli olan. Verilmezse (telefona aktarılamayan pencere) yok.
    prelandingMode = 'follow',
    prelandingEffective = 'auto',
    onPrelanding,
    // Başlık kipi: pencerenin kendi seçimi ('follow' | 'pinned' | 'hover') ve "Genele uy"un o an çözüldüğü kip.
    headerMode = 'follow',
    headerEffective = 'pinned',
    onHeaderMode,
    workspaceSent = false,
    onSend,
    // 'video' (varsayılan) | 'workspace-crop': DeX-içi kırpma penceresinde akış eylemleri (görüntü ölçeği, dinamik DP, tuş düzeni,
    // ayrı PiP, Workspace'e gönder, ön-iniş) anlamsızdır — gizlenir.
    variant = 'video',
  },
  ref
) {
  const effectiveRef = panelRef || ref;
  const isCrop = variant === 'workspace-crop';
  const onOff = (on) => (on ? t('common.acik_2') : t('common.kapali_2'));

  // Dinamik DP: seçim segmentlerde görünür; ipucu ya neden etkisiz olduğunu ya da "Genele uy"un o anki sonucunu söyler.
  const dynamicDpHint = dynamicResolutionOff
    ? t('settings.gercek_cozunurluk_kapali')
    : dynamicDpLocked
      ? t('taskbar.kilitli')
      : dynamicDpMode === 'follow' ? arrow(onOff(dynamicDp)) : null;

  const keymapDetail = keymapCount === 0
    ? t('window.klavye_tuslarini_dokunmaya_esle')
    : keymapEnabled
      ? t('window.keymapcount_tus_tanimli', { keymapCount })
      : t('window.tus_duzeni_kapali_keymapcount_tus', { keymapCount });

  const windowTiles = [
    <HubTile key="fs" size="mini" icon={<Maximize className="size-4" />} label={t('common.tam_ekran')} active={absoluteFullscreen} onClick={onFullscreen} />,
    !isCrop && onPip && (
      <HubTile key="pip" size="mini" icon={<PictureInPicture2 className="size-4" />} label={t('window.ayri_pip')} active={pipOpen} onClick={onPip} />
    ),
    <HubTile key="top" size="mini" icon={<Pin className="size-4" />} label={t('window.ustte_tut')} active={alwaysOnTop} onClick={onAlwaysOnTop} />,
    onDisplayLock && (
      <HubTile
        key="lock"
        size="mini"
        icon={<LockKeyhole className="size-4" />}
        label={displayLocked ? t('window.ekran_kilitli') : t('window.ekran_serbest')}
        hint={displayLocked ? t('window.goruntu_boyutu_px_ve_dpi_sabit') : undefined}
        active={displayLocked}
        onClick={onDisplayLock}
      />
    ),
  ].filter(Boolean);

  const actionTiles = [
    !isCrop && onSend && (
      <HubTile
        key="send"
        size="mini"
        toggle={false}
        testId="hub-send"
        icon={workspaceSent ? <Check className="size-4 text-status-active" /> : <Send className="size-4" />}
        label={workspaceSent ? t('window.workspace_e_gonderildi') : t('window.workspace_e_gonder')}
        hint={t('window.mevcut_durumu_paylas')}
        onClick={onSend}
      />
    ),
    onReloadPage && (
      <HubTile
        key="reload"
        size="mini"
        toggle={false}
        testId="hub-reload"
        disabled={reloadingPage}
        icon={<Globe className={cn('size-4', reloadingPage && 'animate-pulse')} />}
        label={reloadingPage ? t('window.sayfa_yenileniyor') : t('common.sayfayi_yenile')}
        hint={t('window.acik_web_sayfasini_yeniden_yukle')}
        onClick={onReloadPage}
      />
    ),
    onRestartApp && (
      <HubTile
        key="restart"
        size="mini"
        toggle={false}
        testId="hub-restart"
        disabled={restartingApp}
        icon={<RotateCw className={cn('size-4', restartingApp && 'animate-spin')} />}
        label={restartingApp ? t('window.yeniden_baslatiliyor') : t('common.uygulamayi_yeniden_baslat')}
        hint={restartingApp ? t('window.bu_birkac_saniye_surebilir') : t('window.takilan_ya_da_siyah_kalan_uygulamayi')}
        onClick={onRestartApp}
      />
    ),
  ].filter(Boolean);

  return (
    <motion.div
      ref={effectiveRef}
      initial={{ opacity: 0, y: -7, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -7, scale: 0.985 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      style={{ top: headerHeight + 4, maxHeight: `calc(100% - ${headerHeight + 12}px)` }}
      className="absolute right-2 z-[120] flex w-[min(320px,calc(100%-16px))] origin-top-right isolate flex-col overflow-hidden rounded-md border border-border bg-popover/95 text-popover-foreground shadow-window select-none backdrop-blur-2xl"
      role="dialog"
      aria-label={t('window.pencere_hub_i')}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border bg-muted/30 px-3 py-2.5">
        {(iconPkg || title) && <AppIcon pkg={iconPkg} displayName={title} size={24} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold">{title || t('window.pencere_hub_i')}</p>
          {metrics && <p className="truncate font-mono text-[10px] text-muted-foreground" data-testid="hub-metrics">{metrics}</p>}
        </div>
      </div>

      <div className="dex-scroll min-h-0 overflow-y-auto overscroll-contain bg-background/50 p-2 [scrollbar-gutter:stable]">
        {!isCrop && (
          <>
            <HubSection>{t('common.goruntu')}</HubSection>
            {onFitMode && (
              <HubChoice
                testId="hub-fit"
                label={t('window.olcek')}
                hint={fitMode === 'auto' ? arrow(fitShortLabel(fitAuto)) : null}
                stack
                value={fitMode}
                onChange={onFitMode}
                options={FIT_ORDER.map((key) => ({ value: key, label: fitShortLabel(key), title: FIT_MODES[key].label }))}
              />
            )}
            {onDynamicDp && (
              <HubChoice
                testId="hub-dynamic-dp"
                label={t('window.dinamik_dp')}
                hint={dynamicDpHint}
                value={dynamicDpMode}
                onChange={onDynamicDp}
                options={[
                  { value: 'follow', label: t('window.genele_uy') },
                  { value: 'on', label: t('common.acik_2') },
                  { value: 'off', label: t('common.kapali_2'), disabled: !dynamicDpOffAvailable },
                ]}
              />
            )}
            {onKeymap && (
              // Satırın kendisi düzenleyiciyi açar; düzen varken sağdaki anahtar onu geçici aç/kapar (sohbet yazarken gibi — düzen silinmez).
              <div className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <HubAction
                    dense
                    testId="hub-keymap"
                    icon={<Keyboard className="size-4" />}
                    label={t('window.tus_duzeni')}
                    detail={keymapDetail}
                    onClick={onKeymap}
                  />
                </div>
                {keymapCount > 0 && onToggleKeymap && (
                  <span data-testid="hub-keymap-toggle" className="shrink-0 pr-2" onPointerDown={(e) => e.stopPropagation()}>
                    <Switch
                      checked={keymapEnabled}
                      label={t('window.tus_duzeni')}
                      size="sm"
                      onChange={(event) => { event?.stopPropagation?.(); onToggleKeymap(); }}
                    />
                  </span>
                )}
              </div>
            )}
            <HubDivider />
          </>
        )}

        <HubSection>{t('common.pencere')}</HubSection>
        <div className={cn('grid gap-1 px-1', windowTiles.length >= 4 ? 'grid-cols-4' : windowTiles.length === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
          {windowTiles}
        </div>
        {onHeaderMode && (
          <HubChoice
            testId="hub-header"
            label={t('window.baslik')}
            hint={headerMode === 'follow' ? arrow(HEADER_MODE_LABELS[headerEffective] ?? HEADER_MODE_LABELS.pinned) : null}
            value={headerMode}
            onChange={onHeaderMode}
            options={['follow', 'pinned', 'hover'].map((mode) => ({ value: mode, label: HEADER_MODE_LABELS[mode] }))}
          />
        )}

        {onPrelanding && !isCrop && (
          <>
            <HubDivider />
            <HubSection>{t('window.telefona_aktarim')}</HubSection>
            <HubChoice
              testId="hub-prelanding"
              label={t('common.on_inis')}
              hint={prelandingMode === 'follow' ? arrow(PRELANDING_LABELS[prelandingEffective] ?? PRELANDING_LABELS.auto) : null}
              value={prelandingMode}
              onChange={onPrelanding}
              options={['follow', 'auto', 'on', 'off'].map((mode) => ({ value: mode, label: PRELANDING_LABELS[mode] }))}
            />
          </>
        )}

        {actionTiles.length > 0 && (
          <>
            <HubDivider />
            <div className={cn('grid gap-1 px-1', actionTiles.length >= 3 ? 'grid-cols-3' : 'grid-cols-2')}>{actionTiles}</div>
          </>
        )}
      </div>
    </motion.div>
  );
});

// ───────────────────────────────────────── ortak parçalar (WorkspaceTaskHub da kullanır)

export function HubSection({ children }) {
  return <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

export function HubDivider() {
  return <div className="mx-1 my-1.5 h-px bg-border" />;
}

/**
 * A setting with a few named values, all visible (one click picks one). `stack`: the segments take a line of their own (many values);
 * otherwise they sit to the right of the name and wrap below it when the panel is narrow. `hint`: what applies now (shown under the name).
 */
export function HubChoice({ label, hint, options, value, onChange, stack = false, testId }) {
  return (
    <div data-testid={testId} className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1.5', stack && 'flex-col items-stretch')}>
      <div className={cn('min-w-0', stack ? 'flex items-baseline justify-between gap-2' : 'flex-1')}>
        <span className="block truncate text-[11px] font-medium leading-4">{label}</span>
        {hint && <span className="block truncate text-[10px] leading-[13px] text-muted-foreground">{hint}</span>}
      </div>
      <SegmentedControl
        label={label}
        options={options}
        value={value}
        onChange={onChange}
        stopPropagation
        stretch={stack}
        className={cn('bg-muted', stack ? 'w-full' : 'ml-auto')}
      />
    </div>
  );
}

// Satır: `choice` = seçmeli (aria-pressed; `checked` = seçili, tik gösterir). `destructive`: geri alınamaz eylem.
// `compact`: tek satır, açıklama yalnız ipucunda. `dense`: açıklama görünür ama satır alçak (küçük simge kutusu).
export function HubAction({ icon, label, detail, onClick, trailing, emphasized = false, disabled = false, destructive = false, choice = false, checked = false, compact = false, dense = false, testId }) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      aria-busy={disabled || undefined}
      aria-pressed={choice ? checked : undefined}
      title={compact ? detail : undefined}
      className={cn(
        'flex h-auto w-full items-center justify-start gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-accent cursor-pointer disabled:cursor-progress disabled:opacity-70 disabled:hover:bg-transparent',
        compact || dense ? 'py-1.5' : 'py-2.5',
        (emphasized || checked) && 'bg-secondary',
        destructive && 'hover:bg-destructive/10'
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
    >
      <span className={cn('grid shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground', dense || compact ? 'size-7' : 'size-8', destructive && 'bg-destructive/10 text-destructive')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-xs font-medium', destructive && 'text-destructive')}>{label}</span>
        {detail && !compact && <span className="block truncate text-[10px] font-normal text-muted-foreground">{detail}</span>}
      </span>
      {checked && (
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground" aria-hidden="true">
          <Check className="size-2.5" strokeWidth={3.5} />
        </span>
      )}
      {trailing && <span className="text-muted-foreground">{trailing}</span>}
    </button>
  );
}

/**
 * Karo. `size`: 'tile' (büyük, simge üstte), 'mini' (küçük, simge üstte, tek sırada dörde kadar), 'row' (tek satır). `toggle`: açık/kapalı
 * bir ayar (aria-pressed, açıkken nokta); false → tek seferlik eylem. `hint` yalnız ipucunda (mini) ya da altta (tile) görünür.
 */
export function HubTile({ icon, label, hint, active = false, onClick, className, badge, testId, compact = false, size, toggle = true, disabled = false }) {
  const kind = size || (compact ? 'row' : 'tile');
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      aria-busy={disabled || undefined}
      title={kind === 'mini' ? (hint ? `${label} — ${hint}` : label) : undefined}
      className={cn(
        'relative flex min-w-0 overflow-hidden rounded-md text-center transition-all cursor-pointer disabled:cursor-progress disabled:opacity-70',
        kind === 'row' && 'min-h-9 flex-row items-center justify-center gap-2 px-2 py-2',
        kind === 'tile' && 'min-h-[74px] flex-col items-center justify-center gap-1.5 px-2 py-2',
        kind === 'mini' && 'min-h-[54px] flex-col items-center justify-center gap-1 px-1 py-1.5',
        toggle && active
          ? 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        className
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      aria-pressed={toggle ? active : undefined}
      aria-label={toggle ? `${label}: ${active ? t('common.acik') : t('common.kapali')}` : label}
    >
      <span className={cn('grid shrink-0 place-items-center rounded-full bg-background/20', kind === 'tile' ? 'size-7' : 'size-6')}>
        {icon}
      </span>
      <span className={cn(
        'whitespace-normal font-semibold',
        kind === 'row' ? 'min-w-0 truncate text-[10px] leading-[13px]' : 'line-clamp-2 w-full text-[10px] leading-[12px]',
      )}
      >
        {label}
      </span>
      {hint && kind === 'tile' && <span className="-mt-1 line-clamp-2 w-full whitespace-normal text-[9px] leading-[11px] opacity-80">{hint}</span>}
      {badge != null && (
        <span className="absolute left-1.5 top-1.5 min-w-4 rounded-full bg-background/30 px-1 text-center font-mono text-[9px] font-bold leading-4" aria-hidden="true">
          {badge}
        </span>
      )}
      {toggle && active && (
        <span
          className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-status-active ring-2 ring-primary-foreground/70"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export default HubPanel;
