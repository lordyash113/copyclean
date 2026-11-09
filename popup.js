import { FORMATS, serialize } from './lib/exporters.js';
import { TableScanner } from './lib/scanner.js';
import { copyTable } from './lib/clipboard.js';

const $ = id => document.getElementById(id);
let tables = [];
let busy = false;
let restarting = false;
let restartTimer;
let lifecycleId = 0;
let receivedNotification = 0;
let appliedNotification = 0;
let copyVersion = 0;
let copying = false;
let disposed = false;
const downloadURLs = new Map();
let panelWindowId;
let emptyMessage = 'No HTML tables found on this page.';
const sourceLabel = () => 'HTML Table';
let feedbackTimer;
function clearFeedbackTimer() {
  clearTimeout(feedbackTimer);
  feedbackTimer = undefined;
}
function updateScrollHint() {
  const preview = $('preview');
  $('scroll-hint').hidden = preview.scrollWidth <= preview.clientWidth;
}
const previewObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateScrollHint) : null;
previewObserver?.observe($('preview'));
window.addEventListener('resize', updateScrollHint);
async function activeTab() {
  panelWindowId ??= (await chrome.windows.getCurrent()).id;
  const [tab] = await chrome.tabs.query({ active: true, windowId: panelWindowId });
  return tab;
}
const selected = () => tables[Number($('table-select').value)];
function status(message, error = false, tone, title) {
  clearFeedbackTimer();
  const kind = tone || (error ? 'error' : /^(Copied |CopyClean restarted\.|Download requested\.)/.test(message) ? 'success' : 'info');
  $('status').textContent = message;
  $('status').dataset.error = String(error);
  $('feedback').dataset.active = String(Boolean(message));
  $('feedback').dataset.tone = kind;
  $('feedback').tabIndex = message && kind !== 'success' ? 0 : -1;
  const titles = { error: 'Action needed', warning: 'Please review', success: 'Done', info: busy ? 'Working' : 'Note' };
  $('feedback-title').textContent = message ? title || titles[kind] : '';
  $('feedback-icon').textContent = message ? ({ error: '!', warning: '!', success: '✓', info: 'i' })[kind] : '';
  if (message && kind === 'success') feedbackTimer = setTimeout(() => status(''), 3000);
}
function updateActions() {
  const table = selected();
  const disabled = busy || !table || Boolean(table.error) || !table.rows.length || !table.rows[0]?.length;
  $('copy').disabled = disabled || copying;
  $('copy').setAttribute('aria-busy', String(copying));
  $('copy-label').textContent = copying ? 'Copying…' : 'Copy Table';
  $('download').disabled = disabled;
  $('action-summary').textContent = busy ? 'Scanning the active page…'
    : disabled ? 'Select a non-empty table to export'
      : `${FORMATS[$('format').value].label} · all extracted rows`;
}
function preview() {
  const table = selected();
  $('table-select').title = table ? `${sourceLabel(table)}: ${table.name}` : '';
  $('preview').setAttribute('aria-busy', String(busy));
  $('preview').dataset.state = busy ? 'loading' : table?.error || document.querySelector('main').dataset.phase === 'error' ? 'error' : table?.rows[0]?.length ? 'ready' : 'empty';
  $('source-type').hidden = !table;
  $('source-type').textContent = table ? `Source: ${sourceLabel(table)}` : '';
  $('preview').replaceChildren();
  $('dimensions').textContent = table ? `${table.rows.length} rows · ${table.rows[0]?.length || 0} columns` : 'First 5 rows';
  if (!table || table.error || !table.rows.length || !table.rows[0]?.length) {
    const message = document.createElement('p');
    message.className = 'placeholder';
    message.textContent = table?.error || (table ? 'This table is empty.' : emptyMessage);
    $('preview').append(message);
  } else {
    const element = document.createElement('table');
    element.setAttribute('aria-label', `${table.name || 'Extracted table'} preview`);
    const width = table.rows.reduce((width, row) => Math.max(width, row.length), 0);
    const headings = new Set();
    if (Array.isArray(table.cells)) {
      for (const cell of table.cells) {
        if (!cell.header || cell.row >= 5 || cell.column >= width) continue;
        for (let r = cell.row; r < Math.min(5, cell.row + cell.rowspan); r++) {
          for (let c = cell.column; c < Math.min(width, cell.column + cell.colspan); c++) headings.add(`${r}:${c}`);
        }
      }
    }
    let shortened = false;
    table.rows.slice(0, 5).forEach((row, index) => {
      const tr = document.createElement('tr');
      row.slice(0, width).forEach((value, column) => {
        const heading = Array.isArray(table.cells) ? headings.has(`${index}:${column}`) : index < (table.headerRowCount ?? (table.header ? 1 : 0));
        const cell = document.createElement(heading ? 'th' : 'td');
        cell.textContent = value.length > 1000 ? value.slice(0, 1000).replace(/[\uD800-\uDBFF]$/, '') + '…' : value;
        if (value.length > 1000) shortened = true;
        tr.append(cell);
      });
      element.append(tr);
    });
    $('preview').append(element);
    if (shortened) $('dimensions').textContent += ' · text shortened in preview';
  }
  updateScrollHint();
  updateActions();
}
function renderState(state) {
  const finishingRestart = restarting && state.phase !== 'loading';
  if (finishingRestart) {
    restarting = false;
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }
  busy = state.phase === 'loading';
  if (busy) { copying = false; copyVersion++; }
  document.querySelector('main').setAttribute('aria-busy', String(busy));
  document.querySelector('main').dataset.phase = state.phase;
  // Recovery remains available during an ordinary scan, including a stuck one.
  $('restart').disabled = restarting;
  const htmlTables = state.tables || [];
  tables = htmlTables.map(table => ({ ...table, sourceType: 'html-table' }));
  $('table-select').replaceChildren();
  $('table-select').disabled = busy || !tables.length;
  status('');
  if (state.phase === 'ready') {
    emptyMessage = 'No HTML tables found on this page.';
    $('count').textContent = `${tables.length} ${tables.length === 1 ? 'table' : 'tables'} detected`;
    tables.forEach((table, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${table.name} (${table.rows.length} rows)${table.error ? ' — unavailable' : ''}`;
      $('table-select').append(option);
    });
    if (!tables.length) $('table-select').add(new Option('No HTML tables detected', ''));
    if (state.warnings.length) status(`${finishingRestart ? 'CopyClean restarted. ' : ''}${state.warnings.join(' ')}`, false, 'warning', 'Scan complete with notes');
    else if (finishingRestart) status(`CopyClean restarted. ${tables.length} ${tables.length === 1 ? 'table' : 'tables'} detected.`);
  } else {
    const loadingMessage = restarting ? 'Restarting CopyClean...' : state.message;
    $('count').textContent = busy ? (restarting ? loadingMessage : 'Detecting tables…') : state.title;
    emptyMessage = busy ? loadingMessage : 'This page could not be scanned.';
    $('table-select').add(new Option(busy ? 'Scanning active page…' : 'No table data available', ''));
    if (!busy) status(`${finishingRestart ? 'Restart failed. ' : ''}${state.message}`, true, 'error', state.title);
    else if (restarting) status(loadingMessage);
  }
  preview();
  $('scan-announcement').textContent = busy
    ? restarting ? '' : state.message || 'Scanning the active page.'
    : $('count').textContent;
}

const scanner = new TableScanner({
  scripting: chrome.scripting,
  readTab: activeTab,
  onState: renderState,
  isVisible: () => !disposed && !document.hidden
});
function exportTable() {
  const table = selected();
  if (!table || table.error || !table.rows[0]?.length) throw new Error('Select a non-empty table first.');
  return table;
}
function exportData() {
  return serialize(exportTable(), $('format').value, { protectFormulas: $('protect').checked });
}
$('table-select').addEventListener('change', () => {
  const error = selected()?.error;
  status(error || '', Boolean(error), 'error', 'This table is unavailable');
  preview();
});
$('restart').addEventListener('click', () => {
  if (restarting) return;
  restarting = true;
  const generation = ++lifecycleId;
  scanner.reset();
  panelWindowId = undefined;
  busy = false;
  tables = [];
  // Existing runtime, visibility, and worker tab listeners stay registered once.
  // Resetting their scanner state restores detection without duplicating them.
  restartTimer = setTimeout(() => {
    if (!restarting || generation !== lifecycleId) return;
    scanner.reset();
    renderState({ phase: 'error', title: 'Restart failed', message: 'The scan timed out. The side panel is still usable; try Restart CopyClean again when the page finishes loading.' });
  }, 20000);
  void scanner.scan();
});
$('format').addEventListener('change', () => {
  const spreadsheet = ['csv', 'tsv', 'formatted'].includes($('format').value);
  $('protect').disabled = !spreadsheet;
  $('format-hint').textContent = spreadsheet ? 'Adds an apostrophe to formula-like values in spreadsheet exports.' : 'Formula protection applies to CSV, TSV, and Formatted Table.';
  $('copy-hint').textContent = $('format').value === 'formatted'
    ? 'For Excel Online and Google Sheets: copies an HTML table with a TSV plain-text fallback.'
    : $('format').value === 'csv'
      ? 'CSV is for file import. For spreadsheet paste into columns, select Formatted Table or TSV.'
      : $('format').value === 'tsv' ? 'Copies tab-separated cells and newline-separated records for spreadsheet paste.'
        : `Copies ${FORMATS[$('format').value].label} as plain text.`;
  $('download').title = `Download as ${FORMATS[$('format').value].label}`;
  updateActions();
  status(restarting ? 'Restarting CopyClean...' : '');
});
$('copy').addEventListener('click', async () => {
  if (copying) return;
  const generation = lifecycleId;
  const operation = ++copyVersion;
  const request = scanner.requestId;
  const table = selected();
  const current = () => generation === lifecycleId && operation === copyVersion && request === scanner.requestId && table === selected();
  const format = $('format').value;
  copying = true;
  updateActions();
  try {
    const result = await copyTable(exportTable(), format, { protectFormulas: $('protect').checked });
    if (current()) {
      if (result.fallback) status('Rich clipboard writing is unsupported; copied TSV instead. Paste into spreadsheet cells. Formatting and merged cells are not included.', false, 'warning', 'Copied as plain text');
      else if (result.rich) status('Copied Formatted Table with HTML and TSV fallback to clipboard. Paste into spreadsheet cells.', false, 'success', 'Copied to clipboard');
      else status(`Copied ${FORMATS[format].label} to clipboard.${format === 'csv' ? ' For Excel Online or Google Sheets columns, choose Formatted Table or TSV.' : ''}`);
    }
  } catch (error) {
    if (current()) status(`Copy failed. Keep the CopyClean panel focused and retry, or download instead. ${error.message}`, true, 'error', 'Copy failed');
  } finally {
    if (operation === copyVersion) { copying = false; updateActions(); }
  }
});
$('download').addEventListener('click', () => {
  let url;
  try {
    const format = FORMATS[$('format').value];
    const data = exportData();
    const content = $('format').value === 'formatted'
      ? `<!doctype html><html><head><meta charset="utf-8"><title>CopyClean table</title></head><body>${data}</body></html>` : data;
    url = URL.createObjectURL(new Blob([content], { type: format.mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `copyclean-table-${Number($('table-select').value) + 1}.${format.extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    status('Download requested.');
  } catch (error) { status(`Download failed. ${error.message}`, true, 'error', 'Download failed'); }
  finally { if (url) downloadURLs.set(url, setTimeout(() => releaseDownload(url), 10000)); }
});
function releaseDownload(url) {
  clearTimeout(downloadURLs.get(url));
  downloadURLs.delete(url);
  URL.revokeObjectURL(url);
}

// Only this panel's window may trigger scans. The queried active tab, rather
// than a possibly delayed message's tab ID, determines the injection target.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.type !== 'copyclean:page-changed' ||
      !Number.isInteger(message.tabId) || !Number.isInteger(message.windowId) ||
      !['loading', 'scan'].includes(message.phase) ||
      message.windowId !== panelWindowId || document.hidden || disposed) return;
  const generation = lifecycleId;
  const notification = ++receivedNotification;
  void (async () => {
    const tab = await activeTab();
    // A delayed navigation event from the previous tab must not clear this one.
    if (generation !== lifecycleId || document.hidden || disposed || tab?.id !== message.tabId || notification < appliedNotification) return;
    appliedNotification = notification;
    if (message.phase === 'loading') scanner.invalidate();
    else if (message.phase === 'scan') {
      await scanner.scan({ force: message.reason === 'toolbar', discardCache: message.reason === 'activated' });
    }
  })().catch(error => {
    if (generation === lifecycleId && notification >= appliedNotification && !restarting) status(`Could not identify the active tab: ${error.message}`, true);
  });
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    lifecycleId++;
    status('');
    restarting = false;
    clearTimeout(restartTimer);
    restartTimer = undefined;
    scanner.invalidate();
  }
  else void scanner.scan();
});
window.addEventListener('pagehide', () => {
  disposed = true;
  clearFeedbackTimer();
  previewObserver?.disconnect();
  window.removeEventListener('resize', updateScrollHint);
  lifecycleId++;
  clearTimeout(restartTimer);
  restarting = false;
  tables = [];
  scanner.reset();
  for (const url of downloadURLs.keys()) releaseDownload(url);
});
window.addEventListener('pageshow', event => {
  if (event.persisted) { disposed = false; previewObserver?.observe($('preview')); window.addEventListener('resize', updateScrollHint); void scanner.scan(); }
});
// Direct side-panel opens work without a toolbar gesture or message receiver.
void scanner.scan();
