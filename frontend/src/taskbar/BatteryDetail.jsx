// Pil sayfası (QuickSettings view 'battery'): pilin NE olduğu (sağlık, kapasite, döngü), NE yaptığı (kim şarj ediyor, ne hızla,
// ne zamana dek) ve nasıl hissettirdiği (sıcaklık, koruma). Veri daemon'dan (battery_health) gelir; backend hesaplar
// (device/battery_health.py), burası yalnızca gösterir — ölçülemeyen değer "—" olur, uydurulmaz.

import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  Activity, BatteryCharging, BatteryMedium, Calendar, Cpu, HeartPulse, Info, Plug, RefreshCw, ShieldCheck, Thermometer, TriangleAlert, Zap,
} from 'lucide-react';
import { cn } from '../lib/utils.js';
import { useSystemStore } from '../state/systemStore.js';
import { batteryTemperatureC } from '../state/deviceThermal.js';
import {
  HEALTH_TITLE, MISSING, capacityText, chargeSourceText, diagnosisText, etaText, formatDate, formatMah, healthText,
  powerText, protectionText, sessionText, statusLabel, temperatureText,
} from '../state/batteryView.js';
import { t } from '../i18n/index.js';

const POLL_MS = 5000;

function Row({ icon: Icon, label, value, tone, title }) {
  return (
    <div className="flex items-center gap-3 border-b border-border/50 py-2 last:border-b-0" title={title}>
      <span className={cn('grid size-7 shrink-0 place-items-center rounded-full bg-background/85 shadow-sm', tone)}>
        <Icon className="size-3.5" />
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="ml-auto min-w-0 break-words text-right font-mono text-[11px] font-bold tabular-nums text-foreground" title={String(value)}>{value}</span>
    </div>
  );
}

function Notice({ tone, children }) {
  const warn = tone === 'warn';
  const Icon = warn ? TriangleAlert : Info;
  return (
    <p
      role={warn ? 'alert' : 'status'}
      className={cn(
        'mt-2 flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[10px] leading-snug',
        warn ? 'border-warning/40 bg-warning/10 text-foreground' : 'border-border/60 bg-muted/40 text-muted-foreground',
      )}
    >
      <Icon className={cn('mt-px size-3.5 shrink-0', warn ? 'text-warning' : 'text-muted-foreground')} />
      <span>{children}</span>
    </p>
  );
}

