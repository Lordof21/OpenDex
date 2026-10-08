// Çalışma Alanı (Eco Workspace) kabının "paket" kimliği. Kabın kendi paketi YOKTUR (`package: null`, bkz. helpers.createEcoWorkspaceContainer);
// ikon çözümü ise paket anahtarıyla çalışır → kap için sabit bir ikon anahtarı kullanılır. Yaprak modül (hiçbir şey içe aktarmaz).
export const WORKSPACE_ICON_PACKAGE = 'com.opendex.workspace';

// Arka uçtaki sabit "anchor" oturumunun paketi de (eco_workspace.ANCHOR_PACKAGE) aynı ikonu alır.
const WORKSPACE_PACKAGE_PREFIXES = [WORKSPACE_ICON_PACKAGE, 'com.opendex.eco_workspace'];

export const isWorkspacePackage = (pkg) => typeof pkg === 'string' && WORKSPACE_PACKAGE_PREFIXES.some((prefix) => pkg.startsWith(prefix));

/**
 * Bir pencere/görev için ikon paketi: Çalışma Alanı kabı → özel ikon; diğerleri kendi paketi (kırpma anahtarını AppIcon çözer).
 * Başlığın baş harfi hiçbir yerde ikon yerine kullanılmaz.
 */
export const iconPackageOf = (win) => (win?.isEcoWorkspace ? WORKSPACE_ICON_PACKAGE : win?.package ?? win?.appId ?? null);
