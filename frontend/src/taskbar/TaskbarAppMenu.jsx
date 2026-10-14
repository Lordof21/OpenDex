// Görev çubuğu uygulama düğmesinin bağlam menüsü (basılı tut ya da sağ tık): düğmenin tıklamasıyla AYNI eylemler + pencereye özel olanlar.
//
//   [ad]  Küçült / Geri yükle / Öne getir · Telefona aktar / Telefondan geri al · (web sayfası varsa) Sayfayı yenile · Uygulamayı yeniden başlat
//         · (varsa) Hepsini kapat · Kapat
//
// Hangi eylemlerin sunulacağı saf modelden gelir (taskbarModel.appMenuModel); burada yalnız çizim, klavye ve odak vardır:
//   · açılınca ilk öğeye odak · ↑/↓/Home/End gezinir · Esc ve dışarı tıklama kapatır (Taskbar'ın yüzey mantığı) · kapanınca odak düğmeye döner.
import React, { forwardRef, useEffect, useRef } from 'react';
import { AppWindow, Globe, Layers, Minus, Monitor, RotateCw, Smartphone, X } from 'lucide-react';

import { PanelShell } from './PanelShell.jsx';
import { MenuItem, MenuLabel, MenuSeparator } from '../ui/Menu.jsx';
import { cardLeft } from './taskbarModel.js';
import { t } from '../i18n/index.js';

const MENU_WIDTH = 232;

const TOGGLE_ICON = { minimize: Minus, restore: AppWindow, focus: AppWindow };

export const TaskbarAppMenu = forwardRef(function TaskbarAppMenu({
  name,
  model,
  anchorX = null,
  onToggle,
  onHandoff,
  onReclaim,
  onRestart,
  onReloadPage,
  onClose,
  onCloseAll,
  onDismiss,
  ...motionProps
}, ref) {
  const listRef = useRef(null);

  useEffect(() => {
    const first = listRef.current?.querySelector('[role="menuitem"]');
    first?.focus();
  }, []);

  const onKeyDown = (event) => {
    const items = [...(listRef.current?.querySelectorAll('[role="menuitem"]') || [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = items[(at + 1) % items.length];
    else if (event.key === 'ArrowUp') next = items[(at - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    else if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss?.();
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const ToggleIcon = TOGGLE_ICON[model.toggle] || AppWindow;
  const run = (action) => () => {
    onDismiss?.();
    action?.();
  };

  return (
    <PanelShell
      ref={ref}
      {...motionProps}
      data-taskbar-menu=""
      style={{ left: `${cardLeft(anchorX, MENU_WIDTH, vw)}px`, width: `${MENU_WIDTH}px` }}
      className="rounded-xl border border-border/80 bg-popover/95 p-1 shadow-2xl backdrop-blur-3xl"
    >
      <div ref={listRef} role="menu" aria-label={t('taskbar.name_menusu', { name })} onKeyDown={onKeyDown}>
        <MenuLabel>{name}</MenuLabel>
        {model.toggleLabel && (
          <MenuItem icon={<ToggleIcon className="size-3.5" />} label={model.toggleLabel} onClick={run(onToggle)} />
        )}
        {model.canHandoff && (
          <MenuItem icon={<Smartphone className="size-3.5" />} label={t('common.telefona_aktar')} onClick={run(onHandoff)} />
        )}
        {model.canReclaim && (
          <MenuItem icon={<Monitor className="size-3.5" />} label={t('taskbar.telefondan_geri_al')} onClick={run(onReclaim)} />
        )}
        {model.canReloadPage && (
          <MenuItem icon={<Globe className="size-3.5" />} label={t('common.sayfayi_yenile')} onClick={run(onReloadPage)} />
        )}
        {model.canRestart && (
          <MenuItem icon={<RotateCw className="size-3.5" />} label={t('common.uygulamayi_yeniden_baslat')} onClick={run(onRestart)} />
        )}
        <MenuSeparator />
        {model.closeAllCount > 0 && (
          <MenuItem
            icon={<Layers className="size-3.5" />}
            label={t('taskbar.tum_pencereleri_kapat')}
            hint={String(model.closeAllCount)}
            destructive
            onClick={run(onCloseAll)}
          />
        )}
        <MenuItem icon={<X className="size-3.5" />} label={t('common.kapat')} destructive onClick={run(onClose)} />
      </div>
    </PanelShell>
  );
});

export default TaskbarAppMenu;
