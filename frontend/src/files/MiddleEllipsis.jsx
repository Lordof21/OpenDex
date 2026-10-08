// Uzun, boşluksuz adlar için ORTADAN kısaltma: "IMG_2024081…0000.jpg". Uzantı ve son karakterler hep görünür (dosya türü
// kaybolmaz); baş kısım CSS ile ucundan kırpılır. Tek satırlık hücrelerde (ızgara, dar liste) kullanılır.
import React from 'react';
import { cn } from '../lib/utils.js';

/** Sonda hep görünecek parça: uzantı (".jpg") + ondan önceki 4 karakter; uzantı yoksa son 6 karakter. SAF. */
export function splitName(name, keep = 4) {
  const dot = name.lastIndexOf('.');
  const tailLen = dot > 0 && name.length - dot <= 8 ? name.length - dot + keep : 6;
  if (name.length <= tailLen + 1) return { head: name, tail: '' };
  return { head: name.slice(0, -tailLen), tail: name.slice(-tailLen) };
}

export default function MiddleEllipsis({ text, className }) {
  const { head, tail } = splitName(text);
  return (
    <span className={cn('flex w-full min-w-0 justify-center whitespace-nowrap', className)} title={text}>
      <span className="min-w-0 truncate">{head}</span>
      {tail && <span className="shrink-0">{tail}</span>}
    </span>
  );
}
