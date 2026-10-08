// OpenDeX Desktop Home Screen — Ported from Smooth Resize Studio & Desktop Icon Grid
// Complete with 17x7 slot grid, multi-wallpaper engine, dynamic scaling, custom folder icons,
// drag-and-drop rearrangement, floating status badge, and desktop/icon context menus.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Edit2,
  Grid2x2,
  Image as ImageIcon,
  LayoutGrid,
  MonitorCog,
  Moon,
  Plus,
  RotateCcw,
  Shuffle,
  Sun,
  Trash2,
  Play,
  RefreshCw,
  EyeOff,
  SlidersHorizontal,
  Smartphone,
  AppWindow,
  Search,
  X,
} from 'lucide-react';

import AppIcon from '../ui/AppIcon.jsx';
import Button from '../ui/Button.jsx';
import { Dialog } from '../ui/Dialog.jsx';
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from '../ui/Menu.jsx';
import DesktopLoadingSkeleton from './DesktopLoadingSkeleton.jsx';
import ManageIconsDialog from './ManageIconsDialog.jsx';
import WallpaperDialog from './wallpaper/WallpaperDialog.jsx';
import { useWallpaper } from './wallpaper/useWallpaper.js';
import { useWallpaperStore } from './wallpaper/wallpaperStore.js';
import { desktopStats } from './manageIcons.js';
import { fetchAppList, refreshAppList } from './appRegistry.js';
import { getAppLayout, saveAppLayout } from '../settings/settingsApi.js';
import { useWindowStore } from '../window/windowStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { useTheme } from '../state/ThemeContext.jsx';
import { openOpenDexSettings } from '../settings/SettingsPanel.jsx';
import { cn } from '../lib/utils.js';
import { api } from '../lib/api.js';

export const COLUMNS = 17;
export const ROWS = 7;
export const CELLS = COLUMNS * ROWS; // 119 slots

const SCALE_LABEL = {
  small: 'Küçük',
  medium: 'Orta',
  large: 'Büyük',
};

const SCALE_VALUE = {
  small: 0.82,
  medium: 1.0,
  large: 1.2,
};

const CURATED_ESSENTIAL_CATEGORIES = [
  // 1. OpenDeX System Tools
  { key: 'settings_opendex', test: (pkg) => pkg === 'com.opendex.settings' },
  { key: 'screen_mirror', test: (pkg) => pkg === 'com.opendex.screen_mirror' },
  { key: 'files_opendex', test: (pkg) => pkg === 'com.opendex.files' },

  // 2. Android Daily Drivers (at most 1 per category, Windows / DeX style)
  { key: 'browser', test: (pkg, name) => /chrome|browser|sbrowser|firefox|opera|edge|internet|tarayıcı/i.test(`${pkg} ${name}`) },
  { key: 'files', test: (pkg, name) => /files|filemanager|documentsui|myfiles|dosyalar|dosya/i.test(`${pkg} ${name}`) },
  { key: 'gallery', test: (pkg, name) => /gallery|photos|fotoğraf|galeri/i.test(`${pkg} ${name}`) },
  { key: 'camera', test: (pkg, name) => /camera|kamera/i.test(`${pkg} ${name}`) },
  { key: 'settings', test: (pkg, name) => (pkg === 'com.android.settings' || /settings|ayarlar/i.test(name)) && !pkg.includes('opendex') },
  { key: 'youtube', test: (pkg, name) => /youtube/i.test(`${pkg} ${name}`) },
  { key: 'messages', test: (pkg, name) => /whatsapp|messaging|mms|telegram|signal|mesaj/i.test(`${pkg} ${name}`) },
  { key: 'phone', test: (pkg, name) => /dialer|contacts|telefon|rehber/i.test(`${pkg} ${name}`) },
  { key: 'store', test: (pkg, name) => /vending|playstore|play store|store|mağaza/i.test(`${pkg} ${name}`) },
  { key: 'music', test: (pkg, name) => /spotify|music|müzik|ytmusic/i.test(`${pkg} ${name}`) },
  { key: 'calendar', test: (pkg, name) => /calendar|takvim/i.test(`${pkg} ${name}`) },
  { key: 'calculator', test: (pkg, name) => /calculator|hesap/i.test(`${pkg} ${name}`) },
  { key: 'notes', test: (pkg, name) => /notes|keep|notlar/i.test(`${pkg} ${name}`) },
];

const DEFAULT_FALLBACK_APPS = [
  { package: 'com.opendex.settings', display_name: 'OpenDeX Ayarları', isBuiltin: true },
  { package: 'com.opendex.screen_mirror', display_name: 'Telefon Ekranını Yansıt', isBuiltin: true },
  { package: 'com.opendex.files', display_name: 'Dosyalar', isBuiltin: true },
  { package: 'com.android.chrome', display_name: 'Chrome' },
  { package: 'com.sec.android.app.myfiles', display_name: 'Dosyalarım' },
  { package: 'com.sec.android.gallery3d', display_name: 'Galeri' },
  { package: 'com.android.settings', display_name: 'Ayarlar' },
  { package: 'com.google.android.youtube', display_name: 'YouTube' },
  { package: 'com.sec.android.app.camera', display_name: 'Kamera' },
  { package: 'com.whatsapp', display_name: 'Mesajlar' },
  { package: 'com.samsung.android.dialer', display_name: 'Çağrı' },
  { package: 'com.android.vending', display_name: 'Play Store' },
  { package: 'com.samsung.android.calendar', display_name: 'Takvim' },
];

