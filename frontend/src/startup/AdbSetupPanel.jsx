// "adb is needed" — the boot screen's answer when this computer has no adb (the app does not bundle it, and without it nothing
// reaches the phone). One obvious path (Otomatik kur: Google's official platform-tools, checked and kept in OpenDeX's own folder),
// two quiet ones (an adb the user already has; Google's page), and it needs no clicking when the user installs adb themselves:
// the backend is asked again every few seconds and whenever the window regains focus (useAdbSetup).
//
// Three views, one at a time: the offer · the install (a single honest bar) · "adb hazır" for a moment, then the boot goes on.
// State and polling: useAdbSetup.js. Backend: app/device/adb_setup.py.
import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, FolderSearch, RotateCw, ShieldCheck, TerminalSquare } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { t } from '../i18n/index.js';
import { installPercent, useAdbSetup } from './useAdbSetup.js';

const READY_HOLD_MS = 1100;          // "adb hazır" stays readable for a moment before the boot goes on
const READY_HOLD_REDUCED_MS = 500;

const phaseText = (phase) => ({
  manifest: t('startup.adb_faz_manifest'),
  download: t('startup.adb_faz_download'),
  verify: t('startup.adb_faz_verify'),
  extract: t('startup.adb_faz_extract'),
})[phase] || t('startup.adb_faz_manifest');

/** The words for what went wrong: the install's own failures, or what a refused pick said. */
function problemText(problem) {
  if (!problem) return null;
  if (problem.kind === 'locate') {
    return {
      title: t('startup.adb_secim_hata_baslik'),
      body: ({
        not_found: t('startup.adb_hata_not_found'),
        not_adb: t('startup.adb_hata_not_adb'),
        broken: t('startup.adb_hata_broken'),
      })[problem.code] || t('startup.adb_hata_broken'),
    };
  }
  return {
    title: t('startup.adb_hata_baslik'),
    body: ({
      network: t('startup.adb_hata_network'),
      checksum: t('startup.adb_hata_checksum'),
      size: t('startup.adb_hata_size'),
      disk: t('startup.adb_hata_disk'),
      bad_archive: t('startup.adb_hata_bad_archive'),
      verify_failed: t('startup.adb_hata_verify_failed'),
      manifest: t('startup.adb_hata_manifest'),
      unsupported_os: t('startup.adb_hata_manifest'),
    })[problem.code] || t('startup.adb_hata_failed'),
  };
}

const megabytes = (bytes) => new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1048576);

function QuietButton({ icon: Icon, onClick, busy = false, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex h-9 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2.5 text-[11px] font-semibold text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
    >
      <Icon className={cn('size-3.5 shrink-0 text-muted-foreground', busy && 'animate-pulse')} aria-hidden="true" />
      <span className="truncate">{children}</span>
    </button>
  );
}

/**
 * @param {{resolved?: boolean, version?: string|null, onDone?: () => void}} props
 *   `resolved`: the backend's startup state says adb is there (found, installed or picked); `onDone` runs once the success
 *   moment has been shown — the boot screen then puts its steps back.
 */
