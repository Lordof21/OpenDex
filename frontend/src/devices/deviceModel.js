// Cihaz yöneticisinin saf modeli (docs/design/DEVICE_MANAGER.md §5): adb hatları + kayıtlı cihazlar → FİZİKSEL cihazlar.
//
// Bir telefonun USB ve Wi-Fi hatları aynı ANDROID_ID'yi taşır (backend her hatta bir kez okur: DeviceInfo.android_id) ve
// tek kartta görünür; kimliği henüz okunmamış / okunamayan hat (yetki bekleyen, çevrimdışı) kendi seri numarasıyla tek
// başına durur. Kayıtlı cihaz, canlı bir hattı varsa o karta eklenir; yoksa "Kayıtlı" bölümünde kalır.
//
// Burada React yok, ağ yok: bileşenler yalnız bu çıktıyı çizer, eylemler deviceHubStore'dadır. Testler: tests/deviceModel.test.js.

export const LINK_USB = 'usb';
export const LINK_WIFI = 'wifi';

/** adb'nin hat durumu → arayüz durumu. Bilinmeyen değer "offline" sayılır (kullanılamaz). */
const ADB_STATE = { device: 'device', unauthorized: 'unauthorized', offline: 'offline' };

/** "Pixel_8" → "Pixel 8"; boşsa null. */
export function displayModel(model) {
  const text = String(model || '').replaceAll('_', ' ').trim();
  return text || null;
}

/** "192.168.1.5:5555" → { ip, port }; IPv6 köşeli parantezini de çözer. Seri numarası (USB) → { ip: null, port: null }. */
export function splitAddress(serial) {
  const text = String(serial || '');
  const cut = text.lastIndexOf(':');
  if (cut <= 0) return { ip: null, port: null };
  const port = Number(text.slice(cut + 1));
  return { ip: text.slice(0, cut).replace(/^\[|\]$/g, ''), port: Number.isFinite(port) ? port : null };
}

/** Ham DeviceInfo → hat. */
export function linkOf(device) {
  const serial = String(device?.serial || '');
  const wifi = device?.transport === 'wireless' || serial.includes(':');
  const { ip, port } = wifi ? splitAddress(serial) : { ip: null, port: null };
  return {
    serial,
    transport: wifi ? LINK_WIFI : LINK_USB,
    state: ADB_STATE[device?.state] || 'offline',
    active: Boolean(device?.is_active),
    ip,
    port,
  };
}

const usable = (link) => link?.state === 'device';

// Hat sırası: etkin olan, sonra kullanılabilir USB (daha hızlı, daha kararlı), sonra Wi-Fi, en sonda kullanılamayanlar.
const linkRank = (link) => (link.active ? 0 : 1) * 10 + (usable(link) ? 0 : 5) + (link.transport === LINK_USB ? 0 : 1);

function statusOf(group, session) {
  if (group.active) {
    if (session.switching) return 'switching';
    if (session.phase === 'binding') return 'binding';
    if (session.phase === 'lost') return 'reconnecting';
    return session.linkWeak ? 'weak' : 'connected';
  }
  if (group.links.some(usable)) return 'ready';
  if (group.links.some((l) => l.state === 'unauthorized')) return 'unauthorized';
  if (group.links.length) return 'offline';
  return group.known?.discovered ? 'discovered' : 'saved';
}

/**
 * @param devices   GET /api/devices/state → devices (DeviceInfo[]: serial, state, model, transport, is_active, android_id)
 * @param known     GET /api/devices/known (KnownDeviceInfo[], son görülen başta)
 * @param session   { phase: null|'binding'|'ready'|'lost', switching, linkWeak }
 * @param fallbackName  adı hiç bilinmeyen cihazın adı (ör. "Android cihazı")
 * @returns {{ active: Group|null, nearby: Group[], saved: Group[], all: Group[] }}
 */
export function groupDevices({ devices = [], known = [], session = {}, fallbackName = 'Android' } = {}) {
  const groups = new Map();
  const order = [];
  const groupFor = (key, androidId) => {
    let group = groups.get(key);
    if (!group) {
      group = { key, androidId: androidId || null, links: [], known: null, liveModel: null };
      groups.set(key, group);
      order.push(key);
    }
    return group;
  };

  for (const device of Array.isArray(devices) ? devices : []) {
    if (!device?.serial) continue;
    const group = groupFor(device.android_id ? `id:${device.android_id}` : `serial:${device.serial}`, device.android_id);
    group.links.push(linkOf(device));
    group.liveModel = group.liveModel || displayModel(device.model);
  }
  for (const record of Array.isArray(known) ? known : []) {
    if (!record?.android_id) continue;
    groupFor(`id:${record.android_id}`, record.android_id).known = record;
  }

  const all = order.map((key) => {
    const group = groups.get(key);
    group.links.sort((a, b) => linkRank(a) - linkRank(b));
    const model = group.liveModel || displayModel(group.known?.model);
    const activeLink = group.links.find((l) => l.active) || null;
    const finished = {
      ...group,
      model,
      alias: group.known?.alias || null,
      name: group.known?.alias || model || fallbackName,
      tablet: /\btab/i.test(model || ''),
      active: Boolean(activeLink),
      activeLink,
      usbLink: group.links.find((l) => l.transport === LINK_USB) || null,
      wifiLink: group.links.find((l) => l.transport === LINK_WIFI) || null,
      live: group.links.length > 0,
    };
    finished.status = statusOf(finished, session);
    return finished;
  });

  const nearbyRank = { ready: 0, unauthorized: 1, offline: 2 };
  return {
    active: all.find((g) => g.active) || null,
    nearby: all.filter((g) => g.live && !g.active).sort((a, b) => nearbyRank[a.status] - nearbyRank[b.status]),
    saved: all.filter((g) => !g.live), // GET /devices/known sırası: en son görülen başta
    all,
  };
}

