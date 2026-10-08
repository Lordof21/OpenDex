// Bağlam menüsü MODELİ — saf. Bileşen (FileContextMenu) yalnızca bunu çizer; hangi öğenin hangi durumda göründüğü burada,
// tablo testleriyle sabitlenir. Öğeler: { type: 'item', id, label, icon, hint?, destructive?, disabled? } | { type: 'separator' }.
import {
  ArrowLeftRight, ClipboardPaste, Copy, ExternalLink, Eye, FolderOpen, FolderPlus, Info, Laptop, Pencil, RefreshCw, Scissors,
  Smartphone, Star, Trash2, EyeOff,
} from 'lucide-react';
import { previewKind } from './fileTypes.js';

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
      item('new-folder', 'Yeni klasör', FolderPlus, { hint: 'Ctrl+Shift+N' }),
      item('paste', 'Yapıştır', ClipboardPaste, { hint: 'Ctrl+V', disabled: !hasClipboard }),
      SEP,
      item('toggle-hidden', showHidden ? 'Gizli dosyaları gizle' : 'Gizli dosyaları göster', showHidden ? EyeOff : Eye, { hint: 'Ctrl+H' }),
      item('refresh', 'Yenile', RefreshCw, { hint: 'F5' }),
    );
    return out;
  }

  // Aç / önizle
  if (one?.kind === 'dir') out.push(item('open', 'Aç', FolderOpen, { hint: 'Enter' }));
  else if (one && previewKind(one)) out.push(item('preview', 'Önizle', Eye, { hint: 'Boşluk' }));
  if (one && one.kind !== 'dir') out.push(item('open-on-pc', provider === 'phone' ? 'Bilgisayarda aç' : 'Varsayılan uygulamayla aç', ExternalLink));
  if (one && provider === 'pc') out.push(item('reveal', 'Klasörde göster', FolderOpen));
  if (out.length) out.push(SEP);

  // Bu yerler arası aktarım: bu uygulamanın asıl işi
  if (provider === 'pc') out.push(item('send-to-phone', many ? 'Telefona gönder' : 'Telefona gönder', Smartphone, { disabled: !phoneConnected }));
  else out.push(item('save-to-pc', many ? 'Bilgisayara kaydet' : 'Bilgisayara kaydet', Laptop));
  if (dual) {
    out.push(item('copy-other', 'Diğer bölmeye kopyala', Copy, { hint: 'F5' }), item('move-other', 'Diğer bölmeye taşı', ArrowLeftRight, { hint: 'F6' }));
  }
  out.push(SEP, item('copy', 'Kopyala', Copy, { hint: 'Ctrl+C' }), item('cut', 'Kes', Scissors, { hint: 'Ctrl+X' }));
  if (one?.kind === 'dir') out.push(item('paste-into', 'İçine yapıştır', ClipboardPaste, { hint: 'Ctrl+V', disabled: !hasClipboard }));
  out.push(SEP);
  if (one) out.push(item('rename', 'Yeniden adlandır', Pencil, { hint: 'F2' }));
  if (one?.kind === 'dir') out.push(item('favorite', 'Favorilere ekle', Star));
  out.push(item('delete', onlyFiles || one ? 'Sil' : 'Sil', Trash2, { hint: 'Del', destructive: true }));
  if (one) out.push(SEP, item('properties', 'Özellikler', Info, { hint: 'Alt+Enter' }));
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
