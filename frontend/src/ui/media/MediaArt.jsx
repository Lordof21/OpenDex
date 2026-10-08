// Medya kapağı — tek bileşen, dört durum (görev çubuğu, panel ana kapağı ve oturum satırı aynısını kullanır):
//   image    kapak yüklendi (yumuşak belirir)
//   pending  şarkı değişti, kapak henüz gelmedi → YANLIŞ kapak yerine iskelet; `data-art-pending="true"`
//   fallback kapak yok ya da bozuk → uygulamanın simgesi (yoksa nota) zarif bir zeminde
// Bozuk görsel DOM'a dokunularak değil durumla yönetilir; kapak değişince durum sıfırlanır.

import React, { useState } from 'react';
import { Music4 } from 'lucide-react';
import AppIcon from '../AppIcon.jsx';
import { cn } from '../../lib/utils.js';

export function MediaArt({
  src,
  pkg,
  pending = false,
  paused = false,
  size,
  iconSize,
  className,
  imgClassName,
  children,
}) {
  // `status.src` ile eşleşmeyen durum "yükleniyor" sayılır: kapak değiştiğinde eski sonuç yeni kapağa sızmaz.
  const [status, setStatus] = useState({ src: null, state: 'loading' });
  const state = src && status.src === src ? status.state : 'loading';
  const failed = state === 'error';
  const showImage = Boolean(src) && !failed;
  const skeleton = !src && pending;
  const px = typeof size === 'number' ? size : undefined;
  const glyph = iconSize || Math.round((px || 56) * 0.62);

  return (
    <span
      className={cn(
        'relative isolate grid shrink-0 place-items-center overflow-hidden bg-muted/50 ring-1 ring-foreground/10',
        skeleton && 'animate-pulse',
        className,
      )}
      style={px ? { width: px, height: px } : undefined}
      data-art-state={showImage ? 'image' : skeleton ? 'pending' : 'fallback'}
      data-art-pending={skeleton ? 'true' : undefined}
    >
      <span className="absolute inset-0 bg-gradient-to-br from-primary/20 via-muted/60 to-background" aria-hidden="true" />
      {!showImage && (
        <span className="relative grid place-items-center" aria-hidden="true">
          {pkg ? <AppIcon pkg={pkg} size={glyph} className="drop-shadow-md" /> : <Music4 className="text-primary/70" style={{ width: glyph * 0.7, height: glyph * 0.7 }} />}
        </span>
      )}
      {skeleton && <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-foreground/10 to-transparent" aria-hidden="true" />}
      {showImage && (
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={() => setStatus({ src, state: 'loaded' })}
          onError={() => setStatus({ src, state: 'error' })}
          className={cn(
            'absolute inset-0 size-full object-cover transition-[opacity,filter,transform] duration-500',
            state === 'loaded' ? 'opacity-100' : 'opacity-0',
            paused && 'saturate-[0.8] brightness-[0.92]',
            imgClassName,
          )}
        />
      )}
      {children}
    </span>
  );
}

export default MediaArt;
