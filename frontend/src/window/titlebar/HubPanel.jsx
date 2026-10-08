import React, { forwardRef } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  Gauge,
  Image as ImageIcon,
  Keyboard,
  LockKeyhole,
  Maximize,
  Move,
  PanelTop,
  PictureInPicture2,
  Pin,
  RotateCw,
  Send,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';


export const HubPanel = forwardRef(function HubPanel(
  {
    panelRef,
    compact = false,
    imageLabel = 'Otomatik',
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
    dynamicDp = true,
    onDynamicDp,
    // "Yön tuşları": ekranda Android D-pad kaplaması (TV tarzı gezinme). Oyun kolu değildir; eski adı "Kontroller" idi.
    visualControls = false,
    onVisualControls,
    // "Tuş düzeni": klavye tuşlarını telefon ekranındaki noktalara eşleyen editör. Verilmezse (Dosyalar, Workspace, kırpma
    // penceresi: canvas'ında editör yok) satır hiç gösterilmez. `keymapCount` = bu uygulama için tanımlı tuş sayısı.
    onKeymap,
    keymapCount = 0,
    headerModeLabel = 'Genele uy',
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
      aria-label="Pencere Hub'ı"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-border px-4 py-3 bg-muted/30">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold">Pencere Hub'ı</p>
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            Görüntü ve pencere davranışı
          </p>
        </div>
        <span className="shrink-0 rounded-sm bg-muted px-2 py-1 font-mono text-[9px] font-semibold text-muted-foreground">
          LIVE
        </span>
      </div>

      <div className="dex-scroll min-h-0 overflow-y-auto overscroll-contain bg-background/50 p-2 [scrollbar-gutter:stable]">
        {!isCrop && (
          <>
            <p className="px-2 pb-1 pt-1 text-[9px] font-semibold uppercase text-muted-foreground">
              Görüntü
            </p>
            <HubAction
              icon={<ImageIcon className="size-4" />}
              label="Görüntü ölçeği"
              detail={imageLabel}
              onClick={onCycleImage}
              trailing={<span className="font-mono text-[10px]">Döndür</span>}
            />
            <div className="grid grid-cols-2 gap-1.5 px-1 pt-1">
              <HubTile
                icon={<Gauge className="size-4" />}
                label="Dinamik DP"
                active={dynamicDp}
                onClick={onDynamicDp}
              />
              <HubTile
                icon={<Move className="size-4" />}
                label="Yön tuşları"
                active={visualControls}
                onClick={onVisualControls}
              />
            </div>
            {onKeymap && (
              <HubAction
                icon={<Keyboard className="size-4" />}
                label="Tuş düzeni"
                detail={keymapCount > 0 ? `${keymapCount} tuş tanımlı` : 'Klavye tuşlarını dokunmaya eşle'}
                onClick={onKeymap}
                trailing={<span className="font-mono text-[10px]">Düzenle</span>}
              />
            )}

            <div className="my-2 h-px bg-border" />
          </>
        )}

        <p className="px-2 pb-1 text-[9px] font-semibold uppercase text-muted-foreground">
          Pencere
        </p>
        <div className={cn('grid gap-1.5 px-1', compact ? 'grid-cols-2' : 'grid-cols-3')}>
          <HubTile
            icon={<Maximize className="size-4" />}
            label="Tam ekran"
            active={absoluteFullscreen}
            onClick={onFullscreen}
          />
          {!isCrop && (
            <HubTile
              icon={<PictureInPicture2 className="size-4" />}
              label="Ayrı PiP"
              active={pipOpen}
              onClick={onPip}
            />
          )}
          <HubTile
            icon={<Pin className="size-4" />}
            label="Üstte tut"
            active={alwaysOnTop}
            onClick={onAlwaysOnTop}
          />
          {onDisplayLock && (
            <HubTile
              icon={<LockKeyhole className="size-4" />}
              label={displayLocked ? 'Ekran kilitli' : 'Ekran serbest'}
              active={displayLocked}
              onClick={onDisplayLock}
            />
          )}
          <HubTile
            icon={<PanelTop className="size-4" />}
            label={`Başlık: ${headerModeLabel}`}
            active={headerModeActive}
            onClick={onCycleHeader}
          />
        </div>
        {onDisplayLock && displayLocked && (
          <p className="px-2 pt-1.5 text-[10px] leading-[14px] text-muted-foreground" data-testid="display-lock-hint">
            Görüntü boyutu (px) ve DPI sabit. Pencereyi istediğin gibi boyutlandırabilirsin; görüntü sığdırılır.
          </p>
        )}

        {onRestartApp && (
          <>
            <div className="my-2 h-px bg-border" />
            <HubAction
              icon={<RotateCw className={cn('size-4', restartingApp && 'animate-spin')} />}
              label={restartingApp ? 'Yeniden başlatılıyor…' : 'Uygulamayı yeniden başlat'}
              detail={restartingApp ? 'Bu birkaç saniye sürebilir' : 'Takılan ya da siyah kalan uygulamayı pencerede yenile'}
              onClick={onRestartApp}
              disabled={restartingApp}
              trailing={<span className="font-mono text-[10px]">Yenile</span>}
            />
          </>
        )}

        {!isCrop && (
          <>
            <div className="my-2 h-px bg-border" />

            <HubAction
              icon={workspaceSent ? <Check className="size-4 text-status-active" /> : <Send className="size-4" />}
              label={workspaceSent ? "Workspace'e gönderildi" : "Workspace'e gönder"}
              detail={workspaceSent ? 'Hazır' : 'Mevcut durumu paylaş'}
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

function HubTile({ icon, label, active, onClick }) {
  return (
    <button
      type="button"
      className={cn(
        'relative flex min-h-[74px] min-w-0 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-md px-2 py-2 text-center transition-all cursor-pointer',
        active
          ? 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      aria-pressed={active}
      aria-label={`${label}: ${active ? 'açık' : 'kapalı'}`}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-background/20">
        {icon}
      </span>
      <span className="line-clamp-2 w-full whitespace-normal text-[10px] font-semibold leading-[13px]">
        {label}
      </span>
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
