// Aktarım tepsisi: pencerenin sağ altında açılan panel. İş başına kart: başlık, ilerleme çubuğu, hız/kalan süre, şu an
// kopyalanan dosya, duraklat/sürdür/iptal. Çakışma kartın içinde yanıtlanır; biten işler hata ayrıntısıyla kalır, kullanıcı
// kapatır. İşi backend yürütür — pencere kapansa da sürer.
import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Pause, Play, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../lib/utils.js';
import { IconButton } from '../ui/IconButton.jsx';
import ConflictPanel from './ConflictPanel.jsx';
import { formatEta, formatSize, formatSpeed } from './formatters.js';
import { TERMINAL, jobProgress, jobTitle, useTransferStore } from './transferStore.js';

export function stateLabel(job) {
  if (job.state === 'paused') return job.pause_reason === 'device_offline' ? 'Telefon bağlantısı bekleniyor…' : 'Duraklatıldı';
  return {
    queued: 'Sırada', scanning: 'Dosyalar sayılıyor…', running: job.op === 'move' ? 'Taşınıyor' : 'Kopyalanıyor', waiting: 'Karar bekleniyor',
    completed: 'Tamamlandı', failed: 'Başarısız', cancelled: 'İptal edildi',
  }[job.state] ?? job.state;
}

function Bar({ value, tone }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value == null ? undefined : Math.round(value)}
      className="h-1.5 overflow-hidden rounded-full bg-border"
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-200', tone, value == null && 'w-1/3 animate-pulse motion-reduce:animate-none')}
        style={value == null ? undefined : { width: `${value}%` }}
      />
    </div>
  );
}

function JobCard({ job }) {
  const [showErrors, setShowErrors] = useState(false);
  const store = useTransferStore.getState();
  const done = TERMINAL.has(job.state);
  const progress = jobProgress(job);
  const paused = job.state === 'paused';
  const tone = job.state === 'failed' ? 'bg-destructive' : job.failed || job.state === 'cancelled' ? 'bg-ft-sheet' : 'bg-primary';
  const eta = formatEta(job.eta);
  const detail = [
    job.total_bytes ? `${formatSize(job.done_bytes)} / ${formatSize(job.total_bytes)}` : null,
    !paused && job.speed ? formatSpeed(job.speed) : null,
    !paused && !done && eta ? `${eta} kaldı` : null,
  ].filter(Boolean).join(' · ');

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/60 p-2.5" data-job={job.id}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold" title={jobTitle(job)}>{jobTitle(job)}</p>
          <p className={cn('text-[11px]', job.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
            {done && job.state === 'completed' && <Check className="mr-1 inline size-3 text-ft-sheet" aria-hidden="true" />}
            {stateLabel(job)}{job.skipped ? ` · ${job.skipped} atlandı` : ''}{job.failed ? ` · ${job.failed} hata` : ''}
          </p>
        </div>
        {!done && (
          <>
            {job.state !== 'waiting' && (
              <IconButton label={paused ? 'Sürdür' : 'Duraklat'} size="sm" onClick={() => (paused ? store.resume(job.id) : store.pause(job.id))}>
                {paused ? <Play /> : <Pause />}
              </IconButton>
            )}
            <IconButton label="İptal et" size="sm" danger="destructive" onClick={() => store.cancel(job.id)}><X /></IconButton>
          </>
        )}
        {done && <IconButton label="Listeden kaldır" size="sm" onClick={() => store.dismiss(job.id)}><X /></IconButton>}
      </div>
      {!done && job.state !== 'waiting' && <Bar value={progress} tone={tone} />}
      {job.state === 'waiting' && <ConflictPanel job={job} />}
      {!done && job.current.length > 0 && <p className="truncate font-mono text-[10px] text-muted-foreground" title={job.current[0]}>{job.current[0]}</p>}
      {detail && <p className="text-[10px] tabular-nums text-muted-foreground">{detail}</p>}
      {job.state === 'failed' && job.error?.message && <p role="alert" className="text-[11px] text-destructive">{job.error.message}</p>}
      {done && job.errors.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowErrors((v) => !v)} aria-expanded={showErrors} className="flex items-center gap-1 text-[11px] font-medium text-destructive hover:underline cursor-pointer">
            <AlertTriangle className="size-3" aria-hidden="true" /> {job.errors.length} hata
            <ChevronDown className={cn('size-3 transition-transform', showErrors && 'rotate-180')} aria-hidden="true" />
          </button>
          {showErrors && (
            <ul className="dex-scroll mt-1 max-h-24 space-y-0.5 overflow-y-auto overflow-x-hidden text-[10px] text-muted-foreground">
              {job.errors.slice(0, 20).map((e, i) => <li key={i} className="truncate" title={`${e.name}: ${e.detail || e.message || ''}`}><span className="font-mono">{e.name}</span> — {e.message || e.code}</li>)}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export default function TransferTray({ compact = false }) {
  const jobs = useTransferStore((s) => s.jobs);
  const order = useTransferStore((s) => s.order);
  const open = useTransferStore((s) => s.trayOpen);
  const list = useMemo(() => order.map((id) => jobs[id]).filter(Boolean), [jobs, order]);
  const finished = list.filter((j) => TERMINAL.has(j.state)).length;

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          key="tray"
          role="region"
          aria-label="Aktarımlar"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.16 }}
          className={cn('absolute z-30 flex max-h-[65%] flex-col rounded-xl border border-border/80 bg-popover/95 text-popover-foreground shadow-window backdrop-blur-2xl', compact ? 'inset-x-2 bottom-[4.75rem]' : 'bottom-9 right-3 w-[22rem] max-w-[calc(100%-1.5rem)]')}
        >
          <header className="flex items-center gap-1 border-b border-border/70 px-3 py-2">
            <h2 className="flex-1 text-xs font-semibold">Aktarımlar</h2>
            {finished > 0 && <button type="button" onClick={() => useTransferStore.getState().clearFinished()} className="rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer">Bitenleri temizle</button>}
            <IconButton label="Tepsiyi kapat" size="sm" onClick={() => useTransferStore.getState().setTrayOpen(false)}><X /></IconButton>
          </header>
          {list.length === 0 ? (
            <p className="px-4 py-6 text-center text-[11px] text-muted-foreground">Henüz aktarım yok. Dosyaları sürükleyip bırakın ya da kopyalayıp yapıştırın.</p>
          ) : (
            <ul className="dex-scroll flex flex-col gap-2 overflow-y-auto overflow-x-hidden p-2">{[...list].reverse().map((job) => <JobCard key={job.id} job={job} />)}</ul>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
