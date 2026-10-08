// Kapak resminin React bağlantıları: çözümleme (tercih + tema + resimler), açılışta hazırlama ve slayt gösterisi zamanlayıcısı.
import { useEffect, useMemo } from 'react';
import { useTheme } from '../../state/ThemeContext.jsx';
import { resolveWallpaper } from './prefs.js';
import { useWallpaperStore } from './wallpaperStore.js';

/** Şu anki kapağın çizim tarifi. Kullanıcı resimlerinin künyelerini ilk kullanımda yükler. */
export function useWallpaper() {
  const prefs = useWallpaperStore((s) => s.prefs);
  const images = useWallpaperStore((s) => s.images);
  const { isDark } = useTheme();

  useEffect(() => {
    useWallpaperStore.getState().hydrate();
  }, []);

  return useMemo(() => resolveWallpaper(prefs, { isDark, images }), [prefs, images, isDark]);
}

/**
 * Slayt gösterisi: etkinse her `intervalMin` dakikada bir sıradaki kapağa geçer. Elle yapılan her seçim süreyi sıfırlar
 * (zamanlayıcı seçime bağlıdır). Sekme/pencere gizliyken geçmez — çözülmeyecek bir resmi boşuna hazırlamayız.
 */
export function useWallpaperSlideshow() {
  const { enabled, intervalMin, source } = useWallpaperStore((s) => s.prefs.slideshow);
  const mode = useWallpaperStore((s) => s.prefs.mode);
  const id = useWallpaperStore((s) => s.prefs.id);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer;
    const arm = () => {
      timer = setTimeout(() => {
        if (typeof document !== 'undefined' && document.hidden) arm();
        else useWallpaperStore.getState().advanceSlideshow();
      }, intervalMin * 60_000);
    };
    arm();
    return () => clearTimeout(timer);
  }, [enabled, intervalMin, source, mode, id]);
}
