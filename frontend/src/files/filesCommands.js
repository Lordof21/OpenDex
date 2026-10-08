// Kullanıcı eylemleri: store durumunu okur, backend'i çağırır, sonucu bildirir. Bileşenler (menü, kısayol, sürükle-bırak)
// hep BU işlevleri çağırır — "Sil" bir menüde de Delete tuşunda da aynı davranır.
import { useSystemStore } from '../state/systemStore.js';
import { fsApi } from './fsApi.js';
import { renameSelection, uniqueName, validateName } from './fileNames.js';
import { previewKind } from './fileTypes.js';
import { keyOf, useFilesStore } from './filesStore.js';
import { countLabel } from './formatters.js';
import { baseName, deviceKey, isPhone, joinPath, parentOf, sameLoc, sepOf } from './paths.js';
import { addFolderViaShell, grantPaths, inTauri, pickFiles, pickFolder } from './tauriBridge.js';
import { useTransferStore } from './transferStore.js';

const toast = (message, options) => useSystemStore.getState().pushToast?.(message, options);
const store = () => useFilesStore.getState();

/** Bölmenin açık klasörü (kanonik yol: telefonda /sdcard → /storage/emulated/0). */
export function paneFolder(pane) {
  return pane?.loc ? { ...pane.loc, path: pane.canonical || pane.loc.path } : null;
}

/** Girdinin konumu: arama sonuçlarında kendi konumu, klasör listesinde klasör + ad. */
export function entryLoc(pane, entry) {
  return entry._loc ?? joinPath(paneFolder(pane), entry.name);
}

const usesWindowsNames = (loc) => !isPhone(loc) && sepOf(loc) === '\\';

function selected(winId, pi) {
  const pane = store().wins[winId]?.panes[pi];
  return { pane, entries: store().selectedEntries(winId, pi) };
}

// ── Açma ───────────────────────────────────────────────────────────────────────────────────────────────────
export async function openEntry(winId, pi, entry) {
  const pane = store().wins[winId]?.panes[pi];
  if (!pane || !entry) return;
  const loc = entryLoc(pane, entry);
  if (entry.kind === 'dir') {
    await store().navigate(winId, pi, loc);
    return;
  }
  if (previewKind(entry)) {
    store().openPreview(winId, pi, keyOf(entry));
    return;
  }
  await openOnPc(loc);
}

export async function openOnPc(loc) {
  try {
    await fsApi.open(loc);
    if (isPhone(loc)) toast('Dosya bilgisayara indirilip açılıyor…', { tone: 'info' });
  } catch (err) {
    toast(err.code === 'permission' ? 'Bu dosya türü güvenlik nedeniyle doğrudan açılmaz; klasörde gösterin.' : err.message || 'Dosya açılamadı.', { tone: 'error' });
  }
}

export async function revealOnPc(loc) {
  try {
    await fsApi.reveal(loc);
  } catch (err) {
    toast(err.message || 'Klasörde gösterilemedi.', { tone: 'error' });
  }
}

// ── Yeni klasör / yeniden adlandırma ───────────────────────────────────────────────────────────────────────
/** "Yeni klasör" oluşturur, listeyi yeniler ve ADLANDIRMA kutusunu açar (Gezgin gibi). */
export async function createFolder(winId, pi) {
  const pane = store().wins[winId]?.panes[pi];
  const folder = paneFolder(pane);
  if (!folder) return;
  const taken = new Set(pane.entries.map((e) => e.name.normalize('NFC').toLowerCase()));
  const name = uniqueName('Yeni klasör', taken);
  try {
    await fsApi.mkdir(folder, name);
    await store().navigate(winId, pi, pane.loc, { push: false, select: name, rename: true });
  } catch (err) {
    toast(err.message || 'Klasör oluşturulamadı.', { tone: 'error' });
  }
}

/** Satır içi adlandırmayı uygular. Hata satır içinde gösterilsin diye FIRLATILIR (iletişim kutusu yok). */
export async function commitRename(winId, pi, entry, newName) {
  const pane = store().wins[winId]?.panes[pi];
  const name = newName.trim();
  if (!pane || name === entry.name) {
    store().stopRename(winId, pi);
    return;
  }
  const loc = entryLoc(pane, entry);
  const problem = validateName(name, { windows: usesWindowsNames(loc) });
  if (problem) throw Object.assign(new Error(problem), { code: 'invalid_name' });
  await fsApi.rename(loc, name);                                   // reddedilirse (zaten var…) çağıran satır içinde gösterir
  store().stopRename(winId, pi);
  await store().navigate(winId, pi, pane.loc, { push: false, select: name });
}

