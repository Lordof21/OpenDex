// OpenDeX Spatial Liquid Glass AppLock Overlay
// Designed with Apple Face ID / Samsung Knox Vault / HarmonyOS NEXT Liquid Glass aesthetic:
// - Frosted multi-layer ambient blur with biometric security breathing ring
// - Human-centric reassurance (no intimidating debug jargon)
// - Tactile liquid emerald action pills with spring physics
// - Fluid responsive layout matching any window geometry (compact phone to 4K desktop)

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck, Fingerprint, Smartphone, Check, RotateCw } from 'lucide-react';

export default function AppLockOverlay({
  message,
  onReclaim,
  onWakeDevice,
  onRetryPrompt,
  onDismiss,
}) {
  const [isContinuing, setIsContinuing] = useState(false);
  const [isWaking, setIsWaking] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  const handleContinue = async () => {
    if (isContinuing) return;
    setIsContinuing(true);
    try {
      if (onReclaim) await onReclaim();
    } finally {
      setIsContinuing(false);
    }
  };

  const handleWake = async () => {
    if (isWaking) return;
    setIsWaking(true);
    try {
      if (onWakeDevice) await onWakeDevice();
    } finally {
      setTimeout(() => setIsWaking(false), 800);
    }
  };

  // Re-runs the backend's up-to-15s unlock-wait sequence (fire-and-forget —
  // resolves almost instantly, the actual polling happens server-side) so a
  // failed fingerprint/PIN attempt doesn't force closing and cold-relaunching
  // the app.
  const handleRetry = async () => {
    if (isRetrying) return;
    setIsRetrying(true);
    try {
      if (onRetryPrompt) await onRetryPrompt();
    } finally {
      setTimeout(() => setIsRetrying(false), 800);
    }
  };

  return (
    <motion.div
      key="overlay-applock"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ type: 'spring', damping: 28, stiffness: 340 }}
      className="absolute inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-background/60 backdrop-blur-2xl select-none"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Specular Ambient Glow Spot */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden flex items-center justify-center">
        <div className="w-80 h-80 rounded-full bg-gradient-to-tr from-status-active/15 via-primary/10 to-status-active/15 blur-3xl opacity-60 animate-pulse-ring" />
      </div>

      <div className="relative max-w-sm w-full rounded-3xl bg-popover/90 border border-border/80 shadow-2xl backdrop-blur-2xl p-5 sm:p-6 flex flex-col items-center text-center">

        {/* Biometric Shield Hero Graphic */}
        <div className="relative mb-3.5 flex items-center justify-center">
          {/* Animated concentric breathing halo */}
          <motion.div
            animate={{ scale: [1, 1.25, 1], opacity: [0.25, 0.5, 0.25] }}
            transition={{ repeat: Infinity, duration: 2.6, ease: 'easeInOut' }}
            className="absolute -inset-3 rounded-full bg-status-active/20 blur-xl"
          />

          <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-status-active/20 via-status-active/10 to-transparent border border-status-active/40 text-status-active shadow-sm">
            <Fingerprint className="w-8 h-8 text-status-active animate-pulse" strokeWidth={1.75} />
            
            {/* Live Security Radar Pulse */}
            <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-active opacity-75" />
              <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-status-active border-2 border-background" />
            </span>
          </div>
        </div>

        {/* Title & Subtitle */}
        <h3 className="text-base sm:text-lg font-bold text-foreground tracking-tight">
          Biyometrik Onay Gerekli
        </h3>
        <p className="mt-1 text-xs text-muted-foreground font-normal leading-relaxed max-w-[280px]">
          {message || 'Lütfen telefonunuzdan parmak izinizi okutun veya ekran şifrenizi girin.'}
        </p>

        {/* Security Reassurance Pill */}
        <div className="mt-4 w-full rounded-2xl bg-muted/50 border border-border/60 p-3 text-left flex items-start gap-2.5 shadow-inner">
          <div className="p-1 rounded-lg bg-status-active/15 border border-status-active/30 text-status-active shrink-0 mt-0.5">
            <ShieldCheck className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
              <span>Donanım Korumalı Güvenlik</span>
            </div>
            <p className="text-[10.5px] text-muted-foreground leading-snug mt-0.5">
              Şifre ve biyometrik verileriniz cihazınızda güvenle işlenir. Telefonunuzdan kilidi açtığınızda bu pencere otomatik devam eder.
            </p>
          </div>
        </div>

        {/* Action Button Group */}
        <div className="mt-5 flex flex-col items-center w-full gap-2">
          {/* Primary CTA */}
          <button
            type="button"
            disabled={isContinuing}
            onClick={handleContinue}
            className={`relative overflow-hidden flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl text-xs font-semibold shadow-md transition-all cursor-pointer ${
              isContinuing
                ? 'bg-status-active/70 text-image-foreground cursor-wait opacity-90'
                : 'bg-status-active hover:bg-status-active/90 text-image-foreground shadow-status-active/20 active:scale-[0.98]'
            }`}
          >
            {isContinuing ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 0.85, ease: 'linear' }}
                className="h-3.5 w-3.5 rounded-full border-2 border-image-foreground/30 border-t-image-foreground"
              />
            ) : (
              <Check className="w-3.5 h-3.5 text-image-foreground" strokeWidth={2.5} />
            )}
            <span>{isContinuing ? 'Kontrol Ediliyor...' : 'Kilidi Açtım • Devam Et'}</span>
          </button>

          {/* Secondary Action Row */}
          <div className="flex items-center gap-2 w-full">
            {onRetryPrompt && (
              <button
                type="button"
                disabled={isRetrying}
                onClick={handleRetry}
                title="Kilit Kontrolünü Tekrar Dene"
                aria-label="Kilit Kontrolünü Tekrar Dene"
                className="shrink-0 flex items-center justify-center p-2 rounded-xl bg-muted border border-border/70 hover:bg-accent text-muted-foreground hover:text-foreground transition-all active:scale-[0.98] cursor-pointer"
              >
                <RotateCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin text-status-active' : ''}`} />
              </button>
            )}

            <button
              type="button"
              disabled={isWaking}
              onClick={handleWake}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl bg-muted border border-border/70 hover:bg-accent text-foreground text-xs font-medium transition-all active:scale-[0.98] cursor-pointer"
            >
              <Smartphone className={`w-3.5 h-3.5 ${isWaking ? 'animate-bounce text-warning' : 'text-muted-foreground'}`} />
              <span>{isWaking ? 'Uyandırılıyor...' : 'Ekranı Uyandır'}</span>
            </button>

            <button
              type="button"
              onClick={onDismiss}
              className="py-2 px-3 rounded-xl bg-muted/60 border border-border/50 hover:bg-accent text-muted-foreground hover:text-foreground text-xs font-medium transition-all active:scale-[0.98] cursor-pointer"
            >
              Kapat
            </button>
          </div>
        </div>

      </div>
    </motion.div>
  );
}

