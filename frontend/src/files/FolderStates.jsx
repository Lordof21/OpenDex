// Klasör görünümünün boş / yükleniyor / hata durumları. Yükleniyor iskeleti 150 ms GECİKMELİ görünür: hızlı yüklenen
// klasörde ekran "iskelet → liste" diye yanıp sönmez.
import React from 'react';
import { CloudOff, FolderOpen, FolderX, Lock, RefreshCw, SearchX, ShieldAlert, Smartphone } from 'lucide-react';
import Button from '../ui/Button.jsx';
import { t } from '../i18n/index.js';

export function SkeletonRows({ rowH = 36, count = 12 }) {
  return (
    <div aria-hidden="true" className="pointer-events-none animate-pulse px-2 [animation-delay:150ms] opacity-0 [animation-fill-mode:forwards] motion-reduce:animate-none" style={{ animationName: 'files-skeleton-in, pulse', animationDuration: '120ms, 1.6s', animationDelay: '150ms, 150ms', animationFillMode: 'forwards, none' }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5 px-2" style={{ height: rowH }}>
          <span className="size-5 shrink-0 rounded-sm bg-muted" />
          <span className="h-3 rounded bg-muted" style={{ width: `${38 + ((i * 17) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}

function Centered({ icon: Icon, title, hint, children, tone = 'text-muted-foreground' }) {
  return (
    <div role="status" className="absolute inset-0 grid place-items-center p-6">
      <div className="flex max-w-72 flex-col items-center gap-2 text-center">
        <Icon className={`size-9 ${tone}`} strokeWidth={1.4} aria-hidden="true" />
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
        {children && <div className="mt-1 flex flex-wrap justify-center gap-1.5">{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ filtered, query, hiddenCount, onShowHidden, onNewFolder }) {
  if (query) return <Centered icon={SearchX} title={t('files.eslesen_oge_yok')} hint={t('files.query_icin_bu_klasorde_sonuc', { query })} />;
  if (filtered && hiddenCount > 0) {
    return (
      <Centered icon={FolderOpen} title={t('files.bu_klasorde_yalniz_gizli_ogeler_var')} hint={t('files.hiddencount_gizli_oge_su_an', { hiddenCount })}>
        <Button size="xs" variant="outline" onClick={onShowHidden}>{t('files.gizli_dosyalari_goster')}</Button>
      </Centered>
    );
  }
  return (
    <Centered icon={FolderOpen} title={t('files.bu_klasor_bos')} hint={t('files.dosyalari_buraya_surukleyebilir_ya_da')}>
      <Button size="xs" variant="outline" onClick={onNewFolder}>{t('files.yeni_klasor')}</Button>
    </Centered>
  );
}

const ERROR_VIEW = {
  not_found: { icon: FolderX, title: t('files.klasor_bulunamadi'), hint: t('files.silinmis_ya_da_tasinmis_olabilir') },
  outside_roots: { icon: ShieldAlert, title: t('files.bu_konuma_erisim_izni_yok'), hint: t('files.opendex_yalniz_izin_verilen') },
  permission: { icon: Lock, title: t('files.erisim_reddedildi'), hint: t('files.bu_klasoru_okuma_yetkisi_yok') },
  device_offline: { icon: Smartphone, title: t('files.telefona_ulasilamiyor'), hint: t('files.kablo_ya_da_kablosuz_baglantiyi') },
  timeout: { icon: CloudOff, title: t('files.telefon_yanit_vermedi'), hint: t('files.baglanti_yavas_olabilir_yeniden') },
};

export function ErrorState({ error, onRetry }) {
  const view = ERROR_VIEW[error?.code] || { icon: CloudOff, title: t('files.klasor_okunamadi'), hint: error?.message };
  return (
    <Centered icon={view.icon} title={view.title} hint={view.hint} tone="text-destructive">
      <Button size="xs" variant="outline" startIcon={<RefreshCw className="size-3" />} onClick={onRetry}>{t('files.yeniden_dene')}</Button>
    </Centered>
  );
}
