// Bildirim görselliğinin saf kuralları (React yok): toast, bildirim merkezi ve orta üst sistem mesajı aynı dili
// konuşsun diye tek yerde. Renkler yalnız tasarım token'larıdır (index.css) — ham renk / Tailwind paleti yok.

import {
  Bell,
  CircleAlert,
  CircleCheck,
  Info,
  Mail,
  MessageCircle,
  Music2,
  ShieldAlert,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { formatRelativeTime } from '../desktop/notifications/timeUtils.js';

/** Backend kategorisi (schemas/notifications.py NotificationCategory) → rozet ikonu, renk token'ı, erişilebilir ad. */
const CATEGORY_META = {
  msg: { Icon: MessageCircle, tone: 'var(--status-active)', label: 'Mesaj' },
  email: { Icon: Mail, tone: 'var(--app-mail)', label: 'E-posta' },
  media: { Icon: Music2, tone: 'var(--app-gallery)', label: 'Medya' },
  social: { Icon: Users, tone: 'var(--app-browser)', label: 'Sosyal' },
  sys: { Icon: ShieldAlert, tone: 'var(--app-settings)', label: 'Sistem' },
  call: { Icon: Bell, tone: 'var(--status-active)', label: 'Arama' },
  generic: { Icon: Bell, tone: 'var(--notification-accent)', label: 'Bildirim' },
};

export function categoryMeta(category) {
  return CATEGORY_META[category] || CATEGORY_META.generic;
}

/**
 * Store'daki (backend) bildirim YA DA eski demo biçimi ({appId, appName, headline, detail, time}) → kartın okuduğu tek
 * görünüm modeli. `raw` özgün nesnedir: dokununca derin gezinme onu kullanır (android_key, id…) — bildirim merkezinin
 * eskiden hedefe gidememesinin nedeni bu alanları kopyalarken düşürmesiydi.
 */
export function toCardModel(n) {
  if (!n) return null;
  const isDemo = !n.android_key && (n.headline !== undefined || n.appId !== undefined) && n.title === undefined;
  const pkg = n.package || n.package_name || n.appId || null;
  const appName = n.app_name || n.appName || (pkg ? pkg.split('.').pop() : 'Bildirim');
  const title = n.title || n.headline || '';
  const text = n.text || n.detail || '';
  const bigText = n.big_text || null;
  return {
    id: String(n.id ?? n.key ?? `${pkg}:${title}`),
    pkg,
    appName,
    title: title && title !== appName ? title : '',
    text,
    bigText: bigText && bigText !== text ? bigText : null,
    lines: Array.isArray(n.lines) ? n.lines : [],
    time: typeof n.time === 'string' && isDemo ? n.time : formatRelativeTime(n.timestamp || n),
    category: n.category || 'generic',
    actions: Array.isArray(n.actions) ? n.actions.filter((a) => a && a.action_type !== 'reply') : [],
    unread: n.read === false,
    ongoing: Boolean(n.is_ongoing),
    raw: isDemo ? null : n,
  };
}

// ── Orta üst sistem mesajı ("ada") ────────────────────────────────────────────────────────────────────────────

export const TONES = {
  success: { Icon: CircleCheck, color: 'var(--status-active)', label: 'Başarılı' },
  warning: { Icon: TriangleAlert, color: 'var(--warning)', label: 'Uyarı' },
  error: { Icon: CircleAlert, color: 'var(--destructive)', label: 'Hata' },
  info: { Icon: Info, color: 'var(--info)', label: 'Bilgi' },
};

// Mesajın başındaki emoji tonu söyler (🎉/✓ başarı, ⚠️ uyarı, 🔒 kilit…) — ikon onu zaten gösterdiği için metinden atılır.
const LEADING_SYMBOL = /^\s*(?:\[[^\]]{1,24}\]\s*)?(\p{Extended_Pictographic}️?|✓|✔)\s*/u;
const TRAILING_CHECK = /\s*(✓|✔)\s*$/u;

// Düz alt dize (`\b` Türkçe harfle başlayan kelimede — "ısındı" — sınır bulamaz).
const ERROR_WORDS = /(hata|başarısız|gönderilemedi|açılamadı|bulunamadı|reddetti|çekilemedi|desteklemiyor|değiştirilemedi)/i;
const WARNING_WORDS = /(uyarı|ısındı|dolu|kilit|zaman aşımı|düşürüldü|duraklatıldı|artık medya oynatmıyor)/i;
const SUCCESS_WORDS = /(başarılı|eklendi|oluşturuldu|güncellendi|aktif|bağlandı|açıldı|yerleştirildi|sıfırlandı|kaldırıldı|silindi|düzenlendi|çıkarıldı|aktarılıyor)/i;

/**
 * pushToast(message[, {tone, title}]) → {tone, text, title}. Açık `tone` her zaman kazanır; yoksa mesajdan çıkarılır:
 * önce baştaki sembol (⚠️ uyarı, 🎉 ✓ başarı, 🔒 uyarı), sonra kelimeler (hata > uyarı > başarı), yoksa bilgi.
 */
export function classifyToast(message, options = {}) {
  const raw = String(message ?? '').trim();
  const lead = raw.match(LEADING_SYMBOL);
  const symbol = lead?.[1] || '';
  const trailingCheck = TRAILING_CHECK.test(raw);
  let text = raw.replace(LEADING_SYMBOL, '').replace(TRAILING_CHECK, '').trim() || raw;
  // "[İkon Hatası] …" gibi köşeli etiketler başlığa taşınır.
  const tag = raw.match(/^\s*\[([^\]]{1,24})\]\s*/);
  let title = options.title || null;
  if (tag) {
    title = title || tag[1];
    text = text.replace(/^\s*\[[^\]]{1,24}\]\s*/, '');
  }
  let tone = options.tone && TONES[options.tone] ? options.tone : null;
  if (!tone) {
    if (/⚠/.test(symbol)) tone = 'warning';
    else if (/[🎉✅✓✔]/u.test(symbol) || trailingCheck) tone = 'success';
    else if (/🔒/u.test(symbol)) tone = 'warning';
    else if (ERROR_WORDS.test(raw)) tone = 'error';
    else if (WARNING_WORDS.test(raw)) tone = 'warning';
    else if (SUCCESS_WORDS.test(raw)) tone = 'success';
    else tone = 'info';
  }
  return { tone, text, title };
}
