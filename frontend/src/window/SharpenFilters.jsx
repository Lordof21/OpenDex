// Görüntü keskinleştirme çekirdekleri (Adaptive & Ultra): VideoCanvas `filter: url(#dex-sharpen-…)` ile bunlara BAŞVURUR. Bir `url(#id)`
// yalnız KENDİ belge içindeki tanımı bulur — Tauri PiP ana pencereden ayrı bir webview (ayrı belge) olduğu için tanım orada da bulunmalı;
// yoksa filtre sessizce yok sayılır ve PiP'te keskinleştirme hiç uygulanmaz. Ana pencere (App.jsx) ve PiP (PipApp.jsx) aynı bileşeni basar.

import React from 'react';

export default function SharpenFilters() {
  return (
    <svg className="pointer-events-none absolute size-0 opacity-0" aria-hidden="true">
      <defs>
        <filter id="dex-sharpen-adaptive" x="0%" y="0%" width="100%" height="100%">
          <feConvolveMatrix
            order="3"
            preserveAlpha="true"
            kernelMatrix="
                 0   -0.18   0
               -0.18  1.72 -0.18
                 0   -0.18   0"
          />
        </filter>
        <filter id="dex-sharpen-ultra" x="0%" y="0%" width="100%" height="100%">
          <feConvolveMatrix
            order="3"
            preserveAlpha="true"
            kernelMatrix="
               -0.15 -0.35 -0.15
               -0.35  3.00 -0.35
               -0.15 -0.35 -0.15"
          />
        </filter>
      </defs>
    </svg>
  );
}
