// Yerleşim menüsü: Windows 11'in "yerleşim düzenleri" menüsündeki gibi 3 × 2 düzen (yarılar, 3/5 + yığın, üçte birler, çeyrekler…) ve altta
// tam ekran. Hem DeX içi pencerelerde (uygulama içi kenara yapıştırma: store.applySnapZone) hem PiP / Workspace PiP işletim sistemi
// pencerelerinde (ekranın bölgesine oturtma: usePipOsWindow.snap) AYNI menü açılır; bölgelerin kutuları windowModel.OS_SNAP_ZONES'tadır.

import React from 'react';
import { motion } from 'framer-motion';
import { t } from '../../i18n/index.js';
import { rovingKeys } from '../../ui/rovingKeys.js';
import { OS_SNAP_ZONES } from '../windowModel.js';

const LAYOUTS = [
  ['left', 'right'],
  ['main', 'stack-t', 'stack-b'],
  ['l13', 'r23'],
  ['l23', 'r13'],
  ['left', 'tr', 'br'],
  ['tl', 'tr', 'bl', 'br'],
];

const pct = (v) => `${(v * 100).toFixed(3)}%`;

export default function SnapLayoutMenu({ current, onPick }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.97 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      className="absolute right-0 top-full z-[100] w-[240px] pt-1.5 select-none"
      role="menu"
      aria-label={t('window.yerlesim_duzenleri')}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => rovingKeys(e, '[role="menuitem"]', { orientation: 'both' })}
    >
      <div className="rounded-lg border border-border bg-popover/95 p-2.5 shadow-window backdrop-blur-2xl">
        <div className="grid grid-cols-2 gap-2">
          {LAYOUTS.map((zones, index) => (
            <div key={index} className="relative h-[52px] rounded-md bg-muted/60" role="group">
              {zones.map((zone) => {
                const [x, y, w, h] = OS_SNAP_ZONES[zone];
                return (
                  <div key={zone} className="absolute p-[2px]" style={{ left: pct(x), top: pct(y), width: pct(w), height: pct(h) }}>
                    <button
                      type="button"
                      role="menuitem"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPick(zone);
                      }}
                      aria-label={t('window.zone_konumuna_yerlestir', { zone })}
                      className={`size-full rounded-[3px] border border-border/60 bg-background/80 transition-colors hover:border-primary hover:bg-primary/70 ${
                        current === zone ? 'border-primary bg-primary/40' : ''
                      } cursor-pointer`}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <button
          type="button"
          role="menuitem"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onPick('max');
          }}
          aria-label={t('window.ekrani_kapla')}
          className={`mt-2 h-[22px] w-full rounded-[3px] border border-border/60 bg-background/80 text-[10px] text-muted-foreground transition-colors hover:border-primary hover:bg-primary/70 hover:text-primary-foreground ${
            current === 'max' ? 'border-primary bg-primary/40' : ''
          } cursor-pointer`}
        >
          {t('window.ekrani_kapla')}
        </button>
      </div>
    </motion.div>
  );
}
