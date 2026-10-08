// Wi-Fi sinyal çubukları. Kart, satır, buton, onay şeridi ve anahtar artık src/ui/ altında.

import { cn } from '../lib/utils.js';

export function SignalBars({ n, className }) {
  const level = Math.max(0, Math.min(4, Number.isFinite(n) ? n : 0));
  return (
    <span className={cn('inline-flex h-3 items-end gap-px', className)} role="img" aria-label={`Sinyal ${level}/4`}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={cn('w-[3px] rounded-[1px]', i <= level ? 'bg-current' : 'bg-current opacity-20')}
          style={{ height: 3 * i }}
        />
      ))}
    </span>
  );
}
