import { t } from '../i18n/index.js';
// Klavye → eylem eşlemesi. SAF: bir KeyboardEvent'ten (ya da {key, ctrlKey, …} nesnesinden) eylem tanımı üretir; FolderView
// yalnızca bunu yürütür. Kısayol tablosu böylece testle sabitlenir ve belgelenir (kısayol yardımı aynı tabloyu kullanır).
//
// İki bölmeli kipte F5/F6 (Total Commander alışkanlığı) kopyala/taşı; tek bölmede F5 yenile.

/** Kısayol yardımı için gösterilen liste: [tuş, açıklama]. */
export const SHORTCUTS = Object.freeze([
  ['↑ ↓ ← →', t('files.odagi_tasi')],
  ['Shift + ok', t('files.secimi_genislet')],
  ['Ctrl + A', t('files.tumunu_sec')],
  ['Enter', t('common.ac')],
  [t('files.bosluk'), t('files.hizli_onizleme')],
  [t('files.backspace_alt'), t('files.ust_klasor')],
  ['Alt + ← / →', t('files.geri_ileri')],
  ['F2', t('files.yeniden_adlandir')],
  ['Delete', t('files.geri_donusum_kutusuna_tasi')],
  ['Shift + Delete', t('files.kalici_sil')],
  ['Ctrl + C / X / V', t('files.kopyala_kes_yapistir')],
  ['Ctrl + Shift + N', t('files.yeni_klasor')],
  [t('files.f5_f6'), t('files.iki_bolmede_digerine_kopyala_tasi')],
  ['Ctrl + L', t('files.adres_cubuguna_git')],
  ['Ctrl + F', t('files.bu_klasorde_ara')],
  ['Ctrl + H', t('files.gizli_dosyalari_goster_gizle')],
  ['Alt + Enter', t('files.ozellikler')],
  [t('files.harf_yazin'), t('files.ada_gore_atla')],
]);

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

export function resolveKey(e, { dual = false } = {}) {
  const mod = e.ctrlKey || e.metaKey;
  const shift = Boolean(e.shiftKey);
  const k = e.key;

  if (e.altKey && !mod) {
    if (k === 'ArrowLeft') return { type: 'back' };
    if (k === 'ArrowRight') return { type: 'forward' };
    if (k === 'ArrowUp') return { type: 'up' };
    if (k === 'Enter') return { type: 'properties' };
    return null;
  }

  if (NAV_KEYS.has(k)) return { type: 'move', key: k, ctrl: mod, shift };

  switch (k) {
    case 'Enter': return { type: 'open' };
    case ' ': return mod ? { type: 'toggle' } : { type: 'preview' };
    case 'Backspace': return { type: 'up' };
    case 'F2': return { type: 'rename' };
    case 'Delete': return { type: 'delete', permanent: shift };
    case 'F5': return dual ? { type: 'transfer', op: 'copy' } : { type: 'reload' };
    case 'F6': return dual ? { type: 'transfer', op: 'move' } : null;
    case 'F10': return shift ? { type: 'menu' } : null;
    case 'ContextMenu': return { type: 'menu' };
    case 'Escape': return { type: 'escape' };
    default: break;
  }

  if (mod) {
    switch (k.length === 1 ? k.toLowerCase() : k) {
      case 'a': return { type: 'select-all' };
      case 'c': return { type: 'copy' };
      case 'x': return { type: 'cut' };
      case 'v': return { type: 'paste' };
      case 'r': return { type: 'reload' };
      case 'l': return { type: 'focus-path' };
      case 'f': return { type: 'focus-search' };
      case 'h': return { type: 'toggle-hidden' };
      case 'n': return shift ? { type: 'new-folder' } : null;
      default: return null;
    }
  }

  // Yazdırılabilir tek karakter (Türkçe harfler dahil): ada göre atla.
  if (k.length === 1 && !e.altKey) return { type: 'type', char: k };
  return null;
}

/** Bu eylemler odağı/seçimi değiştirmez ya da tarayıcıya aittir: tarayıcı varsayılanı ENGELLENMEZ. */
export const PASSTHROUGH = new Set(['type']);
