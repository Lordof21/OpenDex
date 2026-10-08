// Durum çubuğu özeti (SAF): görünen öğe sayısı, gizli sayısı, seçim ve seçilen DOSYALARIN toplam boyutu.
// Klasör boyutu listeden bilinmez (hesaplamak ağır): seçimde klasör varsa "+ klasörler" notu düşülür.
import { countLabel, formatSize } from './formatters.js';
import { keyOf } from './filesStore.js';

export function summarize(pane) {
  if (!pane) return { total: 0, hidden: 0, selected: 0, bytes: 0, folders: 0, files: 0 };
  const total = pane.visible.length;
  // "Gizli": gizli öznitelikli ve ŞU AN gösterilmeyenler — aramanın elediği girdiler gizli DEĞİLDİR.
  const hidden = pane.showHidden ? 0 : pane.entries.filter((e) => e.hidden).length;
  let bytes = 0;
  let folders = 0;
  let files = 0;
  if (pane.selection.ids.size) {
    for (const e of pane.visible) {
      if (!pane.selection.ids.has(keyOf(e))) continue;
      if (e.kind === 'dir') folders += 1;
      else {
        files += 1;
        bytes += e.size || 0;
      }
    }
  }
  return { total, hidden, selected: folders + files, bytes, folders, files };
}

/** "128 öğe · 3 gizli" / "3 öğe seçili · 12,4 MB (+ klasörler)". */
export function statusText(pane) {
  const s = summarize(pane);
  if (pane?.search) {
    const more = pane.search.truncated ? '+' : '';
    return pane.search.status === 'loading' ? 'Aranıyor…' : `${countLabel(s.total)}${more} bulundu`;
  }
  if (pane?.status === 'loading' && s.total === 0) return 'Yükleniyor…';
  if (pane?.query && s.selected === 0) return countLabel(s.total, 'eşleşme');
  if (s.selected > 0) {
    const size = s.files > 0 ? ` · ${formatSize(s.bytes)}${s.folders ? ' (+ klasörler)' : ''}` : '';
    return `${countLabel(s.selected)} seçili${size}`;
  }
  return `${countLabel(s.total)}${s.hidden > 0 ? ` · ${s.hidden} gizli` : ''}`;
}
