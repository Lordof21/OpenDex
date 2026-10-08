// "Simgeleri Yönet" saf mantığı: hangi uygulama masaüstünde, süzme/gruplama, yerleştirme ve kaldırma.
// Arayüzden (React/DOM) bağımsızdır; ManageIconsDialog yalnız bunları çağırır — davranış tek yerde test edilir.
//
// Düzen modeli (Desktop.jsx ile aynı): `layout = { [hücre]: paket | 'custom-…' }`. `custom-` ile başlayanlar klasör ve
// kısayollardır; bu modül onlara DOKUNMAZ (yalnız uygulama paketlerini yerleştirir/kaldırır).

export const FILTERS = Object.freeze(['all', 'on', 'off']);

const collator = new Intl.Collator('tr-TR', { sensitivity: 'base', numeric: true });
const isCustomId = (id) => typeof id === 'string' && id.startsWith('custom-');

export const trLower = (text) => String(text || '').toLocaleLowerCase('tr-TR');
export const appName = (app) => app?.display_name || app?.name || app?.package || '';

/** Masaüstünde duran uygulama paketleri (klasör/kısayol kimlikleri hariç). */
export function packagesOnDesktop(layout) {
  const out = new Set();
  for (const id of Object.values(layout || {})) if (id && !isCustomId(id)) out.add(id);
  return out;
}

/** paket → o paketi içeren klasör adları. Bir uygulama hem klasörde hem masaüstünde olabilir. */
export function folderMembership(custom) {
  const map = new Map();
  for (const item of custom || []) {
    if (!Array.isArray(item?.appIds)) continue;
    for (const pkg of item.appIds) {
      const names = map.get(pkg) || [];
      names.push(item.name || 'Klasör');
      map.set(pkg, names);
    }
  }
  return map;
}

/** { total, onDesktop, off, used, free }: `used`, klasörler dahil dolu hücre sayısıdır (kapasite o sayıya bakar). */
export function desktopStats(apps, layout, cells) {
  const on = packagesOnDesktop(layout);
  let onDesktop = 0;
  for (const app of apps || []) if (on.has(app.package)) onDesktop += 1;
  const total = (apps || []).length;
  const used = Object.values(layout || {}).filter(Boolean).length;
  return { total, onDesktop, off: total - onDesktop, used, free: Math.max(0, cells - used) };
}

export function matchesQuery(app, needle) {
  if (!needle) return true;
  return trLower(appName(app)).includes(needle) || trLower(app.package).includes(needle);
}

/** Her filtrenin sayısı (arama uygulanmış listeye göre değil, tüm listeye göre — sekmeler "kaç tane var"ı söyler). */
export function filterCounts(apps, onSet) {
  let on = 0;
  for (const app of apps || []) if (onSet.has(app.package)) on += 1;
  return { all: (apps || []).length, on, off: (apps || []).length - on };
}

function sectionOf(app) {
  if (app.isBuiltin) return { key: 'opendex', label: 'OpenDeX' };
  const first = appName(app).trim().charAt(0).toLocaleUpperCase('tr-TR');
  return /\p{L}/u.test(first) ? { key: first, label: first } : { key: '#', label: '#' };
}

/**
 * Görünen liste: yerleşik OpenDeX uygulamaları önce, sonra A–Z harf grupları (tr-TR sıralı). Boş grup yoktur.
 * @returns {{ key: string, label: string, apps: object[] }[]}
 */
export function buildSections(apps, { query = '', filter = 'all', onSet }) {
  const needle = trLower(query).trim();
  const groups = new Map();
  for (const app of apps || []) {
    if (!matchesQuery(app, needle)) continue;
    const on = onSet.has(app.package);
    if ((filter === 'on' && !on) || (filter === 'off' && on)) continue;
    const section = sectionOf(app);
    if (!groups.has(section.key)) groups.set(section.key, { ...section, apps: [] });
    groups.get(section.key).apps.push(app);
  }
  const order = (key) => (key === 'opendex' ? 0 : key === '#' ? 2 : 1);
  return [...groups.values()]
    .map((group) => ({ ...group, apps: group.apps.sort((a, b) => collator.compare(appName(a), appName(b))) }))
    .sort((a, b) => order(a.key) - order(b.key) || collator.compare(a.label, b.label));
}

export function flatten(sections) {
  return sections.flatMap((section) => section.apps);
}

/** İlk boş hücre (soldan sağa, yukarıdan aşağıya); dolu masaüstünde null. */
export function firstFreeCell(layout, cells) {
  for (let cell = 0; cell < cells; cell += 1) if (!layout[cell]) return cell;
  return null;
}

/**
 * Uygulamaları ilk boş hücrelere yerleştirir. Zaten masaüstünde olan atlanır; yer kalmayanlar `skipped` sayılır.
 * @returns {{ layout: object, placed: number, skipped: number }}
 */
export function placeApps(layout, packages, cells) {
  const next = { ...layout };
  const present = packagesOnDesktop(next);
  let placed = 0;
  let skipped = 0;
  for (const pkg of packages) {
    if (present.has(pkg)) continue;
    const cell = firstFreeCell(next, cells);
    if (cell === null) {
      skipped += 1;
      continue;
    }
    next[cell] = pkg;
    present.add(pkg);
    placed += 1;
  }
  return { layout: next, placed, skipped };
}

/** Uygulamaları masaüstünden kaldırır (klasör/kısayollar yerinde kalır). */
export function removeApps(layout, packages) {
  const drop = new Set(packages);
  const next = {};
  let removed = 0;
  for (const [cell, id] of Object.entries(layout)) {
    if (drop.has(id)) removed += 1;
    else next[cell] = id;
  }
  return { layout: next, removed };
}

/**
 * Önerilen düzen + masaüstündeki klasör/kısayollar: varsayılan düzene geçmek kullanıcının klasörlerini silmez.
 * Klasör eski hücresi boşsa orada, değilse ilk boş hücrede durur.
 */
export function withCustomKept(defaults, current, cells) {
  const next = { ...defaults };
  const pending = [];
  for (const [cell, id] of Object.entries(current || {})) {
    if (!isCustomId(id)) continue;
    if (!next[Number(cell)]) next[Number(cell)] = id;
    else pending.push(id);
  }
  for (const id of pending) {
    const cell = firstFreeCell(next, cells);
    if (cell !== null) next[cell] = id;
  }
  return next;
}

/** "3 uygulama" — Türkçede sayıdan sonra çoğul eki yoktur. */
export function countLabel(n, noun = 'uygulama') {
  return `${new Intl.NumberFormat('tr-TR').format(n)} ${noun}`;
}
