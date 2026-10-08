// Özellikler: ad, tür, konum (kopyalanabilir), boyut, değiştirme tarihi, gizli/bağlantı bilgisi. Listeden gelen bilgi hemen
// gösterilir; `stat` ile (izin bitleri, bağlantı hedefi) zenginleştirilir.
import React, { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { Dialog } from '../ui/Dialog.jsx';
import { Button } from '../ui/Button.jsx';
import { useSystemStore } from '../state/systemStore.js';
import FileIcon from './FileIcon.jsx';
import { fsApi } from './fsApi.js';
import { typeLabel } from './fileTypes.js';
import { useFilesStore } from './filesStore.js';
import { formatFullDate, formatSize } from './formatters.js';
import { isPhone, parentOf } from './paths.js';

/** "rwxr-xr-x" (telefon, sekizlik mod). Mod yoksa null. */
export function modeString(mode) {
  if (!Number.isInteger(mode)) return null;
  const bits = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i += 1) out += mode & (1 << (8 - i)) ? bits[i] : '-';
  return out;
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-1.5 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export default function PropertiesDialog({ winId, dialog }) {
  const close = () => useFilesStore.getState().closeDialog(winId);
  const [entry, setEntry] = useState(dialog.entry);
  const loc = dialog.loc;

  useEffect(() => {
    let live = true;
    // Yalnız listede olmayan/taze alanlar birleşir (ad ve tür listeden gelen kalır — arama sonucu/bağlantı karışmasın).
    fsApi.stat(loc).then((full) => { if (live) setEntry((e) => ({ ...e, mode: full.mode, link_target: full.link_target, size: full.size ?? e.size, mtime: full.mtime ?? e.mtime })); }).catch(() => {});
    return () => { live = false; };
  }, [loc]);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(loc.path);
      useSystemStore.getState().pushToast?.('Yol panoya kopyalandı.', { tone: 'success', durationMs: 1600 });
    } catch {
      useSystemStore.getState().pushToast?.('Yol kopyalanamadı.', { tone: 'error' });
    }
  };

  const mode = modeString(entry.mode);
  return (
    <Dialog open onClose={close} label="Özellikler" position="absolute" className="max-w-md p-5">
      <div className="flex items-center gap-3 border-b border-border/70 pb-3">
        <FileIcon entry={entry} loc={loc} size={40} thumb px={96} />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold" title={entry.name}>{entry.name}</h2>
          <p className="text-[11px] text-muted-foreground">{typeLabel(entry)}</p>
        </div>
      </div>
      <dl className="divide-y divide-border/50">
        <Row label="Konum">
          <span className="flex items-start gap-1">
            <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{parentOf(loc)?.path ?? loc.path}</span>
            <button type="button" aria-label="Tam yolu kopyala" onClick={copyPath} className="grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer"><Copy className="size-3" /></button>
          </span>
        </Row>
        <Row label="Yer">{isPhone(loc) ? 'Telefon' : 'Bilgisayar'}</Row>
        {entry.kind !== 'dir' && <Row label="Boyut"><span className="tabular-nums">{formatSize(entry.size)} <span className="text-muted-foreground">({new Intl.NumberFormat('tr-TR').format(entry.size)} bayt)</span></span></Row>}
        <Row label="Değiştirme">{formatFullDate(entry.mtime)}</Row>
        {entry.symlink && <Row label="Bağlantı">{entry.link_target || 'Sembolik bağlantı'}</Row>}
        {entry.hidden && <Row label="Öznitelik">Gizli</Row>}
        {mode && <Row label="İzinler"><span className="font-mono">{mode}</span></Row>}
      </dl>
      <div className="mt-3 flex justify-end"><Button size="sm" variant="outline" onClick={close} autoFocus>Kapat</Button></div>
    </Dialog>
  );
}
