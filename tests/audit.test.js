import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { serialize } from '../lib/exporters.js';
import { TableScanner } from '../lib/scanner.js';
import { createPanel, settle } from './harness.js';

const extractor = readFileSync(new URL('../content/extract-tables.js', import.meta.url), 'utf8');
const unicode = 'नमस्ते, 世界 😀 café e\u0301 東京';

test('audit: CSV escapes delimiters, quotes, CR/LF and empty cells without damaging Unicode', () => {
  const rows = [['a,b', '"quoted"', 'one\rtwo', 'one\ntwo', 'one\r\ntwo', '', unicode], ['', '', '', '', '', '', '尾']];
  assert.equal(serialize({ rows }, 'csv'), `"a,b","""quoted""","one\rtwo","one\ntwo","one\r\ntwo",,"${unicode}"\r\n,,,,,,尾`);
  assert.equal(serialize({ rows: [[unicode, 'a\tb', '"q"', '']] }, 'tsv'), `${unicode}\t"a\tb"\t"""q"""\t`);
  assert.deepEqual(JSON.parse(serialize({ rows }, 'json')), rows);
});

test('audit: all formats and downloaded UTF-8 bytes preserve Unicode', async t => {
  const table = { rows: [['Heading'], [unicode]], header: true };
  for (const format of ['csv', 'json', 'tsv', 'markdown', 'formatted']) {
    assert.ok(serialize(table, format).includes(unicode));
  }
  const panel = await createPanel({ html: '<table><tr><th>Heading</th></tr><tr><td></td></tr></table>' });
  t.after(panel.close);
  panel.page.window.document.querySelector('td').textContent = unicode;
  await panel.click('restart');
  for (const format of ['csv', 'json', 'tsv', 'markdown', 'formatted']) {
    panel.$('format').value = format;
    await panel.click('download');
    const buffer = await panel.state.blobs.at(-1).arrayBuffer();
    assert.ok(new TextDecoder('utf-8', { fatal: true }).decode(buffer).includes(unicode));
  }
});

test('audit: HTML escaping stays inert in preview, rich clipboard, and downloaded HTML', async t => {
  const payload = `<img src="https://invalid.example/x" onerror="evil()">&'雪`;
  const panel = await createPanel({ html: '<table><tr><th>Text</th></tr><tr><td></td></tr></table>' });
  t.after(panel.close);
  panel.page.window.document.querySelector('td').textContent = payload;
  await panel.click('restart');
  assert.equal(panel.$('preview').querySelector('td').textContent, payload);
  assert.equal(panel.$('preview').querySelector('img'), null);
  panel.$('format').value = 'formatted';
  await panel.click('copy');
  const [item] = panel.state.clipboardWrites.at(-1);
  const html = await (await item.getType('text/html')).text();
  assert.match(html, /&lt;img src=&quot;/);
  const dom = new JSDOM(html);
  try {
    assert.equal(dom.window.document.querySelector('img,script,iframe'), null);
    assert.equal(dom.window.document.querySelector('td').textContent, payload);
  } finally { dom.window.close(); }
  await panel.click('download');
  assert.ok((await panel.state.blobs.at(-1).text()).includes(html));
});

test('audit: extraction never clones live cells and preserves BR/nested-table semantics', async t => {
  const panel = await createPanel({ html: '<table><tr><td>A<br>B<b> C</b><script>evil()</script><style>bad</style><template>no</template><table><tr><td>Nested</td></tr></table></td></tr></table>' });
  t.after(panel.close);
  const cell = panel.page.window.document.querySelector('td');
  cell.cloneNode = () => { throw new Error('Live cell cloning is forbidden'); };
  await panel.click('restart');
  assert.equal(panel.$('count').textContent, '2 tables detected');
  assert.equal(panel.$('preview').querySelector('td').textContent, 'A\nB C');
  assert.equal(cell.querySelectorAll('script,style,template,table').length, 4); // Source DOM unchanged.
});

test('audit: merged spans, multiple headers and body headings match preview and HTML export', async t => {
  const panel = await createPanel({ html: `<table><thead><tr><th rowspan="2">Name</th><th colspan="2">Scores</th></tr>
    <tr><th>First</th><th>Last</th></tr></thead><tbody><tr><th rowspan="0">Ada</th><td>1</td><td>2</td></tr>
    <tr><td colspan="2">3</td></tr></tbody><tbody><tr><td>Grace</td><td>4</td><td>5</td></tr></tbody></table>` });
  t.after(panel.close);
  const preview = panel.$('preview').querySelector('table');
  assert.deepEqual(Array.from(preview.rows[1].cells, cell => cell.tagName), ['TH', 'TH', 'TH']);
  assert.deepEqual(Array.from(preview.rows[2].cells, cell => cell.tagName), ['TH', 'TD', 'TD']);
  assert.deepEqual(Array.from(preview.rows[3].cells, cell => cell.tagName), ['TH', 'TD', 'TD']);
  assert.equal(preview.rows[4].cells[0].tagName, 'TD');
  panel.$('format').value = 'json';
  await panel.click('copy');
  assert.deepEqual(JSON.parse(panel.state.copies.at(-1)), [
    ['Name', 'Scores', 'Scores'], ['Name', 'First', 'Last'], ['Ada', '1', '2'], ['Ada', '3', '3'], ['Grace', '4', '5']
  ]);
});

