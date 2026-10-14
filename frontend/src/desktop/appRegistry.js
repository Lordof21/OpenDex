// App list client — PackageManager launcher query on the backend.

import { api } from '../lib/api.js';
import { t } from '../i18n/index.js';

let cache = null;

export const BUILTIN_SYSTEM_APPS = [
  { package: 'com.opendex.settings', display_name: t('common.opendex_ayarlari'), is_system: true, isBuiltin: true },
  { package: 'com.opendex.screen_mirror', display_name: t('common.telefon_ekranini_yansit'), is_system: true, isBuiltin: true },
  { package: 'com.opendex.files', display_name: t('common.dosyalar'), is_system: true, isBuiltin: true },
];

export const DEFAULT_FALLBACK_APPS = [
  { package: 'com.opendex.settings', display_name: t('common.opendex_ayarlari'), is_system: true, isBuiltin: true },
  { package: 'com.opendex.screen_mirror', display_name: t('common.telefon_ekranini_yansit'), is_system: true, isBuiltin: true },
  { package: 'com.opendex.files', display_name: t('common.dosyalar'), is_system: true, isBuiltin: true },
  { package: 'com.android.chrome', display_name: 'Chrome' },
  { package: 'com.sec.android.app.myfiles', display_name: t('desktop.dosyalarim') },
  { package: 'com.sec.android.gallery3d', display_name: t('common.galeri') },
  { package: 'com.android.settings', display_name: t('common.ayarlar') },
  { package: 'com.google.android.youtube', display_name: 'YouTube' },
  { package: 'com.sec.android.app.camera', display_name: t('desktop.kamera') },
  { package: 'com.whatsapp', display_name: t('common.mesajlar') },
  { package: 'com.samsung.android.dialer', display_name: t('desktop.cagri') },
  { package: 'com.android.vending', display_name: 'Play Store' },
  { package: 'com.samsung.android.calendar', display_name: t('common.takvim') },
];

export const STATIC_APPS = DEFAULT_FALLBACK_APPS;

function mergeWithBuiltins(remoteApps) {
  const filteredRemote = (remoteApps || []).filter(
    (a) => a.package !== 'com.opendex.settings' && a.package !== 'com.opendex.screen_mirror' && a.package !== 'com.opendex.files' && a.package !== 'com.android.internal.mirror'
  );
  return [...BUILTIN_SYSTEM_APPS, ...filteredRemote];
}

export async function fetchAppList({ force = false } = {}) {
  if (cache && !force) return cache;
  const remoteApps = await api.get('/api/apps');
  cache = mergeWithBuiltins(remoteApps);
  return cache;
}

export async function refreshAppList() {
  // "Yenile" button: RegistryDiff catches new AND uninstalled apps in one pass.
  const diff = await api.post('/api/apps/refresh');
  cache = mergeWithBuiltins(diff.all_apps);
  return { ...diff, all_apps: cache };
}

export function cacheAppList(list) {
  cache = mergeWithBuiltins(list);
}

export function getCachedApp(pkg) {
  if (pkg === 'com.opendex.settings') return BUILTIN_SYSTEM_APPS[0];
  if (pkg === 'com.opendex.screen_mirror' || pkg === 'com.android.internal.mirror') return BUILTIN_SYSTEM_APPS[1];
  if (pkg === 'com.opendex.files') return BUILTIN_SYSTEM_APPS[2];
  if (!cache || !pkg) return null;
  return cache.find((a) => a.package === pkg) || null;
}

export function resolveAppDisplayName(pkg, fallbackName = null) {
  if (pkg === 'com.opendex.settings') return t('common.opendex_ayarlari');
  if (pkg === 'com.opendex.screen_mirror' || pkg === 'com.android.internal.mirror') return t('common.telefon_ekranini_yansit');
  if (pkg === 'com.opendex.files') return t('common.dosyalar');
  if (fallbackName && !fallbackName.startsWith('com.') && fallbackName.trim().length > 0) {
    return fallbackName;
  }
  const app = getCachedApp(pkg);
  if (app?.display_name) return app.display_name;
  return fallbackName || pkg;
}

