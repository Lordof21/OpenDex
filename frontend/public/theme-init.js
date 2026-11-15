// Runs BEFORE the first paint (a classic, render-blocking script: the Tauri CSP allows scripts from 'self' only, so it cannot be
// inline). It applies the saved theme to <html> so the page never shows the light palette first and fades to dark.
// Keep in step with src/state/ThemeContext.jsx (same storage key, same "dark" test).
(function () {
  try {
    if (window.localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');
  } catch (e) { /* storage blocked: the light theme, as ThemeContext does */ }
})();
