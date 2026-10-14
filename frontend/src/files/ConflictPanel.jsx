// "Aynı adlı dosya var" kararı. Hem iletişim kutusunda (odaktaki Dosyalar penceresi) hem tepsi kartında kullanılır:
// iş, kullanıcı karar verene kadar DURUR. Dosyalar yanında karşılaştırılır (boyut, tarih, hangisi daha yeni).
import React, { useState } from 'react';
import { Button } from '../ui/Button.jsx';
import { formatDate, formatSize } from './formatters.js';
import { useTransferStore } from './transferStore.js';
import { t } from '../i18n/index.js';

function Side({ title, size, mtime, hint }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-border/70 bg-background/60 p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="mt-1 text-xs font-medium tabular-nums">{formatSize(size)}</p>
      <p className="text-[11px] text-muted-foreground">{formatDate(mtime)}</p>
      {hint && <p className="mt-1 text-[10px] font-semibold text-primary">{hint}</p>}
    </div>
  );
}

/** Hangi taraf daha yeni / daha büyük: ipucu metinleri (saf; testli). */
export function compareHints(incoming, existing) {
  const newer = incoming.mtime > existing.mtime ? 'in' : incoming.mtime < existing.mtime ? 'ex' : null;
  const same = incoming.size === existing.size && incoming.mtime === existing.mtime;
  return {
    same,
    incoming: same ? t('files.ayni_dosya_gibi_gorunuyor') : newer === 'in' ? t('files.daha_yeni') : newer === 'ex' ? t('files.daha_eski') : null,
    existing: same ? null : newer === 'ex' ? t('files.daha_yeni') : newer === 'in' ? t('files.daha_eski') : null,
  };
}

export default function ConflictPanel({ job, autoFocus = false }) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const c = job.conflict;
  if (!c) return null;
  const hints = compareHints(c.incoming, c.existing);

  const answer = async (resolution) => {
    setBusy(true);
    try {
      await useTransferStore.getState().resolve(job.id, resolution, all);
    } finally {
      setBusy(false);
      setAll(false);
    }
  };

  return (
    <div role="group" aria-label={t('files.cakisma')} className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-semibold">{t('files.bu_klasorde_ayni_ada_sahip_bir_value', { value: c.existing.kind === 'dir' ? t('files.klasor') : 'dosya' })}</p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={c.name}>{c.name}</p>
      </div>
      <div className="flex gap-2">
        <Side title={t('files.gelen')} size={c.incoming.size} mtime={c.incoming.mtime} hint={hints.incoming} />
        <Side title={t('files.mevcut')} size={c.existing.size} mtime={c.existing.mtime} hint={hints.existing} />
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="size-3.5 accent-primary" />
        {t('files.sonraki_cakismalar_icin_de_aynisini')}
      </label>
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => useTransferStore.getState().cancel(job.id)}>{t('common.iptal')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => answer('skip')}>{t('files.atla')}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => answer('keep_both')} autoFocus={autoFocus}>{t('files.ikisini_de_tut')}</Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => answer('replace')}>{t('files.degistir')}</Button>
      </div>
    </div>
  );
}
