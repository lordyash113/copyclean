import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { createPanel, settle } from './harness.js';
import { serialize } from '../lib/exporters.js';

const source = readFileSync(new URL('../content/extract-tables.js', import.meta.url), 'utf8');
function extract(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  try { return dom.window.eval(source); } finally { dom.window.close(); }
}

test('release manifest blocks extension network access and exposes no external entry points', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
  const policy = manifest.content_security_policy.extension_pages;
  for (const rule of ["connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(policy.includes(rule));
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  for (const path of ['background.js', 'popup.js', 'theme.js', 'lib/scanner.js', 'lib/page-access.js', 'lib/clipboard.js', 'lib/exporters.js', 'content/extract-tables.js']) {
    const code = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|eval)\s*\(|\.innerHTML\s*=|insertAdjacentHTML\s*\(/, path);
  }
  assert.equal(existsSync(new URL('../content/extract-layouts.js', import.meta.url)), false);
});

test('HTML-only detection ignores non-table cards and reports the page table limit', () => {
  const result = extract('<div style="display:grid"><div>A</div><div>B</div></div>' + '<table><tr><td>safe</td></tr></table>'.repeat(101));
  assert.equal(result.tables.length, 100);
  assert.match(result.warnings.join(' '), /100-table/);
});

test('excessive table width is unavailable while later supported tables remain usable', () => {
  const result = extract('<table><tr><td colspan="1000">a</td><td>b</td></tr></table><table><tr><td>safe</td></tr></table>');
  assert.match(result.tables[0].error, /1,000-column/);
  assert.equal(result.tables[1].rows[0][0], 'safe');
});

test('aggregate cell budget stops extraction instead of retaining unlimited large tables', () => {
  const table = '<table><tr><td colspan="1000" rowspan="200"></td></tr>' + '<tr></tr>'.repeat(199) + '</table>';
  const result = extract(table.repeat(3));
  assert.equal(result.tables.filter(table => !table.error).length, 2);
  assert.match(result.tables[2].error, /aggregate/);
});

test('cooperative work/time deadline returns a visible warning', () => {
  const table = { children: [], rows: [] };
  table.rows = Array.from({ length: 300 }, () => ({ cells: [], parentElement: {}, closest: () => table }));
  let clock = 0;
  const result = vm.runInNewContext(source, {
    Date: { now: () => clock++ ? 2000 : 0 },
    document: { querySelectorAll: () => [table] }
  });
  assert.match(result.warnings.join(' '), /work\/time safety limit/);
});

test('very tall supported tables render five rows without argument overflow', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.state.execute = () => [{ result: { tables: [{ name: 'Tall', rows: Array.from({ length: 150000 }, () => ['value']), header: false }], warnings: [] } }];
  await panel.click('restart');
  assert.equal(panel.$('preview').querySelectorAll('tr').length, 5);
  assert.equal(panel.$('copy').disabled, false);
  assert.match(panel.$('dimensions').textContent, /150000 rows/);
});

test('malformed and untrusted notifications cannot trigger scans or clear results', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  for (const message of [{ tabId: '7' }, { windowId: '3' }, { phase: 'unexpected' }]) panel.notify(message);
  const message = { type: 'copyclean:page-changed', tabId: 7, windowId: 3, phase: 'loading' };
  panel.events.message(message, { id: 'foreign-extension' });
  panel.events.message(message, { id: 'copyclean-test', tab: { id: 7 } });
  await settle();
  assert.equal(panel.state.injections.length, 1);
  assert.equal(panel.$('count').textContent, '1 table detected');
});

test('spreadsheet exports protect control-prefixed formulas in both clipboard representations', () => {
  const rows = [['=HYPERLINK("https://attacker.invalid")', '\u0000 =1+1', '\t@SUM(1)', '\r-1', '\n+1', 'safe']];
  for (const format of ['csv', 'tsv', 'formatted']) {
    const output = serialize({ rows }, format);
    assert.match(output, format === 'formatted' ? /&#39;=HYPERLINK/ : /'=HYPERLINK/);
    assert.match(output, format === 'formatted' ? /&#39;\u0000 =1\+1/ : /'\u0000 =1\+1/);
  }
  assert.deepEqual(JSON.parse(serialize({ rows }, 'json')), rows);
});
