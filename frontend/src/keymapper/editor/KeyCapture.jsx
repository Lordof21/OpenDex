// Tuş ataması iki yoldan: "Tuş tanı" (o tuşa / fare düğmesine / tekerleğe basılır) ya da yanındaki klavye simgesinden EKRAN KLAVYESİ
// (KeyPicker: harfler, özel tuşlar, sol/sağ tık, tekerlek — istenen doğrudan tıklanır). Tanıma sırasında fare düğmesi panelin dışında bir
// yere basılınca tanınır; "Tuş tanı" düğmesi (ve klavye simgesi) vazgeçirir.
//   · klavye: her tuş (Ctrl, Esc, Meta hariç — bunlar sistemindir; Ctrl fareyi bırakır)
//   · fare: sol/sağ/orta/geri/ileri düğmeler; tekerlek yukarı/aşağı
//   · Esc ya da düğmeye tekrar basmak vazgeçirir (Esc yığın üzerinden gider: düzenleyiciyi KAPATMAZ, yalnız dinlemeyi bırakır)
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Radio, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { pushEscapeHandler } from '../../lib/escapeStack.js';
import { t } from '../../i18n/index.js';
import { MOUSE_KEYS, keyFromEvent } from '../model.js';
import { keyCapLabel, keyFullName } from '../keycaps.js';
import { tip } from './tip.js';
import KeyPicker from './KeyPicker.jsx';

// Atama dinlenirken düzenleyicinin kısayolları (ok = kaydır, Del = sil …) kapalıdır: bağlanmak istenen tuş kısayola yenilmesin.
let capturing = 0;
export const isCapturingKey = () => capturing > 0;

const MOUSE_NAME_BY_BUTTON = Object.fromEntries(Object.entries(MOUSE_KEYS).map(([name, button]) => [button, name]));

