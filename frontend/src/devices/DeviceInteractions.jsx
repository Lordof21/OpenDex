// Bir yüzeyin (Cihaz Merkezi paneli ya da "Cihaz bağla" penceresi) cihaz etkileşimleri: bağlam menüsü, satır içi onaylar ve
// yeniden adlandırma. Eylem kimlikleri deviceModel.deviceMenu'den gelir; burada her kimliğin ne yaptığı (gerekirse önce onay)
// ve menünün çizimi/klavyesi vardır.
//
// Onay gerektirenler: açık pencereler kapanacaksa bağlantıyı kesmek ya da BAŞKA bir telefona geçmek, ve kayıtlı cihazı
// unutmak. Bunlar satırın altında açılan bir onay şeridiyle sorulur (modal yok — kullanıcı bağlamından kopmaz).
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Copy, Hash, Link2, Pencil, PlugZap, RotateCw, Trash2, Unplug, Usb, Wifi } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { Z_INDEX } from '../ui/zIndex.js';
import { isPoint, placeFloating } from '../ui/menuPosition.js';
import { useWindowStore } from '../window/windowStore.js';
import { useDeviceHubStore } from './deviceHubStore.js';
import { deviceMenu } from './deviceModel.js';
import { REASON_TEXT } from './deviceText.js';
import { t } from '../i18n/index.js';

const MENU_WIDTH = 240;
// Odağı kendi alanına alan eylemler (yeniden adlandırma kutusu, onay şeridi): menü kapanınca odak tetikleyiciye dönmez.
const FOCUS_TAKERS = new Set(['rename', 'forget', 'disconnect', 'connect', 'reconnect']);

const ITEM = {
  connect: { icon: Link2, label: () => t('common.baglan') },
  reconnect: { icon: RotateCw, label: () => t('devices.action_reconnect') },
  'switch-usb': { icon: Usb, label: () => t('devices.action_switch_usb') },
  'switch-wifi': { icon: Wifi, label: () => t('devices.action_switch_wifi') },
  disconnect: { icon: Unplug, label: () => t('taskbar.baglantiyi_kes') },
  rename: { icon: Pencil, label: () => t('devices.action_rename') },
  'copy-serial': { icon: Hash, label: () => t('devices.action_copy_serial') },
  'copy-ip': { icon: Copy, label: () => t('devices.action_copy_ip') },
  forget: { icon: Trash2, label: () => t('devices.action_forget') },
};

const InteractionContext = createContext(null);

export function useDeviceInteractions() {
  const ctx = useContext(InteractionContext);
  if (!ctx) throw new Error('useDeviceInteractions: DeviceInteractionProvider gerekli');
  return ctx;
}

/** `groups`: yüzeyin gördüğü cihazlar (useDevices().all) — menü ve onaylar her zaman güncel kaydı okur. */
export function DeviceInteractionProvider({ groups, active, children }) {
  const windowCount = useWindowStore((s) => s.windows.length);
  const [menu, setMenu] = useState(null); // { key, anchor, returnFocus }
  const [renaming, setRenaming] = useState(null); // key
  const [confirm, setConfirm] = useState(null); // { key, kind }
  const store = useDeviceHubStore;

  const byKey = useCallback((key) => groups.find((g) => g.key === key) || null, [groups]);

  const perform = useCallback((id, group) => {
    if (!group) return;
    const hub = store.getState();
    switch (id) {
      case 'connect':
      case 'reconnect':
        // Başka bir telefona geçiş bu telefonun pencerelerini kapatır: varsa önce sorulur.
        if (active && active.key !== group.key && windowCount > 0) setConfirm({ key: group.key, kind: 'switch-device' });
        else hub.connect(group);
        break;
      case 'switch-usb':
        hub.switchLink(group, 'usb');
        break;
      case 'switch-wifi':
        hub.switchLink(group, 'wifi');
        break;
      case 'disconnect':
        if (windowCount > 0) setConfirm({ key: group.key, kind: 'disconnect' });
        else hub.disconnect(group);
        break;
      case 'rename':
        setConfirm(null);
        setRenaming(group.key);
        break;
      case 'copy-serial': {
        const serial = group.activeLink?.serial || group.usbLink?.serial;
        if (serial) hub.copy(serial, t('devices.serial_number'));
        break;
      }
      case 'copy-ip': {
        const ip = deviceMenu(group).find((item) => item.id === 'copy-ip')?.value;
        if (ip) hub.copy(ip);
        break;
      }
      case 'forget':
        setRenaming(null);
        setConfirm({ key: group.key, kind: 'forget' });
        break;
      default:
        break;
    }
  }, [active, windowCount, store]);

  const confirmNow = useCallback(() => {
    if (!confirm) return;
    const group = byKey(confirm.key);
    const hub = store.getState();
    setConfirm(null);
    if (!group) return;
    if (confirm.kind === 'disconnect') hub.disconnect(group);
    else if (confirm.kind === 'switch-device') hub.connect(group);
    else if (confirm.kind === 'forget') hub.forget(group);
  }, [confirm, byKey, store]);

  const openMenu = useCallback((group, anchor) => {
    setMenu({ key: group.key, anchor, returnFocus: typeof document !== 'undefined' ? document.activeElement : null });
  }, []);

  const menuRef = useRef(null);
  menuRef.current = menu;
  /** `restoreFocus`: odak menüyü açan öğeye döner (klavye kullanıcısı yerini kaybetmez) — yeniden adlandırma / onay gibi
   *  odağı kendi alanına alan eylemlerde dönmez. */
  const closeMenu = useCallback((restoreFocus = true) => {
    const back = menuRef.current?.returnFocus;
    setMenu(null);
    if (restoreFocus && back && typeof back.focus === 'function' && back.isConnected) {
      setTimeout(() => back.focus({ preventScroll: true }), 0);
    }
  }, []);

  /** Satırın sağ tık / ⋯ / klavye (Shift+F10, Menü tuşu) işleyicileri. */
  const menuHandlers = useCallback((group) => ({
    onContextMenu: (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMenu(group, { x: event.clientX, y: event.clientY });
    },
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return;
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        openMenu(group, event.currentTarget);
      }
    },
  }), [openMenu]);

  const value = useMemo(() => ({
    menuKey: menu?.key ?? null,
    closeMenu,
    windowCount,
    renaming,
    setRenaming,
    confirm,
    setConfirm,
    confirmNow,
    perform,
    openMenu,
    menuHandlers,
  }), [menu?.key, closeMenu, windowCount, renaming, confirm, confirmNow, perform, openMenu, menuHandlers]);

  const menuGroup = menu ? byKey(menu.key) : null;
  return (
    <InteractionContext.Provider value={value}>
      {children}
      {menu && menuGroup && (
        <DeviceMenu
          group={menuGroup}
          anchor={menu.anchor}
          onPick={(id) => {
            closeMenu(!FOCUS_TAKERS.has(id));
            perform(id, menuGroup);
          }}
          onClose={() => closeMenu()}
        />
      )}
    </InteractionContext.Provider>
  );
}

