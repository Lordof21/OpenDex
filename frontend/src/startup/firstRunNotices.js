// One-time per-device notices.
//
// Persistence: localStorage keyed by ANDROID_ID — notices are pure client-side
// UX state, so they deliberately stay out of the backend API contract.

import { api } from '../lib/api.js';

const STORAGE_PREFIX = 'opendex.notices.';

export const NOTICES = {
  clipboard_warning: {
    key: 'clipboard_warning',
    title: 'Pano kullanımı',
    message:
      'OpenDeX yazarken telefonun panosunu kullanır; telefonda kopyaladığınız içerik değişebilir.',
    action: null,
  },
  keyboard_layout: {
    key: 'keyboard_layout',
    title: 'Klavye düzeni',
    message:
      'Kısayolların doğru çalışması için telefonun fiziksel klavye düzenini bir kez Türkçe Q olarak ayarlayın.',
    action: 'open_layout_settings',
  },
  // helper_apk_hint is Faz 2 — defined for completeness, not queued.
  helper_apk_hint: {
    key: 'helper_apk_hint',
    title: 'Yardımcı uygulama',
    message:
      'Daha iyi Türkçe desteği ve pencere başına ses için yardımcı uygulamayı kurabilirsiniz.',
    action: null,
    phase2: true,
  },
};

function dismissedSet(androidId) {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_PREFIX + androidId) || '[]'));
  } catch {
    return new Set();
  }
}

export async function checkPendingNotices(androidId) {
  if (!androidId) return [];
  const dismissed = dismissedSet(androidId);
  const pending = [];
  for (const notice of Object.values(NOTICES)) {
    if (notice.phase2 || dismissed.has(notice.key)) continue;
    if (notice.key === 'keyboard_layout') {
      // Skip if already configured on the backend profile.
      try {
        const { configured } = await api.get('/api/keyboard/layout-status');
        if (configured) continue;
      } catch {
        /* backend unreachable → show the notice anyway */
      }
    }
    pending.push(notice);
  }
  return pending;
}

export async function dismissNotice(androidId, noticeKey) {
  const dismissed = dismissedSet(androidId);
  dismissed.add(noticeKey);
  localStorage.setItem(STORAGE_PREFIX + androidId, JSON.stringify([...dismissed]));
  if (noticeKey === 'keyboard_layout') {
    await api.post('/api/keyboard/mark-configured').catch(() => {});
  }
}

export async function runNoticeAction(notice) {
  if (notice.action === 'open_layout_settings') {
    await api.post('/api/keyboard/open-layout-settings');
  }
}