export default function KeyCapture({ value, onChange, allowPointer = true, clearable = false, label, autoStart = false, onAutoStarted }) {
  const [listening, setListening] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const cancelledByPress = useRef(false); // pointerdown vazgeçirdi: ardından gelen click dinlemeyi yeniden AÇMASIN
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const finish = useCallback((key) => {
    setListening(false);
    setRejected(false);
    if (key) onChangeRef.current?.(key);
  }, []);

  // Yeni eklenen tuş: hemen dinlemeye başlar ("+ Tuş" → bas → bitti).
  useEffect(() => {
    if (!autoStart) return;
    setListening(true);
    onAutoStarted?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  useEffect(() => {
    if (!listening) return undefined;
    capturing += 1;
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') return; // vazgeçme Esc yığınından gelir
      stop(e);
      if (e.repeat) return;
      const key = keyFromEvent(e);
      if (!key) {
        setRejected(true);
        return;
      }
      finish(key);
    };
    const onPointerDown = (e) => {
      if (e.target?.closest?.('[data-key-capture]')) {
        stop(e);
        cancelledByPress.current = true;
        finish(null); // yakalama düğmesine tekrar basmak vazgeçirir
        return;
      }
      if (!allowPointer) return;
      const name = MOUSE_NAME_BY_BUTTON[e.button];
      if (!name) return;
      stop(e);
      finish(name);
      // Basış tanındı: bırakılınca oluşacak click, altındaki öğeyi (düğme, düğüm, tuval) tetiklemesin.
      const downTarget = e.target;
      const eat = (ev) => {
        if (ev.target !== downTarget) return; // bu basışın click'i değil: dokunma
        window.removeEventListener('click', eat, true);
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', eat, true);
      setTimeout(() => window.removeEventListener('click', eat, true), 1000);
    };
    const onWheel = (e) => {
      if (!allowPointer || !e.deltaY) return;
      stop(e);
      finish(e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
    };
    const swallow = (e) => {
      if (e.button >= 3) e.preventDefault(); // geri/ileri düğmesi sayfa gezintisi yapmasın
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('mouseup', swallow, true);
    window.addEventListener('auxclick', swallow, true);
    const popEscape = pushEscapeHandler(() => finish(null));
    return () => {
      capturing = Math.max(0, capturing - 1);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('mouseup', swallow, true);
      window.removeEventListener('auxclick', swallow, true);
      popEscape();
    };
  }, [listening, allowPointer, finish]);

  const onDetectClick = () => {
    if (cancelledByPress.current) {
      cancelledByPress.current = false;
      return;
    }
    setRejected(false);
    setPickerOpen(false);
    setListening((on) => !on);
  };
  const onToggleKeyboard = () => {
    if (cancelledByPress.current) cancelledByPress.current = false;
    setListening(false);
    setPickerOpen((open) => !open);
  };
  const pick = (key) => {
    setPickerOpen(false);
    onChangeRef.current?.(key);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div
          data-testid="key-value"
          className={cn(
            'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border px-2.5 text-left transition-colors',
            listening ? 'border-primary bg-primary/15 text-primary' : 'border-border/70 bg-muted/60 text-foreground',
          )}
        >
          {listening ? (
            <span role="status" className="truncate text-[11px] font-semibold">
              {rejected ? t('keymapper.bu_tus_atanamaz_baska_bir_tusa_bas') : (allowPointer ? t('keymapper.bir_tusa_bas_fare_dugmesi_ya_da') : t('keymapper.bir_tusa_bas'))}
            </span>
          ) : value ? (
            <>
              <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md border border-primary/60 bg-popover px-1.5 font-mono text-[11px] font-bold text-foreground">{keyCapLabel(value)}</span>
              <span className="truncate text-[11px] text-muted-foreground">{keyFullName(value)}</span>
            </>
          ) : (
            <span className="truncate text-[11px] text-muted-foreground">{t('keymapper.atanmamis')}</span>
          )}
        </div>
        <button
          type="button"
          data-key-capture=""
          aria-label={label}
          aria-pressed={listening}
          {...tip(listening ? t('keymapper.tus_tani_vazgec') : t('keymapper.tus_tani'), 'bottom', 'end')}
          onClick={onDetectClick}
          className={cn(
            'flex h-9 shrink-0 items-center gap-1 rounded-xl border px-2 text-[11px] font-semibold transition-colors cursor-pointer',
            listening ? 'border-primary bg-primary text-primary-foreground' : 'border-border/70 bg-muted/60 text-foreground hover:border-primary/60 hover:bg-accent/60',
          )}
        >
          <Radio className="size-3.5 shrink-0" aria-hidden="true" />
          {listening ? t('keymapper.tus_tani_vazgec') : t('keymapper.tus_tani')}
        </button>
        <button
          type="button"
          data-key-capture=""
          data-testid="key-picker-toggle"
          aria-label={t('keymapper.ekran_klavyesi')}
          aria-pressed={pickerOpen}
          aria-expanded={pickerOpen}
          {...tip(t('keymapper.ekran_klavyesi'), 'bottom', 'end')}
          onClick={onToggleKeyboard}
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-xl border transition-colors cursor-pointer',
            pickerOpen ? 'border-primary bg-primary text-primary-foreground' : 'border-border/70 bg-muted/60 text-foreground hover:border-primary/60 hover:bg-accent/60',
          )}
        >
          <Keyboard className="size-4" aria-hidden="true" />
        </button>
        {clearable && value && !listening && (
          <button
            type="button"
            onClick={() => onChange?.(null)}
            aria-label={t('keymapper.tusu_kaldir')}
            {...tip(t('keymapper.tusu_kaldir'), 'bottom', 'end')}
            className="grid size-9 shrink-0 place-items-center rounded-xl border border-border/70 bg-muted/60 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      {pickerOpen && <KeyPicker value={value} onPick={pick} allowPointer={allowPointer} />}
    </div>
  );
}
