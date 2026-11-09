// Runs before the stylesheet to avoid a flash of the wrong saved theme.
// Only a light/dark preference is stored; no webpage data is persisted.
(() => {
  const key = 'copyclean.theme';
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let preference;
  try { preference = localStorage.getItem(key); } catch { /* Theme still works when storage is blocked. */ }
  if (!['light', 'dark'].includes(preference)) preference = null;

  function apply() {
    const dark = (preference || (media?.matches ? 'dark' : 'light')) === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    button.setAttribute('aria-pressed', String(dark));
    button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    document.getElementById('theme-moon').hidden = dark;
    document.getElementById('theme-sun').hidden = !dark;
  }

  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme-toggle').addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch { /* Retain the choice for this open panel. */ }
      apply();
    });
  }, { once: true });
  media?.addEventListener('change', () => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = ['light', 'dark'].includes(event.newValue) ? event.newValue : null;
      apply();
    }
  });
})();
