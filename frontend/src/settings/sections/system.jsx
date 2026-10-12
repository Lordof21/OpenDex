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

const SYSTEM_ROWS = [
  { label: 'OpenDeX Sürümü', value: 'v4.2', hint: 'Engine v4.2' },
  { label: 'Scrcpy Core', value: 'v4.1' },
  { label: 'A/V Senkronizasyon Saati', value: 'PTS Monotonic Sync' },
  { label: 'Ses Aktarım Protokolü', value: '48kHz PCM Dual Playback' },
  { label: 'Encoder Limiti', value: '16', hint: 'doğrulanmış' },
  { label: 'Esnek Ekran Boyutlandırma', value: 'Destekleniyor' },
];

// Ayrıntılı akış loglarını konsola/terminale açan izleme kategorileri (tarayıcı + backend aynı anda).
const TRACE_CHOICES = [
  { id: 'handoff', label: 'Telefon ⟷ PC geçişi' },
  { id: 'applock', label: 'Uygulama kilidi' },
  { id: 'teleport', label: 'Workspace taşıma' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'power', label: 'Ekran gücü' },
  { id: 'supervisor', label: 'Bağlantı denetçisi' },
  { id: 'media', label: 'Medya' },
  { id: 'video', label: 'Yayın (video)' },
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
      setLogInfo(res.ok ? `${res.lines} satır panoya kopyalandı` : 'Panoya yazılamadı (tarayıcı izni gerekebilir)');
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
          `Encoder kapasite testi tamamlandı: ${limit} eşzamanlı pencere destekleniyor` +
            (res?.capped_by_safety_limit ? ' (güvenlik sınırında durduruldu).' : '.'),
        );
      } else {
        pushToast?.(`Encoder kapasite testi sonuç vermedi${res?.failure_reason ? `: ${res.failure_reason}` : '.'}`);
      }
    } catch (err) {
      setTestState('done');
      pushToast?.(`Encoder kapasite testi başarısız: ${err?.detail || err?.message || 'bilinmeyen hata'}`);
    }
  };

  return (
    <Page icon={Stethoscope} title={SECTIONS.advanced.label} subtitle={SECTIONS.advanced.subtitle}>
      <ActionCard item="logs" icon={Stethoscope}>
        <p className="text-[11px] leading-[16px] text-muted-foreground">
          «Logları kopyala»: tarayıcı logu, backend log dosyasının sonu (<span className="font-mono">backend/logs/</span>), yayın
          sağlığı ve telefon ekran durumu tek parça panoya alınır.
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button onClick={copyLogs} disabled={logState === 'busy'}>
            {logState === 'busy' ? 'Hazırlanıyor…' : 'Logları kopyala'}
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
        <p className="text-[11px] leading-[16px] text-muted-foreground">Test için önce açık pencereleri kapatın.</p>
        <div className="mt-2.5 flex items-center gap-2">
          <Button onClick={runTest} disabled={testState === 'running'}>
            {testState === 'running' ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Ölçülüyor…
              </span>
            ) : (
              'Test Et'
            )}
          </Button>
          {testState === 'done' && (
            <span className="flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground" role="status">
              <Check className="size-3 text-status-active" /> Test tamamlandı
            </span>
          )}
        </div>
      </ActionCard>

      <Group title="Deneysel">
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
    heading: 'Android İşletim Sistemi Güvenlik Bariyeri',
    body: 'Android\'de bildirimlerdeki “Yanıtla” eylemi arka planda bir PendingIntent ve RemoteInput taşır. SystemServer, sahte mesaj enjeksiyonunu engellemek için bu eylemi yalnızca kullanıcının Bildirim Erişimi ekranından onayladığı bir NotificationListenerService APK\'sına tanır.',
    footnote: '⚡ UID 2000 (ADB/Shell) bir listener APK olmadığı için sistem intent enjeksiyonunu reddeder.',
  },
  {
    heading: 'OpenDeX\'in Doğal ve Güvenli Çözümü',
    body: 'Arka planda gizlice sanal pencere açıp körlemesine panodan metin yapıştırmak güvenilmezdir. OpenDeX\'te bildirime tıkladığınızda WhatsApp penceresi doğal olarak masaüstünde odaklanır; klavyeniz, fareniz ve sohbet geçmişinizle mesajınızı güvenle gönderirsiniz.',
    footnote: '✓ Sıfır hack, sıfır gizli pencere; %100 gerçek masaüstü ergonomisi.',
  },
];

export function AboutSection() {
  const { flashId } = useSettingsUi();
  return (
    <Page icon={Info} title={SECTIONS.about.label} subtitle={SECTIONS.about.subtitle}>
      <section data-setting-id="architecture" className={cn('rounded-xl border border-border/70 bg-muted/30 p-4 transition-colors', flashId === 'architecture' && 'settings-flash')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold">{settingItem('architecture').title}</h3>
          <Chip>%100 Yerel Android (AOSP)</Chip>
        </div>
        <p className="mt-2.5 text-[12px] font-semibold">OpenDeX Temel İlkesi: “Sıfır Kurulum / Zero‑APK”</p>
        <p className="mt-1 text-[11.5px] leading-[17px] text-muted-foreground">
          Telefonunuza asla yabancı bir APK kurmamak, root yetkisi talep etmemek ve cihazınızın Knox / OEM garanti bütünlüğünü
          bozmamaktır. Sistem tak‑çalıştır mantığıyla, saf ADB köprüsü ve Android OS resmi çekirdek API'leri üzerinden çalışır.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Metric value="0" label="APK Kurulumu" hint="Cihaz belleği tertemiz" />
          <Metric value="0" label="Root / Modifikasyon" hint="Garanti & Knox bozulmaz" />
          <Metric value="100%" label="Yerel Gizlilik" hint="Doğrudan USB / LAN transferi" />
        </div>
      </section>

      <section data-setting-id="directReply" className={cn('rounded-xl border border-border/70 bg-muted/30 p-4 transition-colors', flashId === 'directReply' && 'settings-flash')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold leading-[18px]">{settingItem('directReply').title}</h3>
          <Chip className="font-mono">PendingIntent & RemoteInput</Chip>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          WhatsApp, Telegram vb. mesaj bildirimlerine pencere açmadan arkada gizlice cevap gönderme engeli
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
          Bildirim Triyajı: Kartlardaki “Okundu İşaretle” (çift tik) bildirimi silmez; “Okunmamış” sekmesinden gizleyip geçmişte
          (“Tümü”) saklar. Bildirimler sistemden yalnızca “X” butonuna bastığınızda kalıcı olarak silinir.
        </p>
      </section>
    </Page>
  );
}