/** Onay şeridinin cümlesi ve düğmesi. */
export function confirmCopy(kind, group, windowCount) {
  if (kind === 'disconnect') {
    return { message: t('devices.confirm_disconnect', { count: windowCount }), label: t('taskbar.baglantiyi_kes') };
  }
  if (kind === 'switch-device') {
    return { message: t('devices.confirm_switch_device', { name: group?.name || '', count: windowCount }), label: t('devices.action_switch_device') };
  }
  return { message: t('devices.confirm_forget', { name: group?.name || '' }), label: t('devices.action_forget_short') };
}

function DeviceMenu({ group, anchor, onPick, onClose }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const busy = useDeviceHubStore((s) => Boolean(s.busy));
  const items = useMemo(() => deviceMenu(group, { busy }), [group, busy]);

  useLayoutEffect(() => {
    setPos(placeFloating({ anchor, width: MENU_WIDTH, height: ref.current?.offsetHeight || 0, vw: window.innerWidth, vh: window.innerHeight }));
  }, [anchor, items.length]);

  useEffect(() => {
    const removeEscape = pushEscapeHandler(onClose);
    const onDown = (event) => {
      if (ref.current?.contains(event.target)) return;
      if (!isPoint(anchor) && anchor?.contains?.(event.target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      removeEscape();
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  useEffect(() => {
    if (pos) ref.current?.querySelector('[role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
  }, [pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps -- yalnız ilk yerleşimde

  const onKeyDown = (event) => {
    const list = [...(ref.current?.querySelectorAll('[role="menuitem"]') || [])];
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = list[(at + 1) % list.length];
    else if (event.key === 'ArrowUp') next = list[(at - 1 + list.length) % list.length];
    else if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list[list.length - 1];
    else if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  return createPortal(
    <div
      data-taskbar-portal=""
      className="fixed"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: MENU_WIDTH, zIndex: Z_INDEX.flyoutNested }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <motion.div
        ref={ref}
        role="menu"
        aria-label={t('devices.menu_label', { name: group.name })}
        onKeyDown={onKeyDown}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: reduce ? 0.1 : 0.16, ease: [0.22, 1, 0.36, 1] }}
        style={{ transformOrigin: `${pos?.originX ?? MENU_WIDTH / 2}px ${pos?.originY ?? 0}px` }}
        className="select-none overflow-hidden rounded-[12px] border border-taskbar-border/80 bg-popover p-1 text-popover-foreground shadow-window"
      >
        <p className="truncate px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase leading-none tracking-[0.12em] text-muted-foreground">
          {group.name}
        </p>
        {items.map((item, index) =>
          item.type === 'separator' ? (
            <div key={`sep-${index}`} role="separator" className="mx-1 my-1 h-px bg-border/70" />
          ) : (
            <MenuRow key={item.id} item={item} onPick={onPick} />
          ),
        )}
      </motion.div>
    </div>,
    document.body,
  );
}

function MenuRow({ item, onPick }) {
  const spec = ITEM[item.id] || { icon: PlugZap, label: () => item.id };
  const Icon = spec.icon;
  const reason = item.disabled && item.reason ? REASON_TEXT[item.reason]?.() : null;
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={item.disabled || undefined}
      onClick={() => {
        if (!item.disabled) onPick(item.id);
      }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-[11.5px] font-medium outline-none transition-colors duration-100',
        item.disabled
          ? 'cursor-not-allowed text-muted-foreground/60'
          : item.destructive
            ? 'cursor-pointer text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10'
            : 'cursor-pointer hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground',
      )}
    >
      <Icon className={cn('size-3.5 shrink-0', !item.destructive && 'text-muted-foreground')} strokeWidth={2} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{spec.label()}</span>
        {reason && <span className="block truncate text-[9.5px] font-normal text-muted-foreground">{reason}</span>}
      </span>
    </button>
  );
}
