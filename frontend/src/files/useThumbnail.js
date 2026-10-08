import { useEffect, useState } from 'react';
import { requestThumb } from './thumbCache.js';
import { locKey } from './paths.js';

/** Bir girdinin küçük resim adresi (blob URL) ya da null (henüz yok / türü yok). `enabled=false` iken hiç istek gitmez. */
export function useThumbnail(loc, entry, px, enabled) {
  const [url, setUrl] = useState(null);
  const version = enabled ? `${Math.round(entry.mtime)}-${entry.size}` : '';
  const key = enabled ? locKey(loc) : '';

  useEffect(() => {
    if (!enabled) {
      setUrl(null);
      return undefined;
    }
    const ctrl = new AbortController();
    let release = null;
    let gone = false;
    setUrl(null);
    requestThumb(loc, px, version, ctrl.signal)
      .then((result) => {
        if (!result) return;
        if (gone) result.release();
        else {
          release = result.release;
          setUrl(result.url);
        }
      })
      .catch(() => {});
    return () => {
      gone = true;
      ctrl.abort();
      release?.();
    };
    // `loc` nesnesi her çizimde yeni olabilir: kimlik `key` + `version` ile belirlenir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, version, px]);

  return url;
}
