// DeX-içi kırpma penceresinin paket anahtarı. Gerçek uygulama paketiyle KARIŞMAZ: paket-bazlı mantık
// (kalıcı geometri, pencere arama/başlatma, bildirim yönlendirme) kırpma pencerelerini görmez. Yaprak modül:
// hiçbir şey içe aktarmaz (windowMath.js'in de kullanabilmesi için).
export const CROP_PACKAGE_PREFIX = 'com.opendex.crop:';

export const cropPackageKey = (pkg) => `${CROP_PACKAGE_PREFIX}${pkg}`;

export const isCropPackage = (pkg) => typeof pkg === 'string' && pkg.startsWith(CROP_PACKAGE_PREFIX);

/** Kırpma paket anahtarından gerçek uygulama paketini çıkarır (ikon/ad çözümü için); diğerlerini olduğu gibi döner. */
export const realPackageOf = (pkg) => (isCropPackage(pkg) ? pkg.slice(CROP_PACKAGE_PREFIX.length) : pkg);
