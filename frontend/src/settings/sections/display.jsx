// Görüntü: netlik anahtarları, çözünürlük stratejisi, yoğunluk (DPI / Target DP), ekran sığdırma ve keskinleştirme.
// Sıra "en çok dokunulandan en az dokunulana": anahtarlar → strateji → yoğunluk → sığdırma → keskinlik.

import React from 'react';
import { Blocks, Crop, Gauge, Maximize2, Monitor, MonitorCog, Sparkles, Zap } from 'lucide-react';
import { Callout, ChoiceGroup, Group, Page, PrecisionSlider, SliderField, ToggleRow } from '../controls.jsx';
import {
  DPI_OPTIONS,
  FIT_OPTIONS,
  RESOLUTION_OPTIONS,
  SECTIONS,
  SHARPEN_OPTIONS,
  TARGET_DP_OPTIONS,
} from '../settingsModel.js';

export function DisplaySection({ ctl }) {
  const { values: v, actions: a, liveEffectiveDpi } = ctl;
  const resolutionTag = RESOLUTION_OPTIONS.find((option) => option.value === v.resolution)?.tag;

  return (
    <Page icon={Monitor} title={SECTIONS.display.label} subtitle={SECTIONS.display.subtitle}>
      <Group title="Netlik">
        <ToggleRow
          item="realResolution"
          icon={Sparkles}
          checked={v.smartResize}
          onToggle={() => a.toggle('dynamic_resolution_enabled', v.smartResize)}
          detail="Çözünürlük, pencerenin video alanından (başlık çubuğu ve kenarlıklar çıkarılmış haliyle) piksel‑birebir hesaplanır. İçerik yoğunluğu (DPI) 180‑220 bandında dengelenir; böylece yazılar mikro boyuta düşmez ve tam ekranda çok sütunlu düzen korunur."
        />
        <ToggleRow item="instantResize" icon={Maximize2} checked={v.instantResize} onToggle={() => a.toggle('resize_instant_apply', v.instantResize)} />
        <ToggleRow item="pixelPerfect" icon={Zap} checked={v.subpixel} onToggle={() => a.toggle('pixel_perfect_dpr', v.subpixel)} />
      </Group>

      <ChoiceGroup
        item="resolutionMode"
        icon={MonitorCog}
        options={RESOLUTION_OPTIONS}
        value={v.resolution}
        onChange={a.setResolution}
        columns={2}
        readout={resolutionTag}
        detail="Dinamik‑Fix: stream oranı pencerenin video alanına birebir eşlenir, çözünürlük kodlayıcı uyumlu 8 katına hizalanır; esneme, siyah çubuk ya da ölçek küçültme olmaz."
      />

      <div className="space-y-3">
        <Callout tone="tip" title="Yoğunluk: iki yoldan biri">
          Özel DPI ile Target DP birbirini dışlar: birini seçince diğeri otomatiğe döner. Her pencerenin kendi yoğunluğunu
          DeX hızlı ayar panelinden de değiştirebilirsiniz; burası yeni pencerelerin varsayılanıdır.
        </Callout>

        <ChoiceGroup
          item="customDpi"
          icon={Gauge}
          options={DPI_OPTIONS}
          value={v.dpi}
          onChange={a.setDpi}
          columns={3}
          readout={v.dpi === 'auto' ? `Oto · ${liveEffectiveDpi} DPI` : `${v.dpi} DPI`}
        />
        <SliderField title="Hassas DPI Yoğunluk Ayarı" readout={v.dpi === 'auto' ? `Otomatik (${liveEffectiveDpi} DPI)` : `${v.dpi} DPI`}>
          <PrecisionSlider
            value={v.dpi === 'auto' ? liveEffectiveDpi : Number(v.dpi)}
            min={130}
            max={380}
            step={2}
            auto={v.dpi === 'auto'}
            onCommit={(val) => a.setDpi(String(val))}
            onAuto={() => a.setDpi('auto')}
            label="Özel DPI yoğunluğu"
            unit="DPI"
            ticks={[130, 160, 180, 200, 220, 240, 280, 320, 360]}
          />
        </SliderField>

        <ChoiceGroup
          item="targetDp"
          icon={Blocks}
          options={TARGET_DP_OPTIONS}
          value={v.targetDp}
          onChange={a.setTargetDp}
          columns={3}
          readout={v.targetDp === 'auto' ? 'Otomatik' : `${v.targetDp} dp`}
          detail="Target DP, en küçük kenarın dp karşılığıdır (smallest width): 600 dp tablet, 720 dp masaüstü, 960 dp geniş içerik düzenini açar. Pencere boyutuna göre DPI buna göre türetilir."
        />
        <SliderField title="Hassas Target DP Çalışma Alanı" readout={v.targetDp === 'auto' ? 'Otomatik (720 dp)' : `${v.targetDp} dp`}>
          <PrecisionSlider
            value={v.targetDp === 'auto' ? 720 : Number(v.targetDp)}
            min={350}
            max={1200}
            step={10}
            auto={v.targetDp === 'auto'}
            onCommit={(val) => a.setTargetDp(String(val))}
            onAuto={() => a.setTargetDp('auto')}
            label="Mantıksal alan (target dp)"
            unit="dp"
            ticks={[350, 480, 600, 720, 840, 960, 1080]}
          />
        </SliderField>
      </div>

      <ChoiceGroup
        item="fitMode"
        icon={Crop}
        options={FIT_OPTIONS}
        value={v.fit}
        onChange={a.setFit}
        columns={3}
        detail="Dinamik‑Fix açıkken stream oranı pencereye zaten birebir eşlendiği için üç mod pratikte aynı sonucu verir; fark yalnız sabit çözünürlük stratejilerinde görünür."
      />

      <ChoiceGroup item="sharpen" icon={Sparkles} options={SHARPEN_OPTIONS} value={v.sharpen} onChange={a.setSharpen} columns={3} />
    </Page>
  );
}
