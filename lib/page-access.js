export function restrictedPage(url) {
  if (!url) return null; // Chrome may hide protected URLs or withheld sites.
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return 'CopyClean scans HTTP and HTTPS webpages. Local files are outside its configured website access.';
    if (!['https:', 'http:'].includes(parsed.protocol) ||
        parsed.hostname === 'chromewebstore.google.com' ||
        (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))) {
      return 'Chrome protects this page from extensions. Open a regular HTTP or HTTPS website; internal pages, the Chrome Web Store, and built-in viewers cannot be scanned.';
    }
  } catch { return 'The active page address is unavailable. Wait for it to finish loading and retry.'; }
  return null;
}

export function accessFailure(error, tab) {
  const message = error?.message || String(error);
  const restricted = restrictedPage(tab?.url);
  if (restricted || /chrome:\/\/|edge:\/\/|extensions gallery|webstore|chromewebstore|chrome-extension:\/\//i.test(message)) {
    return { title: 'Protected page', message: restricted || 'Chrome protects this page from extensions. Open a regular HTTP or HTTPS website.' };
  }
  if (/file:\/\//i.test(message)) {
    return { title: 'Unsupported page', message: 'CopyClean scans HTTP and HTTPS webpages; local file access is not configured.' };
  }
  if (/Cannot access|permission|not allowed|not permitted|Missing host/i.test(message)) {
    return {
      title: 'Website access blocked',
      message: 'Chrome has withheld website access. In Extensions → CopyClean → Site access, allow access on all sites (or this site), then return to the panel. If you just updated CopyClean, reload it at chrome://extensions and accept its new website permissions. Built-in viewers may remain protected even with website access.'
    };
  }
  if (/No tab|tab.*closed|Frame.*removed|frame.*not found|No frame/i.test(message)) {
    return { title: 'Page changed', message: 'The tab closed or navigated during extraction. Select an open webpage; CopyClean will scan it automatically.' };
  }
  return { title: 'Scan failed', message: `Could not extract tables: ${message}. The page may be a protected viewer or still loading. Try another webpage or use Restart CopyClean to retry.` };
}
