// Genel Bakış: ayarların "ön kapısı". Üç soruya yanıt verir — ne durumdayım (cihaz + özet kutucukları), hızlıca nasıl
// ayarlarım (hazır profiller + hızlı anahtarlar), dikkat etmem gereken bir şey var mı (öneriler).

import React from 'react';
import {
  Activity,
  BatteryCharging,
  CheckCircle2,
  ChevronRight,
  LayoutDashboard,
  Monitor,
  Radio,
  Scale,
  Smartphone,
  Sparkles,
  Speaker,
  AppWindow,
  Wifi,
} from 'lucide-react';
import { useSystemStore } from '../../state/systemStore.js';
import { cn } from '../../lib/utils.js';
import { Callout, Chip, ChoiceGroup, Group, Page, ToggleRow, useSettingsUi } from '../controls.jsx';
import { PROFILES, SECTIONS, activeProfileId, recommendations, sectionSummary } from '../settingsModel.js';
import { t } from '../../i18n/index.js';

const PROFILE_ICONS = { balanced: Scale, clarity: Sparkles, battery: BatteryCharging, lowdata: Wifi };
const TILE_ICONS = { display: Monitor, stream: Radio, audio: Speaker, windows: AppWindow };

const CONNECTION = {
  connected: { label: t('common.bagli'), tone: 'success' },
  reconnecting: { label: t('settings.yeniden_baglaniyor'), tone: 'warning' },
  checking: { label: t('settings.denetleniyor'), tone: 'muted' },
  disconnected: { label: t('settings.baglanti_yok'), tone: 'warning' },
};
const TRANSPORT = { usb: 'USB', wifi: 'Wi‑Fi', tcp: 'Wi‑Fi', network: 'Wi‑Fi' };

function DeviceHero({ profileLabel }) {
  const connectionState = useSystemStore((s) => s.connectionState);
  const deviceLabel = useSystemStore((s) => s.deviceLabel);
  const transport = useSystemStore((s) => s.deviceIdentity?.transport);
  const conn = CONNECTION[connectionState] || CONNECTION.checking;
  const link = TRANSPORT[String(transport || '').toLowerCase()] || null;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-primary/[0.09] via-muted/30 to-transparent p-4">
      <div className="flex items-center gap-3.5">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-xs" aria-hidden="true">
          <Smartphone className="size-6" strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('settings.bagli_cihaz')}</p>
          <p className="truncate text-[16px] font-semibold leading-[22px] text-foreground" data-testid="overview-device">
            {deviceLabel || (connectionState === 'connected' ? t('settings.android_cihaz') : t('common.cihaz_bagli_degil'))}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Chip tone={conn.tone}>
              <span className={cn('size-1.5 rounded-full', conn.tone === 'success' ? 'bg-status-active' : conn.tone === 'warning' ? 'bg-warning' : 'bg-muted-foreground')} />
              {conn.label}
            </Chip>
            {link && <Chip>{link}</Chip>}
            <Chip tone="primary">{t('settings.profil_profilelabel', { profileLabel })}</Chip>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryTiles({ live, go }) {
  const { layout } = useSettingsUi();
  const ids = ['display', 'stream', 'audio', 'windows'];
  return (
    <div className={cn('grid gap-2', layout === 'narrow' ? 'grid-cols-1' : 'grid-cols-2')}>
      {ids.map((id) => {
        const Icon = TILE_ICONS[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() => go(id)}
            className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5 text-left outline-none transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background/80 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true">
              <Icon className="size-4" strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{SECTIONS[id].label}</span>
              <span className="block truncate font-mono text-[11.5px] font-semibold tabular-nums text-foreground">{sectionSummary(id, live)}</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

export function OverviewSection({ ctl, go }) {
  const { live, values: v, actions: a, pushToast } = ctl;
  const profileId = activeProfileId(live);
  const profile = PROFILES.find((p) => p.id === profileId);
  const tips = recommendations(live);

  const applyProfile = (id) => {
    const chosen = PROFILES.find((p) => p.id === id);
    if (!chosen) return;
    a.applyPatch(chosen.patch);
    pushToast?.(t('settings.label_profili_uygulandi', { label: chosen.label }));
  };
  const runTip = (tip) => {
    if (tip.action?.patch) a.applyPatch(tip.action.patch);
    else if (tip.action?.section) go(tip.action.section);
  };

  return (
    <Page icon={LayoutDashboard} title={SECTIONS.overview.label} subtitle={SECTIONS.overview.subtitle}>
      <DeviceHero profileLabel={profile ? profile.label : t('common.ozel')} />

      <ChoiceGroup
        icon={Activity}
        title={t('settings.hazir_profiller')}
        subtitle={t('settings.tek_dokunusla_yayin_kalitesini')}
        options={PROFILES.map((p) => ({ value: p.id, label: p.label, description: p.description, tag: p.tagline }))}
        optionIcons={PROFILE_ICONS}
        value={profileId}
        onChange={applyProfile}
        columns={2}
        readout={profileId === 'custom' ? t('settings.ozel_ayar') : undefined}
      />

      {tips.length > 0 ? (
        <section aria-label={t('settings.oneriler')} className="space-y-2">
          <h3 className="px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('settings.oneriler')}</h3>
          {tips.map((tip) => (
            <Callout
              key={tip.id}
              tone={tip.tone === 'warn' ? 'warn' : 'tip'}
              title={tip.title}
              action={
                tip.action && (
                  <button
                    type="button"
                    onClick={() => runTip(tip)}
                    className="shrink-0 cursor-pointer self-center rounded-md border border-border/70 bg-background px-2.5 py-1 text-[11px] font-semibold text-foreground outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {tip.action.label}
                  </button>
                )
              }
            >
              {tip.body}
            </Callout>
          ))}
        </section>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-3.5 py-2.5 text-[11.5px] text-muted-foreground">
          <CheckCircle2 className="size-4 shrink-0 text-status-active" aria-hidden="true" />
          {t('settings.ayarlariniz_dengeli_gorunuyor_ek_bir')}
        </div>
      )}

      <section aria-label={t('settings.su_anki_ayarlar')} className="space-y-1.5">
        <h3 className="px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('settings.su_an')}</h3>
        <SummaryTiles live={live} go={go} />
      </section>

      <Group title={t('settings.hizli_ayarlar')}>
        <ToggleRow item="realResolution" icon={Sparkles} checked={v.smartResize} onToggle={() => a.toggle('dynamic_resolution_enabled', v.smartResize)} />
        <ToggleRow item="dimPhone" icon={Monitor} checked={v.dimPhone} onToggle={() => a.toggle('screen_off_while_mirroring', v.dimPhone)} />
      </Group>
    </Page>
  );
}
