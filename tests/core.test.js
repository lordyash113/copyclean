import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { serialize } from '../lib/exporters.js';

test('CSV and TSV quote delimiters, quotes and newlines; JSON preserves values', () => {
  const table = { rows: [['a,b', 'say "hi"', 'a\nb', 'a\tb', '']], header: false };
  assert.equal(serialize(table, 'csv'), '"a,b","say ""hi""","a\nb",a\tb,');
  assert.equal(serialize(table, 'tsv'), 'a,b\t"say ""hi"""\t"a\nb"\t"a\tb"\t');
  assert.deepEqual(JSON.parse(serialize(table, 'json')), table.rows);
});
test('formula protection defaults on and can be disabled without changing source', () => {
  const table = { rows: [['=SUM(A1)', ' +1', '@x', '-2', '\tcommand', 'normal']] };
  assert.equal(serialize(table, 'csv'), "'=SUM(A1),' +1,'@x,'-2,'\tcommand,normal");
  assert.equal(serialize(table, 'csv', { protectFormulas: false }), '=SUM(A1), +1,@x,-2,\tcommand,normal');
  assert.equal(table.rows[0][0], '=SUM(A1)');
});
test('Markdown creates headers only when needed and escapes markup', () => {
  assert.equal(serialize({ rows: [['a|b', '<img>\n*x*']], header: false }, 'markdown'), '| Column 1 | Column 2 |\n| --- | --- |\n| a\\|b | &lt;img&gt;<br>\\*x\\* |');
  assert.equal(serialize({ rows: [['Name'], ['Ada']], header: true }, 'markdown'), '| Name |\n| --- |\n| Ada |');
  for (const format of ['csv', 'tsv', 'markdown']) assert.equal(serialize({ rows: [] }, format), '');
  assert.equal(serialize({ rows: [] }, 'json'), '[]');
  assert.throws(() => serialize({ rows: [] }, '__proto__'), /Unsupported/);
});

// Small DOM contract doubles exercise the real content script without dependencies.
const script = readFileSync(new URL('../content/extract-tables.js', import.meta.url), 'utf8');
const cell = (value, colSpan = 1, rowSpan = 1, tagName = 'TD') => ({
  colSpan, rowSpan, tagName, textContent: value
});
function extract(groups) {
  const table = { children: [], rows: [] };
  groups.forEach(group => {
    const parentElement = {};
    group.forEach(cells => table.rows.push({ cells, parentElement, closest: () => table }));
  });
  return JSON.parse(JSON.stringify(vm.runInNewContext(script, {
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    document: { querySelectorAll: () => [table], createTreeWalker: root => {
      let read = false;
      return { nextNode: () => read ? null : (read = true, { nodeType: 3, nodeValue: root.textContent }) };
    } }
  })));
}
test('extractor expands merged cells and pads ragged rows', () => {
  const result = extract([[[cell('A', 1, 2, 'TH'), cell('B', 2, 1, 'TH')], [cell('C')], [cell('D')]]]);
  assert.deepEqual(result.tables[0].rows, [['A', 'B', 'B'], ['A', 'C', ''], ['D', '', '']]);
  assert.equal(result.tables[0].header, true);
});
test('rowspan zero stops at row group and empty tables are supported', () => {
  assert.deepEqual(extract([[[cell('A', 1, 0)], []], [[cell('B')]]]).tables[0].rows, [['A'], ['A'], ['B']]);
  assert.deepEqual(extract([]).tables[0].rows, []);
});
test('oversized and overlapping tables return recoverable errors', () => {
  assert.match(extract([[[cell('A', 200001)]]]).tables[0].error, /safety limit/);
  assert.match(extract([[[cell('A'), cell('B', 1, 2)], [cell('C', 2)]]]).tables[0].error, /overlapping/);
});
