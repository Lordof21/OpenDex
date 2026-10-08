// OpenDeX Spatial Liquid Glass Handoff Overlay
// Designed with Apple Universal Control / Huawei Super Device / Samsung DeX Flow principles:
// - Seamless ecosystem continuity metaphor (Phone ⟷ PC)
// - Human-centric reassurance (no technical jargon)
// - Tactile liquid celestial glass CTA with smooth indeterminate spring loading
// - Fluid responsive layout matching any window geometry

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Smartphone, Monitor, ArrowLeftRight, Sparkles, ArrowDownToLine, Layers } from 'lucide-react';
import { useWindowStore } from '../windowStore.js';

export default function HandoffOverlay({ winId }) {
  const [isReclaiming, setIsReclaiming] = useState(false);

  const handleReclaim = async () => {
    if (isReclaiming) return;
    setIsReclaiming(true);
    try {
      await useWindowStore.getState().reclaimWindow(winId);
    } finally {
      setIsReclaiming(false);
    }
  };

  return (
    <motion.div
      key="overlay-handoff"
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
        <div className="w-80 h-80 rounded-full bg-gradient-to-tr from-primary/20 via-info/10 to-primary/20 blur-3xl opacity-60 animate-pulse-ring" />
      </div>

      <div className="relative max-w-sm w-full rounded-3xl bg-popover/90 border border-border/80 shadow-2xl backdrop-blur-2xl p-5 sm:p-6 flex flex-col items-center text-center">

        {/* Dual-Device Continuity Hero Graphic (Phone ⟷ PC) */}
        <div className="relative mb-3.5 flex items-center justify-center gap-3">
          {/* Animated concentric breathing halo */}
          <motion.div
            animate={{ scale: [1, 1.25, 1], opacity: [0.25, 0.5, 0.25] }}
            transition={{ repeat: Infinity, duration: 2.8, ease: 'easeInOut' }}
            className="absolute -inset-3 rounded-full bg-primary/20 blur-xl"
          />

          {/* Smartphone Node */}
          <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/20 via-info/10 to-transparent border border-primary/40 text-primary shadow-sm">
            <Smartphone className="w-7 h-7 text-primary" strokeWidth={1.75} />
            {/* Live beacon ping */}
            <span className="absolute -top-1 -right-1 flex h-3.5 w-3.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-primary border-2 border-background" />
            </span>
          </div>

          {/* Bi-directional Flow Link */}
          <motion.div
            animate={{ x: [-3, 3, -3], opacity: [0.7, 1, 0.7] }}
            transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
            className="flex items-center justify-center text-primary"
          >
            <ArrowLeftRight className="w-5 h-5 text-primary" strokeWidth={2} />
          </motion.div>

          {/* Desktop Monitor Node */}
          <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/60 border border-border/70 text-muted-foreground shadow-inner">
            <Monitor className="w-7 h-7" strokeWidth={1.75} />
          </div>
        </div>

        {/* Title & Subtitle */}
        <h3 className="text-base sm:text-lg font-bold text-foreground tracking-tight">
          Uygulama Telefona Aktarıldı
        </h3>
        <p className="mt-1 text-xs text-muted-foreground font-normal leading-relaxed max-w-[280px]">
          Bu uygulama şu anda telefonunuzun ekranında aktif durumda.
        </p>

        {/* Ecosystem Continuity Reassurance Pill */}
        <div className="mt-4 w-full rounded-2xl bg-muted/50 border border-border/60 p-3 text-left flex items-start gap-2.5 shadow-inner">
          <div className="p-1 rounded-lg bg-primary/15 border border-primary/30 text-primary shrink-0 mt-0.5">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold text-foreground flex items-center gap-1.5">
              <span>Kesintisiz Çoklu Ekran</span>
            </div>
            <p className="text-[10.5px] text-muted-foreground leading-snug mt-0.5">
              Uygulamayı dilediğiniz an tek dokunuşla masaüstü penceresine geri alabilir ve kaldığınız yerden devam edebilirsiniz.
            </p>
          </div>
        </div>

        {/* Action Button Group */}
        <div className="mt-5 flex flex-col items-center w-full gap-2">
          {/* Primary CTA */}
          <button
            type="button"
            disabled={isReclaiming}
            onClick={handleReclaim}
            className={`relative overflow-hidden flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl text-xs font-semibold shadow-md transition-all cursor-pointer ${
              isReclaiming
                ? 'bg-primary/70 text-primary-foreground cursor-wait opacity-90'
                : 'bg-primary hover:bg-primary/90 text-primary-foreground shadow-primary/20 active:scale-[0.98]'
            }`}
          >
            {isReclaiming ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, duration: 0.85, ease: 'linear' }}
                className="h-3.5 w-3.5 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
              />
            ) : (
              <ArrowDownToLine className="w-3.5 h-3.5" strokeWidth={2.2} />
            )}
            <span>{isReclaiming ? 'Masaüstüne Aktarılıyor...' : "PC'ye Geri Al"}</span>
          </button>

          {/* Doğrudan kenar: telefon → Workspace (backend dock_to_workspace görevi Display 0'dan
              alır; reclaim + dock'un iki adımlı VD döngüsü gerekmez) */}
          <button
            type="button"
            disabled={isReclaiming}
            onClick={() => {
              useWindowStore.getState().dockToWorkspace(winId);
            }}
            className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-muted hover:bg-accent border border-border/70 text-foreground text-xs font-medium transition-all active:scale-[0.98] cursor-pointer"
          >
            <Layers className="w-3.5 h-3.5" strokeWidth={2} />
            <span>Çalışma Alanına Al</span>
          </button>

          {/* Secondary CTA */}
          <button
            type="button"
            disabled={isReclaiming}
            onClick={() => {
              useWindowStore.getState().closeWindow(winId);
            }}
            className="w-full py-2 px-3 rounded-xl bg-muted/60 hover:bg-accent border border-border/60 text-muted-foreground hover:text-foreground text-xs font-medium transition-all active:scale-[0.98] cursor-pointer"
          >
            Pencereyi Kapat
          </button>

          {/* Progress Shimmer during Reclaim */}
          {isReclaiming && (
            <div className="w-full mt-1 rounded-full bg-muted p-0.5 border border-primary/25 overflow-hidden shadow-inner">
              <motion.div
                className="h-1 rounded-full bg-primary shadow-md shadow-primary/40"
                initial={{ x: '-100%', width: '50%' }}
                animate={{ x: '220%' }}
                transition={{ repeat: Infinity, duration: 1.1, ease: 'easeInOut' }}
              />
            </div>
          )}
        </div>

      </div>
    </motion.div>
  );
}
