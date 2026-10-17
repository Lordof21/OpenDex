// Bir pencerenin / görevin şu an basılı düğümleri (motor yayını): rozetler bununla yanar.
import { useSyncExternalStore } from 'react';
import { getKeymapActivity, subscribeKeymapActivity } from '../keymapperEngine.js';

export function useKeymapActivity(targetId) {
  return useSyncExternalStore(
    (notify) => subscribeKeymapActivity(targetId, notify),
    () => getKeymapActivity(targetId),
    () => getKeymapActivity(targetId),
  );
}
