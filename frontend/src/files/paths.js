// Konum (Location) yardımcıları: { provider: 'pc' | 'phone', path, device? }. Yol sözdizimi sağlayıcıya aittir:
// telefon POSIX ('/'), PC yerel (Windows '\' + sürücü, diğerleri '/').

export const isPhone = (loc) => loc?.provider === 'phone';

export function sepOf(loc) {
  if (!loc || isPhone(loc)) return '/';
  return /^[A-Za-z]:|\\/.test(loc.path) ? '\\' : '/';
}

// Tek telefon bağlıdır ve seri numarası USB ↔ Wi-Fi geçişinde değişir (R5CT… ↔ 192.168.1.7:5555) — telefon aynıdır. Bu yüzden
// bir telefon konumunun kimliğine/karşılaştırmasına seri numarası KATILMAZ (backend de bağlı olanı kullanır).
export const deviceKey = (loc) => (loc && loc.provider !== 'phone' ? loc.device || '' : '');

export const locKey = (loc) => (loc ? `${loc.provider}:${deviceKey(loc)}:${loc.path}` : '');

export function sameLoc(a, b) {
  return Boolean(a && b) && locKey(a) === locKey(b);
}

const trimEnd = (path, sep) => (path.length > 1 && path.endsWith(sep) && !/^[A-Za-z]:\\$/.test(path) ? path.slice(0, -1) : path);

export function joinPath(loc, name) {
  const sep = sepOf(loc);
  const base = trimEnd(loc.path, sep);
  return { ...loc, path: base.endsWith(sep) ? base + name : base + sep + name };
}

/** Üst klasör; kökteyse null. ('C:\\' ve '/' kökleri). */
export function parentOf(loc) {
  const sep = sepOf(loc);
  const path = trimEnd(loc.path, sep);
  if (path === '/' || /^[A-Za-z]:\\?$/.test(path)) return null;
  const cut = path.lastIndexOf(sep);
  if (cut < 0) return null;
  if (cut === 0) return { ...loc, path: sep };
  const parent = path.slice(0, cut);
  return { ...loc, path: /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent };
}

export function baseName(loc) {
  const sep = sepOf(loc);
  const path = trimEnd(loc.path, sep);
  return path.slice(path.lastIndexOf(sep) + 1) || path;
}

const fold = (loc, path) => (loc.provider === 'pc' && sepOf(loc) === '\\' ? path.toLowerCase() : path);

/** `loc`, `root` klasörünün kendisi ya da altı mı? */
export function isInside(loc, root) {
  if (!loc || !root || loc.provider !== root.provider || deviceKey(loc) !== deviceKey(root)) return false;
  const sep = sepOf(root);
  const a = fold(loc, trimEnd(loc.path, sep));
  const b = fold(root, trimEnd(root.path, sep));
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Breadcrumb dilimleri: [{ label, loc }]. En uzun eşleşen "yer" (Dahili depolama, Belgeler…) kökü olur; kalanı klasör
 * adlarıdır. Hiçbir yere uymayan konumda kökten başlar.
 */
export function breadcrumbs(loc, places = []) {
  if (!loc) return [];
  const sep = sepOf(loc);
  const mine = places.filter((p) => isInside(loc, { provider: p.provider, path: p.path, device: p.device }));
  mine.sort((a, b) => b.path.length - a.path.length);
  const root = mine[0];
  const out = [];
  let rest;
  let cursor;
  if (root) {
    out.push({ label: root.name, loc: { provider: root.provider, path: root.path, device: loc.device } });
    cursor = { ...loc, path: root.path };
    rest = trimEnd(loc.path, sep).slice(trimEnd(root.path, sep).length);
  } else if (sep === '\\') {
    const drive = /^[A-Za-z]:/.exec(loc.path)?.[0];
    out.push({ label: drive ? `${drive}\\` : '\\', loc: { ...loc, path: drive ? `${drive}\\` : '\\' } });
    cursor = out[0].loc;
    rest = loc.path.slice(drive ? drive.length : 0);
  } else {
    out.push({ label: isPhone(loc) ? 'Telefon' : '/', loc: { ...loc, path: '/' } });
    cursor = out[0].loc;
    rest = trimEnd(loc.path, sep);
  }
  for (const part of rest.split(sep).filter(Boolean)) {
    cursor = joinPath(cursor, part);
    out.push({ label: part, loc: cursor });
  }
  return out;
}

/**
 * Adres çubuğuna yazılan metni konuma çevirir (SAF; geçerliliğine backend karar verir — izin verilen kök dışı → outside_roots).
 * Telefon: POSIX, başa '/' eklenir. PC: Windows'ta '/' → '\', "C:" → "C:\", sürücü harfi büyütülür. Boş → null.
 */
export function parsePathInput(text, current) {
  let t = String(text ?? '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!t || !current) return null;
  if (isPhone(current)) {
    t = t.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (!t.startsWith('/')) t = `/${t}`;
    if (t.length > 1) t = t.replace(/\/$/, '');
    return { provider: 'phone', path: t, ...(current.device ? { device: current.device } : {}) };
  }
  if (sepOf(current) === '\\' || /^[A-Za-z]:/.test(t)) {
    t = t.replace(/\//g, '\\');
    if (/^[A-Za-z]:$/.test(t)) t += '\\';
    t = t.replace(/^[a-z]:/, (d) => d.toUpperCase());
    if (t.length > 3) t = t.replace(/\\+$/, '');
  }
  return { provider: 'pc', path: t };
}

/**
 * Uzun yolda baştaki dilimleri "…" menüsüne toplar: kök + son `max - 1` dilim görünür kalır.
 * @returns {{ head: object|null, hidden: object[], tail: object[] }}
 */
export function collapseCrumbs(crumbs, max) {
  if (crumbs.length <= max || max < 2) return { head: null, hidden: [], tail: crumbs };
  const keep = max - 1;                                   // son dilimler (kökten ayrı)
  return { head: crumbs[0], hidden: crumbs.slice(1, crumbs.length - keep), tail: crumbs.slice(crumbs.length - keep) };
}