export default function AdbSetupPanel({ resolved = false, version: knownVersion = null, onDone = () => {} }) {
  const reduce = useReducedMotion();
  const adb = useAdbSetup({ resolved });
  const view = adb.ready ? 'ready' : adb.installing ? 'installing' : 'offer';
  const version = adb.version || knownVersion;

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (view !== 'ready') return undefined;
    const timer = setTimeout(() => onDoneRef.current(), reduce ? READY_HOLD_REDUCED_MS : READY_HOLD_MS);
    return () => clearTimeout(timer);
  }, [view, reduce]);

  const view$ = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } }
    : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 }, transition: { duration: 0.18, ease: 'easeOut' } };

  const snap = adb.snap;
  const canInstall = snap?.can_install !== false;       // an OS Google publishes no platform-tools for: pick or the official page
  const problem = problemText(adb.problem);
  const install = snap?.install;
  const percent = installPercent(install);
  const downloading = install?.phase === 'download' && install.total > 0;

  return (
    <section aria-labelledby="adb-setup-title" className="w-full text-left">
      <AnimatePresence mode="wait" initial={false}>
        {view === 'ready' && (
          <motion.div key="ready" role="status" {...view$} className="flex flex-col items-center py-3 text-center">
            <motion.span
              initial={reduce ? false : { scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 22 }}
              className="grid size-12 place-items-center rounded-full bg-status-active/12 text-status-active ring-1 ring-status-active/30"
              aria-hidden="true"
            >
              <CheckCircle2 className="size-6" strokeWidth={2} />
            </motion.span>
            <h2 id="adb-setup-title" className="mt-3 text-[14px] font-bold tracking-tight text-foreground">{t('startup.adb_hazir')}</h2>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {version ? t('startup.adb_hazir_surum', { version }) : t('startup.adb_telefon_araniyor')}
            </p>
          </motion.div>
        )}

        {view === 'installing' && (
          <motion.div key="installing" aria-busy="true" {...view$}>
            <div className="flex items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary" aria-hidden="true">
                <span className="size-[18px] animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </span>
              <div className="min-w-0">
                <h2 id="adb-setup-title" className="text-[14px] font-bold leading-snug tracking-tight text-foreground">
                  {t('startup.adb_kuruluyor')}
                  {install?.version && <span className="ml-1.5 font-mono text-[10.5px] font-medium text-muted-foreground">{install.version}</span>}
                </h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground" aria-live="polite">{phaseText(install?.phase)}</p>
              </div>
            </div>

            <div className="mt-4">
              <div
                role="progressbar"
                aria-label={t('startup.adb_ilerleme_etiket')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="relative h-2 w-full overflow-hidden rounded-full border border-border/40 bg-muted"
              >
                <motion.div
                  className="relative h-full rounded-full bg-primary"
                  initial={false}
                  animate={{ width: `${percent}%` }}
                  transition={reduce ? { duration: 0 } : { duration: 0.3, ease: 'easeOut' }}
                >
                  <div className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-primary-foreground/20 to-transparent" />
                </motion.div>
              </div>
              <div className="mt-1.5 flex items-center justify-between font-mono text-[10.5px] tabular-nums text-muted-foreground">
                <span>
                  {downloading ? t('startup.adb_ilerleme_mb', { received: megabytes(install.received), total: megabytes(install.total) }) : ' '}
                </span>
                <span className="font-semibold text-primary">{percent}%</span>
              </div>
            </div>

            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={adb.cancel}
                className="inline-flex h-7 cursor-pointer items-center rounded-md px-2.5 text-[10.5px] font-semibold text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('startup.adb_vazgec')}
              </button>
            </div>
          </motion.div>
        )}

        {view === 'offer' && (
          <motion.div key="offer" {...view$}>
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-warning/30 bg-warning/10 text-warning" aria-hidden="true">
                <TerminalSquare className="size-[18px]" strokeWidth={1.9} />
              </span>
              <div className="min-w-0">
                <h2 id="adb-setup-title" className="text-[14px] font-bold leading-snug tracking-tight text-foreground">{t('startup.adb_baslik')}</h2>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t('startup.adb_aciklama')}</p>
              </div>
            </div>

            {problem && (
              <div role="alert" className="mt-3.5 flex items-start gap-2 rounded-lg border border-window-close/35 bg-window-close/5 px-2.5 py-2">
                <AlertTriangle className="mt-px size-3.5 shrink-0 text-window-close" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold leading-snug text-foreground">{problem.title}</p>
                  <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">{problem.body}</p>
                </div>
              </div>
            )}

            {canInstall && (
              <>
                <button
                  type="button"
                  autoFocus
                  onClick={adb.install}
                  disabled={adb.pending === 'install'}
                  className="mt-4 flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl bg-primary px-3.5 text-primary-foreground shadow-sm outline-none transition-[background-color,transform] hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover active:scale-[0.99] disabled:cursor-default disabled:opacity-70"
                >
                  <Download className="size-4 shrink-0" strokeWidth={2.2} aria-hidden="true" />
                  <span className="flex-1 text-left text-[12.5px] font-semibold">
                    {adb.problem?.kind === 'install' ? t('startup.adb_tekrar_dene') : t('startup.adb_otomatik_kur')}
                  </span>
                  {snap?.approx_mb ? (
                    <span className="font-mono text-[10.5px] tabular-nums opacity-75">{t('startup.adb_boyut', { mb: snap.approx_mb })}</span>
                  ) : null}
                </button>
                <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-muted-foreground">
                  <ShieldCheck className="mt-px size-3 shrink-0 text-status-active/80" aria-hidden="true" />
                  <span>{t('startup.adb_guven_notu', { dir: snap?.install_dir || '~/.opendex/platform-tools' })}</span>
                </p>

                <div className="my-3.5 flex items-center gap-2.5" role="separator">
                  <span className="h-px flex-1 bg-border/60" />
                  <span className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground/80">{t('startup.adb_ya_da')}</span>
                  <span className="h-px flex-1 bg-border/60" />
                </div>
              </>
            )}

            <div className={cn('grid gap-2', adb.canPick ? 'grid-cols-2' : 'grid-cols-1', !canInstall && 'mt-4')}>
              {adb.canPick && (
                <QuietButton icon={FolderSearch} onClick={adb.pick} busy={adb.pending === 'locate'}>{t('startup.adb_dosya_sec')}</QuietButton>
              )}
              <QuietButton icon={ExternalLink} onClick={adb.openPage}>{t('startup.adb_resmi_sayfa')}</QuietButton>
            </div>

            <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-border/50 pt-3">
              <p className="min-w-0 text-[10px] leading-snug text-muted-foreground" aria-live="polite">
                {adb.pending === 'recheck' ? t('startup.adb_araniyor') : t('startup.adb_otomatik_algila')}
              </p>
              <button
                type="button"
                onClick={adb.recheck}
                disabled={adb.pending === 'recheck'}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[10.5px] font-semibold text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
              >
                <RotateCw className={cn('size-3', adb.pending === 'recheck' && 'animate-spin')} aria-hidden="true" />
                {t('startup.adb_tekrar_ara')}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
