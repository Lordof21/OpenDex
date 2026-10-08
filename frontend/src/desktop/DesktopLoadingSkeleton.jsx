import React from 'react';
import { motion } from 'framer-motion';
import { Cpu } from 'lucide-react';
import { staggerContainer, staggerItem } from '../ui/motion.js';

export default function DesktopLoadingSkeleton({ deviceLabel = 'Android Cihazı' }) {
  // 16 squircle icon skeletons arranged in responsive tablet grid
  const dummyItems = Array.from({ length: 16 }, (_, i) => i);

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.25 } }}
      className="flex flex-col items-center justify-start w-full px-4 pt-2"
    >
      {/* Floating Futuristic HUD Badge */}
      <motion.div
        variants={staggerItem}
        className="relative mb-6 flex items-center gap-3 rounded-full border border-border bg-popover/90 px-5 py-2 shadow-2xl backdrop-blur-2xl"
      >
        <div className="absolute -inset-1 rounded-full bg-gradient-to-r from-primary/15 via-accent/30 to-primary/15 blur-md animate-pulse-ring" />

        <div className="relative flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 3, ease: 'linear' }}
          >
            <Cpu className="h-4 w-4" />
          </motion.div>
        </div>

        <div className="relative flex flex-col text-left">
          <div className="flex items-center gap-1.5 text-xs font-bold text-foreground">
            <span>{deviceLabel}</span>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-ping" />
          </div>
          <span className="text-[10.5px] font-medium text-muted-foreground">
            Uygulamalar ve ikon düzeni taranıyor...
          </span>
        </div>
      </motion.div>

      {/* Compact Tablet Centered Grid */}
      <motion.div
        variants={staggerContainer}
        className="mx-auto grid w-full max-w-5xl grid-cols-4 gap-x-4 gap-y-6 sm:grid-cols-6 md:grid-cols-7 lg:grid-cols-8 justify-items-center"
      >
        {dummyItems.map((id) => (
          <motion.div
            key={id}
            variants={staggerItem}
            className="flex flex-col items-center gap-2.5 p-2 w-24"
          >
            {/* Squircle Icon Skeleton */}
            <div className="relative h-13 w-13 overflow-hidden rounded-[22%] bg-muted/60 border border-border/60 shadow-lg backdrop-blur-md">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/10 to-transparent animate-shimmer" />
            </div>
            {/* Text Title Skeleton */}
            <div className="relative h-3.5 w-16 overflow-hidden rounded-md bg-muted/60 border border-border/40">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/10 to-transparent animate-shimmer" />
            </div>
          </motion.div>
        ))}
      </motion.div>
    </motion.div>
  );
}
