// Pencerenin açık iletişim kutusu (en çok bir tane) + çakışma kutusu. Çakışma, iş durmuş beklediği için ODAKTAKİ Dosyalar
// penceresinde modal olarak çıkar; odakta değilse tepsi kartında yanıtlanabilir (aynı ConflictPanel).
import React from 'react';
import { Dialog } from '../ui/Dialog.jsx';
import ConfirmDeleteDialog from './ConfirmDeleteDialog.jsx';
import ConflictPanel from './ConflictPanel.jsx';
import PropertiesDialog from './PropertiesDialog.jsx';
import ShortcutsDialog from './ShortcutsDialog.jsx';
import TrashDialog from './TrashDialog.jsx';
import { useFilesStore } from './filesStore.js';
import { selectConflictJob, useTransferStore } from './transferStore.js';

export default function FilesDialogs({ winId, focused }) {
  const dialog = useFilesStore((s) => s.wins[winId]?.dialog);
  const conflictJob = useTransferStore((s) => selectConflictJob(s));
  return (
    <>
      {dialog?.type === 'confirm-delete' && <ConfirmDeleteDialog winId={winId} dialog={dialog} />}
      {dialog?.type === 'properties' && <PropertiesDialog winId={winId} dialog={dialog} />}
      {dialog?.type === 'trash' && <TrashDialog winId={winId} />}
      {dialog?.type === 'shortcuts' && <ShortcutsDialog winId={winId} />}
      {focused && conflictJob && (
        <Dialog open label="Aynı adlı öğe var" position="absolute" closeOnBackdrop={false} closeOnEscape={false} className="max-w-md p-5">
          <ConflictPanel job={conflictJob} autoFocus />
        </Dialog>
      )}
    </>
  );
}
