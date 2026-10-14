import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  Zap,
  Radio,
  Wifi,
  ChevronDown,
  ChevronUp,
  X,
  Layers,
  Gauge,
  Sparkles,
  Timer,
  Hourglass,
} from 'lucide-react';
import { startBackendRttProbe, useBackendRtt } from '../media/rttProbe.js';
import { t } from '../i18n/index.js';

// Ölçülemeyen değer HİÇBİR ZAMAN uydurulmaz: null → "—". (Eski sürüm rtt=12/6, fps=60,
// jitter=0.3 gibi sabitleri ve `fps || 60` gibi "0 ise 60 göster" kalıplarını kullanıyordu.)
const show = (v, unit = '') => (v == null || Number.isNaN(v) ? '—' : `${v}${unit}`);

const Row = ({ icon: Icon, iconClass, label, title, children }) => (
  <div className="flex items-center justify-between gap-2 py-0.5 px-1.5 rounded bg-scrim-foreground/[0.03]" title={title}>
    <span className="text-scrim-foreground/60 flex items-center gap-1.5 shrink-0">
      <Icon className={`w-3 h-3 ${iconClass}`} />
      {label}:
    </span>
    <span className="text-right">{children}</span>
  </div>
);

/**
 * LatencyHudOverlay: yayın telemetrisi. Bütün sayılar decoder'ın GERÇEK ölçümleridir
 * (bkz. media/streamStats.js, media/rttProbe.js).
 *
 * RTT = arayüz⟷backend (olay soketi ping/pong). Telefon⟷PC ADB halkasını KAPSAMAZ.
 * Bu HUD "uçtan uca (kameradan ekrana)" gecikme iddia ETMEZ — cihaz ve tarayıcı saatleri
 * ortak olmadığından bu değer güvenilir ölçülemez; onun yerine tıkanmayı gösteren
 * "birikme" (kuyruk gecikmesi) ve çözme gecikmesi gösterilir.
 */
