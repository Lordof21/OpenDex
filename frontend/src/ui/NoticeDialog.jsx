// One-time onboarding notices: clipboard honesty warning + TR layout
// routing. Honest and simple beats silently losing user data.
// Esc / dış tıklama bilerek KAPATMAZ: kapatmak bildirimi kalıcı olarak "görüldü" sayar, yalnız "Anladım" ile olur.

import { dismissNotice, runNoticeAction } from '../startup/firstRunNotices.js';
import Button from './Button.jsx';
import { Dialog } from './Dialog.jsx';

export default function NoticeDialog({ androidId, notice, onDone }) {
  const done = async () => {
    await dismissNotice(androidId, notice.key);
    onDone();
  };

  return (
    <Dialog
      open={Boolean(notice)}
      label={notice?.title}
      position="absolute"
      layer="z-flyoutDialog"
      closeOnBackdrop={false}
      closeOnEscape={false}
      className="w-96 max-w-none p-5 text-foreground"
    >
      {notice && (
        <>
          <h3 className="text-sm font-semibold text-foreground">{notice.title}</h3>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{notice.message}</p>
          <div className="mt-4 flex justify-end gap-2">
            {notice.action && (
              <Button size="sm" variant="secondary" onClick={() => runNoticeAction(notice)}>
                Ayarı telefonda aç
              </Button>
            )}
            <Button size="sm" onClick={done}>
              Anladım
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
