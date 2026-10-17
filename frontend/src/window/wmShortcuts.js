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
  toggleKeymap: 'toggle-keymap',
});

/**
 * Olay bir WM kısayoluysa eylem kimliğini, değilse null döner. (Esc durum gerektirdiği için burada yok.)
 *
 * `game`: odaktaki pencere OYUN KİPİNDE (aktif tuş düzeni var). Oyuncu Ctrl'ü fareyi serbest bırakmak için basılı tutup W ile ilerler:
 * Ctrl+W oyunu KAPATIR (uygulama da telefonda öldürülür — 2026-10-16 00:23 olayı). Oyun kipinde yalnız bu iki "Ctrl + tek tuş" kısayolu
 * (Ctrl+W kapat, Ctrl+M küçült) kapalıdır ve tuş oyuna gider; Alt / Shift / Win'li kombinasyonlar oyunda rastlantıyla basılmaz, aynen çalışır.
 *
 * `layout`: odaktaki pencerenin/görevin KAYITLI bir tuş düzeni var (açık ya da kapalı). Ctrl+G ancak o zaman düzeni açıp kapatır; düzeni
 * olmayan pencerede Ctrl+G uygulamanındır (Chrome'da "sonrakini bul").
 */
export function matchWmShortcut(e, { game = false, layout = false } = {}) {
  if (!e || typeof e.key !== 'string') return null;
  const key = e.key.toLowerCase();

  // Alt+Tab / Alt+Shift+Tab → pencereler arası geçiş
  if (e.altKey && e.key === 'Tab') return WM_ACTIONS.altTab;
  // Ctrl+W → odaktaki paneli kapat
  if (!game && e.ctrlKey && !e.altKey && !e.shiftKey && key === 'w') return WM_ACTIONS.closeWindow;
  // Ctrl+M → odaktaki paneli küçült
  if (!game && e.ctrlKey && !e.altKey && !e.shiftKey && key === 'm') return WM_ACTIONS.minimizeWindow;
  // Ctrl+G → odaktaki pencerenin tuş düzenini aç / kapat (oyun kipinden çıkıp normal dokunmaya dönmek için; düzen silinmez)
  if (layout && e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && key === 'g') return WM_ACTIONS.toggleKeymap;
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
