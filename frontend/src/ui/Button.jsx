// OpenDeX tek buton sistemi — Smooth Resize Studio referansının components/ui/button.tsx API'si (JSX, bağımlılıksız).
// Renkler yalnız semantik token'lardan gelir; `dark:` / gray / slate / hex YOK.
import React, { forwardRef } from 'react';
import { cn } from '../lib/utils.js';

export const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium cursor-pointer select-none transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0';

export const BUTTON_VARIANTS = {
  default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
  secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
  outline: 'border border-border/70 bg-background text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground',
  ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
  'destructive-ghost': 'text-destructive hover:bg-destructive/10',
  link: 'text-primary underline-offset-4 hover:underline',
};

// Eski (TailAdmin) adlar geçiş süresince çalışsın diye; yeni kodda KULLANMAYIN.
const LEGACY_VARIANT = { primary: 'default', danger: 'destructive', light: 'secondary' };

export const BUTTON_SIZES = {
  '2xs': 'h-6 gap-1 rounded-md px-2 text-[10px] font-semibold', // eski connectivityParts SmallButton
  xs: 'h-7 px-2.5 text-[10px] font-semibold',
  sm: 'h-8 px-3 text-[11px] font-semibold',
  default: 'h-9 px-4 text-[11px] font-semibold',
  lg: 'h-10 px-6 text-xs font-semibold',
  icon: 'size-9',
  'icon-sm': 'size-8',
  'icon-xs': 'size-7',
  'icon-2xs': 'size-6',
};
const LEGACY_SIZE = { md: 'default' };

export function buttonClasses({ variant = 'default', size = 'default', className } = {}) {
  const v = BUTTON_VARIANTS[LEGACY_VARIANT[variant] || variant] || BUTTON_VARIANTS.default;
  const s = BUTTON_SIZES[LEGACY_SIZE[size] || size] || BUTTON_SIZES.default;
  return cn(BUTTON_BASE, v, s, className);
}

const Button = forwardRef(function Button(
  { variant = 'default', size = 'default', startIcon, endIcon, loading = false, disabled = false, type = 'button', className, children, ...props },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button ref={ref} type={type} disabled={isDisabled} className={buttonClasses({ variant, size, className })} {...props}>
      {loading ? (
        <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
      ) : (
        startIcon
      )}
      {children}
      {!loading && endIcon}
    </button>
  );
});

export { Button };
export default Button;
