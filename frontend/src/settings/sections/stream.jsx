// Yayın (kodlayıcı, kare hızı, bit hızı, canlı pencere sınırı) ve Ses (yönlendirme, ince ayar, ses kodlayıcı).

import React from 'react';
import { Activity, AudioLines, Blocks, Cpu, Radio, Speaker, Volume2 } from 'lucide-react';
import SyncFineTune from '../../taskbar/SyncFineTune.jsx';
import { ROUTE_OPTIONS } from '../../ui/audioRouting.jsx';
import { ChoiceGroup, Page, useSettingsUi } from '../controls.jsx';
import { cn } from '../../lib/utils.js';
import {
  AUDIO_CODEC_OPTIONS,
  AUDIO_ROUTE_TEXT,
  BITRATE_OPTIONS,
  CODEC_OPTIONS,
  FPS_OPTIONS,
  SECTIONS,
  WINDOW_LIMIT_OPTIONS,
} from '../settingsModel.js';

// Ses rotası listesi, uygulamanın her yerinde kullanılan tek sözlükten (ui/audioRouting) kurulur.
const AUDIO_ROUTE_OPTIONS = ROUTE_OPTIONS.map(({ value, label }) => ({ value, label, ...AUDIO_ROUTE_TEXT[value] }));
const AUDIO_ROUTE_ICONS = Object.fromEntries(ROUTE_OPTIONS.map(({ value, icon }) => [value, icon]));

export function StreamSection({ ctl }) {
  const { values: v, actions: a } = ctl;
  return (
    <Page icon={Radio} title={SECTIONS.stream.label} subtitle={SECTIONS.stream.subtitle}>
      <ChoiceGroup item="codec" icon={Cpu} options={CODEC_OPTIONS} value={v.codec} onChange={a.setCodec} columns={2} />
      <ChoiceGroup item="fps" icon={Activity} options={FPS_OPTIONS} value={v.fps} onChange={a.setFps} columns={3} readout={`${v.fps} FPS`} />
      <ChoiceGroup item="bitrate" icon={AudioLines} options={BITRATE_OPTIONS} value={v.bitrate} onChange={a.setBitrate} columns={3} readout={`${v.bitrate} Mbps`} />
      <ChoiceGroup item="windowLimit" icon={Blocks} options={WINDOW_LIMIT_OPTIONS} value={v.windowLimit} onChange={a.setWindowLimit} columns={3} />
    </Page>
  );
}

export function AudioSection({ ctl }) {
  const { values: v, actions: a } = ctl;
  const { flashId } = useSettingsUi();
  return (
    <Page icon={Speaker} title={SECTIONS.audio.label} subtitle={SECTIONS.audio.subtitle}>
      <ChoiceGroup
        item="audioRoute"
        icon={Volume2}
        options={AUDIO_ROUTE_OPTIONS}
        optionIcons={AUDIO_ROUTE_ICONS}
        value={v.audioRoute}
        onChange={a.setAudioRoute}
        columns={3}
      />
      <div
        data-setting-id="audioSync"
        className={cn('overflow-hidden rounded-xl border border-border/70 bg-muted/30 transition-colors', flashId === 'audioSync' && 'settings-flash')}
      >
        <SyncFineTune className="px-3.5 py-3" />
      </div>
      <ChoiceGroup item="audioCodec" icon={AudioLines} options={AUDIO_CODEC_OPTIONS} value={v.audioCodec} onChange={a.setAudioCodec} columns={2} />
    </Page>
  );
}
