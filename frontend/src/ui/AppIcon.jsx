import React, { useEffect, useState } from 'react';
import { authedUrl } from '../lib/apiToken.js';
import { isMirrorPackage } from '../window/mirrorPackage.js';
import { realPackageOf } from '../window/cropPackage.js';
import { isWorkspacePackage } from '../window/workspacePackage.js';
import filesArt from '../assets/icons/files.png';
import settingsArt from '../assets/icons/settings.png';
import mirrorArt from '../assets/icons/mirror.png';
import workspaceArt from '../assets/icons/workspace.png';

/**
 * OpenDeX'in kendi uygulamalarının ikonları (Dosyalar, Ayarlar, Telefon Yansıtma, Çalışma Alanı): kare, tam taşan resimler
 * (frontend/src/assets/icons); köşe yuvarlama, çerçeve ve gölge burada, `rounded-[22%]` kutusunda verilir — resmin kendisi
 * köşe/gölge içermez. Orta tonlu, doygun zemin: açık (bej) ve koyu temada aynı resim kullanılır.
 */
function ArtIcon({ src, size, className = '', name }) {
  return (
    <div
      className={`app-icon relative flex shrink-0 overflow-hidden rounded-[22%] border border-foreground/10 shadow-sm select-none ${className}`}
      style={size}
      data-app-icon={name}
    >
      <img src={src} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover pointer-events-none" />
    </div>
  );
}

/**
 * Çalışma Alanı simgesi: birbirine binen üç pencere (arkada başlık çubuklu geniş pencere, önde iki kart) — "paylaşımlı ekranda yan yana
 * çalışan uygulamalar". Çizgi/dolgu `currentColor`dan gelir (kutu `text-image-foreground`), renk kodu yoktur.
 */
export function WorkspaceGlyph({ size = 20, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect x="2.6" y="4" width="18.8" height="14.4" rx="3.2" fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeOpacity="0.9" strokeWidth="1.5" />
      <circle cx="5.9" cy="7.2" r="0.9" fill="currentColor" fillOpacity="0.9" />
      <circle cx="8.6" cy="7.2" r="0.9" fill="currentColor" fillOpacity="0.65" />
      <rect x="5" y="10.2" width="8.4" height="7.2" rx="1.7" fill="currentColor" />
      <rect x="12.4" y="12.4" width="8.2" height="7.4" rx="1.7" fill="currentColor" fillOpacity="0.55" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function getAppIconPlaceholder(pkg, name) {
  const source = name || pkg || '?';
  const letter = source.trim().charAt(0).toUpperCase() || '?';
  let hash = 0;
  for (const ch of (pkg || '')) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  return { letter, hue };
}

export default function AppIcon({
  app,
  pkg,
  package_name,
  displayName,
  app_name,
  /* size can be number in px or "taskbar" | "launcher" | "preview" */
  size = 'taskbar',
  className = "",
  iconClassName = "",
  version = 0,
}) {
  // If an app object with vector icon and skin is provided (like Smooth apps):
  if (app && app.icon && app.skin) {
    const Icon = app.icon;
    const skinClass = `app-icon-${app.skin || 'lovable'}`;
    const sizeClasses =
      size === 'launcher' || size >= 48
        ? 'size-12 rounded-[12px]'
        : size === 'preview' || size <= 28
        ? 'size-6 rounded-[6px]'
        : 'size-[34px] rounded-[9px]';

    const iconSize =
      size === 'launcher' || size >= 48
        ? 'size-6'
        : size === 'preview' || size <= 28
        ? 'size-3.5'
        : 'size-[18px]';

    return (
      <span
        className={`app-icon relative grid shrink-0 place-items-center overflow-hidden border border-foreground/10 shadow-sm ${skinClass} ${sizeClasses} ${className}`}
        aria-hidden="true"
      >
        <span className="app-icon-shine absolute inset-x-0 top-0 h-1/2" />
        <span className="app-icon-orbit absolute inset-[3px] rounded-[inherit]" />
        <span className="app-icon-glyph absolute inset-[6px] rounded-[4px]" />
        <Icon className={`relative z-10 drop-shadow-sm ${iconSize} ${iconClassName}`} strokeWidth={1.9} />
        <span className="app-icon-glint absolute left-[5px] top-[4px] size-1 rounded-full" />
      </span>
    );
  }

  // DeX-içi kırpma penceresinin paket anahtarı gerçek uygulamanın ikonunu gösterir.
  const targetPkg = realPackageOf(pkg || package_name || app?.package || app?.id);
  const targetName = displayName || app_name || app?.name || app?.display_name;
  const [error, setError] = useState(false);
  const placeholder = getAppIconPlaceholder(targetPkg, targetName);

  useEffect(() => {
    setError(false);
  }, [targetPkg, version]);

  const numSize = typeof size === 'number' ? size : size === 'launcher' ? 48 : size === 'preview' ? 24 : 34;
  const sizeStyle = { width: numSize, height: numSize, minWidth: numSize, minHeight: numSize };

  if (targetPkg === 'com.opendex.settings' || targetPkg === 'opendex' || targetPkg === 'settings') {
    return <ArtIcon src={settingsArt} size={sizeStyle} className={className} name="settings" />;
  }

  if (isWorkspacePackage(targetPkg)) {
    return <ArtIcon src={workspaceArt} size={sizeStyle} className={className} name="workspace" />;
  }

  if (targetPkg === 'com.opendex.files') {
    return <ArtIcon src={filesArt} size={sizeStyle} className={className} name="files" />;
  }

  if (isMirrorPackage(targetPkg)) {
    return <ArtIcon src={mirrorArt} size={sizeStyle} className={className} name="mirror" />;
  }

  // <img> cannot send a header: the token rides in the query string (backend accepts it on GET only).
  const iconUrl = authedUrl(`/api/apps/icon-v2/${encodeURIComponent(targetPkg || '')}${version ? `?v=${version}` : ''}`);

  const handleError = () => {
    setError(true);
  };

  if (error || !targetPkg) {
    return (
      <div
        className={`relative flex shrink-0 items-center justify-center font-bold text-image-foreground shadow-md ring-1 ring-image-foreground/20 overflow-hidden rounded-[22%] select-none ${className}`}
        style={{
          ...sizeStyle,
          background: `linear-gradient(135deg, hsl(${placeholder.hue} 65% 50%), hsl(${(placeholder.hue + 35) % 360} 70% 35%))`,
        }}
      >
        <span className="drop-shadow-md text-image-foreground font-extrabold" style={{ fontSize: numSize * 0.4 }}>
          {placeholder.letter}
        </span>
        <div className="absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-white/20 pointer-events-none" />
      </div>
    );
  }

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-[22%] bg-transparent select-none ${className}`}
      style={sizeStyle}
    >
      <img
        src={iconUrl}
        alt={targetName || targetPkg}
        onError={handleError}
        className={`absolute inset-0 h-full w-full scale-[0.85] object-contain pointer-events-none drop-shadow-md ${iconClassName}`}
        loading="lazy"
      />
    </div>
  );
}

