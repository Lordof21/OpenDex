// Çerçevesiz PiP penceresinin kenar / köşe tutamaçları: işletim sistemi başlık çubuğunu ve kenarlığını kaldırdığımız için pencereyi
// kenarından tutup büyütüp küçültmek bunlarla olur. Basınca işletim sisteminin kendi boyutlandırması başlar (Windows'taki gibi;
// kenara yapıştırma ve imleç biçimi dahil). Pencere büyütülmüş / tam ekranken gösterilmez.

import React from 'react';

const EDGE = 5;   // kenar şeridinin kalınlığı (px)
const CORNER = 12; // köşe tutamacının kenarı (px)

const GRIPS = [
  { direction: 'North', cursor: 'ns-resize', style: { top: 0, left: CORNER, right: CORNER, height: EDGE } },
  { direction: 'South', cursor: 'ns-resize', style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE } },
  { direction: 'West', cursor: 'ew-resize', style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { direction: 'East', cursor: 'ew-resize', style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { direction: 'NorthWest', cursor: 'nwse-resize', style: { top: 0, left: 0, width: CORNER, height: CORNER } },
  { direction: 'NorthEast', cursor: 'nesw-resize', style: { top: 0, right: 0, width: CORNER, height: CORNER } },
  { direction: 'SouthWest', cursor: 'nesw-resize', style: { bottom: 0, left: 0, width: CORNER, height: CORNER } },
  { direction: 'SouthEast', cursor: 'nwse-resize', style: { bottom: 0, right: 0, width: CORNER, height: CORNER } },
];

export default function PipResizeGrips({ onResize, disabled = false }) {
  if (disabled) return null;
  return (
    <>
      {GRIPS.map(({ direction, cursor, style }) => (
        <div
          key={direction}
          data-pip-grip={direction}
          aria-hidden="true"
          className="absolute z-[200]"
          style={{ ...style, cursor, touchAction: 'none' }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            onResize(direction);
          }}
        />
      ))}
    </>
  );
}
