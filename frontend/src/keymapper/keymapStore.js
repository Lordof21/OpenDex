// Keymap Zustand store — manages visual keymapping presets per app package.
//
// Key Node Shape:
//   { id, type: 'tap' | 'dpad', key: string, label: string, rx: number, ry: number, radius?: number }
//   - rx, ry: normalized coordinates in [0, 1] relative to device width/height.

import { create } from 'zustand';

const STORAGE_KEY = 'opendex_keymap_presets';

// Default presets for popular packages (game packages can define their own)
const DEFAULT_PRESETS = {
  default: [],
};

function loadPresetsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PRESETS;
    const parsed = JSON.parse(raw);
    // Sanitize: clear old default WASD preset if it exists in storage so normal apps don't hijack typing
    if (parsed.default && parsed.default.some((n) => n.id === 'wasd')) {
      parsed.default = [];
    }
    return parsed;
  } catch {
    return DEFAULT_PRESETS;
  }
}

function savePresetsToStorage(presets) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {}
}

export const useKeymapStore = create((set, get) => ({
  presets: loadPresetsFromStorage(),
  editWindowId: null, // window_id currently in Keymapper Edit Mode
  activePresetPackage: null,
  overlayOpacity: 0.75, // 0.2 to 1.0 visual opacity of key badges

  setEditWindowId: (windowId) => set({ editWindowId: windowId }),
  setOverlayOpacity: (opacity) => set({ overlayOpacity: opacity }),

  getKeymapForPackage: (pkg) => {
    const { presets } = get();
    return presets[pkg] || [];
  },

  savePackageKeymap: (pkg, nodes) => {
    const { presets } = get();
    const updated = { ...presets, [pkg]: nodes };
    savePresetsToStorage(updated);
    set({ presets: updated });
  },

  addNodeToPackage: (pkg, node) => {
    const { getKeymapForPackage, savePackageKeymap } = get();
    const current = getKeymapForPackage(pkg);
    const newNode = {
      id: node.id || `node_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: node.type || 'tap',
      key: node.key || 'Space',
      label: node.label || 'Tıklama',
      rx: node.rx ?? 0.5,
      ry: node.ry ?? 0.5,
      radius: node.radius ?? 0.1,
    };
    savePackageKeymap(pkg, [...current, newNode]);
  },

  updateNodeInPackage: (pkg, nodeId, patch) => {
    const { getKeymapForPackage, savePackageKeymap } = get();
    const current = getKeymapForPackage(pkg);
    const updated = current.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
    savePackageKeymap(pkg, updated);
  },

  removeNodeFromPackage: (pkg, nodeId) => {
    const { getKeymapForPackage, savePackageKeymap } = get();
    const current = getKeymapForPackage(pkg);
    const updated = current.filter((n) => n.id !== nodeId);
    savePackageKeymap(pkg, updated);
  },

  resetPackageToDefault: (pkg) => {
    const { savePackageKeymap } = get();
    savePackageKeymap(pkg, DEFAULT_PRESETS['default']);
  },

  clearPackageKeymap: (pkg) => {
    const { savePackageKeymap } = get();
    savePackageKeymap(pkg, []);
  },
}));
