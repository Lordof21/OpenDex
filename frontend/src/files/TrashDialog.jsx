// Telefonun geri dönüşüm kutusu: silinenleri listeler, geri yükler ya da kalıcı siler. Kutu `.opendex-trash` içinde yaşar
// (telefonun kendi çöpü yok); süresi dolanları backend temizler (FS_TRASH_DAYS).
import React, { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Dialog } from '../ui/Dialog.jsx';
import { Button } from '../ui/Button.jsx';
import { useSystemStore } from '../state/systemStore.js';
import { fsApi } from './fsApi.js';
import { useFilesStore } from './filesStore.js';
import { countLabel, formatDate, formatSize } from './formatters.js';
import { t } from '../i18n/index.js';

const toast = (m, tone) => useSystemStore.getState().pushToast?.(m, { tone });

export default function TrashDialog({ winId }) {
  const close = () => useFilesStore.getState().closeDialog(winId);
  const device = useFilesStore((s) => s.places.device);
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const load = useCallback(async () => {
    try {
      const { items: rows } = await fsApi.trash(device);
      setItems(Array.isArray(rows) ? rows : []);
      setPicked(new Set());
      setError(null);
    } catch (err) {
      setError(err.code === 'device_offline' ? t('files.telefona_ulasilamiyor_2') : err.message || t('files.kutu_okunamadi'));
    }
  }, [device]);

  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      toast(err.message || t('common.islem_basarisiz'), 'error');
    } finally {
      setBusy(false);
      setConfirmEmpty(false);
    }
  };

  const ids = [...picked];
  const restore = () => run(async () => {
    const { results } = await fsApi.restore(ids, device);
    const ok = results.filter((r) => r.ok).length;
    if (ok) toast(t('files.countlabel_geri_yuklendi', { countLabel: countLabel(ok) }), 'success');
    const bad = results.filter((r) => !r.ok);
    if (bad.length) toast(t('files.countlabel_geri_yuklenemedi', { countLabel: countLabel(bad.length) }), 'error');
    useFilesStore.getState().handleFsChanged({ provider: 'phone', device, path: results.find((r) => r.ok)?.path?.replace(/\/[^/]+$/, '') });
  });
  const remove = () => run(async () => {
    const { deleted } = await fsApi.emptyTrash(device, ids);
    toast(t('files.countlabel_kalici_silindi', { countLabel: countLabel(deleted) }), 'success');
  });
  const empty = () => run(async () => {
    const { deleted } = await fsApi.emptyTrash(device, null);
    toast(t('files.kutu_bosaltildi_countlabel', { countLabel: countLabel(deleted) }), 'success');
  });

  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Dialog open onClose={close} label={t('files.telefonun_geri_donusum_kutusu')} position="absolute" className="flex max-h-[85%] max-w-lg flex-col p-0">
      <header className="flex items-center justify-between border-b border-border/70 px-4 py-3">
        <h2 className="text-sm font-semibold">{t('files.telefonun_geri_donusum_kutusu')}</h2>
        {items?.length > 0 && <span className="text-[11px] text-muted-foreground">{countLabel(items.length)}</span>}
      </header>
      <div className="dex-scroll min-h-24 flex-1 overflow-y-auto overflow-x-hidden p-2">
        {error && <p role="alert" className="p-4 text-center text-xs text-destructive">{error}</p>}
        {!error && items === null && <p className="p-4 text-center text-xs text-muted-foreground">{t('common.yukleniyor_2')}</p>}
        {!error && items?.length === 0 && <p className="p-6 text-center text-xs text-muted-foreground">{t('files.kutu_bos')}</p>}
        {items?.length > 0 && (
          <ul>
            {items.map((it) => (
              <li key={it.id}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-xs hover:bg-accent/50">
                  <input type="checkbox" checked={picked.has(it.id)} onChange={() => toggle(it.id)} className="size-3.5 accent-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" title={it.name}>{it.name}</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground" title={it.original}>{it.original}</span>
                  </span>
                  <span className="shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                    {it.is_dir ? t('common.klasor') : formatSize(it.size)}<br />{formatDate(it.deleted)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-4 py-3">
        {confirmEmpty ? (
          <>
            <span className="text-xs text-destructive">{t('files.kutudaki_her_sey_kalici_silinsin_mi')}</span>
            <span className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => setConfirmEmpty(false)} autoFocus>{t('common.vazgec')}</Button>
              <Button size="sm" variant="destructive" loading={busy} onClick={empty}>{t('files.evet_bosalt')}</Button>
            </span>
          </>
        ) : (
          <>
            <Button size="sm" variant="destructive-ghost" disabled={busy || !items?.length} startIcon={<Trash2 className="size-3" />} onClick={() => setConfirmEmpty(true)}>{t('files.kutuyu_bosalt')}</Button>
            <span className="flex gap-1.5">
              <Button size="sm" variant="outline" disabled={busy || ids.length === 0} onClick={remove}>{t('files.kalici_sil')}</Button>
              <Button size="sm" disabled={busy || ids.length === 0} startIcon={<RotateCcw className="size-3" />} onClick={restore}>{t('common.geri_yukle')}</Button>
              <Button size="sm" variant="ghost" onClick={close}>{t('common.kapat')}</Button>
            </span>
          </>
        )}
      </footer>
    </Dialog>
  );
}
