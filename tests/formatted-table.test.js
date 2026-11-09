import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { serialize } from '../lib/exporters.js';
import { createPanel } from './harness.js';

async function clipboardContent(panel) {
  const items = panel.state.clipboardWrites.at(-1);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.deepEqual(item.types, ['text/html', 'text/plain']);
  return {
    html: await (await item.getType('text/html')).text(),
    plain: await (await item.getType('text/plain')).text()
  };
}

test('Formatted Table copies HTML and TSV in one ClipboardItem and downloads UTF-8 HTML', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  panel.$('format').dispatchEvent(new panel.popup.window.Event('change'));
  assert.equal(panel.$('protect').disabled, false);
  await panel.click('copy');
  const { html, plain } = await clipboardContent(panel);
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const table = dom.window.document.querySelector('table');
  assert.equal(table.querySelectorAll('thead tr').length, 1);
  assert.equal(table.querySelectorAll('thead th').length, 3);
  assert.equal(table.querySelectorAll('tbody tr').length, 6);
  assert.equal(table.querySelectorAll('tbody td').length, 18);
  assert.match(table.querySelector('th').getAttribute('style'), /font-weight:bold/);
  assert.match(plain, /^Company\tContact\tCountry\r\n/);
  assert.match(plain, /Magazzini Alimentari Riuniti/);
  assert.equal(panel.state.copies.length, 0); // No later writeText clobbers the rich item.
  assert.match(panel.$('status').textContent, /Copied Formatted Table.*HTML and TSV/);
  await panel.click('download');
  assert.equal(panel.state.downloads.at(-1), 'copyclean-table-1.html');
  const download = await panel.state.blobs.at(-1).text();
  assert.match(download, /<meta charset="utf-8">/);
  assert.ok(download.includes(html));
});

test('merged cells, multirow headers, row headers, and row groups survive HTML export', async t => {
  const panel = await createPanel({ html: `<table>
    <thead><tr><th rowspan="2">Name</th><th colspan="2">Scores</th></tr><tr><th>First</th><th>Last</th></tr></thead>
    <tbody><tr><th rowspan="0">Ada</th><td>1</td><td>2</td></tr><tr><td colspan="2">3</td></tr></tbody>
    <tbody><tr><th>Grace</th><td>4</td><td>5</td></tr></tbody></table>` });
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  await panel.click('copy');
  const { html, plain } = await clipboardContent(panel);
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  const table = dom.window.document.querySelector('table');
  assert.equal(table.tHead.rows.length, 2);
  assert.equal(table.tHead.rows[0].cells[0].rowSpan, 2);
  assert.equal(table.tHead.rows[0].cells[1].colSpan, 2);
  assert.equal(table.tBodies[0].rows[0].cells[0].tagName, 'TH');
  assert.equal(table.tBodies[0].rows[0].cells[0].rowSpan, 2);
  assert.equal(table.tBodies[0].rows[1].cells.length, 1);
  assert.equal(table.tBodies[0].rows[1].cells[0].colSpan, 2);
  assert.equal(table.tBodies[0].rows[2].cells[0].textContent, 'Grace');
  assert.equal(plain, 'Name\tScores\tScores\r\nName\tFirst\tLast\r\nAda\t1\t2\r\nAda\t3\t3\r\nGrace\t4\t5');
});

test('source HTML is never reused; special characters and line breaks remain safe text', async t => {
  const text = '<img src=x onerror="alert(1)"> & \'quoted\'\n雪';
  const table = { rows: [['Header'], [text]], header: true };
  const html = serialize(table, 'formatted');
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &#39;quoted&#39;<br>雪/);
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  assert.equal(dom.window.document.querySelectorAll('img,script,a,iframe').length, 0);
  assert.equal(dom.window.document.querySelector('td').textContent, text.replace('\n', ''));
  const panel = await createPanel({ html: '<table><tr><td onclick="evil()"><b>Bold</b><script>evil()</script><table><tr><td>Nested</td></tr></table><br>Next</td></tr></table>' });
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  await panel.click('copy');
  const payload = await clipboardContent(panel);
  assert.match(payload.html, /Bold<br>Next/);
  assert.doesNotMatch(payload.html, /onclick|evil\(\)|Nested|<b>/);
});

test('headerless/ragged tables and adapters without merge metadata produce valid tables', () => {
  const html = serialize({ rows: [['A', 'B'], ['C']], header: false }, 'formatted');
  const dom = new JSDOM(html);
  try {
    const table = dom.window.document.querySelector('table');
    assert.ok(table.tHead);
    assert.equal(table.tHead.rows.length, 0);
    assert.equal(table.tBodies[0].rows.length, 2);
    assert.equal(table.rows[1].cells.length, 2);
    assert.equal(table.rows[1].cells[1].textContent, '');
    assert.equal(table.querySelectorAll('th').length, 0);
  } finally { dom.window.close(); }
  assert.match(serialize({ rows: [], header: true }, 'formatted'), /<thead><\/thead><tbody><\/tbody>/);
});

test('HTML and TSV share formula protection and malformed merge metadata is rejected', () => {
  const table = { rows: [['=1+1', '@SUM']], header: false };
  assert.match(serialize(table, 'formatted'), /&#39;=1\+1/);
  assert.match(serialize(table, 'tsv'), /^'=1\+1\t'@SUM$/);
  assert.doesNotMatch(serialize(table, 'formatted', { protectFormulas: false }), /&#39;/);
  for (const cells of [
    [{ row: 0, column: 0, rowspan: 1, colspan: '" onclick="evil()' }],
    [{ row: 0, column: 0, rowspan: 2, colspan: 1 }],
    [{ row: 0, column: 0, rowspan: 1, colspan: 2 }, { row: 0, column: 1, rowspan: 1, colspan: 1 }]
  ]) assert.throws(() => serialize({ ...table, cells }, 'formatted'), /metadata/);
});

test('clipboard failures and missing rich clipboard support display clear errors without false success', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  panel.state.clipboardError = new Error('Clipboard access denied');
  await panel.click('copy');
  assert.match(panel.$('status').textContent, /Copy failed.*Clipboard access denied/);
  assert.equal(panel.$('status').dataset.error, 'true');
  assert.equal(panel.state.clipboardWrites.length, 0);
  assert.equal(panel.$('copy').disabled, false);
  panel.state.clipboardError = null;
  panel.popup.window.ClipboardItem = undefined;
  await panel.click('copy');
  assert.match(panel.$('status').textContent, /unsupported; copied TSV instead/);
  assert.match(panel.state.copies.at(-1), /^Company\tContact\tCountry/);
  assert.equal(panel.$('status').dataset.error, 'false');
  panel.$('format').value = 'tsv';
  await panel.click('copy');
  assert.match(panel.$('status').textContent, /Copied TSV/);
});
