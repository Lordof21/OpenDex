// Kalıcı silme onayı (Shift+Delete ya da geri dönüşüm kutusu olmayan konum). Varsayılan odak "Vazgeç"te: Enter'a basmak
// yanlışlıkla silmez. Telefonda geri dönüşüm kutusu bu yüzden vardır; burada kalıcılık açıkça söylenir.
import React from 'react';
import { Trash2 } from 'lucide-react';
import { Dialog } from '../ui/Dialog.jsx';
import { Button } from '../ui/Button.jsx';
import { performDelete } from './filesCommands.js';
import { useFilesStore } from './filesStore.js';
import { countLabel } from './formatters.js';

const MAX_NAMES = 5;

export default function ConfirmDeleteDialog({ winId, dialog }) {
  const close = () => useFilesStore.getState().closeDialog(winId);
  const { items, reason, pane } = dialog;
  const names = items.slice(0, MAX_NAMES).map((i) => i.entry.name);
  const dirs = items.filter((i) => i.entry.kind === 'dir').length;
  return (
    <Dialog open onClose={close} label="Kalıcı silme onayı" position="absolute" className="max-w-sm p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive"><Trash2 className="size-4" aria-hidden="true" /></span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{countLabel(items.length)} kalıcı olarak silinsin mi?</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {reason === 'no-bin' ? 'Bu konumda geri dönüşüm kutusu yok; ' : ''}Bu işlem geri alınamaz.
            {dirs > 0 ? ' Klasörlerin içindekilerle birlikte silinir.' : ''}
          </p>
          <ul className="mt-2 space-y-0.5 text-[11px]">
            {names.map((n) => <li key={n} className="truncate font-mono" title={n}>{n}</li>)}
            {items.length > MAX_NAMES && <li className="text-muted-foreground">ve {items.length - MAX_NAMES} öğe daha</li>}
          </ul>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={close} autoFocus>Vazgeç</Button>
        <Button size="sm" variant="destructive" onClick={() => performDelete(winId, pane, items, true)}>Kalıcı olarak sil</Button>
      </div>
    </Dialog>
  );
}
