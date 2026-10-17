import React, { forwardRef } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  Gauge,
  Globe,
  Image as ImageIcon,
  Keyboard,
  LockKeyhole,
  Maximize,
  PanelTop,
  PictureInPicture2,
  Pin,
  RotateCw,
  Send,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';


export const HubPanel = forwardRef(function HubPanel(
  {
    panelRef,
    compact = false,
    imageLabel = t('common.otomatik_2'),
    onCycleImage,
    absoluteFullscreen = false,
    onFullscreen,
    pipOpen = false,
    onPip,
    alwaysOnTop = false,
    onAlwaysOnTop,
    // "Ekran kilidi": akışın px + DPI'ı sabit; pencere serbest. Verilmezse (ayna / Dosyalar / kırpma / Workspace: akışı
    // pencereye bağlı olmayan pencereler) düğme hiç gösterilmez.
    displayLocked = false,
    onDisplayLock,
    // "Uygulamayı yeniden başlat": takılan / siyah kalan uygulamayı aynı pencerede yeniler. Verilmezse (akışı olmayan
    // pencereler: ayna / Dosyalar / kırpma / Workspace kabı) satır hiç gösterilmez. `restartingApp`: işlem sürüyor.
    onRestartApp,
    restartingApp = false,
    // "Sayfayı yenile": Chromium tabanlı bir tarayıcı penceresinde açık sekmeyi normal yenileme ile yeniden yükler (uygulama ve
    // diğer sekmeler korunur). Verilmezse (pencerenin web sayfası yok) satır hiç gösterilmez. Hiçbir zaman kendiliğinden çalışmaz.
    onReloadPage,
    reloadingPage = false,
    // "Dinamik DP": `dynamicDp` = şu an geçerli olan (otomatik yoğunluk mu), `dynamicDpMode` = pencerenin kendi seçimi
    // ('follow' Genele uy | 'on' Açık | 'off' Kapalı). Karo üçlü döner.
    dynamicDp = true,
    dynamicDpMode = 'on',
    // Genel "Gerçek çözünürlük" kapalıyken yoğunluk politikası hiçbir pencereye uygulanmaz: karo kapalı görünür ve bunu söyler.
    dynamicResolutionOff = false,
    onDynamicDp,
    // "Tuş düzeni": klavye/fare tuşlarını telefon ekranındaki noktalara eşleyen düzen. Verilmezse (Dosyalar, Workspace, kırpma
    // penceresi: canvas'ında editör yok) satır ve döşeme hiç gösterilmez. `keymapCount` = bu uygulama için tanımlı düğüm sayısı;
    // `keymapEnabled` / `onToggleKeymap` = düzeni geçici aç/kapa (sohbet yazarken gibi — düzen silinmez).
    onKeymap,
    keymapCount = 0,
    keymapEnabled = true,
    onToggleKeymap,
    headerModeLabel = t('window.genele_uy'),
    headerModeActive = false,
    onCycleHeader,
    workspaceSent = false,
    onSend,
    // 'video' (varsayılan) | 'workspace-crop': DeX-içi kırpma penceresinde video/akış eylemleri (görüntü ölçeği,
    // dinamik DP, kontroller, ayrı PiP, Workspace'e gönder) anlamsızdır — gizlenir.
    variant = 'video',
  },
  ref
) {
  const effectiveRef = panelRef || ref;
  // Pencerenin KENDİ seçimi her zaman yazılır ("Genele uy" dendiyse "Genele uy" görünür); yanında o an geçerli sonuç ya da neden etkisiz olduğu.
  const dynamicDpChoice = dynamicDpMode === 'follow' ? t('window.genele_uy') : dynamicDpMode === 'off' ? t('common.kapali_2') : t('common.acik_2');
  const dynamicDpHint = dynamicResolutionOff
    ? `${dynamicDpChoice} · ${t('settings.gercek_cozunurluk_kapali')}`
    : dynamicDpMode === 'follow'
      ? `${dynamicDpChoice} · ${dynamicDp ? t('common.acik_2') : t('common.kapali_2')}`
      : dynamicDpChoice;
  const isCrop = variant === 'workspace-crop';
  return (
    <motion.div
      ref={effectiveRef}
      initial={{ opacity: 0, y: -7, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -7, scale: 0.985 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="absolute right-2 top-12 z-[120] flex max-h-[calc(100%-3.5rem)] w-[min(356px,calc(100%-16px))] origin-top-right isolate flex-col overflow-hidden rounded-md border border-border bg-popover/95 text-popover-foreground shadow-window select-none backdrop-blur-2xl"
      role="dialog"
      aria-label={t('window.pencere_hub_i')}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-border px-4 py-3 bg-muted/30">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold">{t('window.pencere_hub_i')}</p>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {t('window.goruntu_ve_pencere_davranisi')}
          </p>
        </div>
        <span className="shrink-0 rounded-sm bg-muted px-2 py-1 font-mono text-[9px] font-semibold text-muted-foreground">
          {t('window.live')}
        </span>
      </div>

      <div className="dex-scroll min-h-0 overflow-y-auto overscroll-contain bg-background/50 p-2 [scrollbar-gutter:stable]">
        {!isCrop && (
          <>
            <p className="px-2 pb-1 pt-1 text-[9px] font-semibold uppercase text-muted-foreground">
              {t('common.goruntu')}
            </p>
            <HubAction
              icon={<ImageIcon className="size-4" />}
              label={t('window.goruntu_olcegi')}
              detail={imageLabel}
              onClick={onCycleImage}
              trailing={<span className="font-mono text-[10px]">{t('window.dondur')}</span>}
            />
            <div className="grid grid-cols-2 gap-1.5 px-1 pt-1">
              <HubTile
                icon={<Gauge className="size-4" />}
                label={t('window.dinamik_dp')}
                hint={dynamicDpHint}
                active={dynamicDp}
                onClick={onDynamicDp}
                className={onToggleKeymap ? undefined : 'col-span-2'}
              />
              {onToggleKeymap && (
                // Düzen yokken döşeme düzenleyiciyi açar (kapatılacak bir şey yok); varken aç/kapa anahtarıdır.
                <HubTile
                  icon={<Keyboard className="size-4" />}
                  label={t('window.tus_duzeni')}
                  active={keymapEnabled && keymapCount > 0}
                  badge={keymapCount > 0 ? keymapCount : undefined}
                  onClick={keymapCount > 0 ? onToggleKeymap : onKeymap}
                  testId="hub-keymap-toggle"
                />
              )}
            </div>
            {onKeymap && (
              <HubAction
                icon={<Keyboard className="size-4" />}
                label={t('window.tus_duzeni')}
                detail={keymapCount === 0
                  ? t('window.klavye_tuslarini_dokunmaya_esle')
                  : keymapEnabled
                    ? t('window.keymapcount_tus_tanimli', { keymapCount })
                    : t('window.tus_duzeni_kapali_keymapcount_tus', { keymapCount })}
                onClick={onKeymap}
                trailing={<span className="font-mono text-[10px]">{t('window.duzenle')}</span>}
              />
            )}

            <div className="my-2 h-px bg-border" />
          </>
        )}

        <p className="px-2 pb-1 text-[9px] font-semibold uppercase text-muted-foreground">
          {t('common.pencere')}
        </p>
        <div className={cn('grid gap-1.5 px-1', compact ? 'grid-cols-2' : 'grid-cols-3')}>
          <HubTile
            icon={<Maximize className="size-4" />}
            label={t('common.tam_ekran')}
            active={absoluteFullscreen}
            onClick={onFullscreen}
          />
          {!isCrop && (
            <HubTile
              icon={<PictureInPicture2 className="size-4" />}
              label={t('window.ayri_pip')}
              active={pipOpen}
              onClick={onPip}
            />
          )}
          <HubTile
            icon={<Pin className="size-4" />}
            label={t('window.ustte_tut')}
            active={alwaysOnTop}
            onClick={onAlwaysOnTop}
          />
          {onDisplayLock && (
            <HubTile
              icon={<LockKeyhole className="size-4" />}
              label={displayLocked ? t('window.ekran_kilitli') : t('window.ekran_serbest')}
              active={displayLocked}
              onClick={onDisplayLock}
            />
          )}
          <HubTile
            icon={<PanelTop className="size-4" />}
            label={t('window.baslik_headermodelabel', { headerModeLabel })}
            active={headerModeActive}
            onClick={onCycleHeader}
          />
        </div>
        {onDisplayLock && displayLocked && (
          <p className="px-2 pt-1.5 text-[10px] leading-[14px] text-muted-foreground" data-testid="display-lock-hint">
            {t('window.goruntu_boyutu_px_ve_dpi_sabit')}
          </p>
        )}

        {(onReloadPage || onRestartApp) && (
          <>
            <div className="my-2 h-px bg-border" />
            {onReloadPage && (
              <HubAction
                icon={<Globe className={cn('size-4', reloadingPage && 'animate-pulse')} />}
                label={reloadingPage ? t('window.sayfa_yenileniyor') : t('common.sayfayi_yenile')}
                detail={t('window.acik_web_sayfasini_yeniden_yukle')}
                onClick={onReloadPage}
                disabled={reloadingPage}
                trailing={<span className="font-mono text-[10px]">{t('window.yukle')}</span>}
              />
            )}
            {onRestartApp && (
              <HubAction
                icon={<RotateCw className={cn('size-4', restartingApp && 'animate-spin')} />}
                label={restartingApp ? t('window.yeniden_baslatiliyor') : t('common.uygulamayi_yeniden_baslat')}
                detail={restartingApp ? t('window.bu_birkac_saniye_surebilir') : t('window.takilan_ya_da_siyah_kalan_uygulamayi')}
                onClick={onRestartApp}
                disabled={restartingApp}
                trailing={<span className="font-mono text-[10px]">{t('window.yenile')}</span>}
              />
            )}
          </>
        )}

        {!isCrop && (
          <>
            <div className="my-2 h-px bg-border" />

            <HubAction
              icon={workspaceSent ? <Check className="size-4 text-status-active" /> : <Send className="size-4" />}
              label={workspaceSent ? t('window.workspace_e_gonderildi') : t('window.workspace_e_gonder')}
              detail={workspaceSent ? t('common.hazir') : t('window.mevcut_durumu_paylas')}
              onClick={onSend}
              emphasized={workspaceSent}
            />
          </>
        )}
      </div>
    </motion.div>
  );
});

function HubAction({ icon, label, detail, onClick, trailing, emphasized = false, disabled = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={disabled || undefined}
      className={cn(
        'flex h-auto w-full items-center justify-start gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-accent cursor-pointer disabled:cursor-progress disabled:opacity-70 disabled:hover:bg-transparent',
        emphasized && 'bg-secondary'
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block truncate text-[10px] font-normal text-muted-foreground">{detail}</span>
      </span>
      {trailing && <span className="text-muted-foreground">{trailing}</span>}
    </button>
  );
}

function HubTile({ icon, label, hint, active, onClick, className, badge, testId }) {
  return (
    <button
      type="button"
      data-testid={testId}
      className={cn(
        'relative flex min-h-[74px] min-w-0 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-md px-2 py-2 text-center transition-all cursor-pointer',
        active
          ? 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        className
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      aria-pressed={active}
      aria-label={`${label}: ${active ? t('common.acik') : t('common.kapali')}`}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-background/20">
        {icon}
      </span>
      <span className="line-clamp-2 w-full whitespace-normal text-[10px] font-semibold leading-[13px]">
        {label}
      </span>
      {hint && <span className="-mt-1 line-clamp-2 w-full whitespace-normal text-[9px] leading-[11px] opacity-80">{hint}</span>}
      {badge != null && (
        <span className="absolute left-1.5 top-1.5 min-w-4 rounded-full bg-background/30 px-1 text-center font-mono text-[9px] font-bold leading-4" aria-hidden="true">
          {badge}
        </span>
      )}
      {active && (
        <span
          className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-status-active ring-2 ring-primary-foreground/70"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export default HubPanel;
