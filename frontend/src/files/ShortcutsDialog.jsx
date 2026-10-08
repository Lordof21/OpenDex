// Klavye kısayolları (keymap.SHORTCUTS tablosu — kısayol ile yardım aynı kaynaktan).
import React from 'react';
import { Dialog } from '../ui/Dialog.jsx';
import { Button } from '../ui/Button.jsx';
import { useFilesStore } from './filesStore.js';
import { SHORTCUTS } from './keymap.js';

export default function ShortcutsDialog({ winId }) {
  const close = () => useFilesStore.getState().closeDialog(winId);
  return (
    <Dialog open onClose={close} label="Klavye kısayolları" position="absolute" className="dex-scroll max-h-[85%] max-w-md overflow-y-auto overflow-x-hidden p-5">
      <h2 className="mb-2 text-sm font-semibold">Klavye kısayolları</h2>
      <dl className="divide-y divide-border/50">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={keys} className="flex items-center justify-between gap-3 py-1.5 text-xs">
            <dt className="text-muted-foreground">{label}</dt>
            <dd><kbd className="rounded-sm border border-border/70 bg-background px-1.5 py-0.5 font-mono text-[10px]">{keys}</kbd></dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex justify-end"><Button size="sm" variant="outline" onClick={close} autoFocus>Kapat</Button></div>
    </Dialog>
  );
}