/** Hattın bir sonraki bağlanma yolu: önce kullanılabilir USB, sonra Wi-Fi; yoksa kayıtlı kablosuz adres. */
export function connectRoute(group) {
  if (!group) return null;
  if (usable(group.usbLink)) return { kind: 'bind', serial: group.usbLink.serial, transport: LINK_USB };
  if (usable(group.wifiLink)) return { kind: 'bind', serial: group.wifiLink.serial, transport: LINK_WIFI };
  if (!group.live && group.known && group.known.last_transport === 'wireless') return { kind: 'known', androidId: group.known.android_id };
  return null;
}

/**
 * Bir satırın birincil eylemi ya da neden eylemi olmadığı:
 *   { action: 'connect' | 'reconnect' } · { hint: 'unauthorized' | 'offline' | 'plug-usb' } · null (etkin cihaz)
 */
export function primaryAction(group) {
  if (!group || group.active) return null;
  if (group.status === 'unauthorized') return { hint: 'unauthorized' };
  if (group.status === 'offline') return { hint: 'offline' };
  const route = connectRoute(group);
  if (route?.kind === 'bind') return { action: 'connect' };
  if (route?.kind === 'known') return { action: 'reconnect' };
  return { hint: 'plug-usb' };
}

/**
 * Etkin cihazın hat seçici durumu: her hat için { available, reason } — reason: 'busy' | 'needs-cable' | 'unauthorized'.
 * Wi-Fi her zaman denenebilir (USB'den `adb tcpip`); USB yalnız AYNI telefonun kullanılabilir USB hattı varken.
 */
export function linkChoices(group) {
  if (!group?.active) return null;
  const busy = group.status !== 'connected' && group.status !== 'weak';
  const current = group.activeLink?.transport || LINK_USB;
  const usb = group.usbLink;
  const usbReason = usable(usb) ? null : usb?.state === 'unauthorized' ? 'unauthorized' : 'needs-cable';
  return {
    current,
    [LINK_USB]: current === LINK_USB ? { available: true, reason: null } : { available: !busy && !usbReason, reason: busy ? 'busy' : usbReason },
    [LINK_WIFI]: current === LINK_WIFI ? { available: true, reason: null } : { available: !busy, reason: busy ? 'busy' : null },
  };
}

/**
 * Bağlam menüsünün öğeleri (sağ tık · ⋯ · Shift+F10). Etiket/simge bileşende; burada yalnız NE sunulur ve neden kapalı.
 * @returns Array<{ id, disabled?, reason? } | { type: 'separator' }>
 */
export function deviceMenu(group, { busy = false } = {}) {
  if (!group) return [];
  const items = [];
  const sep = () => {
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
  };
  if (group.active) {
    const choices = linkChoices(group);
    const other = choices.current === LINK_USB ? LINK_WIFI : LINK_USB;
    items.push({ id: other === LINK_USB ? 'switch-usb' : 'switch-wifi', disabled: busy || !choices[other].available, reason: choices[other].reason });
    items.push({ id: 'disconnect', disabled: busy });
  } else {
    const primary = primaryAction(group);
    if (primary?.action) items.push({ id: primary.action, disabled: busy });
  }
  sep();
  if (group.known) items.push({ id: 'rename' });
  const serial = group.activeLink?.serial || group.usbLink?.serial || null;
  if (serial && !serial.includes(':')) items.push({ id: 'copy-serial' });
  const ip = group.wifiLink?.ip || group.known?.discovered_ip || group.known?.last_known_ip || null;
  if (ip) items.push({ id: 'copy-ip', value: ip });
  if (group.known) {
    sep();
    items.push({ id: 'forget', destructive: true });
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  return items;
}

/** Kayıtlı bir kaydın en anlamlı adresi ("192.168.1.5"); yoksa null. */
export function knownAddress(known) {
  if (!known) return null;
  if (known.discovered && known.discovered_ip) return known.discovered_ip;
  return known.last_known_ip || null;
}