export default function BatteryDetail() {
  const info = useSystemStore((s) => s.batteryInfo);
  const report = useSystemStore((s) => s.batteryHealth);
  const fetchHealth = useSystemStore((s) => s.fetchBatteryHealth);

  useEffect(() => {
    fetchHealth?.();
    const id = setInterval(() => fetchHealth?.(), POLL_MS);
    return () => clearInterval(id);
  }, [fetchHealth]);

  // The 5-second push is already here while the full report is on its way (or when the phone helper is too old for it).
  const level = report?.level ?? info?.level ?? null;
  const status = report?.status ?? (info ? (info.is_charging ? 'charging' : 'discharging') : 'unknown');
  const charging = report?.charging;
  const thermal = report?.thermal;
  const batteryC = thermal?.battery_c ?? batteryTemperatureC(info);
  const voltage = report?.voltage_v ?? (info?.voltage_mv ? info.voltage_mv / 1000 : null);
  const eta = etaText(charging?.eta);
  const protection = protectionText(report?.protection);
  const session = sessionText(report?.session);
  const diagnoses = (report?.diagnoses || []).map((code) => ({ code, ...diagnosisText(code, report) })).filter((d) => d.text);
  const capacity = report?.capacity;

  return (
    <div className="dex-scroll min-h-0 flex-1 overflow-y-auto pb-1" data-testid="battery-detail">
      <div className="mt-2 rounded-lg border border-border/70 bg-muted/50 p-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-full bg-status-active/15 text-status-active">
            {status === 'charging' ? <BatteryCharging className="size-[18px]" /> : <BatteryMedium className="size-[18px]" />}
          </span>
          <span className="font-mono text-[26px] font-semibold leading-none tabular-nums">{level != null ? `%${level}` : MISSING}</span>
          <span className="ml-auto rounded-full bg-status-active/15 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-status-active">
            {statusLabel(status)}
          </span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-background/80">
          <motion.div
            className="h-full rounded-full bg-status-active"
            initial={{ width: 0 }}
            animate={{ width: `${level ?? 0}%` }}
            transition={{ type: 'spring', stiffness: 240, damping: 32 }}
          />
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-2 text-[9px] text-muted-foreground">
          <span data-testid="battery-capacity">
            {Number.isFinite(capacity?.now_mah) ? `${formatMah(capacity.now_mah)}${Number.isFinite(capacity?.full_mah) ? ` / ${formatMah(capacity.full_mah)}` : ''} mAh` : MISSING}
          </span>
          {eta && <span data-testid="battery-eta" className="text-right">{eta}</span>}
        </div>
      </div>

      {diagnoses.map((d) => (
        <Notice key={d.code} tone={d.tone}>{d.text}</Notice>
      ))}

      <div className="mt-2 overflow-hidden rounded-lg border border-border/70 bg-muted/40 px-3">
        <Row icon={Plug} label={t('taskbar.sarj_kaynagi')} value={chargeSourceText(charging)} tone="text-status-active" />
        <Row icon={Activity} label={charging?.direction === 'out' ? t('taskbar.anlik_tuketim') : t('taskbar.sarj_gucu')} value={powerText(charging)} tone="text-window-expand" />
        <Row icon={Zap} label={t('taskbar.voltaj')} value={voltage ? `${voltage.toFixed(2)} V` : MISSING} tone="text-primary" />
        <Row
          icon={Thermometer}
          label={t('taskbar.pil_sicakligi')}
          value={temperatureText(batteryC, thermal?.battery_state, { battery: true })}
          tone="text-window-close"
        />
        {Number.isFinite(thermal?.soc_c) && (
          <Row icon={Cpu} label={t('taskbar.islemci_soc')} value={temperatureText(thermal.soc_c, thermal.soc_state)} tone="text-muted-foreground" />
        )}
        {protection && <Row icon={ShieldCheck} label={t('taskbar.pil_korumasi')} value={protection} tone="text-status-active" title={t('taskbar.telefonun_ayari_sinirin_su_an')} />}
        {session && <Row icon={RefreshCw} label={t('taskbar.bu_oturumda')} value={session} tone="text-primary" title={t('taskbar.opendex_baglandigindan_beri_pilin')} />}
      </div>

      <div className="mt-2 overflow-hidden rounded-lg border border-border/70 bg-muted/40 px-3">
        <Row
          icon={HeartPulse}
          label={t('taskbar.pil_sagligi')}
          value={healthText(report?.health)}
          tone="text-status-active"
          title={report?.health ? HEALTH_TITLE[report.health.source] : t('taskbar.bu_telefon_pil_sagligini_bildirmiyor')}
        />
        <Row icon={Cpu} label={t('taskbar.kapasite')} value={capacityText(capacity)} tone="text-muted-foreground" />
        {report?.cycles != null && <Row icon={RefreshCw} label={t('taskbar.sarj_dongusu')} value={`${report.cycles}`} tone="text-muted-foreground" />}
        {report?.first_use && (
          <Row
            icon={Calendar}
            label={t('taskbar.ilk_kullanim')}
            value={t('taskbar.formatdate_age_days_gun', { formatDate: formatDate(report.first_use.at_ms), age_days: report.first_use.age_days })}
            tone="text-muted-foreground"
          />
        )}
        {report?.technology && <Row icon={Cpu} label={t('taskbar.pil_kimyasi')} value={report.technology} tone="text-muted-foreground" />}
      </div>

      {report?.limited && (
        <Notice tone="info">
          {t('taskbar.telefon_yardimcisi_guncel_degil')}{' '} <code>{t('taskbar.py_backend_java_build_py')}</code> {' '}{t('taskbar.ile_yenileyip_opendex_i_yeniden')}
        </Notice>
      )}
      {report && report.ok === false && <Notice tone="info">{t('taskbar.pil_ayrintilari_su_an_okunamiyor')}</Notice>}
    </div>
  );
}