export default function LatencyHudOverlay({ win, decoder, hasFrame }) {
  const [stats, setStats] = useState(null); // ilk gerçek örneğe kadar HİÇBİR sayı gösterilmez
  const [isExpanded, setIsExpanded] = useState(false);
  // Hidden until the user asks for it (F8): a measurement overlay on every window is not a default.
  const [isVisible, setIsVisible] = useState(false);
  // Always-mounted anchor (also while the HUD is hidden): tells which document this overlay is drawn in.
  const anchorRef = useRef(null);
  const rtt = useBackendRtt();

  useEffect(() => startBackendRttProbe(), []);

  useEffect(() => {
    // A new decoder starts a new measurement: the previous decoder's last numbers must not linger as if current.
    setStats(null);
    if (!decoder || typeof decoder.onStats !== 'function') return undefined;
    const handleStats = (next) => setStats(next);
    decoder.onStats(handleStats);
    return () => {
      if (typeof decoder.offStats === 'function') decoder.offStats(handleStats);
    };
  }, [decoder]);

  // Keyboard shortcut F8: Toggle HUD visibility. Keys are delivered to the window of the document that has the focus, so
  // the listener belongs to the window THIS overlay is drawn in: a window popped out to Picture-in-Picture lives in
  // another document, where a listener on the main `window` never fires (the HUD could not be hidden there).
  useEffect(() => {
    const view = anchorRef.current?.ownerDocument?.defaultView || window;
    const onKey = (e) => {
      if (e.key === 'F8') {
        e.preventDefault();
        setIsVisible((v) => !v);
      }
    };
    view.addEventListener('keydown', onKey);
    return () => view.removeEventListener('keydown', onKey);
  }, []);

  if (!isVisible || !hasFrame) return <span ref={anchorRef} hidden aria-hidden="true" />;

  // Tıkanıklık ANLIK durumu yansıtır: kuyrukta 100ms üzeri birikme varsa veya bu pencerede kare atlanıyorsa.
  // Kümülatif toplam resync sayacı burayı kalıcı olarak kilitlemez; sistem normale dönünce rozet kendiliğinden kaybolur.
  const backlogged = (stats?.queueMs ?? 0) > 100 || (stats?.skipped ?? 0) > 0;

  // Renk yalnızca GERÇEK bir ölçüme göre; ölçüm yoksa nötr.
  let pingColor = 'text-scrim-foreground/60';
  let pingDotColor = 'bg-scrim-foreground/40';
  let qualityText = t('window.olculemiyor');
  if (rtt != null) {
    if (rtt > 65) {
      pingColor = 'text-destructive';
      pingDotColor = 'bg-destructive shadow-[0_0_8px_var(--destructive)]';
      qualityText = t('window.gecikmeli');
    } else if (rtt > 30) {
      pingColor = 'text-warning';
      pingDotColor = 'bg-warning shadow-[0_0_8px_var(--warning)]';
      qualityText = t('common.dengeli_2');
    } else {
      pingColor = 'text-status-active';
      pingDotColor = 'bg-status-active shadow-[0_0_8px_var(--status-active)]';
      qualityText = t('common.iyi');
    }
  }

  return (
    <div ref={anchorRef} className="absolute top-2.5 right-2.5 z-30 pointer-events-auto flex flex-col items-end select-none font-mono">
      {/* Compact Pill Badge */}
      <motion.button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-scrim hover:bg-scrim/95 backdrop-blur-md border border-scrim-foreground/10 hover:border-info/40 shadow-window text-[11px] text-scrim-foreground transition-colors duration-150 cursor-pointer"
        title={t('window.canli_yayin_olcumlerini_genisletmek')}
      >
        <span className="relative flex h-2 w-2">
          {rtt != null && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${pingDotColor}`} />}
          <span className={`relative inline-flex rounded-full h-2 w-2 ${pingDotColor}`} />
        </span>

        <span className={`font-bold tracking-tight ${pingColor}`}>
          {show(rtt)} <span className="text-[9px] font-normal text-scrim-foreground/60">{t('window.ms')}</span>
        </span>

        <span className="text-scrim-foreground/35">•</span>

        <span className="font-semibold text-scrim-foreground/85">
          {show(stats?.fps)} <span className="text-[9px] font-normal text-scrim-foreground/60">{t('window.fps')}</span>
        </span>

        <span className="text-scrim-foreground/35">•</span>

        <span
          className="text-[9px] px-1.5 py-0.5 rounded font-semibold tracking-wider uppercase bg-scrim-foreground/10 text-scrim-foreground/85 border border-scrim-foreground/15"
          title={t('window.tcp_webcodecs')}
        >
          {t('window.tcp')}
        </span>

        {backlogged && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-warning/20 text-warning border border-warning/30" title={t('window.yayin_tikandi_biriken_kareler')}>
            {t('window.tikaniklik')}
          </span>
        )}

        {isExpanded ? <ChevronUp className="w-3 h-3 text-scrim-foreground/60 ml-0.5" /> : <ChevronDown className="w-3 h-3 text-scrim-foreground/60 ml-0.5" />}
      </motion.button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 4, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="w-80 mt-1.5 p-3 rounded-xl bg-scrim backdrop-blur-xl border border-scrim-foreground/10 shadow-window text-xs text-scrim-foreground ring-1 ring-info/20"
          >
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-scrim-foreground/10">
              <div className="flex items-center gap-1.5 text-info text-[10px] font-bold tracking-wider uppercase">
                <Activity className="w-3.5 h-3.5 animate-pulse" />
                <span>{t('window.yayin_telemetrisi')}</span>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsExpanded(false);
                }}
                className="text-scrim-foreground/60 hover:text-scrim-foreground p-0.5 rounded transition-colors"
                title={t('common.kucult')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="space-y-1.5 text-[11px]">
              <Row
                icon={Zap}
                iconClass="text-warning"
                label={t('window.arayuz_backend_rtt')}
                title={t('window.olay_soketi_ping_pong_ile_olculur')}
              >
                <span className={`font-bold ${pingColor}`}>
                  {show(rtt, ' ms')} <span className="text-[9px] font-normal text-scrim-foreground/60">({qualityText})</span>
                </span>
              </Row>

              <Row icon={Gauge} iconClass="text-info" label={t('window.kare_hizi_cizilen')} title={t('window.ekrana_gercekten_cizilen_kare_sn')}>
                <span className="font-bold text-info">{show(stats?.fps, ' FPS')}</span>
                {stats?.decodedFps != null && stats.decodedFps !== stats.fps && (
                  <span className="text-[9px] text-scrim-foreground/50"> {' '}{t('window.cozulen_decodedfps', { decodedFps: stats.decodedFps })}</span>
                )}
              </Row>

              <Row icon={Timer} iconClass="text-info" label={t('window.cozme_gecikmesi')} title={t('window.karenin_agdan_gelisinden_ekrana')}>
                <span className="text-scrim-foreground">{show(stats?.decodeMs, ' ms')}</span>
              </Row>

              <Row icon={Hourglass} iconClass="text-warning" label={t('window.birikme_kuyruk_gecikmesi')} title={t('window.tek_yon_gecikmenin_son_10_sn')}>
                <span className={(stats?.queueMs ?? 0) > 100 ? 'text-warning font-bold' : 'text-scrim-foreground'}>{show(stats?.queueMs, ' ms')}</span>
              </Row>

              <Row icon={Radio} iconClass="text-info" label={t('window.jitter')} title={t('window.kare_varis_araliginin_kaynak_zaman')}>
                <span className="text-scrim-foreground">{show(stats?.jitterMs, ' ms')}</span>
              </Row>

              <Row icon={Wifi} iconClass="text-destructive" label={t('window.atlanan_kare_resync')} title={t('window.cozulup_sunumu_atlanan_eski_kareler')}>
                <span className={(stats?.resyncs ?? 0) > 0 ? 'text-warning font-bold' : 'text-scrim-foreground/85'}>
                  {t('window.show_sn', { show: show(stats?.skipped) })}{' '} <span className="text-[9px] text-scrim-foreground/50">{t('window.toplam_show_resync_show2', { show: show(stats?.totalSkipped), show2: show(stats?.resyncs) })}</span>
                </span>
              </Row>

              <Row icon={Sparkles} iconClass="text-status-active" label={t('window.alinan_bant_genisligi')} title={t('window.agdan_alinan_video_verisi_mbps')}>
                <span className="text-status-active font-semibold">{show(stats?.bitrateMbps, ' Mbps')}</span>
              </Row>

              <Row icon={Layers} iconClass="text-scrim-foreground/60" label={t('window.cihaz_cozunurlugu')}>
                <span className="text-scrim-foreground/85">
                  {win?.deviceW || win?.w}×{win?.deviceH || win?.h}
                </span>
              </Row>

              <Row icon={Activity} iconClass="text-info" label={t('window.iletim_protokolu')}>
                <span className="font-semibold text-scrim-foreground/85">{t('window.tcp_webcodecs_2')}</span>
              </Row>
            </div>

            <div className="mt-2 text-[9px] text-scrim-foreground/50 text-center">
              {t('window.olculemedi_uydurma_deger_gosterilmez')}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
