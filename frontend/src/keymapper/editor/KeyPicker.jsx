// Ekran klavyesi: "Tuş tanı"ya basmadan, istenen tuşa / fare düğmesine doğrudan tıklanır. Klavyenin kendisi (Türkçe Q) ve fare düğmeleri
// aynı yerde: sol/sağ tık, tekerlek de buradan seçilir (tanıma sırasında fare tıkı panelin kendisine denk geldiğinde karışmasın diye).
// Atanamayan tuşlar (Ctrl, Esc, Meta) burada yok. Değer adları KeyboardEvent.key ile aynıdır (model.keyFromEvent) — tanıyarak atananla bire bir.
import React from 'react';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { keyCapLabel, keyFullName } from '../keycaps.js';

const ROWS = [
  ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'],
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'ı', 'o', 'p', 'ğ', 'ü'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ş', 'i'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', 'ö', 'ç'],
];
const SPECIAL = ['Shift', 'Alt', 'Tab', 'Space', 'Enter', 'Backspace'];
const ARROWS = ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'];
const POINTER = ['MouseLeft', 'MouseRight', 'MouseMiddle', 'MouseBack', 'MouseForward', 'WheelUp', 'WheelDown'];

function Cap({ name, value, onPick, wide = false }) {
  const selected = value === name;
  return (
    <button
      type="button"
      data-key={name}
      aria-pressed={selected}
      aria-label={keyFullName(name)}
      onClick={() => onPick(name)}
      className={cn(
        'grid h-6 shrink-0 place-items-center rounded-md border font-mono text-[10px] font-bold leading-none transition-colors cursor-pointer',
        wide ? 'px-1.5 text-[9px]' : 'w-[17px]',
        name.length > 2 && !wide && 'text-[8.5px]',
        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border/70 bg-muted/60 text-foreground hover:border-primary/60 hover:bg-accent',
      )}
    >
      {keyCapLabel(name)}
    </button>
  );
}

export default function KeyPicker({ value, onPick, allowPointer = true }) {
  return (
    <div data-testid="key-picker" role="group" aria-label={t('keymapper.ekran_klavyesi')} className="space-y-1 rounded-xl border border-border/70 bg-muted/40 p-1.5">
      {ROWS.map((row) => (
        <div key={row[0]} className="flex justify-center gap-0.5">
          {row.map((name) => <Cap key={name} name={name} value={value} onPick={onPick} />)}
        </div>
      ))}
      <div className="flex flex-wrap justify-center gap-0.5">
        {SPECIAL.map((name) => <Cap key={name} name={name} value={value} onPick={onPick} wide />)}
      </div>
      <div className="flex justify-center gap-0.5">
        {ARROWS.map((name) => <Cap key={name} name={name} value={value} onPick={onPick} wide />)}
      </div>
      {allowPointer && (
        <div className="space-y-1 border-t border-border/60 pt-1">
          <p className="px-0.5 text-[9.5px] font-bold uppercase tracking-wide text-muted-foreground">{t('keymapper.sk_fare')}</p>
          <div className="grid grid-cols-2 gap-1">
            {POINTER.map((name) => {
              const selected = value === name;
              return (
                <button
                  key={name}
                  type="button"
                  data-key={name}
                  aria-pressed={selected}
                  onClick={() => onPick(name)}
                  className={cn(
                    'h-7 truncate rounded-md border px-1.5 text-[10px] font-semibold transition-colors cursor-pointer',
                    selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border/70 bg-muted/60 text-foreground hover:border-primary/60 hover:bg-accent',
                  )}
                >
                  {keyFullName(name)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
