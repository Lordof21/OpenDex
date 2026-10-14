// Bağlam menüsü MODELİ — saf. Bileşen (FileContextMenu) yalnızca bunu çizer; hangi öğenin hangi durumda göründüğü burada,
// tablo testleriyle sabitlenir. Öğeler: { type: 'item', id, label, icon, hint?, destructive?, disabled? } | { type: 'separator' }.
import {
  ArrowLeftRight, ClipboardPaste, Copy, ExternalLink, Eye, FolderOpen, FolderPlus, Info, Laptop, Pencil, RefreshCw, Scissors,
  Smartphone, Star, Trash2, EyeOff,
} from 'lucide-react';
import { previewKind } from './fileTypes.js';
import { t as tt } from '../i18n/index.js';

const item = (id, label, icon, extra = {}) => ({ type: 'item', id, label, icon, ...extra });
const SEP = Object.freeze({ type: 'separator' });

/**
 * @param {object} ctx
 *   targets    — sağ tıklanan/seçili girdiler ([] = boş alan)
 *   provider   — bölmenin sağlayıcısı ('pc' | 'phone')
 *   hasClipboard, dual (iki bölme açık), phoneConnected, showHidden
 */
export function buildMenu({ targets, provider, hasClipboard = false, dual = false, phoneConnected = true, showHidden = false }) {
  const many = targets.length > 1;
  const one = targets.length === 1 ? targets[0] : null;
  const onlyFiles = targets.length > 0 && targets.every((t) => t.kind !== 'dir');
  const out = [];

  if (targets.length === 0) {
    out.push(
      item('new-folder', tt('files.yeni_klasor'), FolderPlus, { hint: 'Ctrl+Shift+N' }),
      item('paste', tt('files.yapistir'), ClipboardPaste, { hint: 'Ctrl+V', disabled: !hasClipboard }),
      SEP,
      item('toggle-hidden', showHidden ? tt('files.gizli_dosyalari_gizle') : tt('files.gizli_dosyalari_goster'), showHidden ? EyeOff : Eye, { hint: 'Ctrl+H' }),
      item('refresh', tt('files.yenile'), RefreshCw, { hint: 'F5' }),
    );
    return out;
  }

  // Aç / önizle
  if (one?.kind === 'dir') out.push(item('open', tt('common.ac'), FolderOpen, { hint: tt('files.enter') }));
  else if (one && previewKind(one)) out.push(item('preview', tt('files.onizle'), Eye, { hint: tt('files.bosluk') }));
  if (one && one.kind !== 'dir') out.push(item('open-on-pc', provider === 'phone' ? tt('files.bilgisayarda_ac') : tt('files.varsayilan_uygulamayla_ac'), ExternalLink));
  if (one && provider === 'pc') out.push(item('reveal', tt('files.klasorde_goster'), FolderOpen));
  if (out.length) out.push(SEP);

  // Bu yerler arası aktarım: bu uygulamanın asıl işi
  if (provider === 'pc') out.push(item('send-to-phone', many ? tt('files.telefona_gonder') : tt('files.telefona_gonder'), Smartphone, { disabled: !phoneConnected }));
  else out.push(item('save-to-pc', many ? tt('files.bilgisayara_kaydet_2') : tt('files.bilgisayara_kaydet_2'), Laptop));
  if (dual) {
    out.push(item('copy-other', tt('files.diger_bolmeye_kopyala'), Copy, { hint: 'F5' }), item('move-other', tt('files.diger_bolmeye_tasi'), ArrowLeftRight, { hint: 'F6' }));
  }
  out.push(SEP, item('copy', tt('files.kopyala_2'), Copy, { hint: 'Ctrl+C' }), item('cut', tt('files.kes_2'), Scissors, { hint: 'Ctrl+X' }));
  if (one?.kind === 'dir') out.push(item('paste-into', tt('files.icine_yapistir'), ClipboardPaste, { hint: 'Ctrl+V', disabled: !hasClipboard }));
  out.push(SEP);
  if (one) out.push(item('rename', tt('files.yeniden_adlandir'), Pencil, { hint: 'F2' }));
  if (one?.kind === 'dir') out.push(item('favorite', tt('files.favorilere_ekle'), Star));
  out.push(item('delete', onlyFiles || one ? tt('files.sil') : tt('files.sil'), Trash2, { hint: tt('files.del'), destructive: true }));
  if (one) out.push(SEP, item('properties', tt('files.ozellikler'), Info, { hint: 'Alt+Enter' }));
  return out;
}

/** Ardışık ayırıcıları ve baş/son ayırıcıyı temizler (koşullu öğeler yüzünden oluşabilir). */
export function tidy(menu) {
  const out = [];
  for (const entry of menu) {
    if (entry.type === 'separator' && (out.length === 0 || out[out.length - 1].type === 'separator')) continue;
    out.push(entry);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}
