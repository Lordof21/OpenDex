// Pencere yöneticisi kısayollarının TEK tanıma tablosu (saf; store/DOM bağımlılığı yok).
//
// İki tüketici aynı tabloyu okur, birbirinden ayrışamaz:
//   - store/shortcutsSlice.js  → kısayolu uygular (pencereyi kapat/küçült, paneli aç…)
//   - input/keyboardInject.js  → `isWindowManagerShortcut`: tanınan tuşlar telefona ASLA iletilmez
// Eskiden enjeksiyon katmanı yalnız Alt+Tab ve Ctrl+W'yi biliyordu; Ctrl+M / Ctrl+Shift+F / Ctrl+Alt+Ok /
// Win+D hem uygulanıyor hem de telefona "Ctrl+M" olarak gönderiliyordu.

export const WM_ACTIONS = Object.freeze({
  altTab: 'alt-tab',
  closeWindow: 'close-window',
  minimizeWindow: 'minimize-window',
  fullscreen: 'fullscreen',
  workspaceArrow: 'workspace-arrow',
  dexQuickPanel: 'dex-quick-panel',
  showDesktop: 'show-desktop',
  openFiles: 'open-files',
});

/** Olay bir WM kısayoluysa eylem kimliğini, değilse null döner. (Esc durum gerektirdiği için burada yok.) */
export function matchWmShortcut(e) {
  if (!e || typeof e.key !== 'string') return null;
  const key = e.key.toLowerCase();

  // Alt+Tab / Alt+Shift+Tab → pencereler arası geçiş
  if (e.altKey && e.key === 'Tab') return WM_ACTIONS.altTab;
  // Ctrl+W → odaktaki paneli kapat
  if (e.ctrlKey && !e.altKey && !e.shiftKey && key === 'w') return WM_ACTIONS.closeWindow;
  // Ctrl+M → odaktaki paneli küçült
  if (e.ctrlKey && !e.altKey && !e.shiftKey && key === 'm') return WM_ACTIONS.minimizeWindow;
  // Ctrl+Shift+F → mutlak tam ekran
  if (e.ctrlKey && e.shiftKey && key === 'f') return WM_ACTIONS.fullscreen;
  // Ctrl+Alt+Yukarı/Aşağı → Workspace görevini tomurcukla / çalışma alanına geri gönder
  // (Win+Shift+Ok'un OS pencere-taşıma kısayoluyla çakışmaması için özellikle bu kombinasyon)
  if (e.ctrlKey && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return WM_ACTIONS.workspaceArrow;
  // Ctrl+Alt+D → DeX hızlı ayar paneli. `code` ile de eşleşir: Ctrl+Alt bazı düzenlerde AltGr sayıldığı
  // için `key` başka bir karakter olabilir.
  if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && (key === 'd' || e.code === 'KeyD')) {
    return WM_ACTIONS.dexQuickPanel;
  }
  // Ctrl+Shift+E → Dosyalar penceresini aç / öne getir
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && key === 'e') return WM_ACTIONS.openFiles;
  // Win+D veya Ctrl+Shift+D → masaüstünü göster
  if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && key === 'd') return WM_ACTIONS.showDesktop;

  return null;
}
