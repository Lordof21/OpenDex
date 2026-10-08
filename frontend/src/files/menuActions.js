// Bağlam menüsü öğesi → eylem. Menü (fare / Menu tuşu / dokunmatik çubuk) ile klavye kısayolu aynı komutları çağırır;
// burada yalnızca "menü kimliği → hangi komut" eşlemesi vardır.
import {
  addFavorite, copySelection, createFolder, cutSelection, deleteSelected, entryLoc, openEntry, openOnPc, paste, revealOnPc,
  sendSelection, showProperties, transferToOtherPane,
} from './filesCommands.js';
import { keyOf, useFilesStore } from './filesStore.js';

/**
 * @param {string} id   buildMenu öğe kimliği
 * @param {{winId:string, pi:number, entries:object[]}} ctx   entries: menünün açıldığı hedefler (boş alan = [])
 */
export async function runMenuAction(id, { winId, pi, entries }) {
  const S = useFilesStore.getState();
  const pane = S.wins[winId]?.panes[pi];
  if (!pane) return;
  const one = entries.length === 1 ? entries[0] : null;
  switch (id) {
    case 'open': return openEntry(winId, pi, one);
    case 'preview': return S.openPreview(winId, pi, keyOf(one));
    case 'open-on-pc': return openOnPc(entryLoc(pane, one));
    case 'reveal': return revealOnPc(entryLoc(pane, one));
    case 'send-to-phone': return sendSelection(winId, pi, 'phone');
    case 'save-to-pc': return sendSelection(winId, pi, 'pc');
    case 'copy-other': return transferToOtherPane(winId, 'copy');
    case 'move-other': return transferToOtherPane(winId, 'move');
    case 'copy': return copySelection(winId, pi);
    case 'cut': return cutSelection(winId, pi);
    case 'paste': return paste(winId, pi);
    case 'paste-into': return paste(winId, pi, entryLoc(pane, one));
    case 'rename': return S.startRename(winId, pi, keyOf(one));
    case 'favorite': return addFavorite(entryLoc(pane, one), one.name);
    case 'delete': return deleteSelected(winId, pi);
    case 'properties': return showProperties(winId, pi, one);
    case 'new-folder': return createFolder(winId, pi);
    case 'toggle-hidden': return S.toggleHidden(winId, pi);
    case 'refresh': return S.reload(winId, pi);
    default: return undefined;
  }
}

/** Kısayol/menü için "bu pencerede adres çubuğuna / aramaya odaklan" olayları (Breadcrumbs / Toolbar dinler). */
export const FOCUS_PATH_EVENT = 'opendex:files-focus-path';
export const FOCUS_SEARCH_EVENT = 'opendex:files-focus-search';
export const emitFocus = (type, winId, pi) => window.dispatchEvent(new CustomEvent(type, { detail: { winId, pi } }));
