// Applies the cached theme before the first paint, to avoid a light flash in dark mode.
// Mirrors resolveTheme() in src/theme/themeStore.ts; storage keys in src/app/preferences.ts.
(function () {
  var preference = 'system';
  try {
    preference = localStorage.getItem('yadbe.theme') || 'system';
  } catch (_) {
    // Storage unavailable: follow the OS.
  }
  var dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'graphite' : 'paper';
})();
