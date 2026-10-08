// Liste görünümünün yapışkan sütun başlığı: tıklama sıralar, ok yönü gösterir, `aria-sort` ekran okuyucuya bildirir.
// Dar kipte sütunlar kapanır; telefon düzeninde başlık hiç çizilmez (sıralama araç çubuğundan).
import React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '../lib/utils.js';

export const HEADER_HEIGHT = 28;

const CELL = 'flex h-full items-center gap-1 rounded-sm px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-pointer';

function Cell({ id, label, sort, onSort, className, align }) {
  const active = sort.key === id;
  return (
    <div role="columnheader" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={className}>
      {/* Tıklama alanı hücreden 6 px taşar (-mx): başlık METNİ satırlardaki değerlerle piksel piksel hizalı kalır. */}
      <button type="button" className={cn(CELL, '-mx-1.5 w-[calc(100%+0.75rem)]', align === 'right' && 'justify-end', active && 'text-foreground')} onClick={() => onSort(id)}>
        <span className="truncate">{label}</span>
        {active && (sort.dir === 'asc' ? <ArrowUp className="size-3 shrink-0" aria-hidden="true" /> : <ArrowDown className="size-3 shrink-0" aria-hidden="true" />)}
      </button>
    </div>
  );
}

export default function ColumnHeader({ sort, columns, showCheck, onSort }) {
  return (
    <div role="row" aria-rowindex={1} className="sticky top-0 z-10 border-b border-border/70 bg-background/92 backdrop-blur-sm" style={{ height: HEADER_HEIGHT }}>
      {/* Satırlarla aynı iç boşluk (inset 4 + padding 8); seçim kutusu açıkken satırlar 24 px kayar */}
      <div className="flex h-full items-center gap-2 pr-3" style={{ paddingLeft: showCheck ? 36 : 12 }}>
        <Cell id="name" label="Ad" sort={sort} onSort={onSort} className="min-w-0 flex-1" />
        {columns.date && <Cell id="modified" label="Değiştirme tarihi" sort={sort} onSort={onSort} className="w-36 shrink-0" />}
        {columns.type && <Cell id="type" label="Tür" sort={sort} onSort={onSort} className="w-36 shrink-0" />}
        {columns.size && <Cell id="size" label="Boyut" sort={sort} onSort={onSort} className="w-20 shrink-0" align="right" />}
      </div>
    </div>
  );
}
