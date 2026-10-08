// Kapak resmini çizen katman: uygulama kabuğunun İLK çocuğu (diğer her şey DOM sırasıyla üstüne biner), tıklamaları geçirir.
//
//   - Kapak değişince eski ile yeni ÇAPRAZ GEÇİŞLE değişir (yeni üstte belirir, eski altta kalır → ara kare "boş zemin" olmaz).
//   - Kullanıcı resmi önce çözülür (decode), sonra gösterilir: yarım yüklenmiş resim parlaması olmaz.
//   - Bulanıklık/karartma/yerleşim değişiklikleri çapraz geçiş YAPMAZ, anında uygulanır (kaydırıcı elde canlı kalır).
//   - Blob URL'leri geçiş bitince iptal edilir; bileşen kalkarken hepsi serbest bırakılır.
import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { imageStore } from './imageStore.js';
import { artStyle, blurStyle, dimStyle } from './layerStyle.js';
import { DEFAULT_PREFS } from './prefs.js';
import { useWallpaperStore } from './wallpaperStore.js';

const FADE_S = 0.65;
const REVOKE_AFTER_MS = FADE_S * 1000 + 500;

async function decode(url) {
  const img = new Image();
  img.src = url;
  if (typeof img.decode === 'function') await img.decode();
}

/**
 * Çizilecek kapağı "hazır" olana dek önceki kapakta tutar. Hazır = kullanıcı resmi çözüldü (hazır kapaklar anında hazırdır).
 * @returns {{ wp: object, url: string|null }}
 */
function useStagedWallpaper(wallpaper, readBlob) {
  const [staged, setStaged] = useState(() => ({ wp: wallpaper, url: null }));
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const urls = useRef(new Set());

  useEffect(() => {
    const current = stagedRef.current;
    if (wallpaper.kind !== 'image') {
      setStaged({ wp: wallpaper, url: null });
      return undefined;
    }
    if (current.wp.key === wallpaper.key && current.url) {
      setStaged({ wp: wallpaper, url: current.url }); // aynı resim; yalnız yerleşim/bulanıklık/karartma değişti
      return undefined;
    }
    let cancelled = false;
    (async () => {
      let url = null;
      try {
        const blob = await readBlob(wallpaper.imageId);
        if (blob) {
          url = URL.createObjectURL(blob);
          await decode(url);
        }
      } catch {
        if (url) URL.revokeObjectURL(url);
        url = null;
      }
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      if (!url) {
        // Resmin baytı yok/bozuk: boş zemin bırakmak yerine varsayılan kapağa dön (künye silinmiş durumu resolve zaten karşılar).
        useWallpaperStore.getState().selectBuiltin(DEFAULT_PREFS.id);
        return;
      }
      urls.current.add(url);
      setStaged({ wp: wallpaper, url });
    })();
    return () => {
      cancelled = true;
    };
  }, [wallpaper, readBlob]);

  // Önceki resmin URL'sini çapraz geçiş bittikten sonra serbest bırak. Zamanlayıcı bilerek İPTAL EDİLMEZ: resim art arda değişirse
  // (A→B→C) A'nınki de kendi süresinde bırakılır; bileşen kalkınca kalanlar aşağıdaki temizlikle bırakılır (çift iptal zararsızdır).
  const lastUrl = useRef(null);
  useEffect(() => {
    const previous = lastUrl.current;
    lastUrl.current = staged.url;
    if (!previous || previous === staged.url) return;
    setTimeout(() => {
      URL.revokeObjectURL(previous);
      urls.current.delete(previous);
    }, REVOKE_AFTER_MS);
  }, [staged.url]);

  useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), []);
  return staged;
}

const readBlobFromStore = (id) => imageStore.blob(id);

/** @param {{ wallpaper: object, readBlob?: (id: string) => Promise<Blob|null> }} props  wallpaper = resolveWallpaper çıktısı */
export default function WallpaperLayer({ wallpaper, readBlob = readBlobFromStore }) {
  const reduced = useReducedMotion();
  const { wp, url } = useStagedWallpaper(wallpaper, readBlob);
  const fade = reduced ? 0 : FADE_S;
  // Yerleşim anında uygulanır: aynı resimse en son tarifin `fit`i, yoksa sahnelenmiş olanın.
  const art = wp.key === wallpaper.key ? { ...wp, fit: wallpaper.fit } : wp;

  return (
    <div aria-hidden="true" data-wallpaper={wallpaper.key} className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute" style={blurStyle(wallpaper.blur)}>
        <AnimatePresence initial={false}>
          <motion.div
            key={`${wp.key}${url ? '+img' : ''}`}
            className="absolute inset-0"
            style={artStyle(art, url)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 1, transition: { duration: fade } }}
            transition={{ duration: fade, ease: 'easeInOut' }}
          />
        </AnimatePresence>
      </div>
      <div className="absolute inset-0" style={dimStyle(wallpaper.dim)} />
    </div>
  );
}
