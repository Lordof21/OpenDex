// DeX Ayarları › Çözünürlük Stratejisi › "Özel boyut": the user names a fixed stream size (width × height) once, it becomes a button;
// pressing the button applies that size to the window at once (a `custom_<w>x<h>` resolution mode, see windowMath.customModeOf).
import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { ChoiceChip } from '../ui/Choice.jsx';
import { cn } from '../lib/utils.js';
import { t as tt } from '../i18n/index.js';
import { useSystemStore } from '../state/systemStore.js';
import {
  CUSTOM_RESOLUTION_MAX, CUSTOM_RESOLUTION_MIN, customModeOf, customResolutionOf, customSizeIssue,
} from '../window/windowMath.js';
import {
  addCustomResolution,
  customResolutionLabel,
  loadCustomResolutions,
  removeCustomResolution,
} from '../window/customResolutions.js';

const INPUT = 'h-7 w-[58px] rounded-[6px] border border-border/70 bg-background px-1.5 text-center text-[10px] font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** `active`: the window's current resolution mode; `onPick(mode)` applies a mode to the window. */
export function CustomResolutionRow({ active, onPick }) {
  const [presets, setPresets] = useState(loadCustomResolutions);
  const [w, setW] = useState('');
  const [h, setH] = useState('');
  const mode = customModeOf(w, h);
  // The phone pixel ceiling (backend display_limits, served with the device profile): a size over it is scaled down by the
  // backend. The user is told here BEFORE pressing the button, and again when it happens (geometrySlice.commitResize).
  const limit = useSystemStore((s) => s.deviceProfile?.max_display_pixels) || 0;
  const size = mode ? customResolutionOf(mode) : null;
  const overLimit = Boolean(size && limit > 0 && size.w * size.h > limit);
  const rangeIssue = customSizeIssue(w, h) === 'range';

  const submit = (event) => {
    event.preventDefault();
    if (!mode) return;
    setPresets(addCustomResolution(mode));
    onPick(mode);
    setW('');
    setH('');
  };

  return (
    <div className="mt-2 border-t border-border/60 pt-2" data-window-setting="custom_resolution">
      <p className="pb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{tt('taskbar.ozel_boyut')}</p>
      {presets.length > 0 && (
        <div className="mb-1.5 grid grid-cols-3 gap-1">
          {presets.map((preset) => {
            const label = customResolutionLabel(preset);
            return (
              <div key={preset} className="group relative">
                <ChoiceChip dense className="w-full" label={label} active={active === preset} onClick={() => onPick(preset)} />
                <button
                  type="button"
                  onClick={() => setPresets(removeCustomResolution(preset))}
                  aria-label={tt('taskbar.ozel_boyut_kaldir', { size: label })}
                  className={cn(
                    'absolute -right-1 -top-1 grid size-3.5 place-items-center rounded-full bg-background text-muted-foreground opacity-0 ring-1 ring-border transition-opacity',
                    'hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 cursor-pointer',
                  )}
                >
                  <X className="size-2.5" strokeWidth={2.4} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <form onSubmit={submit} className="flex items-center gap-1">
        <input
          type="number" inputMode="numeric" min={CUSTOM_RESOLUTION_MIN} max={CUSTOM_RESOLUTION_MAX} step="2"
          value={w} onChange={(e) => setW(e.target.value)} placeholder="600" aria-label="W" className={INPUT}
        />
        <span className="text-[10px] text-muted-foreground" aria-hidden="true">×</span>
        <input
          type="number" inputMode="numeric" min={CUSTOM_RESOLUTION_MIN} max={CUSTOM_RESOLUTION_MAX} step="2"
          value={h} onChange={(e) => setH(e.target.value)} placeholder="700" aria-label="H" className={INPUT}
        />
        <button
          type="submit"
          disabled={!mode}
          className="ml-auto flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-[6px] border border-border/70 bg-background px-2 text-[10px] font-medium transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background"
        >
          <Plus className="size-3 shrink-0" strokeWidth={2.2} aria-hidden="true" />
          <span className="truncate">{tt('taskbar.ozel_boyut_ekle')}</span>
        </button>
      </form>
      {rangeIssue && (
        <p role="alert" className="mt-1 text-[9px] leading-[12px] text-destructive">
          {tt('taskbar.ozel_boyut_aralik', { min: CUSTOM_RESOLUTION_MIN, max: CUSTOM_RESOLUTION_MAX })}
        </p>
      )}
      {overLimit && (
        <p role="status" className="mt-1 text-[9px] leading-[12px] text-warning">
          {tt('taskbar.ozel_boyut_sinir', { limit: (limit / 1e6).toFixed(1), size: `${size.w}×${size.h}` })}
        </p>
      )}
    </div>
  );
}
