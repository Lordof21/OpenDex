import React, { useEffect, useState, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Search, X } from 'lucide-react';
import AppIcon from '../ui/AppIcon.jsx';
import { Z_INDEX } from '../ui/zIndex.js';

export const SYSTEM_APP_PKGS = new Set([
  'com.android.settings',
  'com.sec.android.app.myfiles',
  'com.android.documentsui',
  'com.google.android.apps.docs',
  'com.sec.android.app.camera',
  'com.android.camera2',
  'com.samsung.android.dialer',
  'com.google.android.dialer',
  'com.samsung.android.contacts',
  'com.google.android.contacts',
  'com.opendex.settings',
  'com.opendex.files',
  'settings',
  'files',
  'cloud',
  'security',
  'help',
  'phone',
  'contacts',
]);

export const AppLauncher = forwardRef(function AppLauncher({
  apps = [],
  query = '',
  onQuery,
  onLaunch,
  onClose,
  openAppIds = [],
  ...motionProps
}, ref) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!mounted) return null;

  const normalized = (query || '').toLocaleLowerCase('tr-TR');
  const filtered = apps.filter((app) => {
    const name = (app.display_name || app.name || '').toLocaleLowerCase('tr-TR');
    const pkg = (app.package || app.id || '').toLocaleLowerCase('tr-TR');
    return name.includes(normalized) || pkg.includes(normalized);
  });

  const isSystemApp = (app) => {
    const p = app.package || app.id || '';
    return app.is_system || app.category === 'Sistem' || SYSTEM_APP_PKGS.has(p);
  };

  const systemApps = filtered.filter(isSystemApp);
  const userApps = filtered.filter((app) => !isSystemApp(app));

  return createPortal(
    <motion.div
      ref={ref} {...motionProps}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      style={{ zIndex: Z_INDEX.flyout }}
      className="fixed inset-0 z-flyout grid place-items-center p-4 select-none"
      role="dialog"
      aria-modal="true"
      aria-label="Uygulamalar"
      data-taskbar-portal
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-background/50 backdrop-blur-[4px]"
        onPointerDown={onClose}
        aria-label="Uygulamaları kapat"
      />

      <section className="relative flex h-[min(720px,calc(100vh-96px))] w-[min(1040px,100%)] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-window backdrop-blur-3xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-3 bg-muted/40">
          <p className="text-xs font-semibold text-foreground">
            Toplam {filtered.length} uygulama
          </p>
          <p className="text-[10px] text-muted-foreground">
            {systemApps.length} sistem · {userApps.length} kullanıcı
          </p>
        </div>

        <div className="dex-scroll min-h-0 flex-1 overflow-y-auto px-6 pb-24 pt-4">
          {systemApps.length > 0 && (
            <>
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Sistem uygulamaları
              </p>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-9">
                {systemApps.map((app) => {
                  const appId = app.package || app.id;
                  const isOpen = openAppIds.includes(appId);
                  return (
                    <LauncherApp
                      key={appId}
                      app={app}
                      isOpen={isOpen}
                      onClick={() => onLaunch(app)}
                    />
                  );
                })}
              </div>
            </>
          )}

          {userApps.length > 0 && (
            <>
              {systemApps.length > 0 && <div className="my-5 h-px bg-border" />}
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Kullanıcı uygulamaları
              </p>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-9">
                {userApps.map((app) => {
                  const appId = app.package || app.id;
                  const isOpen = openAppIds.includes(appId);
                  return (
                    <LauncherApp
                      key={appId}
                      app={app}
                      isOpen={isOpen}
                      onClick={() => onLaunch(app)}
                    />
                  );
                })}
              </div>
            </>
          )}

          {filtered.length === 0 && (
            <p className="py-16 text-center text-xs text-muted-foreground">
              «{query}» ile eşleşen uygulama bulunamadı.
            </p>
          )}
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-popover via-popover/90 to-transparent px-6 pb-5 pt-10">
          <label className="pointer-events-auto flex h-11 w-[min(420px,100%)] items-center gap-3 rounded-full border border-border bg-background/95 px-4 shadow-window backdrop-blur-xl ring-1 ring-ring/20">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground"
              placeholder="Uygulamalarda ara..."
            />
            {query && (
              <button
                type="button"
                onClick={() => onQuery('')}
                aria-label="Aramayı temizle"
                className="size-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="size-3.5" />
              </button>
            )}
          </label>
        </div>
      </section>
    </motion.div>,
    document.body
  );
});

function LauncherApp({ app, isOpen, onClick }) {
  const name = app.display_name || app.name || app.title || 'Uygulama';

  return (
    <button
      type="button"
      onClick={onClick}
      className="group/launch flex h-24 min-w-0 flex-col items-center justify-center gap-2 rounded-xl px-1 hover:bg-accent transition-all cursor-pointer select-none"
    >
      <span className="relative transition-transform duration-150 group-hover/launch:-translate-y-1 group-hover/launch:scale-[1.05] active:scale-95">
        <AppIcon app={app} size="launcher" />
        {isOpen && (
          <span className="absolute -bottom-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-status-active shadow-sm" />
        )}
      </span>
      <span className="w-full truncate text-center text-[10.5px] font-medium text-foreground">
        {name}
      </span>
    </button>
  );
}