function buildDefaultSlots(apps) {
  const effectiveApps = apps && apps.length > 2 ? apps : DEFAULT_FALLBACK_APPS;
  const chosenPkgs = new Set();
  const sorted = [];

  // Built-in system apps first
  for (const app of effectiveApps) {
    if (app.isBuiltin && !chosenPkgs.has(app.package)) {
      sorted.push(app);
      chosenPkgs.add(app.package);
    }
  }

  // Curated essentials (at most 1 app per essential category)
  for (const cat of CURATED_ESSENTIAL_CATEGORIES) {
    const match = effectiveApps.find(
      (a) => !chosenPkgs.has(a.package) && cat.test(a.package, a.display_name)
    );
    if (match) {
      sorted.push(match);
      chosenPkgs.add(match.package);
    }
  }

  // NOTE: Windows / DeX design pattern:
  // We do NOT append all remaining installed apps!
  // The desktop holds only curated essential favorites (~10-14 apps).
  // All other apps live in the App Drawer / Start Menu and can be pinned to desktop on demand.

  // Assign column-by-column (filling down each column first: 7 items per column)
  const layout = {};
  sorted.forEach((app, index) => {
    if (index < CELLS) {
      const column = Math.floor(index / ROWS);
      const row = index % ROWS;
      const cell = row * COLUMNS + column;
      layout[cell] = app.package;
    }
  });

  return layout;
}

