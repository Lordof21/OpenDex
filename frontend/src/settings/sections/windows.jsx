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
        detail="Bu yalnızca «yeni bir pencere nerede doğsun» varsayılanıdır; her pencerenin başlığından elle değiştirilebilir (özel ayar genel ayardan baskındır)."
      />

      <Group title="Pencere davranışı">
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
            Bu seçim yalnız «Telefona aktar» düğmesinin varsayılanıdır. Tek seferlik değiştirmek için pencere başlığına sağ tıklayın;
            telefonda kendi açtığınız uygulamalar her zaman tam ekran açılır.
          </p>
        </ChoiceGroup>
        <ChoiceGroup item="appClosed" icon={Blocks} options={APP_CLOSED_OPTIONS} value={v.appClosed} onChange={a.setAppClosed} columns={2} />
      </div>

      <div className="space-y-3">
        <Callout tone="tip" title="Geçiş uyumluluğu (ileri düzey)">
          Telefon ⟷ PC geçişinde uygulamaların arayüzünü yeni yoğunlukta doğru kurmasını sağlar. Varsayılanlar çoğu cihaz için
          doğrudur; yalnızca belirli bir uygulamada geçiş sorunu görürseniz değiştirin.
        </Callout>
        <Group>
          <ToggleRow
            item="stealth"
            icon={ShieldCheck}
            checked={v.stealth}
            onToggle={() => a.toggle('stealth_dpi_enabled', v.stealth)}
            detail="Telefonda zaten çalışan bir uygulama DeX'te açılırken sanal ekran önce telefonun DPI'ında doğar, uygulama yerleşince pencerenin DPI'ına geçer (geçiş kaplamanın arkasında olur). Telefon ↔ PC aktarımı bu ayardan bağımsızdır: orada DPI tek adımda değişir."
          />
          <ToggleRow
            item="handoffPrelanding"
            icon={Smartphone}
            checked={v.handoffPrelanding}
            onToggle={() => a.toggle('handoff_prelanding', v.handoffPrelanding)}
            detail="«Telefona aktar» denince sanal ekran, PC penceresinin perdesi arkasında telefonun kendi çözünürlüğüne ve yoğunluğuna tek adımda çekilir; uygulama orada yeni boyutta yeniden kurulur, görev ancak ondan sonra telefona taşınır. DeX boyutlu bir pencereden bile telefonda yanlış yerleşimli bir arayüz görünmez; kendini uyarlamayan uygulamalarda aktarım birkaç saniye uzar. Kapalıysa taşıma boyut ve DPI'ı tek adımda değiştirir."
          />
          <ToggleRow
            item="densityRefresh"
            icon={RefreshCw}
            checked={v.densityRefresh}
            onToggle={() => a.toggle('density_refresh_enabled', v.densityRefresh)}
            detail="Bir uygulama DPI değişimini yaşadıysa (telefondan pencereye taşıma, canlı DPI, telefona dönüş) arayüzünü yeni yoğunlukta yeniden kurmaya zorlar (YouTube gibi arayüzünü eski yoğunlukta tutan uygulamalar için). Uygulama kapanmaz: etkinlikler aynı süreçte, durumları korunarak yeniden kurulur. Kapatılırsa hiçbir şey yenilenmez."
          />
          <ToggleRow
            item="densityRefreshHard"
            icon={RefreshCw}
            badge="İleri"
            checked={v.densityRefreshHard}
            onToggle={() => a.toggle('density_refresh_hard', v.densityRefreshHard)}
            disabled={!v.densityRefresh}
            detail="Yalnızca nazik yenileme yetmiyorsa açın: uygulamanın süreci Android'in durum koruyan yoluyla yeniden başlatılır. Arka plan servisleri (ör. çalan müzik) kesilir."
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
      <Group title="Pil & ısı">
        <ToggleRow item="dimPhone" icon={Monitor} checked={v.dimPhone} onToggle={() => a.toggle('screen_off_while_mirroring', v.dimPhone)} />
      </Group>
      <Group title="Cihaz hafızası">
        <ToggleRow
          item="rememberDevices"
          icon={ShieldCheck}
          checked={v.rememberDevices}
          onToggle={() => a.toggle('remember_devices', v.rememberDevices)}
          detail="Kapatırsanız yeni eşleşen cihazlar hatırlanmaz — paylaşılan bilgisayarlar için önerilir. Bağlanma her zaman elle tıklamayla olur; bu ayar yalnızca hatırlamayı etkiler, telefondaki Kablosuz Hata Ayıklama güvenini silmez."
        />
      </Group>
    </Page>
  );
}
