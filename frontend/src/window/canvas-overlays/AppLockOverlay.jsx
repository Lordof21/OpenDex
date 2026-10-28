// Uygulama kilidi katmanı. Telefondaki OEM AppLock'u (Xiaomi / Samsung) pencere içinde bir durum olarak anlatır:
//   waiting   — kilit telefonda soruldu; kullanıcı parmak izini okutacak / şifreyi girecek (backend en çok 15 sn bekler)
//   cancelled — kilit ekranı jestle / ana ekranla kapatıldı (açılmadı)
//   timeout   — süre doldu
// Kullanıcının bu ekranda yapabileceği tek şey "telefona dönmek"tir; bu yüzden metin NEREDE (telefonda) ve NE (parmak izi / şifre)
// olduğunu söyler, sayaç ne kadar bekleneceğini gösterir, kapalı ekranlar için "ekranı uyandır" bir tık uzakta durur.
import React from 'react';
import { Fingerprint, LockKeyhole, RotateCw, Smartphone, TimerOff, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { t } from '../../i18n/index.js';
import { resolveAppDisplayName } from '../../desktop/appRegistry.js';
import {
  CountdownGlyph,
  OverlayActions,
  OverlayGlyph,
  OverlayLayer,
  OverlayPanel,
  OverlayStatus,
  OverlayText,
  OverlayTitle,
  StepTracker,
  useActionSize,
  useBusyAction,
  useCountdown,
  useOverlaySize,
} from './overlayKit.jsx';

/** backend wait_for_app_lock_unlock `timeout_s` — sayaç halkası bu süreye göre boşalır. */
export const APPLOCK_WAIT_S = 15;

function Body({ phase, pkg, title, since, dynamic, onReclaim, onWakeDevice, onRetryPrompt, onDismiss }) {
  const size = useOverlaySize();
  const app = resolveAppDisplayName(pkg, title) || t('overlay.bu_uygulama');
  const left = useCountdown(APPLOCK_WAIT_S, since);
  // `dynamic`: pencere AÇIKKEN yeniden sorulan kilit. Backend süre aşımı beklemiyor (olay güdümlü izleyici): geri sayım ve "aktarılıyor"
  // adımları olmaz; kilit açılınca ya da iptal edilince katman kendiliğinden kapanır / "iptal" hâline geçer.
  const counting = !dynamic;
  const [wake, waking] = useBusyAction(onWakeDevice, 800);
  const [retry, retrying] = useBusyAction(onRetryPrompt, 800);
  const [reclaim, reclaiming] = useBusyAction(onReclaim);
  const primarySize = useActionSize(true);
  const actionSize = useActionSize();
  const waiting = phase === 'waiting';

  const copy = {
    waiting: [t('overlay.kilit_baslik_bekleniyor'), t('overlay.kilit_aciklama_bekleniyor', { app })],
    cancelled: [t('overlay.kilit_iptal_baslik'), t('overlay.kilit_iptal_aciklama')],
    timeout: [t('overlay.kilit_zaman_baslik'), t('overlay.kilit_zaman_aciklama')],
  }[phase] || [];

  return (
    <OverlayPanel labelledBy="applock-title" describedBy="applock-text">
      {waiting && counting ? (
        <CountdownGlyph icon={Fingerprint} seconds={APPLOCK_WAIT_S} runKey={since} tone="ok" />
      ) : waiting ? (
        <OverlayGlyph icon={Fingerprint} tone="ok" pulse />
      ) : (
        <OverlayGlyph icon={phase === 'timeout' ? TimerOff : LockKeyhole} tone="warn" />
      )}

      <div className="flex flex-col items-center gap-1">
        <OverlayTitle id="applock-title">{copy[0]}</OverlayTitle>
        <OverlayText id="applock-text" hideOnXs>{copy[1]}</OverlayText>
      </div>

      {waiting && (
        <>
          <OverlayStatus>
            {t('overlay.kilit_durum_bekleniyor')}
            {counting && <span aria-hidden="true" className="ml-1.5 text-foreground">· {t('overlay.kilit_kalan_sure', { seconds: left })}</span>}
          </OverlayStatus>
          {counting && (
            <StepTracker
              label={t('overlay.kilit_adimlar')}
              current={0}
              steps={[
                { id: 'wait', label: t('overlay.kilit_adim_bekleniyor') },
                { id: 'verify', label: t('overlay.kilit_adim_dogrulandi') },
                { id: 'move', label: t('overlay.kilit_adim_aktariliyor') },
              ]}
            />
          )}
        </>
      )}

      <OverlayActions>
        {!waiting && onRetryPrompt && (
          <Button size={primarySize} loading={retrying} onClick={retry} startIcon={<RotateCw className="size-3.5" />} autoFocus>
            {phase === 'timeout' ? t('overlay.tekrar_dene') : t('overlay.kilidi_yeniden_iste')}
          </Button>
        )}
        <Button size={actionSize} variant="outline" loading={waking} onClick={wake} startIcon={<Smartphone className="size-3.5" />}>
          {waking ? t('window.uyandiriliyor') : t('window.ekrani_uyandir')}
        </Button>
        {waiting && size !== 'xs' && (
          <Button size={actionSize} variant="ghost" loading={reclaiming} onClick={reclaim}>
            {reclaiming ? t('window.kontrol_ediliyor') : t('window.kilidi_actim_devam_et')}
          </Button>
        )}
        <Button
          size={actionSize}
          variant="ghost"
          onClick={onDismiss}
          className="text-muted-foreground"
          aria-label={size === 'xs' ? t('common.kapat') : undefined}
          startIcon={size === 'xs' ? <X className="size-3.5" /> : undefined}
        >
          {size === 'xs' ? null : t('common.kapat')}
        </Button>
      </OverlayActions>
    </OverlayPanel>
  );
}

export default function AppLockOverlay({ phase = 'waiting', pkg, title, since, dynamic = false, ...handlers }) {
  return (
    <OverlayLayer tone="veil" data-testid="applock-overlay" data-phase={phase} data-dynamic={dynamic ? 'true' : undefined}>
      <Body phase={phase} pkg={pkg} title={title} since={since} dynamic={dynamic} {...handlers} />
    </OverlayLayer>
  );
}