export const renameRange = renameSelection;

// ── Silme ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Delete → geri dönüşüm; Shift+Delete → onay iletişim kutusu, sonra kalıcı. */
export async function deleteSelected(winId, pi, { permanent = false } = {}) {
  const { pane, entries } = selected(winId, pi);
  if (!pane || entries.length === 0) return;
  if (permanent) {
    store().openDialog(winId, { type: 'confirm-delete', pane: pi, items: entries.map((e) => ({ entry: e, loc: entryLoc(pane, e) })) });
    return;
  }
  await performDelete(winId, pi, entries.map((e) => ({ entry: e, loc: entryLoc(pane, e) })), false);
}

export async function performDelete(winId, pi, items, permanent) {
  store().closeDialog(winId);                                      // onay kutusu kapanır; "kutu yok" sorusu AŞAĞIDA yeniden açılabilir
  try {
    const { results } = await fsApi.remove(items.map((i) => i.loc), { permanent });
    const ok = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    const noBin = failed.filter((r) => r.error?.code === 'trash_unavailable');
    if (noBin.length && !permanent) {
      // Geri dönüşüm kutusu yok (ör. telefonun /data/local/tmp'si): sessizce kalıcı silme YOK, kullanıcıya sorulur.
      const retry = items.filter((i) => noBin.some((r) => r.path === i.loc.path));
      store().openDialog(winId, { type: 'confirm-delete', pane: pi, items: retry, reason: 'no-bin' });
    }
    const other = failed.filter((r) => r.error?.code !== 'trash_unavailable');
    if (ok) {
      const where = permanent ? 'silindi' : isPhone(items[0].loc) ? 'telefonun geri dönüşüm kutusuna taşındı' : 'geri dönüşüm kutusuna taşındı';
      toast(`${countLabel(ok)} ${where}.`, { tone: 'success' });
    }
    if (other.length) toast(`${countLabel(other.length)} silinemedi: ${other[0].error?.message || 'bilinmeyen hata'}`, { tone: 'error' });
  } catch (err) {
    toast(err.message || 'Silinemedi.', { tone: 'error' });
  } finally {
    await store().reload(winId, pi);
  }
}

// ── Pano ───────────────────────────────────────────────────────────────────────────────────────────────────
export function copySelection(winId, pi, op = 'copy') {
  const { pane, entries } = selected(winId, pi);
  if (!pane || entries.length === 0) return;
  store().setClipboard({ op, items: entries.map((e) => ({ loc: entryLoc(pane, e), name: e.name, kind: e.kind })) });
  toast(`${countLabel(entries.length)} ${op === 'cut' ? 'kesildi' : 'kopyalandı'}.`, { tone: 'info', durationMs: 1800 });
}

export const cutSelection = (winId, pi) => copySelection(winId, pi, 'cut');

/** `into`: açıkça verilen klasör (bağlam menüsü "İçine yapıştır"); verilmezse bölmenin açık klasörü. */
export async function paste(winId, pi, into = null) {
  const { clipboard } = store();
  const dest = into || paneFolder(store().wins[winId]?.panes[pi]);
  if (!clipboard || !dest) return;
  await startTransfer({ op: clipboard.op === 'cut' ? 'move' : 'copy', sources: clipboard.items.map((i) => i.loc), dest });
  if (clipboard.op === 'cut') store().setClipboard(null);
}

// ── Aktarımlar ─────────────────────────────────────────────────────────────────────────────────────────────
export async function startTransfer(spec) {
  try {
    return await useTransferStore.getState().start(spec);
  } catch (err) {
    toast(err.message || 'Aktarım başlatılamadı.', { tone: 'error' });
    return null;
  }
}

/** İki bölmeli kipte F5 / F6: seçili girdileri DİĞER bölmenin klasörüne kopyala / taşı. */
export async function transferToOtherPane(winId, op) {
  const w = store().wins[winId];
  if (!w || w.panes.length < 2) return;
  const from = w.activePane;
  const { pane, entries } = selected(winId, from);
  const dest = paneFolder(w.panes[1 - from]);
  if (!pane || !dest || entries.length === 0) return;
  await startTransfer({ op, sources: entries.map((e) => entryLoc(pane, e)), dest });
}

