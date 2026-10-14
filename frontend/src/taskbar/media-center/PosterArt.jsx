// Afişin kapağı: panelin tepesinde kenardan kenara. Kapak kutuyu HER boyutta doldurur (sağ/sol asla boş kalmaz, object-cover): kutu
// kapağın kendi oranını alır, normal boyutta hiçbir şey kırpılmaz; pencere küçülüp yükseklik sınırına (ekranın %44'ü) takılırsa
// kapak genişliğe göre ölçeklenir, yalnız üst/alt hafifçe kırpılır. Başlık kapağı örtmez: kutunun altındaki 48 px'lik şeride oturur.
//
//   hazır olunca geçiş  Parça değişince yeni kapak HAZIR (indirildi, çözüldü, boyutu bilindi) olana dek eski kapak yerinde kalır;
//                       hazır olunca eski yana kayarak söner, yenisi yönüne (sonraki → sağdan, önceki → soldan) yumuşakça
//                       oturur ve üstünden bir ışık süpürmesi geçer. Kullanıcı hiç "boş kare / uygulama simgesi" görmez, gecikme de
//                       hissetmez: geçiş zaten hazır olan bir görüntüyle başlar.
//   yükseklik           Kutu bir `aspect-ratio` kutusudur ve oranı kapağın doğal oranından gelir (geniş kapak alçalır, dikey kapak
//                       yükselir; bkz. mediaCenterModel.posterRatioFor). Oran kapak GEÇİŞİYLE AYNI ANDA değişir ve CSS ile
//                       yumuşakça geçilir; bu yüzden ardışık parçalarda kutu zıplamaz, kayar.
//   güvenlik            Yeni kapak ~3 sn içinde gelmezse (ya da kapaksız/bozuksa) eski kapak YANLIŞ kapak olarak kalmaz: uygulama
//                       simgesine geçilir. Kapağı kesin olmayan parça 0,3 sn bekletilir (kapak hemen gelebilir; simge çakması olmaz).
//   yaşam               çalarken yavaş Ken Burns (CSS, tek compositor katmanı); duraklayınca donar + hafif kararır (opacity)
// Kapak katmanlarında blur/filter yok; üst rozet şeridi `children` ile gelir (scrim zemin, backdrop-filter yok).

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Music2 } from 'lucide-react';
import AppIcon from '../../ui/AppIcon.jsx';
import { cn } from '../../lib/utils.js';
import { artEnter, artSlide } from './choreography.js';
import { POSTER_BASE_RATIO, posterMaxHeight, posterRatioFor } from './mediaCenterModel.js';
import { t } from '../../i18n/index.js';

export const HOLD_MAX_MS = 3200;      // yeni kapak bu sürede hazır olmazsa eski kapak bırakılır
export const NONE_SETTLE_MS = 320;    // kapağı kesin olmayan parça için simgeye geçmeden önce bekleme
export const HINT_DELAY_MS = 380;     // "yeni kapak yükleniyor" ince çubuğu bu sürede hâlâ bekleniyorsa görünür

const FALLBACK = (pkg) => ({ kind: 'fallback', key: `fb:${pkg || 'none'}`, pkg, ratio: null });

/** Görüntüyü yükleyip çözer; doğal boyutla döner. Hata ya da boş boyut → reddedilir. */
export function preloadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    img.onload = () => done(resolve, { w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => done(reject, new Error('art-load-failed'));
    img.decoding = 'async';
    img.src = src;
  });
}

/**
 * Ekranda gösterilen kapak durumu. `art`: yeni parçanın kapağı (boşsa yok ya da yolda), `artPending`: yolda mı.
 * Döner: { shown, holding } — `shown` = { kind: 'skeleton'|'image'|'fallback', key, src?, ratio, seq, dir }.
 * `seq` her gösterim değişiminde artar (ilk gösterimden sonra geçiş efektini tetikler); `dir` geçiş yönüdür.
 */
export function useShownCover({ art, artPending, pkg, directionRef, preload = preloadImage }) {
  // Açılışta kapağı kesin olmayan oturum doğrudan simgeyle başlar (iskelet 0,3 sn çakmaz); kapak varsa/yoldaysa iskelet.
  const [shown, setShown] = useState(() => (!art && !artPending
    ? { ...FALLBACK(pkg), seq: 1, dir: 1 }
    : { kind: 'skeleton', key: 'skeleton', ratio: null, seq: 0, dir: 1 }));
  const [holding, setHolding] = useState(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    let alive = true;
    const timers = [];
    // Bekleme süresi dolunca simgeye geçen zamanlayıcı: yeni kapak GELİNCE (ya da hata verince) iptal edilir; yoksa kapak
    // görüntülendikten sonra bile süre dolup kendiliğinden simgeye dönerdi.
    let holdTimer = null;
    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
    };
    const commit = (next) => {
      if (!alive) return;
      cancelHold();
      setHolding(false);
      setShown((prev) => (prev.key === next.key
        ? prev
        : { ...next, seq: prev.seq + 1, dir: directionRef?.current >= 0 ? 1 : -1 }));
    };

    if (art) {
      if (shownRef.current.src === art) {
        setHolding(false);
      } else {
        setHolding(shownRef.current.kind !== 'skeleton');
        preload(art)
          .then(({ w, h }) => commit({ kind: 'image', key: `img:${art}`, src: art, ratio: posterRatioFor(w, h) }))
          .catch(() => commit(FALLBACK(pkg)));
        holdTimer = setTimeout(() => commit(FALLBACK(pkg)), HOLD_MAX_MS);
      }
    } else if (artPending) {
      setHolding(shownRef.current.kind === 'image');
      holdTimer = setTimeout(() => commit(FALLBACK(pkg)), HOLD_MAX_MS);
    } else {
      setHolding(false);
      timers.push(setTimeout(() => commit(FALLBACK(pkg)), NONE_SETTLE_MS));
    }
    return () => {
      alive = false;
      cancelHold();
      timers.forEach(clearTimeout);
    };
  }, [art, artPending, pkg]); // eslint-disable-line react-hooks/exhaustive-deps -- preload/directionRef sabit kaynaklar

  return { shown, holding };
}

