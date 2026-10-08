// Project settings + desktop layout persistence client.

import { api } from '../lib/api.js';

const listeners = new Set();

export function subscribeSettings(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function getSettings() {
  return api.get('/api/settings');
}

// Kayıtlar SIRAYA girer: her biri bir öncekinin PUT'u bittikten sonra güncel ayarı okur. Eskiden art arda iki
// değişiklik aynı "current"ı okuyup tam nesneyi yazıyordu → son yazan, diğerinin değerini sessizce siliyordu.
let saveChain = Promise.resolve();

export function saveSettings(patch) {
  const run = saveChain.then(async () => {
    const current = await getSettings();
    const saved = await api.put('/api/settings', { ...current, ...patch });
    listeners.forEach((fn) => fn(saved));
    return saved;
  });
  saveChain = run.catch(() => {});
  return run;
}

export async function getAppLayout() {
  return api.get('/api/layout');
}

export async function saveAppLayout(layout) {
  return api.put('/api/layout', layout);
}