test('audit: empty and zero-column tables cannot be copied or downloaded', async t => {
  const panel = await createPanel({ html: '<table></table><table><tr></tr></table>' });
  t.after(panel.close);
  assert.equal(panel.$('count').textContent, '2 tables detected');
  for (const index of ['0', '1']) {
    panel.$('table-select').value = index;
    panel.$('table-select').dispatchEvent(new panel.popup.window.Event('change'));
    assert.match(panel.$('preview').textContent, /empty/);
    assert.equal(panel.$('copy').disabled, true);
    assert.equal(panel.$('download').disabled, true);
  }
  for (const format of ['csv', 'tsv', 'markdown']) assert.equal(serialize({ rows: [] }, format), '');
  assert.equal(serialize({ rows: [] }, 'json'), '[]');
  assert.match(serialize({ rows: [] }, 'formatted'), /<thead><\/thead><tbody><\/tbody>/);
});

test('audit: preview bounds are disclosed while exports retain every column and character', async t => {
  const panel = await createPanel({ html: `<table><tr>${Array.from({ length: 55 }, (_, i) => `<th>H${i}</th>`).join('')}</tr>
    <tr>${Array.from({ length: 55 }, (_, i) => `<td>${i === 0 ? 'a'.repeat(1200) : i}</td>`).join('')}</tr></table>` });
  t.after(panel.close);
  assert.equal(panel.$('preview').querySelectorAll('tr')[0].cells.length, 55);
  assert.match(panel.$('dimensions').textContent, /55 columns.*text shortened/);
  panel.$('format').value = 'json';
  await panel.click('copy');
  const data = JSON.parse(panel.state.copies.at(-1));
  assert.equal(data[1].length, 55);
  assert.equal(data[1][0].length, 1200);
  assert.equal(data[1][54], '54');
});

test('audit: expanded text budget catches small merged tables with oversized serialized output', () => {
  const dom = new JSDOM(`<table><tbody><tr><td colspan="1000" rowspan="200">${'x'.repeat(26)}</td></tr>${'<tr></tr>'.repeat(199)}</tbody></table>`, { runScripts: 'outside-only' });
  try { assert.match(dom.window.eval(extractor).tables[0].error, /expanded text safety limit/); }
  finally { dom.window.close(); }
});

test('audit: shortening a preview never cuts an emoji surrogate pair in half', async t => {
  const value = 'a'.repeat(999) + '😀' + 'b'.repeat(50);
  const panel = await createPanel({ html: `<table><tr><td>${value}</td></tr></table>` });
  t.after(panel.close);
  const preview = panel.$('preview').querySelector('td').textContent;
  assert.equal(preview, 'a'.repeat(999) + '…');
  panel.$('format').value = 'json';
  await panel.click('copy');
  assert.equal(JSON.parse(panel.state.copies.at(-1))[0][0], value);
});

test('audit: an older loading notification cannot overwrite a newer completed scan', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  let release;
  let first = true;
  panel.state.query = (_options, current) => {
    if (first) {
      first = false;
      const snapshot = current();
      return new Promise(resolve => { release = () => resolve(snapshot); });
    }
    return current();
  };
  panel.notify({ phase: 'loading' });
  panel.notify({ phase: 'scan', reason: 'complete' });
  await settle();
  assert.equal(panel.$('count').textContent, '1 table detected');
  release();
  await settle();
  assert.equal(panel.$('count').textContent, '1 table detected');
  assert.equal(panel.$('copy').disabled, false);
});

test('audit: late clipboard completion cannot overwrite a different active page status', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.$('format').value = 'csv'; // Exercise a delayed text-only clipboard write explicitly.
  let release;
  panel.state.copyWrite = () => new Promise(resolve => { release = resolve; });
  panel.$('copy').click();
  await settle();
  panel.state.tabId = 8;
  panel.state.url = 'chrome://extensions';
  panel.notify({ reason: 'activated' });
  await settle();
  const protectedStatus = panel.$('status').textContent;
  release();
  await settle();
  assert.equal(panel.$('status').textContent, protectedStatus);
  assert.equal(panel.$('status').dataset.error, 'true');
});

test('audit: panel close revokes object URLs, releases scan state, and does not duplicate listeners', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  await panel.click('restart');
  await panel.click('restart');
  assert.equal(panel.state.listenerCounts.message, 1);
  await panel.click('download');
  await panel.click('download');
  panel.popup.window.dispatchEvent(new panel.popup.window.Event('pagehide'));
  assert.deepEqual(panel.state.revoked, ['blob:test-1', 'blob:test-2']);
  const count = panel.state.injections.length;
  panel.notify({ reason: 'toolbar' });
  await settle();
  assert.equal(panel.state.injections.length, count);
});

test('audit: adapter deadlines and reset release timers and ignore late native responses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states = [];
  let release;
  const scanner = new TableScanner({
    scripting: { executeScript: () => new Promise(resolve => { release = resolve; }) },
    readTab: async () => ({ id: 7, url: 'https://example.com/', status: 'complete' }),
    onState: state => states.push(state), isVisible: () => true
  });
  const scanning = scanner.scan();
  await settle();
  assert.equal(scanner.pendingAdapters.size, 1);
  t.mock.timers.tick(15000);
  await scanning;
  assert.equal(scanner.pendingAdapters.size, 0);
  assert.equal(scanner.inFlight.size, 0);
  assert.match(states.at(-1).message, /timed out/);
  release([{ result: { tables: [], datasets: [] } }]);
  await settle();
  assert.equal(states.at(-1).phase, 'error');
  const pending = scanner.scan();
  await settle();
  scanner.reset();
  await pending;
  assert.equal(scanner.pendingAdapters.size, 0);
  assert.equal(scanner.cached, null);
});
