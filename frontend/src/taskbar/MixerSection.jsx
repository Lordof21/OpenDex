// Mikser kartı: başlık şeridi (+ opsiyonel sağda değer) ve satırlar.

import React from 'react';

export function MixerSection({ as: Tag = 'div', title, value, children, ...rest }) {
  return (
    <Tag className="mixer-surface mt-2 overflow-hidden rounded-lg border border-border/70 bg-muted/45 px-3" {...rest}>
      <div className="flex items-center justify-between border-b border-border/55 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="pb-1.5">{title}</span>
        {value != null && <span className="pb-1.5 font-mono text-[11px] tabular-nums text-foreground">{value}</span>}
      </div>
      {children}
    </Tag>
  );
}

export default MixerSection;
