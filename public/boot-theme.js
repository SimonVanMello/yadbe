// Applies the cached colors before the first paint, to avoid a light flash in dark mode.
// Mirrors resolveTheme() in src/theme/themeStore.ts; storage keys in src/app/preferences.ts.
(function () {
  var preference = 'system';
  var lightTheme = null;
  var darkTheme = null;
  var style = null;
  var highContrast = null;
  try {
    preference = localStorage.getItem('yadbe.theme') || 'system';
    lightTheme = localStorage.getItem('yadbe.lightTheme');
    darkTheme = localStorage.getItem('yadbe.darkTheme');
    style = localStorage.getItem('yadbe.style');
    highContrast = localStorage.getItem('yadbe.highContrast');
  } catch (_) {
    // Storage unavailable: follow the OS.
  }
  var dark =
    preference === 'dark' ||
    (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  // An id the app does not know falls back to the default once it has loaded.
  root.dataset.theme = (dark ? darkTheme : lightTheme) || (dark ? 'graphite' : 'paper');
  if (style === 'terminal') root.dataset.style = 'terminal';
  if (highContrast === 'true') root.dataset.contrast = 'high';
})();
