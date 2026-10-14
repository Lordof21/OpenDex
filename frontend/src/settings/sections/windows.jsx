// Pencereler & Geçiş (pencere davranışı, telefon ⟷ PC aktarımı, uyumluluk), Görünüm (tema, arka plan), Güç & Cihaz.

import React from 'react';
import {
  AppWindow,
  BatteryCharging,
  Blocks,
  GripHorizontal,
  Layers,
  Lock,
  Maximize2,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Sun,
  Zap,
} from 'lucide-react';
import { Callout, ChoiceGroup, Group, Page, ToggleRow } from '../controls.jsx';
import {
  APP_CLOSED_OPTIONS,
  HANDOFF_OPTIONS,
  SECTIONS,
  THEME_OPTIONS,
  WINDOWING_MODE_OPTIONS,
} from '../settingsModel.js';
import { t } from '../../i18n/index.js';

const WINDOWING_ICONS = { eco: Zap, independent: Monitor, hybrid: Sparkles };
const HANDOFF_ICONS = { fullscreen: Maximize2, freeform: AppWindow };
const THEME_ICONS = { light: Sun, dark: Moon };

export function WindowsSection({ ctl }) {
  const { values: v, actions: a } = ctl;
  return (
    <Page icon={AppWindow} title={SECTIONS.windows.label} subtitle={SECTIONS.windows.subtitle}>
      <ChoiceGroup
        item="windowingMode"
        icon={Layers}
        options={WINDOWING_MODE_OPTIONS}
        optionIcons={WINDOWING_ICONS}
        value={v.windowingMode}
        onChange={a.setWindowingMode}
        columns={3}
        detail={t('settings.bu_yalnizca_yeni_bir_pencere_nerede')}
      />

      <Group title={t('settings.pencere_davranisi')}>
        <ToggleRow item="headerHover" icon={GripHorizontal} checked={v.headerHover} onToggle={() => a.toggle('header_hover_mode', v.headerHover)} />
        <ToggleRow item="dpLock" icon={Lock} checked={v.dpLock} onToggle={() => a.toggle('dp_lock_enabled', v.dpLock)} />
      </Group>

      <div className="space-y-3">
        <ChoiceGroup
          item="handoffWindowing"
          icon={Smartphone}
          options={HANDOFF_OPTIONS}
          optionIcons={HANDOFF_ICONS}
          value={v.handoffWindowing}
          onChange={a.setHandoffWindowing}
          columns={2}
        >
          <p className="mt-2 text-[11px] leading-[15px] text-muted-foreground">
            {t('settings.bu_secim_yalniz_telefona_aktar')}
          </p>
        </ChoiceGroup>
        <ChoiceGroup item="appClosed" icon={Blocks} options={APP_CLOSED_OPTIONS} value={v.appClosed} onChange={a.setAppClosed} columns={2} />
      </div>

      <div className="space-y-3">
        <Callout tone="tip" title={t('settings.gecis_uyumlulugu_ileri_duzey')}>
          {t('settings.telefon_pc_gecisinde_uygulamalarin')}
        </Callout>
        <Group>
          <ToggleRow
            item="stealth"
            icon={ShieldCheck}
            checked={v.stealth}
            onToggle={() => a.toggle('stealth_dpi_enabled', v.stealth)}
            detail={t('settings.telefonda_zaten_calisan_bir_uygulama')}
          />
          <ToggleRow
            item="handoffPrelanding"
            icon={Smartphone}
            checked={v.handoffPrelanding}
            onToggle={() => a.toggle('handoff_prelanding', v.handoffPrelanding)}
            detail={t('settings.telefona_aktar_denince_sanal_ekran_pc')}
          />
          <ToggleRow
            item="densityRefresh"
            icon={RefreshCw}
            checked={v.densityRefresh}
            onToggle={() => a.toggle('density_refresh_enabled', v.densityRefresh)}
            detail={t('settings.bir_uygulama_dpi_degisimini_yasadiysa')}
          />
          <ToggleRow
            item="densityRefreshHard"
            icon={RefreshCw}
            badge={t('settings.ileri')}
            checked={v.densityRefreshHard}
            onToggle={() => a.toggle('density_refresh_hard', v.densityRefreshHard)}
            disabled={!v.densityRefresh}
            detail={t('settings.yalnizca_nazik_yenileme_yetmiyorsa')}
          />
        </Group>
      </div>
    </Page>
  );
}

export function AppearanceSection({ ctl }) {
  const { values: v, actions: a } = ctl;
  return (
    <Page icon={Palette} title={SECTIONS.appearance.label} subtitle={SECTIONS.appearance.subtitle}>
      <ChoiceGroup item="theme" icon={Palette} options={THEME_OPTIONS} optionIcons={THEME_ICONS} value={v.theme} onChange={a.setTheme} columns={2} />
      <Group>
        <ToggleRow item="ambient" icon={Sparkles} checked={v.ambient} onToggle={() => a.toggle('ambient_backdrop', v.ambient)} />
      </Group>
    </Page>
  );
}

export function PowerSection({ ctl }) {
  const { values: v, actions: a } = ctl;
  return (
    <Page icon={BatteryCharging} title={SECTIONS.power.label} subtitle={SECTIONS.power.subtitle}>
      <Group title={t('settings.pil_isi')}>
        <ToggleRow item="dimPhone" icon={Monitor} checked={v.dimPhone} onToggle={() => a.toggle('screen_off_while_mirroring', v.dimPhone)} />
      </Group>
      <Group title={t('settings.cihaz_hafizasi')}>
        <ToggleRow
          item="rememberDevices"
          icon={ShieldCheck}
          checked={v.rememberDevices}
          onToggle={() => a.toggle('remember_devices', v.rememberDevices)}
          detail={t('settings.kapatirsaniz_yeni_eslesen_cihazlar')}
        />
      </Group>
    </Page>
  );
}
