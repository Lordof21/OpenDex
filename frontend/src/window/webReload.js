// "Sayfayı yenile": a Chromium-based window's foreground tab is reloaded (backend: windows/web_reload.py — a NORMAL reload
// through the DevTools socket; the app, its other tabs and the process are untouched).
//
// Deliberately a button and never automatic: a reload after every resize would reload a page the user is reading (lost form
// input, restarted media) and cost the phone one more full render per resize. The user presses it when a page came out wrong.
//
// Whether a window HAS a page is asked of the phone (GET /api/windows/:id/web-reload) — there is no list of browser names here,
// so any Chromium fork (or an app that exposes its WebView to DevTools) is offered the action. The title-bar button and the Hub
// row share one answer per window (an explicit reply is remembered for a few minutes: the title bar remounts whenever it auto-hides).
import { useEffect, useState } from 'react';

import { api } from '../lib/api.js';
import { useSystemStore } from '../state/systemStore.js';
import { restartFailedToast } from './appRestart.js';
import { useWindowStore } from './windowStore.js';
import { t } from '../i18n/index.js';

export const reloadDoneToast = () => t('window.sayfa_yenilendi');
// The backend's refusal text is already a Turkish sentence that says why; same shaping as the restart toast.
export const reloadFailedToast = restartFailedToast;

/** Reloads the window's page and says what happened (the Hub and the taskbar menu share this). Never rejects. */
export async function reloadPageWithToast(windowId) {
  let message;
  try {
    await useWindowStore.getState().reloadWindowPage(windowId);
    message = reloadDoneToast();
  } catch (err) {
    message = reloadFailedToast(err);
  }
  useSystemStore.getState().pushToast?.(message);
}

const KNOWN_TTL_MS = 5 * 60_000;
const known = new Map(); // window id → { available, at } — explicit replies only; an error is never remembered as "no"
const asking = new Map(); // window id → the question in flight (the title bar and the Hub ask at the same moment: one request)

/** Forget what is known about a window's page (tests, and a window whose app changed). */
export function forgetWebReload(windowId) {
  if (windowId === undefined) {
    known.clear();
    asking.clear();
  } else {
    known.delete(windowId);
    asking.delete(windowId);
  }
}

const recall = (windowId) => {
  const hit = known.get(windowId);
  return hit && Date.now() - hit.at < KNOWN_TTL_MS ? hit.available : null;
};

/**
 * Is there a web page to reload in this window's app? Asked of the phone while `enabled` (a menu is open, or the window shows
 * its title bar), at most once per few minutes per window; anything but an explicit `available: true` — an error, an old
 * backend, a mocked client — means "no".
 */
export function useWebReloadAvailable(windowId, enabled) {
  const [available, setAvailable] = useState(() => (enabled && windowId ? recall(windowId) === true : false));
  useEffect(() => {
    if (!enabled || !windowId) {
      setAvailable(false);
      return undefined;
    }
    const remembered = recall(windowId);
    if (remembered !== null) {
      setAvailable(remembered);
      return undefined;
    }
    let live = true;
    let question = asking.get(windowId);
    if (!question) {
      question = Promise.resolve(api.get(`/api/windows/${encodeURIComponent(windowId)}/web-reload`))
        .then((reply) => {
          const yes = reply?.available === true;
          if (reply && typeof reply.available === 'boolean') known.set(windowId, { available: yes, at: Date.now() });
          return yes;
        })
        .catch(() => false)
        .finally(() => asking.delete(windowId));
      asking.set(windowId, question);
    }
    question.then((yes) => live && setAvailable(yes));
    return () => {
      live = false;
    };
  }, [windowId, enabled]);
  return available;
}
