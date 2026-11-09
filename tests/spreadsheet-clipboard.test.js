import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { clipboardPayload } from '../lib/clipboard.js';
import { createPanel } from './harness.js';

const table = {
  header: true,
  rows: [
    ['Name', 'Salary', 'Notes', 'Empty'],
    ['Alice', '$162,700', 'He said "hi"', ''],
    ['雪 😀 नमस्ते', '$98,000', 'Line 1\nLine 2', ''],
    ['', '$0', '', '']
  ]
};
const expectedTSV = 'Name\tSalary\tNotes\tEmpty\r\n' +
  'Alice\t$162,700\t"He said ""hi"""\t\r\n' +
  '雪 😀 नमस्ते\t$98,000\t"Line 1\nLine 2"\t\r\n' +
  '\t$0\t\t';
const fixture = `<table><thead><tr><th>Name</th><th>Salary</th><th>Notes</th><th>Empty</th></tr></thead><tbody>
<tr><td>Alice</td><td>$162,700</td><td>He said &quot;hi&quot;</td><td></td></tr>
<tr><td>雪 😀 नमस्ते</td><td>$98,000</td><td>Line 1<br>Line 2</td><td></td></tr>
<tr><td></td><td>$0</td><td></td><td></td></tr></tbody></table>`;

test('spreadsheet payload preserves salary commas, quotes, empty cells, Unicode, and multiline values', () => {
  const payload = clipboardPayload(table);
  assert.equal(payload['text/plain'], expectedTSV);
  const dom = new JSDOM(payload['text/html']);
  try {
    const result = dom.window.document.querySelector('table');
    assert.equal(result.tHead.rows[0].cells.length, 4);
    assert.ok(Array.from(result.tHead.rows[0].cells).every(cell => cell.tagName === 'TH'));
    assert.equal(result.rows[1].cells[1].textContent, '$162,700');
    assert.equal(result.rows[1].cells[2].textContent, 'He said "hi"');
    assert.equal(result.rows[1].cells[3].textContent, '');
    assert.equal(result.rows[2].cells[0].textContent, '雪 😀 नमस्ते');
    assert.equal(result.rows[2].cells[2].innerHTML, 'Line 1<br>Line 2');
    assert.deepEqual(Array.from(result.rows[3].cells, cell => cell.textContent), ['', '$0', '', '']);
  } finally { dom.window.close(); }
});

test('Formatted Table synchronously writes one ClipboardItem with both representations', async t => {
  const panel = await createPanel({ html: fixture });
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  panel.$('format').dispatchEvent(new panel.popup.window.Event('change'));
  assert.equal(panel.$('format').value, 'formatted');
  panel.$('copy').click();
  // The Clipboard API is reached inside the click handler, before awaiting any
  // tab lookup, network operation, timer, or other unrelated asynchronous work.
  assert.equal(panel.state.clipboardWrites.length, 1);
  const [item] = panel.state.clipboardWrites[0];
  assert.deepEqual(item.types, ['text/html', 'text/plain']);
  assert.equal((await item.getType('text/html')).type, 'text/html');
  assert.equal((await item.getType('text/plain')).type, 'text/plain');
  assert.equal(await (await item.getType('text/plain')).text(), expectedTSV);
  assert.equal(panel.state.copies.length, 0);
  assert.match(panel.$('copy-hint').textContent, /Excel Online and Google Sheets/);
});

test('rich HTML retains original header colspan and body rowspan with salary commas in a single cell', async t => {
  const panel = await createPanel({ html: `<table><thead><tr><th rowspan="2">Name</th><th colspan="2">Compensation</th></tr>
    <tr><th>Salary</th><th>Bonus</th></tr></thead><tbody><tr><td rowspan="2">Ada</td><td>$162,700</td><td></td></tr>
    <tr><td>$170,000</td><td>&quot;Quoted&quot;</td></tr></tbody></table>` });
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  panel.$('format').dispatchEvent(new panel.popup.window.Event('change'));
  await panel.click('copy');
  const [item] = panel.state.clipboardWrites[0];
  const html = await (await item.getType('text/html')).text();
  const plain = await (await item.getType('text/plain')).text();
  const dom = new JSDOM(html);
  try {
    const result = dom.window.document.querySelector('table');
    assert.equal(result.tHead.rows[0].cells[0].rowSpan, 2);
    assert.equal(result.tHead.rows[0].cells[1].colSpan, 2);
    assert.equal(result.tBodies[0].rows[0].cells[0].rowSpan, 2);
    assert.equal(result.tBodies[0].rows[0].cells[1].textContent, '$162,700');
    assert.equal(result.tBodies[0].rows[0].cells[2].textContent, '');
    assert.equal(result.tBodies[0].rows[1].cells.length, 2);
    assert.match(plain, /Ada\t\$162,700\t\r\nAda\t\$170,000\t"""Quoted"""$/);
  } finally { dom.window.close(); }
});

