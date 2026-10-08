// Bağlam / açılır menü parçaları (Desktop.jsx MenuLabel/MenuSeparator/MenuRow buraya taşındı).
// Açılış animasyonu framer-motion ile: eski "animate-in fade-in zoom-in-95" sınıfları Tailwind v3'te CSS üretmiyordu.
import React, { forwardRef } from 'react';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { menuVariants } from './motion.js';

export const MenuSurface = forwardRef(function MenuSurface({ className, children, ...props }, ref) {
  return (
    <motion.div
      ref={ref}
      role="menu"
      variants={menuVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn('overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-window backdrop-blur-2xl', className)}
      {...props}
    >
      {children}
    </motion.div>
  );
});

export function MenuLabel({ children }) {
  return <p className="truncate px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}

export function MenuItem({ icon, label, hint, active, destructive, right, onClick, className, ...aria }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer',
        destructive && 'text-destructive hover:bg-destructive/10 hover:text-destructive',
        className,
      )}
      {...aria}
    >
      {icon && <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      {right}
      {active && <Check className="size-3.5 shrink-0 text-primary" />}
    </button>
  );
}
