// Explicit opt-in network check; the installed extension never fetches this page.
import assert from 'node:assert/strict';
import { createPanel } from './harness.js';

const url = 'https://www.w3schools.com/html/html_tables.asp';
const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
assert.ok(response.ok, `W3Schools returned ${response.status}`);
const html = await response.text();
for (const entry of ['Direct side-panel open', 'Toolbar-triggered rescan']) {
  const panel = await createPanel({ html, url });
  try {
    if (entry === 'Toolbar-triggered rescan') {
      panel.notify({ reason: 'toolbar' });
      const { settle } = await import('./harness.js');
      await settle();
    }
    const sourceTable = panel.page.window.document.querySelector('#customers');
    assert.ok(sourceTable, 'Live page contains #customers');
    const index = Array.from(panel.page.window.document.querySelectorAll('table')).indexOf(sourceTable);
    panel.$('table-select').value = String(index);
    panel.$('table-select').dispatchEvent(new panel.popup.window.Event('change'));
    assert.equal(panel.$('preview').querySelectorAll('tr').length, 5);
    assert.equal(panel.$('preview').querySelector('th').textContent, 'Company');
    assert.match(panel.$('preview').textContent, /Alfreds Futterkiste/);
    for (const format of ['csv', 'json', 'markdown', 'tsv', 'formatted']) {
      panel.$('format').value = format;
      await panel.click('copy');
      const item = panel.state.clipboardWrites.at(-1)?.[0];
      const result = format === 'formatted' ? await (await item.getType('text/html')).text() : panel.state.copies.at(-1);
      assert.match(result, /Magazzini Alimentari Riuniti/);
      assert.match(result, /Giovanni Rovelli/);
      if (format === 'json') assert.equal(JSON.parse(result).length, sourceTable.rows.length);
      if (format === 'formatted') {
        const plain = await (await item.getType('text/plain')).text();
        assert.match(plain, /^Company\tContact\tCountry/);
      }
      await panel.click('download');
      assert.ok(panel.state.downloads.at(-1));
    }
    console.log(`${entry}: ${panel.$('count').textContent}; #customers ${sourceTable.rows.length} rows × 3 columns; five-row preview and all five copy/download paths passed (jsdom, simulated Chrome APIs).`);
  } finally { panel.close(); }
}