for (const feature of ['ClipboardItem', 'write', 'supports', 'constructor', 'write-rejection', 'write-type-notallowed']) {
  test(`unsupported ${feature} falls back to TSV with an explicit notification`, async t => {
    const panel = await createPanel({ html: fixture });
    t.after(panel.close);
  panel.$('format').value = 'formatted';
  panel.$('format').dispatchEvent(new panel.popup.window.Event('change'));
    if (feature === 'ClipboardItem') panel.popup.window.ClipboardItem = undefined;
    if (feature === 'write') panel.popup.window.navigator.clipboard.write = undefined;
    if (feature === 'supports') panel.popup.window.ClipboardItem.supports = type => type !== 'text/html';
    if (feature === 'constructor') panel.popup.window.ClipboardItem = class {
      constructor() { throw new panel.popup.window.DOMException('HTML clipboard not supported', 'NotSupportedError'); }
    };
    if (feature === 'write-rejection') panel.state.richClipboardError = new panel.popup.window.DOMException('HTML clipboard not supported', 'NotSupportedError');
    if (feature === 'write-type-notallowed') panel.state.richClipboardError = new panel.popup.window.DOMException('Type text/html not supported on write', 'NotAllowedError');
    await panel.click('copy');
    assert.equal(panel.state.clipboardWrites.length, 0);
    assert.equal(panel.state.copies.at(-1), expectedTSV);
    assert.match(panel.$('status').textContent, /unsupported; copied TSV instead/);
    assert.match(panel.$('status').textContent, /merged cells are not included/);
    assert.equal(panel.$('status').dataset.error, 'false');
  });
}

test('permission denial stays an error and does not trigger or claim a TSV fallback', async t => {
  const panel = await createPanel({ html: fixture });
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  panel.$('format').dispatchEvent(new panel.popup.window.Event('change'));
  panel.state.richClipboardError = new panel.popup.window.DOMException('Clipboard access denied', 'NotAllowedError');
  await panel.click('copy');
  assert.equal(panel.state.copies.length, 0);
  assert.equal(panel.state.clipboardWrites.length, 0);
  assert.match(panel.$('status').textContent, /Copy failed.*Clipboard access denied/);
  assert.doesNotMatch(panel.$('status').textContent, /copied TSV/);
  assert.equal(panel.$('status').dataset.error, 'true');
});

test('a failed TSV fallback reports failure without claiming success', async t => {
  const panel = await createPanel({ html: fixture });
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  panel.$('format').dispatchEvent(new panel.popup.window.Event('change'));
  panel.popup.window.ClipboardItem = undefined;
  panel.state.clipboardError = new Error('Clipboard blocked');
  await panel.click('copy');
  assert.equal(panel.state.copies.length, 0);
  assert.match(panel.$('status').textContent, /Copy failed.*Clipboard blocked/);
  assert.equal(panel.$('status').dataset.error, 'true');
});

test('explicit CSV still copies selected CSV text and downloads the original CSV file format', async t => {
  const panel = await createPanel({ html: fixture });
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  panel.$('format').dispatchEvent(new panel.popup.window.Event('change'));
  panel.$('format').value = 'csv';
  panel.$('format').dispatchEvent(new panel.popup.window.Event('change'));
  await panel.click('copy');
  const expectedCSV = 'Name,Salary,Notes,Empty\r\nAlice,"$162,700","He said ""hi""",\r\n雪 😀 नमस्ते,"$98,000","Line 1\nLine 2",\r\n,$0,,';
  assert.equal(panel.state.copies[0], expectedCSV);
  assert.equal(panel.state.clipboardWrites.length, 0);
  assert.match(panel.$('copy-hint').textContent, /CSV is for file import/);
  assert.match(panel.$('status').textContent, /Copied CSV.*Formatted Table or TSV/);
  await panel.click('download');
  assert.equal(panel.state.downloads[0], 'copyclean-table-1.csv');
  assert.equal(await panel.state.blobs[0].text(), expectedCSV);
});
