// One-time per-device notices.
//
// Persistence: localStorage keyed by ANDROID_ID — notices are pure client-side
// UX state, so they deliberately stay out of the backend API contract.

import { api } from '../lib/api.js';
import { t } from '../i18n/index.js';

const STORAGE_PREFIX = 'opendex.notices.';

export const NOTICES = {
  clipboard_warning: {
    key: 'clipboard_warning',
    title: t('startup.pano_kullanimi'),
    message:
      t('startup.opendex_yazarken_telefonun_panosunu'),
    action: null,
  },
  keyboard_layout: {
    key: 'keyboard_layout',
    title: t('startup.klavye_duzeni'),
    message:
      t('startup.kisayollarin_dogru_calismasi_icin'),
    action: 'open_layout_settings',
  },
  // helper_apk_hint is Faz 2 — defined for completeness, not queued.
  helper_apk_hint: {
    key: 'helper_apk_hint',
    title: t('startup.yardimci_uygulama'),
    message:
      t('startup.daha_iyi_turkce_destegi_ve_pencere'),
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