export default function Desktop() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Desktop slots & layout: cell -> app.package or customId
  const [layout, setLayout] = useState({});
  const [custom, setCustom] = useState(() => {
    try {
      const saved = window.localStorage.getItem('opendex_custom_icons');
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed.map((item) => ({
          ...item,
          type: item.type || 'folder',
          appIds: Array.isArray(item.appIds) ? item.appIds : [],
        }));
      }
      return [];
    } catch {
      return [];
    }
  });

  // Rename & Folder Modal state
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [activeFolder, setActiveFolder] = useState(null);
  const [showAddAppPicker, setShowAddAppPicker] = useState(false);
  const [folderAppSearch, setFolderAppSearch] = useState('');

  // Display modes & settings
  const [scale, setScale] = useState(() => {
    try {
      return window.localStorage.getItem('opendex_desktop_scale') || 'medium';
    } catch {
      return 'medium';
    }
  });

  const wallpaper = useWallpaper();
  const randomizeWallpaper = useWallpaperStore((s) => s.randomize);
  const showGrid = useWallpaperStore((s) => s.prefs.mode === 'builtin' && s.prefs.id === 'plain'); // ızgara yalnız "Düz" kapakta

  // Interaction states
  const [dragging, setDragging] = useState(null);
  const [target, setTarget] = useState(null);
  const [selected, setSelected] = useState(null);
  const [menu, setMenu] = useState(null); // { x, y, cell, itemId }
  const [submenu, setSubmenu] = useState(null); // { type, top, left }
  const [spin, setSpin] = useState(0);
  const [showHiddenModal, setShowHiddenModal] = useState(false);
  const [showWallpaper, setShowWallpaper] = useState(false);
  const [iconVersions, setIconVersions] = useState({});

  const { theme, toggleTheme } = useTheme();

  // Stores & APIs
  const openWindow = useWindowStore((s) => s.openWindow);
  const pushToast = useSystemStore((s) => s.pushToast);
  const connected = useSystemStore((s) => s.connectionState === 'connected');
  const deviceLabel = useSystemStore((s) => s.deviceLabel);
  const setLaunchpadOpen = useSystemStore((s) => s.setLaunchpadOpen);
  const openSettings = useSystemStore((s) => s.openSettings);

  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const submenuRef = useRef(null);

  // Persist scale
  useEffect(() => {
    try {
      window.localStorage.setItem('opendex_desktop_scale', scale);
    } catch {}
  }, [scale]);

  useEffect(() => {
    try {
      window.localStorage.setItem('opendex_custom_icons', JSON.stringify(custom));
    } catch {}
  }, [custom]);

  // Load app list and persisted layout
  const loadRetriedRef = useRef(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, savedLayout] = await Promise.all([fetchAppList(), getAppLayout().catch(() => [])]);
      loadRetriedRef.current = false; // başarılı: sıradaki bağımsız bir hatada yeniden tek seferlik deneme hakkı yenilenir
      setApps(list);

      // Determine initial slot arrangement
      const layoutObj = {};
      const occupied = new Set();
      const hidden = new Set();

      if (Array.isArray(savedLayout) && savedLayout.length > 0) {
        for (const entry of savedLayout) {
          if (entry.hidden) {
            hidden.add(entry.package);
          } else if (typeof entry.position === 'number' && entry.position >= 0 && entry.position < CELLS) {
            layoutObj[entry.position] = entry.package;
            occupied.add(entry.position);
          }
        }
      }

      // Restore custom icons into their slots
      try {
        const savedCustom = window.localStorage.getItem('opendex_custom_icons');
        const customItems = savedCustom ? JSON.parse(savedCustom) : [];
        const savedCustomSlots = window.localStorage.getItem('opendex_custom_slots');
        const customSlots = savedCustomSlots ? JSON.parse(savedCustomSlots) : {};
        for (const [cell, id] of Object.entries(customSlots)) {
          const numCell = Number(cell);
          if (!layoutObj[numCell] && customItems.some((c) => c.id === id)) {
            layoutObj[numCell] = id;
            occupied.add(numCell);
          }
        }
      } catch {}

      // If no valid layout was saved, or if saved layout has the legacy full dump (> 20 apps),
      // initialize with the clean curated essentials (Windows / DeX style).
      const placedCount = Object.keys(layoutObj).length;
      if (placedCount === 0 || placedCount > 20) {
        const initial = buildDefaultSlots(list);
        setLayout(initial);
        persistLayout(initial);
      } else {
        setLayout(layoutObj);
      }
    } catch (err) {
      console.warn('Desktop load error:', err);
      // Telefon tam hazır olmadan (örn. ekran henüz kapalıyken) ilk istek düşebilir; bağlantı durumu WS
      // seviyesinde hiç DEĞİŞMEDEN (tam bir kopma/yeniden bağlanma döngüsü olmadan) kendini toparlarsa bu
      // TEK başarısız denemeden sonra uygulama çekmecesi kalıcı olarak boş kalırdı — bir kez yeniden denenir.
      if (!loadRetriedRef.current) {
        loadRetriedRef.current = true;
        setTimeout(load, 2500);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  // Persist layout changes
  const persistLayout = useCallback(
    async (nextLayout) => {
      setLayout(nextLayout);

      // Extract custom vs app placements
      const customSlots = {};
      const backendArray = [];

      for (const [cellStr, id] of Object.entries(nextLayout)) {
        const cell = Number(cellStr);
        if (id.startsWith('custom-')) {
          customSlots[cell] = id;
        } else {
          backendArray.push({ package: id, position: cell, hidden: false });
        }
      }

      // Include hidden apps in backend layout
      const visibleSet = new Set(backendArray.map((e) => e.package));
      for (const app of (apps.length > 0 ? apps : DEFAULT_FALLBACK_APPS)) {
        if (!visibleSet.has(app.package)) {
          backendArray.push({ package: app.package, position: 999, hidden: true });
        }
      }

      try {
        window.localStorage.setItem('opendex_custom_slots', JSON.stringify(customSlots));
        await saveAppLayout(backendArray);
      } catch {
        // Fallback local storage
        try {
          window.localStorage.setItem('opendex_desktop_slots_v4', JSON.stringify(backendArray));
        } catch {}
      }
    },
    [apps]
  );

  // App resolver: maps ID to either custom item or Android app object
  const resolve = useCallback(
    (id) => {
      if (!id) return null;
      if (id.startsWith('custom-')) {
        const item = custom.find((entry) => entry.id === id);
        return item
          ? {
              kind: 'custom',
              id,
              name: item.name,
              type: item.type || 'folder',
              appIds: Array.isArray(item.appIds) ? item.appIds : [],
            }
          : null;
      }
      const app =
        apps.find((item) => item.package === id) ||
        DEFAULT_FALLBACK_APPS.find((item) => item.package === id);
      return app ? { kind: 'app', id, app, name: app.display_name } : null;
    },
    [apps, custom]
  );

  // Drag & drop movement between slots
  const move = (from, to) => {
    if (from === to) return;
    const current = { ...layout };
    const movingId = current[from];
    if (!movingId) return;

    // Check collision: if destination is occupied, snap back
    if (current[to]) {
      const occupant = resolve(current[to]);
      pushToast(`«${occupant?.name || 'Hedef'}» konumu dolu. Simge eski yerine döndü.`);
      return;
    }

    delete current[from];
    current[to] = movingId;
    persistLayout(current);
  };

  // Close context menu & submenus
  const closeMenu = useCallback(() => {
    setSubmenu(null);
    setMenu(null);
  }, []);

  // Keyboard navigation: Escape closes menu/selection, F2 renames, Enter launches or confirms rename
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        closeMenu();
        setSelected(null);
        setEditingId(null);
        setActiveFolder(null);
      } else if (event.key === 'F2' && selected) {
        const entry = resolve(selected);
        if (entry && entry.kind === 'custom') {
          setEditingId(selected);
          setEditingName(entry.name);
        }
      } else if (event.key === 'Enter' && selected) {
        if (editingId) {
          handleSaveRename(editingId);
        } else {
          const entry = resolve(selected);
          if (entry) {
            handleLaunchItem(entry);
          }
        }
      }
    };

    const onDown = (event) => {
      const target = event.target;
      const insideMenu = menuRef.current?.contains(target);
      const insideSubmenu = submenuRef.current?.contains(target);
      if (!insideMenu && !insideSubmenu) closeMenu();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [closeMenu, selected, resolve, editingId, editingName]);

  // Open context menu with bounds safety
  const openMenu = (event, cell, itemId) => {
    event.preventDefault();
    event.stopPropagation();
    setSubmenu(null);

    const rect = rootRef.current?.getBoundingClientRect();
    const width = 226;
    const height = itemId && itemId.startsWith('custom-') ? 140 : itemId ? 220 : 340;
    const rawX = event.clientX - (rect?.left ?? 0);
    const rawY = event.clientY - (rect?.top ?? 0);
    const maxX = Math.max(8, (rect?.width ?? 0) - width - 8);
    const maxY = Math.max(8, (rect?.height ?? 0) - height - 8);

    setMenu({
      x: Math.min(rawX, maxX),
      y: Math.min(rawY, maxY),
      cell,
      itemId,
    });
  };

  // Submenu positioning with automatic edge flip
  const toggleSubmenu = (type) => (event) => {
    const row = event.currentTarget;
    const rowRect = row.getBoundingClientRect();
    const rootRect = rootRef.current?.getBoundingClientRect();
    if (!rootRect) return;

    const menuWidth = 226;
    const submenuWidth = 184;
    const gap = 6;
    const top = rowRect.top - rootRect.top;
    let left = (menu?.x ?? 0) + menuWidth + gap;

    if (left + submenuWidth > rootRect.width - 8) {
      left = (menu?.x ?? 0) - submenuWidth - gap;
    }

    setSubmenu((current) => (current?.type === type ? null : { type, top, left }));
  };

  // Find first unoccupied slot
  const firstFreeCell = (preferred) => {
    if (preferred !== null && preferred !== undefined && !layout[preferred]) return preferred;
    for (let cell = 0; cell < CELLS; cell += 1) {
      if (!layout[cell]) return cell;
    }
    return null;
  };

  // Add custom desktop item (e.g. folder or custom launcher)
  const addIcon = (cell) => {
    const free = firstFreeCell(cell);
    if (free === null) {
      pushToast('Masaüstü dolu (maksimum 119 simge).');
      return;
    }
    const id = `custom-${Date.now()}`;
    const newName = `Yeni Klasör ${custom.length + 1}`;
    const newFolder = { id, name: newName, type: 'folder', appIds: [] };
    setCustom((current) => [...current, newFolder]);
    const nextLayout = { ...layout, [free]: id };
    persistLayout(nextLayout);
    setSelected(id);
    setEditingId(id);
    setEditingName(newName);
    pushToast(`«${newName}» oluşturuldu. Yeniden adlandırmak için hemen yazabilirsiniz.`);
  };

  const startRename = (id) => {
    const entry = resolve(id);
    if (!entry) return;
    setEditingId(id);
    setEditingName(entry.name);
  };

  const handleSaveRename = (id) => {
    if (!editingId || editingId !== id) return;
    const trimmed = editingName.trim();
    if (trimmed) {
      setCustom((current) =>
        current.map((item) => (item.id === id ? { ...item, name: trimmed } : item))
      );
      pushToast(`Klasör adı güncellendi: «${trimmed}»`);
    }
    setEditingId(null);
  };

  const renameFolder = (id, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setCustom((current) =>
      current.map((item) => (item.id === id ? { ...item, name: trimmed } : item))
    );
  };

  const addAppToFolder = (folderId, pkg) => {
    setCustom((current) =>
      current.map((item) => {
        if (item.id !== folderId) return item;
        const appIds = item.appIds || [];
        if (appIds.includes(pkg)) return item;
        return { ...item, appIds: [...appIds, pkg] };
      })
    );
    setActiveFolder((current) =>
      current && current.id === folderId
        ? { ...current, appIds: [...(current.appIds || []), pkg] }
        : current
    );
    pushToast('Uygulama klasöre eklendi.');
  };

  const removeAppFromFolder = (folderId, pkg) => {
    setCustom((current) =>
      current.map((item) => {
        if (item.id !== folderId) return item;
        const appIds = (item.appIds || []).filter((p) => p !== pkg);
        return { ...item, appIds };
      })
    );
    setActiveFolder((current) =>
      current && current.id === folderId
        ? { ...current, appIds: (current.appIds || []).filter((p) => p !== pkg) }
        : current
    );
    pushToast('Uygulama klasörden çıkarıldı.');
  };

  const resetToCuratedDefaults = () => {
    const defaults = buildDefaultSlots(apps);
    persistLayout(defaults);
    setSelected(null);
    setSpin((v) => v + 1);
    pushToast('Masaüstü Windows/DeX tarzı varsayılan önemli uygulamalarla düzenlendi.');
  };

  // Remove custom item
  const removeIcon = (id) => {
    setCustom((current) => current.filter((item) => item.id !== id));
    const next = { ...layout };
    for (const key of Object.keys(next)) {
      if (next[Number(key)] === id) delete next[Number(key)];
    }
    persistLayout(next);
    setSelected(null);
    pushToast('Simge masaüstünden silindi.');
  };

  // Remove app from desktop (hide)
  const removeAppFromDesktop = (app) => {
    const next = { ...layout };
    for (const key of Object.keys(next)) {
      if (next[Number(key)] === app.package) delete next[Number(key)];
    }
    persistLayout(next);
    setSelected(null);
    pushToast(`«${app.display_name}» masaüstünden kaldırıldı (Launchpad'den erişilebilir).`);
  };

  // "Simgeleri yönet" penceresinin tek yazma yolu: düzeni kaydeder; artık masaüstünde olmayan seçili simge seçimden düşer.
  const applyManagedLayout = (next) => {
    persistLayout(next);
    setSelected((current) => (current && Object.values(next).includes(current) ? current : null));
  };

  // Reset layout to default
  const refresh = async () => {
    setRefreshing(true);
    try {
      const diff = await refreshAppList();
      setApps(diff.all_apps);
      const initial = buildDefaultSlots(diff.all_apps);
      persistLayout(initial);
      setSelected(null);
      setSpin((v) => v + 1);
      pushToast('Masaüstü düzeni sıfırlandı.');
    } catch (err) {
      pushToast(`Yenileme hatası: ${err.message || err}`);
    } finally {
      setRefreshing(false);
    }
  };

  // Force re-extract app icon from device
  const handleForceReExtractIcon = async (app) => {
    pushToast(`«${app.display_name}» ikonu cihazdan yeniden çekiliyor...`);
    try {
      const res = await api.post(`/api/apps/icon-v2/${encodeURIComponent(app.package)}/refresh`);
      if (res?.ok) {
        setIconVersions((prev) => ({ ...prev, [app.package]: Date.now() }));
        const kb = Math.round(((res.bytes || 0) / 1024) * 10) / 10;
        pushToast(`[İkon Başarılı] ${app.display_name}: ${kb} KB çekildi (${res.duration_ms || 0}ms)`);
      } else {
        pushToast(`[İkon Hatası] ${app.display_name}: ${res?.error || 'Çekilemedi'}`);
      }
    } catch (err) {
      pushToast(`[İkon İstek Hatası] ${app.display_name}: ${err.message || err}`);
    }
  };

  // Launch app or action
  const handleLaunchItem = (entry) => {
    if (!entry) return;
    if (entry.kind === 'custom') {
      setActiveFolder(entry);
      setShowAddAppPicker(false);
      setFolderAppSearch('');
      return;
    }
    if (entry.app.package === 'com.opendex.settings') {
      openSettings();
      openOpenDexSettings();
      return;
    }
    openWindow(entry.app).catch((exc) => {
      pushToast(exc.message || 'Pencere açılamadı.');
    });
  };

  const handleLaunchMirror = () => {
    handleLaunchItem({
      kind: 'app',
      app: { package: 'com.opendex.screen_mirror', display_name: 'Telefon Ekranını Yansıt' },
    });
  };

  // Windows / DeX click behavior:
  // 1st click = select, 2nd click on selected = launch
  const handleItemClick = (e, id, entry) => {
    e.stopPropagation();
    closeMenu();
    if (selected === id) {
      handleLaunchItem(entry);
    } else {
      setSelected(id);
    }
  };

  // Double click = instant launch
  const handleItemDoubleClick = (e, id, entry) => {
    e.stopPropagation();
    closeMenu();
    handleLaunchItem(entry);
  };

  const menuItem = resolve(menu?.itemId);
  const hiddenCount = desktopStats(apps, layout, CELLS).off;

  return (
    <main
      ref={rootRef}
      role="main"
      aria-label="DeX Masaüstü"
      className="relative flex h-full w-full flex-col p-2.5 sm:p-4 overflow-hidden select-none"
      onClick={() => {
        setSelected(null);
        closeMenu();
      }}
      onContextMenu={(event) => openMenu(event, null, null)}
    >
      {/* İnce çalışma ızgarası: yalnız düz kapakta; resimli/renkli kapakta kapağı bozmasın */}
      {showGrid && <div className="workspace-grid pointer-events-none absolute inset-0" aria-hidden="true" />}

      <AnimatePresence mode="wait">
        {loading ? (
          <DesktopLoadingSkeleton key="loading-skeleton" deviceLabel={deviceLabel || 'Android Cihazı'} />
        ) : (
          <div
            key={spin}
            className="relative grid h-full w-full min-h-0 flex-1 gap-1"
            style={{
              gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: CELLS }, (_, cell) => {
              const id = layout[cell];
              const entry = resolve(id);
              const occupied = Boolean(entry);
              const isDropTarget = target === cell && !occupied && dragging !== null;

              return (
                <div
                  key={cell}
                  onDragOver={(event) => {
                    if (dragging === null || occupied) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setTarget(cell);
                  }}
                  onDragEnter={() => {
                    if (!occupied) setTarget(cell);
                  }}
                  onDragLeave={() => {
                    setTarget((current) => (current === cell ? null : current));
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragging === null || occupied) return;
                    move(dragging, cell);
                    setDragging(null);
                    setTarget(null);
                  }}
                  onContextMenu={(event) => openMenu(event, cell, id ?? null)}
                  className={cn(
                    'relative grid min-h-0 min-w-0 place-items-center rounded-[8px] transition-colors',
                    isDropTarget && 'bg-accent/45 ring-1 ring-primary/50'
                  )}
                >
                  {entry && id && (
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', id);
                        setDragging(cell);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setTarget(null);
                      }}
                      onClick={(event) => handleItemClick(event, id, entry)}
                      onDoubleClick={(event) => handleItemDoubleClick(event, id, entry)}
                      aria-label={entry.name}
                      title={entry.name}
                      className={cn(
                        'flex size-full min-w-0 cursor-default flex-col items-center justify-center gap-1 rounded-[8px] px-0.5 py-1 text-center transition-all duration-150 hover:bg-accent/35',
                        selected === id && 'bg-accent/60 ring-1 ring-primary/45 shadow-sm',
                        dragging === cell && 'opacity-40'
                      )}
                    >
                      <span
                        className="origin-center transition-transform duration-150"
                        style={{ transform: `scale(${SCALE_VALUE[scale]})` }}
                      >
                        {entry.kind === 'app' ? (
                          <div className="relative flex size-12 items-center justify-center shrink-0 pointer-events-none">
                            <AppIcon
                              pkg={entry.app.package}
                              displayName={entry.app.display_name}
                              size={44}
                              version={iconVersions[entry.app.package] || 0}
                            />
                          </div>
                        ) : (
                          <span className="relative grid size-11 place-items-center rounded-[12px] border border-border/80 bg-muted/80 text-foreground/85 shadow-sm backdrop-blur-sm overflow-hidden">
                            {entry.appIds && entry.appIds.length > 0 ? (
                              <div className="grid grid-cols-2 gap-0.5 p-1 size-full place-items-center">
                                {entry.appIds.slice(0, 4).map((pkg) => (
                                  <div key={pkg} className="size-4 flex items-center justify-center overflow-hidden">
                                    <AppIcon pkg={pkg} size={15} />
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <Folder className="size-6 text-app-files" strokeWidth={1.9} />
                            )}
                            {entry.appIds && entry.appIds.length > 0 && (
                              <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground shadow-sm">
                                {entry.appIds.length}
                              </span>
                            )}
                          </span>
                        )}
                      </span>

                      {editingId === id ? (
                        <input
                          type="text"
                          autoFocus
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename(id);
                            if (e.key === 'Escape') setEditingId(null);
                            e.stopPropagation();
                          }}
                          onBlur={() => handleSaveRename(id)}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          className="w-full text-center text-[10.5px] font-medium leading-[13px] bg-popover text-foreground rounded border border-primary px-1 py-0.5 outline-none shadow-sm z-20"
                        />
                      ) : (
                        <span className="desktop-ink w-full truncate px-1 text-[10.5px] font-medium leading-[13px] select-none">
                          {entry.name}
                        </span>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </AnimatePresence>

      {/* Main Desktop Context Menu */}
      {menu && (
        <MenuSurface
          ref={menuRef}
          aria-label="Masaüstü menüsü"
          className="absolute z-40 w-[226px]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {menuItem ? (
            <>
              <MenuLabel>{menuItem.name}</MenuLabel>
              <MenuItem
                icon={<Play className="size-3.5 text-primary" />}
                label="Uygulamayı Aç"
                onClick={() => {
                  handleLaunchItem(menuItem);
                  closeMenu();
                }}
              />
              <MenuItem
                icon={<LayoutGrid className="size-3.5" />}
                label="Seç"
                onClick={() => {
                  setSelected(menu.itemId);
                  closeMenu();
                }}
              />

              {menuItem.kind === 'app' && (
                <>
                  <MenuItem
                    icon={<RefreshCw className="size-3.5 text-muted-foreground" />}
                    label="İkonu Yeniden Çek (Debug)"
                    onClick={() => {
                      handleForceReExtractIcon(menuItem.app);
                      closeMenu();
                    }}
                  />
                  <MenuItem
                    icon={<AppWindow className="size-3.5 text-muted-foreground" />}
                    label="Paket Bilgisi"
                    onClick={() => {
                      pushToast(`Paket: ${menuItem.app.package}`);
                      closeMenu();
                    }}
                  />
                  <MenuSeparator />
                  <MenuItem
                    icon={<EyeOff className="size-3.5" />}
                    label="Masaüstünden Kaldır"
                    destructive
                    onClick={() => {
                      removeAppFromDesktop(menuItem.app);
                      closeMenu();
                    }}
                  />
                </>
              )}

              {menuItem.kind === 'custom' && (
                <>
                  <MenuItem
                    icon={<FolderOpen className="size-3.5 text-primary" />}
                    label="Klasörü Aç"
                    onClick={() => {
                      handleLaunchItem(menuItem);
                      closeMenu();
                    }}
                  />
                  <MenuItem
                    icon={<Edit2 className="size-3.5 text-muted-foreground" />}
                    label="Yeniden Adlandır"
                    hint="F2"
                    onClick={() => {
                      startRename(menu.itemId);
                      closeMenu();
                    }}
                  />
                  <MenuItem
                    icon={<FolderPlus className="size-3.5 text-muted-foreground" />}
                    label="Uygulama Ekle / Yönet"
                    onClick={() => {
                      setActiveFolder(menuItem);
                      setShowAddAppPicker(true);
                      closeMenu();
                    }}
                  />
                  <MenuSeparator />
                  <MenuItem
                    icon={<Trash2 className="size-3.5" />}
                    label="Sil"
                    destructive
                    onClick={() => {
                      removeIcon(menu.itemId);
                      closeMenu();
                    }}
                  />
                </>
              )}
            </>
          ) : (
            <>
              <MenuItem
                icon={<Plus className="size-3.5 text-primary" />}
                label="Yeni Klasör"
                hint="Uygulama grubu"
                onClick={() => {
                  addIcon(menu.cell);
                  closeMenu();
                }}
              />
              <MenuItem
                icon={<RotateCcw className="size-3.5" />}
                label="Varsayılan Düzen (Windows/DeX)"
                hint="Önemli uygulamalar"
                onClick={() => {
                  resetToCuratedDefaults();
                  closeMenu();
                }}
              />
              <MenuSeparator />
              <MenuItem
                icon={<Grid2x2 className="size-3.5" />}
                label="Görünüm modu"
                hint={SCALE_LABEL[scale]}
                right={<ChevronRight className="size-3.5 text-muted-foreground" />}
                aria-haspopup="menu"
                aria-expanded={submenu?.type === 'scale'}
                onClick={toggleSubmenu('scale')}
              />
              <MenuSeparator />
              <MenuItem
                icon={<ImageIcon className="size-3.5" />}
                label="Arka planı değiştir…"
                hint={wallpaper.name}
                onClick={() => {
                  setShowWallpaper(true);
                  closeMenu();
                }}
              />
              <MenuItem
                icon={<Shuffle className="size-3.5" />}
                label="Rastgele arka plan"
                onClick={() => {
                  randomizeWallpaper();
                  closeMenu();
                }}
              />
              <MenuSeparator />
              <MenuItem
                icon={theme === 'dark' ? <Sun className="size-3.5 text-window-minimize" /> : <Moon className="size-3.5 text-app-mail" />}
                label={theme === 'dark' ? 'Açık tema' : 'Koyu tema'}
                onClick={() => {
                  toggleTheme();
                  closeMenu();
                }}
              />
              <MenuItem
                icon={<MonitorCog className="size-3.5" />}
                label="Ekran ayarları"
                onClick={() => {
                  openSettings();
                  openOpenDexSettings();
                  closeMenu();
                }}
              />
              <MenuSeparator />
              <MenuItem
                icon={<Smartphone className="size-3.5 text-primary" />}
                label="Telefon Ekranını Yansıt"
                onClick={() => {
                  handleLaunchMirror();
                  closeMenu();
                }}
              />
              <MenuItem
                icon={<LayoutGrid className="size-3.5" />}
                label="Uygulama Çekmecesi"
                onClick={() => {
                  setLaunchpadOpen(true);
                  closeMenu();
                }}
              />
              <MenuItem
                icon={<SlidersHorizontal className="size-3.5 text-muted-foreground" />}
                label={hiddenCount > 0 ? `Simgeleri Yönet (${hiddenCount})` : 'Simgeleri Yönet'}
                onClick={() => {
                  setShowHiddenModal(true);
                  closeMenu();
                }}
              />
            </>
          )}
        </MenuSurface>
      )}

      {/* Flyout Submenu (Görünüm modu) */}
      {submenu && (
        <MenuSurface
          ref={submenuRef}
          aria-label="Görünüm modu"
          className="absolute z-50 w-[184px]"
          style={{ left: submenu.left, top: submenu.top }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {Object.keys(SCALE_LABEL).map((mode) => (
            <MenuItem
              key={mode}
              icon={<Grid2x2 className="size-3.5" />}
              label={SCALE_LABEL[mode]}
              active={scale === mode}
              onClick={() => {
                setScale(mode);
                closeMenu();
              }}
            />
          ))}
        </MenuSurface>
      )}

      {/* Arka plan: kapak resmi galerisi, resimlerim, renkler, ayarlar (WallpaperDialog) */}
      <WallpaperDialog open={showWallpaper} onClose={() => setShowWallpaper(false)} />

      {/* Simgeleri yönet: hangi uygulamalar masaüstünde görünsün (ManageIconsDialog) */}
      <ManageIconsDialog
        open={showHiddenModal}
        onClose={() => setShowHiddenModal(false)}
        apps={apps}
        layout={layout}
        custom={custom}
        cells={CELLS}
        getDefaultLayout={() => buildDefaultSlots(apps)}
        onLayoutChange={applyManagedLayout}
      />

      {/* Active Folder Window Modal */}
      <Dialog open={Boolean(activeFolder)} onClose={() => setActiveFolder(null)} label="Klasör" className="max-w-lg overflow-hidden">
        {/* JSX çocukları Dialog kapalıyken de hesaplanır: activeFolder null iken .name okumasın */}
        {activeFolder && (
          <>
              {/* Folder Header */}
              <div className="flex items-center justify-between border-b border-border/70 px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl bg-app-files/15 text-app-files ring-1 ring-app-files/30">
                    <Folder className="size-5" />
                  </span>
                  <div>
                    <input
                      type="text"
                      value={activeFolder.name}
                      onChange={(e) => {
                        const val = e.target.value;
                        setActiveFolder((prev) => ({ ...prev, name: val }));
                        renameFolder(activeFolder.id, val);
                      }}
                      className="text-base font-bold bg-transparent border-b border-transparent hover:border-border focus:border-primary outline-none px-0.5 max-w-[220px]"
                      placeholder="Klasör Adı"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {activeFolder.appIds?.length || 0} uygulama içeriyor · Başlığa tıklayarak yeniden adlandırabilirsiniz
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="xs"
                    variant={showAddAppPicker ? 'secondary' : 'default'}
                    onClick={() => setShowAddAppPicker((v) => !v)}
                    startIcon={<Plus className="size-3.5" />}
                  >
                    {showAddAppPicker ? 'Listeyi Gizle' : 'Uygulama Ekle'}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setActiveFolder(null)}
                    className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>

              {/* Content */}
              <div className="p-5">
                {showAddAppPicker ? (
                  <div className="space-y-3">
                    <div className="relative">
                      <Search className="absolute left-3 top-2.5 size-3.5 text-muted-foreground" />
                      <input
                        type="text"
                        placeholder="Klasöre eklenecek uygulama ara..."
                        value={folderAppSearch}
                        onChange={(e) => setFolderAppSearch(e.target.value)}
                        className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1 dex-scroll">
                      {apps
                        .filter(
                          (a) =>
                            !activeFolder.appIds?.includes(a.package) &&
                            (a.display_name?.toLowerCase().includes(folderAppSearch.toLowerCase()) ||
                              a.package?.toLowerCase().includes(folderAppSearch.toLowerCase()))
                        )
                        .map((app) => (
                          <div
                            key={app.package}
                            className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 p-2 hover:bg-accent/40"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <AppIcon pkg={app.package} displayName={app.display_name} size={30} />
                              <span className="truncate text-xs font-medium">{app.display_name}</span>
                            </div>
                            <Button
                              size="xs"
                              variant="secondary"
                              onClick={() => addAppToFolder(activeFolder.id, app.package)}
                              startIcon={<Plus className="size-3" />}
                            >
                              Ekle
                            </Button>
                          </div>
                        ))}
                    </div>
                  </div>
                ) : (
                  <>
                    {activeFolder.appIds && activeFolder.appIds.length > 0 ? (
                      <div className="grid grid-cols-4 sm:grid-cols-5 gap-3 max-h-72 overflow-y-auto dex-scroll p-1">
                        {activeFolder.appIds.map((pkg) => {
                          const app = apps.find((a) => a.package === pkg) || {
                            package: pkg,
                            display_name: pkg.split('.').pop(),
                          };
                          return (
                            <div
                              key={pkg}
                              className="group/folderapp relative flex flex-col items-center justify-center p-2 rounded-xl hover:bg-accent/50 transition-colors cursor-pointer"
                              onClick={() => {
                                openWindow(app);
                                setActiveFolder(null);
                              }}
                            >
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeAppFromFolder(activeFolder.id, pkg);
                                }}
                                title="Klasörden çıkar"
                                className="absolute top-0.5 right-0.5 size-5 rounded-full bg-destructive/15 text-destructive hover:bg-destructive hover:text-destructive-foreground opacity-0 group-hover/folderapp:opacity-100 transition-opacity grid place-items-center cursor-pointer"
                              >
                                <X className="size-3" />
                              </button>
                              <div className="size-11 flex items-center justify-center">
                                <AppIcon pkg={app.package} displayName={app.display_name} size={40} />
                              </div>
                              <span className="mt-1 text-[11px] font-medium text-center truncate max-w-[72px]">
                                {app.display_name}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="py-8 text-center">
                        <Folder className="mx-auto size-12 text-muted-foreground/40 mb-2" strokeWidth={1.5} />
                        <p className="text-sm font-semibold text-foreground">Bu klasör henüz boş</p>
                        <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
                          Android uygulamalarınızı buraya ekleyerek masaüstünüzü organize edebilirsiniz.
                        </p>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="mt-4"
                          onClick={() => setShowAddAppPicker(true)}
                          startIcon={<Plus className="size-3.5 text-primary" />}
                        >
                          Uygulama Ekle
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
          </>
        )}
      </Dialog>
    </main>
  );
}
