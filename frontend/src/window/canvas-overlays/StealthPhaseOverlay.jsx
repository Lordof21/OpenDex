// OpenDeX Spatial Liquid Glass Stealth Transition Pill
// Designed with Apple ProMotion / Dynamic Island / HarmonyOS fluid adaptation aesthetic:
// - Minimalist floating frosted capsule (not a heavy intrusive curtain)
// - Specular chromatic aperture rotation
// - Fluid breathing micro-indicators

import React from 'react';
import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';

export default function StealthPhaseOverlay() {
  return (
    <motion.div
      key="overlay-stealth"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-background/60 backdrop-blur-xl select-none pointer-events-auto"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <motion.div
        initial={{ scale: 0.92, y: 4 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 4 }}
        transition={{ type: 'spring', damping: 26, stiffness: 360 }}
        className="relative flex items-center gap-3.5 px-5 py-3 rounded-2xl bg-popover/90 border border-border/80 shadow-2xl backdrop-blur-2xl text-foreground"
      >
        {/* Specular Ambient Glow */}
        <div className="absolute -inset-1 rounded-2xl bg-primary/15 blur-lg pointer-events-none" />

        {/* Chromatic Spinner */}
        <div className="relative flex items-center justify-center">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 1.6, ease: 'linear' }}
            className="w-5 h-5 rounded-full border-2 border-primary/25 border-t-primary"
          />
          <Sparkles className="absolute w-2.5 h-2.5 text-primary" />
        </div>

        {/* Title & Subtitle */}
        <div className="flex flex-col text-left">
          <span className="text-xs font-semibold text-foreground tracking-tight">
            Görünüm Optimize Ediliyor
          </span>
          <span className="text-[10.5px] text-muted-foreground">
            Çözünürlük ve piksel dengesi ayarlanıyor…
          </span>
        </div>

        {/* Dynamic Pulse Dots */}
        <div className="flex items-center gap-1 pl-1">
          {[0, 0.2, 0.4].map((delay, idx) => (
            <motion.span
              key={idx}
              animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.2, 0.8] }}
              transition={{ repeat: Infinity, duration: 1.2, delay }}
              className="h-1.5 w-1.5 rounded-full bg-primary"
            />
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}

