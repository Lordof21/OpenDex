// Gelişmiş & Teşhis (denetleyici, günlük kopyalama, ayrıntılı izleme, encoder kapasite testi, sistem bilgisi) ve Hakkında.

import React, { useState } from 'react';
import { Activity, Check, ChevronRight, Code2, Cpu, Info, Loader2, Stethoscope } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { api } from '../../lib/api.js';
import { logger } from '../../lib/logger.js';
import { copyDiagnosticsReport } from '../../lib/diagnosticsReport.js';
import { cn } from '../../lib/utils.js';
import { Chip, Group, Page, ToggleRow, useSettingsUi } from '../controls.jsx';
import { SECTIONS, settingItem } from '../settingsModel.js';
import { t } from '../../i18n/index.js';

const SYSTEM_ROWS = [
  { label: t('settings.opendex_surumu'), value: 'v4.2', hint: 'Engine v4.2' },
  { label: t('settings.scrcpy_core'), value: 'v4.1' },
  { label: t('settings.a_v_senkronizasyon_saati'), value: 'PTS Monotonic Sync' },
  { label: t('settings.ses_aktarim_protokolu'), value: '48kHz PCM Dual Playback' },
  { label: t('settings.encoder_limiti'), value: '16', hint: t('settings.dogrulanmis') },
  { label: t('settings.esnek_ekran_boyutlandirma'), value: 'Destekleniyor' },
];

// Ayrıntılı akış loglarını konsola/terminale açan izleme kategorileri (tarayıcı + backend aynı anda).
const TRACE_CHOICES = [
  { id: 'handoff', label: t('settings.telefon_pc_gecisi') },
  { id: 'applock', label: t('settings.uygulama_kilidi') },
  { id: 'teleport', label: t('settings.workspace_tasima') },
  { id: 'workspace', label: t('settings.workspace') },
  { id: 'power', label: t('settings.ekran_gucu') },
  { id: 'supervisor', label: t('settings.baglanti_denetcisi') },
  { id: 'media', label: t('common.medya') },
  { id: 'video', label: t('settings.yayin_video') },
];

