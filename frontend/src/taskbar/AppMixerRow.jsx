// One app in the mixer's "PC'deki uygulamalar" section: output route, PC-side level + mute,
// live meter. Reads/writes audioMixerStore only.

import React from 'react';
import { Smartphone, Volume2, VolumeX } from 'lucide-react';
import AppIcon from '../ui/AppIcon.jsx';
import { LevelMeter, RouteSelector, audioErrorText } from '../ui/audioRouting.jsx';
import { useAudioMixerStore } from '../state/audioMixerStore.js';
import { MixerRow } from './MixerRow.jsx';

export default function AppMixerRow({ app, label }) {
  const setRoute = useAudioMixerStore((s) => s.setRoute);
  const setVolume = useAudioMixerStore((s) => s.setVolume);
  const toggleMuted = useAudioMixerStore((s) => s.toggleMuted);
  const name = label || app.package;
  const errorText = audioErrorText(app.error);

  let phoneNote = null;
  if (app.on_phone) phoneNote = 'Telefonda (uygulama telefona devredildi)';
  else if (app.route === 'phone') phoneNote = 'Yalnız telefonda çalıyor';

  return (
    <div className="border-b border-border/55 py-2 last:border-b-0" data-testid={`app-mixer-${app.package}`}>
      <div className="flex items-center gap-2">
        <AppIcon pkg={app.package} displayName={name} size={20} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold" title={app.package}>
          {name}
        </span>
        <RouteSelector
          value={app.route}
          onChange={(route) => setRoute(app.package, route)}
          label={`${name} ses çıkışı`}
        />
      </div>
      {phoneNote ? (
        <p className="mt-1.5 flex items-center gap-1.5 pl-7 text-[10px] text-muted-foreground">
          <Smartphone className="size-3" />
          {phoneNote}
        </p>
      ) : (
        <>
          <MixerRow
            icon={app.muted ? VolumeX : Volume2}
            value={Math.round((app.volume ?? 1) * 100)}
            max={100}
            onChange={(v) => setVolume(app.package, v / 100)}
            label={`${name} ses düzeyi`}
            muted={app.muted}
            onToggleMute={() => toggleMuted(app.package)}
            className="border-b-0 py-1.5"
          />
          <LevelMeter windowIds={app.windows} className="ml-12" />
        </>
      )}
      {errorText && (
        <p className="mt-1 pl-7 text-[9.5px] leading-snug text-destructive" title={app.error}>
          {errorText}
        </p>
      )}
    </div>
  );
}