function CoverLayer({ shown }) {
  if (shown.kind === 'image') {
    return (
      <span className="absolute inset-0" data-art-state="image">
        {/* object-cover: kutuyu kenardan kenara doldurur (yanlarda boşluk yok); kırpma gerekirse üst/alttan, ağırlık üst %40'ta. */}
        <img
          src={shown.src}
          alt=""
          draggable={false}
          decoding="async"
          className="absolute inset-0 size-full object-cover object-[50%_40%]"
        />
      </span>
    );
  }
  if (shown.kind === 'fallback') {
    return (
      <span className="media-poster-fallback absolute inset-0" data-art-state="fallback">
        <span className="absolute inset-0 grid place-items-center pb-14" aria-hidden="true">
          {shown.pkg
            ? <AppIcon pkg={shown.pkg} size={72} className="drop-shadow-xl" />
            : <Music2 className="size-14 text-[var(--media-ink)]" strokeWidth={1.5} />}
        </span>
      </span>
    );
  }
  return (
    <span className="media-poster-fallback absolute inset-0" data-art-state="pending" data-art-pending="true">
      <span className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-foreground/10 to-transparent" aria-hidden="true" />
    </span>
  );
}

export function PosterArt({ session, playing, directionRef, preload, children }) {
  const reduce = useReducedMotion();
  const { shown, holding } = useShownCover({
    art: session.art, artPending: session.artPending, pkg: session.package, directionRef, preload,
  });
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!holding) {
      setHint(false);
      return undefined;
    }
    const timer = setTimeout(() => setHint(true), HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [holding]);

  const slide = artSlide(reduce);
  const ratio = shown.ratio;
  const grown = Boolean(ratio);

  return (
    // Yükseklik: genişlikten `aspect-ratio` ile (box-content: oran YALNIZ kapak alanına uygulanır, altındaki 48 px başlık şeridi
    // ayrıdır); üst sınır taban kutuda min(294 px, %34 ekran), kapaklıda %44 ekran. Hem oran hem sınır CSS ile yumuşakça geçilir.
    // Panel ekrana sığmazsa kapak alanı 152 px'e kadar kısalır (kapak object-cover: yanlar dolu kalır, üst/alt hafifçe kırpılır).
    <motion.div
      variants={artEnter}
      data-testid="media-poster-frame"
      data-poster-grown={grown ? 'true' : undefined}
      className="relative box-content min-h-[152px] shrink pb-12 transition-[aspect-ratio,max-height] duration-[480ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
      style={{ aspectRatio: String(ratio ?? POSTER_BASE_RATIO), maxHeight: posterMaxHeight(grown) }}
    >
      <div className="absolute inset-x-0 top-0 bottom-12 overflow-hidden" data-testid="media-poster">
        <AnimatePresence initial={false} custom={shown.dir}>
          <motion.div
            key={shown.key}
            custom={shown.dir}
            variants={slide}
            initial="enter"
            animate="center"
            exit="exit"
            className="absolute inset-0"
          >
            <span className="media-kenburns absolute inset-0" data-running={playing && !reduce ? 'true' : 'false'}>
              <CoverLayer shown={shown} />
            </span>
          </motion.div>
        </AnimatePresence>

        {/* Işık süpürmesi: yalnız GERÇEK bir kapak değişiminde (ilk gösterimde değil); yeni kapakla AYNI yönde (sonraki: sağdan sola) tek geçiş. */}
        {shown.seq > 1 && !reduce && (
          <motion.span
            key={`sweep:${shown.seq}`}
            data-testid="media-poster-sweep"
            initial={{ x: `${130 * shown.dir}%`, opacity: 0 }}
            animate={{ x: `${-130 * shown.dir}%`, opacity: [0, 0.5, 0] }}
            transition={{ duration: 0.85, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none absolute inset-y-0 left-0 z-[2] w-1/2 bg-gradient-to-r from-transparent via-white/25 to-transparent"
            aria-hidden="true"
          />
        )}

        <span
          className={cn('pointer-events-none absolute inset-0 z-[2] bg-scrim transition-opacity duration-300 ease-out', playing ? 'opacity-0' : 'opacity-[0.22]')}
          data-testid="media-poster-dim"
          aria-hidden="true"
        />
        <span className="media-poster-fade pointer-events-none absolute inset-0 z-[2]" aria-hidden="true" />

        {/* Yeni kapak yolda: üst kenarda ince, kayan çubuk (yalnız hâlâ bekleniyorsa; hızlı gelende hiç görünmez). */}
        {hint && (
          <span className="pointer-events-none absolute inset-x-0 top-0 z-[3] h-0.5 overflow-hidden" data-testid="media-poster-loading" role="status" aria-label={t('taskbar.yeni_kapak_yukleniyor')}>
            <motion.span
              className="block h-full w-1/3 rounded-full bg-[var(--media-ink)] opacity-70"
              initial={{ x: '-100%' }}
              animate={{ x: '300%' }}
              transition={{ duration: 1.15, ease: 'easeInOut', repeat: Infinity }}
            />
          </span>
        )}

        {children && <div className="absolute inset-x-3 top-3 z-[3] flex items-start justify-between gap-2">{children}</div>}
      </div>
    </motion.div>
  );
}

export default PosterArt;