/** Satır içi başlık + açıklama + gövde: Gelişmiş sayfasındaki eylem kartları. */
function ActionCard({ item, icon: Icon, children }) {
  const meta = settingItem(item);
  const { flashId } = useSettingsUi();
  return (
    <section data-setting-id={item} className={cn('rounded-xl border border-border/70 bg-muted/30 p-3.5 transition-colors', flashId === item && 'settings-flash')}>
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[12.5px] font-semibold leading-[17px] text-foreground">{meta.title}</h3>
          <p className="mt-0.5 text-[11.5px] leading-[16px] text-muted-foreground">{meta.description}</p>
        </div>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function AdvancedSection({ ctl }) {
  const { pushToast } = ctl;
  // Yalnız bu oturumda tutulan (backend'e yazılmayan) anahtarlar.
  const [inspector, setInspector] = useState(false);
  const [testState, setTestState] = useState('idle');
  const [logState, setLogState] = useState('idle'); // idle | busy | done | failed
  const [logInfo, setLogInfo] = useState('');
  const [traceSel, setTraceSel] = useState(() => logger.getTrace());

  const copyLogs = async () => {
    setLogState('busy');
    try {
      const res = await copyDiagnosticsReport();
      setLogState(res.ok ? 'done' : 'failed');
      setLogInfo(res.ok ? t('settings.lines_satir_panoya_kopyalandi', { lines: res.lines }) : t('settings.panoya_yazilamadi_tarayici_izni'));
    } catch (err) {
      setLogState('failed');
      setLogInfo(String(err?.message || err));
    }
  };

  const toggleTrace = (id) => {
    const next = traceSel.includes(id) ? traceSel.filter((c) => c !== id) : [...traceSel, id];
    setTraceSel(next);
    logger.setTrace(next);
    api.post('/api/diagnostics/log-level', { trace: next }).catch(() => {});
  };

  const runTest = async () => {
    setTestState('running');
    try {
      // EncoderStressTestResult: the MEASURED limit, never a hardcoded number.
      const res = await api.post('/api/device/encoder-stress-test');
      setTestState('done');
      const limit = Number(res?.measured_encoder_limit);
      if (limit > 0) {
        pushToast?.(
          t('settings.encoder_kapasite_testi_tamamlandi', { limit }) +
            (res?.capped_by_safety_limit ? t('settings.guvenlik_sinirinda_durduruldu') : '.'),
        );
      } else {
        pushToast?.(t('settings.encoder_kapasite_testi_sonuc', { value: res?.failure_reason ? `: ${res.failure_reason}` : '.' }));
      }
    } catch (err) {
      setTestState('done');
      pushToast?.(t('settings.encoder_kapasite_testi_basarisiz_value', { value: err?.detail || err?.message || 'bilinmeyen hata' }));
    }
  };

  return (
    <Page icon={Stethoscope} title={SECTIONS.advanced.label} subtitle={SECTIONS.advanced.subtitle}>
      <ActionCard item="logs" icon={Stethoscope}>
        <p className="text-[11px] leading-[16px] text-muted-foreground">
          {t('settings.loglari_kopyala_tarayici_logu_backend')}<span className="font-mono">{t('settings.backend_logs')}</span>{t('settings.yayin_sagligi_ve_telefon_ekran_durumu')}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button onClick={copyLogs} disabled={logState === 'busy'}>
            {logState === 'busy' ? t('settings.hazirlaniyor') : t('settings.loglari_kopyala')}
          </Button>
          {(logState === 'done' || logState === 'failed') && (
            <span className="flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground" role="status">
              {logState === 'done' && <Check className="size-3 text-status-active" />} {logInfo}
            </span>
          )}
        </div>
      </ActionCard>

      <ActionCard item="trace" icon={Activity}>
        <div className="flex flex-wrap gap-1.5">
          {TRACE_CHOICES.map((choice) => {
            const active = traceSel.includes(choice.id);
            return (
              <button
                key={choice.id}
                type="button"
                aria-pressed={active}
                onClick={() => toggleTrace(choice.id)}
                className={cn(
                  'cursor-pointer rounded-full border px-2.5 py-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'border-primary bg-primary text-primary-foreground' : 'border-border/70 bg-background text-muted-foreground hover:bg-accent/55',
                )}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
      </ActionCard>

      <ActionCard item="encoderTest" icon={Cpu}>
        <p className="text-[11px] leading-[16px] text-muted-foreground">{t('settings.test_icin_once_acik_pencereleri')}</p>
        <div className="mt-2.5 flex items-center gap-2">
          <Button onClick={runTest} disabled={testState === 'running'}>
            {testState === 'running' ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> {' '}{t('common.olculuyor')}
              </span>
            ) : (
              t('settings.test_et')
            )}
          </Button>
          {testState === 'done' && (
            <span className="flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground" role="status">
              <Check className="size-3 text-status-active" /> {' '}{t('settings.test_tamamlandi')}
            </span>
          )}
        </div>
      </ActionCard>

      <Group title={t('settings.deneysel')}>
        <ToggleRow item="inspector" icon={Code2} badge="Beta" checked={inspector} onToggle={() => setInspector((v) => !v)} />
      </Group>

      <section data-setting-id="systemInfo" aria-label={settingItem('systemInfo').title} className="space-y-1.5">
        <h3 className="px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{settingItem('systemInfo').title}</h3>
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-muted/30">
          {SYSTEM_ROWS.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <span className="text-[11.5px] font-medium">{row.label}</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-[11px] font-semibold tabular-nums text-foreground">{row.value}</span>
                {row.hint && <Chip>{row.hint}</Chip>}
              </span>
            </div>
          ))}
        </div>
      </section>
    </Page>
  );
}

function Metric({ value, label, hint }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/70 p-2.5 text-center">
      <p className="font-mono text-[18px] font-semibold leading-none tabular-nums text-primary">{value}</p>
      <p className="mt-1.5 text-[11px] font-semibold text-foreground">{label}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

const DIRECT_REPLY_BLOCKS = [
  {
    heading: t('settings.android_isletim_sistemi_guvenlik'),
    body: t('settings.android_de_bildirimlerdeki_yanitla'),
    footnote: t('settings.uid_2000_adb_shell_bir_listener_apk'),
  },
  {
    heading: t('settings.opendex_in_dogal_ve_guvenli_cozumu'),
    body: t('settings.arka_planda_gizlice_sanal_pencere'),
    footnote: t('settings.sifir_hack_sifir_gizli_pencere_100'),
  },
];

export function AboutSection() {
  const { flashId } = useSettingsUi();
  return (
    <Page icon={Info} title={SECTIONS.about.label} subtitle={SECTIONS.about.subtitle}>
      <section data-setting-id="architecture" className={cn('rounded-xl border border-border/70 bg-muted/30 p-4 transition-colors', flashId === 'architecture' && 'settings-flash')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold">{settingItem('architecture').title}</h3>
          <Chip>{t('settings.100_yerel_android_aosp')}</Chip>
        </div>
        <p className="mt-2.5 text-[12px] font-semibold">{t('settings.opendex_temel_ilkesi_sifir_kurulum')}</p>
        <p className="mt-1 text-[11.5px] leading-[17px] text-muted-foreground">
          {t('settings.telefonunuza_asla_yabanci_bir_apk')}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Metric value="0" label={t('settings.apk_kurulumu')} hint={t('settings.cihaz_bellegi_tertemiz')} />
          <Metric value="0" label={t('settings.root_modifikasyon')} hint={t('settings.garanti_knox_bozulmaz')} />
          <Metric value="100%" label={t('settings.yerel_gizlilik')} hint={t('settings.dogrudan_usb_lan_transferi')} />
        </div>
      </section>

      <section data-setting-id="directReply" className={cn('rounded-xl border border-border/70 bg-muted/30 p-4 transition-colors', flashId === 'directReply' && 'settings-flash')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold leading-[18px]">{settingItem('directReply').title}</h3>
          <Chip className="font-mono">{t('settings.pendingintent_remoteinput')}</Chip>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t('settings.whatsapp_telegram_vb_mesaj')}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {DIRECT_REPLY_BLOCKS.map((block) => (
            <div key={block.heading} className="rounded-lg border border-border/60 bg-background/70 p-3">
              <p className="text-[11.5px] font-semibold leading-[15px] text-foreground">{block.heading}</p>
              <p className="mt-1 text-[11px] leading-[16px] text-muted-foreground">{block.body}</p>
              <p className="mt-2 rounded-md bg-muted px-2 py-1 text-[10.5px] leading-[14px] text-foreground/80">{block.footnote}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 flex gap-1.5 text-[11px] leading-[16px] text-muted-foreground">
          <ChevronRight className="mt-0.5 size-3 shrink-0 text-primary" aria-hidden="true" />
          {t('settings.bildirim_triyaji_kartlardaki_okundu')}
        </p>
      </section>
    </Page>
  );
}
