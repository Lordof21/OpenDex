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
  const [isVisible, setIsVisible] = useState(true);
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

  const backlogged = (stats?.queueMs ?? 0) > 100 || (stats?.resyncs ?? 0) > 0;

  // Renk yalnızca GERÇEK bir ölçüme göre; ölçüm yoksa nötr.
  let pingColor = 'text-scrim-foreground/60';
  let pingDotColor = 'bg-scrim-foreground/40';
  let qualityText = 'Ölçülemiyor';
  if (rtt != null) {
    if (rtt > 65) {
      pingColor = 'text-destructive';
      pingDotColor = 'bg-destructive shadow-[0_0_8px_var(--destructive)]';
      qualityText = 'Gecikmeli';
    } else if (rtt > 30) {
      pingColor = 'text-warning';
      pingDotColor = 'bg-warning shadow-[0_0_8px_var(--warning)]';
      qualityText = 'Dengeli';
    } else {
      pingColor = 'text-status-active';
      pingDotColor = 'bg-status-active shadow-[0_0_8px_var(--status-active)]';
      qualityText = 'İyi';
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
        title="Canlı yayın ölçümlerini genişletmek için tıklayın (F8: Gizle/Göster)"
      >
        <span className="relative flex h-2 w-2">
          {rtt != null && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${pingDotColor}`} />}
          <span className={`relative inline-flex rounded-full h-2 w-2 ${pingDotColor}`} />
        </span>

        <span className={`font-bold tracking-tight ${pingColor}`}>
          {show(rtt)} <span className="text-[9px] font-normal text-scrim-foreground/60">ms</span>
        </span>

        <span className="text-scrim-foreground/35">•</span>

        <span className="font-semibold text-scrim-foreground/85">
          {show(stats?.fps)} <span className="text-[9px] font-normal text-scrim-foreground/60">FPS</span>
        </span>

        <span className="text-scrim-foreground/35">•</span>

        <span
          className="text-[9px] px-1.5 py-0.5 rounded font-semibold tracking-wider uppercase bg-scrim-foreground/10 text-scrim-foreground/85 border border-scrim-foreground/15"
          title="TCP + WebCodecs"
        >
          TCP
        </span>

        {backlogged && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-warning/20 text-warning border border-warning/30" title="Yayın tıkandı: biriken kareler atlanıyor / decoder sıfırlandı">
            TIKANIKLIK
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
                <span>YAYIN TELEMETRİSİ</span>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsExpanded(false);
                }}
                className="text-scrim-foreground/60 hover:text-scrim-foreground p-0.5 rounded transition-colors"
                title="Küçült"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="space-y-1.5 text-[11px]">
              <Row
                icon={Zap}
                iconClass="text-warning"
                label="Arayüz⟷Backend RTT"
                title="Olay soketi ping/pong ile ölçülür. Telefon⟷PC (ADB) halkasını kapsamaz."
              >
                <span className={`font-bold ${pingColor}`}>
                  {show(rtt, ' ms')} <span className="text-[9px] font-normal text-scrim-foreground/60">({qualityText})</span>
                </span>
              </Row>

              <Row icon={Gauge} iconClass="text-info" label="Kare Hızı (çizilen)" title="Ekrana gerçekten çizilen kare/sn. Statik ekranda 0 olması normaldir.">
                <span className="font-bold text-info">{show(stats?.fps, ' FPS')}</span>
                {stats?.decodedFps != null && stats.decodedFps !== stats.fps && (
                  <span className="text-[9px] text-scrim-foreground/50"> · çözülen {stats.decodedFps}</span>
                )}
              </Row>

              <Row icon={Timer} iconClass="text-info" label="Çözme Gecikmesi" title="Karenin ağdan gelişinden ekrana çizilmesine kadar geçen süre.">
                <span className="text-scrim-foreground">{show(stats?.decodeMs, ' ms')}</span>
              </Row>

              <Row icon={Hourglass} iconClass="text-warning" label="Birikme (kuyruk gecikmesi)" title="Tek yön gecikmenin son 10 sn minimumuna göre fazlası. Sağlıklı akışta ~0; ağ/decoder tıkanınca büyür.">
                <span className={(stats?.queueMs ?? 0) > 100 ? 'text-warning font-bold' : 'text-scrim-foreground'}>{show(stats?.queueMs, ' ms')}</span>
              </Row>

              <Row icon={Radio} iconClass="text-info" label="Jitter" title="Kare varış aralığının kaynak zaman damgası aralığından sapması.">
                <span className="text-scrim-foreground">{show(stats?.jitterMs, ' ms')}</span>
              </Row>

              <Row icon={Wifi} iconClass="text-destructive" label="Atlanan Kare / Resync" title="Çözülüp sunumu atlanan eski kareler (hızlı sarma önleme) ve decoder'ın sıfırlanıp keyframe beklediği sayı. TCP'de paket kaybı yoktur.">
                <span className={(stats?.resyncs ?? 0) > 0 ? 'text-warning font-bold' : 'text-scrim-foreground/85'}>
                  {show(stats?.skipped)}/sn <span className="text-[9px] text-scrim-foreground/50">(toplam {show(stats?.totalSkipped)} · resync {show(stats?.resyncs)})</span>
                </span>
              </Row>

              <Row icon={Sparkles} iconClass="text-status-active" label="Alınan Bant Genişliği" title="Ağdan alınan video verisi (Mbps).">
                <span className="text-status-active font-semibold">{show(stats?.bitrateMbps, ' Mbps')}</span>
              </Row>

              <Row icon={Layers} iconClass="text-scrim-foreground/60" label="Cihaz Çözünürlüğü">
                <span className="text-scrim-foreground/85">
                  {win?.deviceW || win?.w}×{win?.deviceH || win?.h}
                </span>
              </Row>

              <Row icon={Activity} iconClass="text-info" label="İletim Protokolü">
                <span className="font-semibold text-scrim-foreground/85">TCP WebCodecs</span>
              </Row>
            </div>

            <div className="mt-2 text-[9px] text-scrim-foreground/50 text-center">
              "—" = ölçülemedi (uydurma değer gösterilmez) · Gizlemek için [F8]
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
