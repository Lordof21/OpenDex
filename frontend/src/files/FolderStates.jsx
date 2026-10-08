// Klasör görünümünün boş / yükleniyor / hata durumları. Yükleniyor iskeleti 150 ms GECİKMELİ görünür: hızlı yüklenen
// klasörde ekran "iskelet → liste" diye yanıp sönmez.
import React from 'react';
import { CloudOff, FolderOpen, FolderX, Lock, RefreshCw, SearchX, ShieldAlert, Smartphone } from 'lucide-react';
import Button from '../ui/Button.jsx';

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
  if (query) return <Centered icon={SearchX} title="Eşleşen öğe yok" hint={`“${query}” için bu klasörde sonuç bulunamadı.`} />;
  if (filtered && hiddenCount > 0) {
    return (
      <Centered icon={FolderOpen} title="Bu klasörde yalnız gizli öğeler var" hint={`${hiddenCount} gizli öğe şu an gösterilmiyor.`}>
        <Button size="xs" variant="outline" onClick={onShowHidden}>Gizli dosyaları göster</Button>
      </Centered>
    );
  }
  return (
    <Centered icon={FolderOpen} title="Bu klasör boş" hint="Dosyaları buraya sürükleyebilir ya da yapıştırabilirsiniz.">
      <Button size="xs" variant="outline" onClick={onNewFolder}>Yeni klasör</Button>
    </Centered>
  );
}

const ERROR_VIEW = {
  not_found: { icon: FolderX, title: 'Klasör bulunamadı', hint: 'Silinmiş ya da taşınmış olabilir.' },
  outside_roots: { icon: ShieldAlert, title: 'Bu konuma erişim izni yok', hint: 'OpenDeX yalnız izin verilen klasörleri gösterir. Kenar çubuğundan “Klasör ekle” ile ekleyebilirsiniz.' },
  permission: { icon: Lock, title: 'Erişim reddedildi', hint: 'Bu klasörü okuma yetkisi yok.' },
  device_offline: { icon: Smartphone, title: 'Telefona ulaşılamıyor', hint: 'Kablo ya da kablosuz bağlantıyı kontrol edin. Bağlantı gelince liste kendiliğinden yenilenir.' },
  timeout: { icon: CloudOff, title: 'Telefon yanıt vermedi', hint: 'Bağlantı yavaş olabilir; yeniden deneyin.' },
};

export function ErrorState({ error, onRetry }) {
  const view = ERROR_VIEW[error?.code] || { icon: CloudOff, title: 'Klasör okunamadı', hint: error?.message };
  return (
    <Centered icon={view.icon} title={view.title} hint={view.hint} tone="text-destructive">
      <Button size="xs" variant="outline" startIcon={<RefreshCw className="size-3" />} onClick={onRetry}>Yeniden dene</Button>
    </Centered>
  );
}