/** "Telefona gönder" / "Bilgisayara kaydet": karşı tarafın uygun klasörüne kopyalar. */
export function defaultDestination(places, target) {
  if (target === 'phone') {
    const root = places.phone.find((p) => p.kind === 'internal') || places.phone[0];
    return root ? { provider: 'phone', path: `${root.path.replace(/\/$/, '')}/Download`, device: root.device ?? places.device } : null;
  }
  const dl = places.pc.find((p) => p.kind === 'downloads') || places.pc[0];
  return dl ? { provider: 'pc', path: dl.path } : null;
}

export async function sendSelection(winId, pi, target) {
  const { pane, entries } = selected(winId, pi);
  const dest = defaultDestination(store().places, target);
  if (!pane || !dest || entries.length === 0) {
    if (!dest) toast(target === 'phone' ? 'Telefon bağlı değil.' : 'Hedef klasör bulunamadı.', { tone: 'warning' });
    return;
  }
  await startTransfer({ op: 'copy', sources: entries.map((e) => entryLoc(pane, e)), dest });
}

/**
 * Sürükle-bırak: aynı yerde (aynı sağlayıcı + cihaz) varsayılan TAŞI, Ctrl ile kopyala; farklı yerler arasında varsayılan
 * KOPYALA (taşımak silmek demektir), Shift ile taşı. Kendi klasörüne bırakmak hiçbir şey yapmaz.
 */
export function dropOperation({ sources, dest, ctrl = false, shift = false }) {
  const same = sources.every((s) => s.provider === dest.provider && deviceKey(s) === deviceKey(dest));
  if (same) return ctrl ? 'copy' : 'move';
  return shift ? 'move' : 'copy';
}

export async function dropOnFolder({ sources, dest, ctrl = false, shift = false }) {
  const usable = sources.filter((s) => !sameLoc(parentOf(s), dest) || ctrl);       // zaten orada
  if (usable.length === 0) return null;
  return startTransfer({ op: dropOperation({ sources: usable, dest, ctrl, shift }), sources: usable, dest });
}

/** Tauri sürükle-bırak / dosya seçici: kabuk yolları İZİNLE (grant) kaydetti; burada yalnızca aktarım başlar. */
export async function startExternalTransfer(grants, dest) {
  if (!grants?.length || !dest) return null;
  return startTransfer({ op: 'copy', sources: grants.map((g) => ({ provider: 'pc', path: g.path })), dest });
}

// ── Yerler ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function addFavorite(loc, name) {
  try {
    await fsApi.addFavorite(loc, name || baseName(loc));
    await store().loadPlaces(store().places.device);
  } catch (err) {
    toast(err.message || 'Favorilere eklenemedi.', { tone: 'error' });
  }
}

export async function removeFavorite(id) {
  await fsApi.removeFavorite(id).catch(() => {});
  await store().loadPlaces(store().places.device).catch(() => {});
}

/** "Klasör ekle": yerel seçici → kabuk jetonlu kalıcı izin. Tarayıcıda (Tauri yok) açıklayıcı ileti. */
export async function addPcFolder() {
  try {
    if (!inTauri()) {
      toast('Klasör eklemek yalnız masaüstü uygulamasında yapılabilir.', { tone: 'warning' });
      return;
    }
    const path = await pickFolder();
    if (!path) return;
    await addFolderViaShell(path);
    await store().loadPlaces(store().places.device);
  } catch (err) {
    toast(err.code === 'outside_roots' ? 'Bu klasör güvenlik nedeniyle eklenemez.' : err.message || 'Klasör eklenemedi.', { tone: 'error' });
  }
}

/** "Dosya yükle": yerel seçici → izin → etkin klasöre kopyala (PC'den telefona/bilgisayara). */
export async function uploadFromPc(winId, pi) {
  const dest = paneFolder(store().wins[winId]?.panes[pi]);
  if (!dest) return;
  try {
    if (!inTauri()) {
      toast('Dosya seçmek yalnız masaüstü uygulamasında yapılabilir.', { tone: 'warning' });
      return;
    }
    const paths = await pickFiles();
    if (!paths.length) return;
    await startExternalTransfer(await grantPaths(paths), dest);
  } catch (err) {
    toast(err.message || 'Dosyalar eklenemedi.', { tone: 'error' });
  }
}

export function showProperties(winId, pi, entry) {
  const pane = store().wins[winId]?.panes[pi];
  if (pane) store().openDialog(winId, { type: 'properties', pane: pi, entry, loc: entryLoc(pane, entry) });
}
