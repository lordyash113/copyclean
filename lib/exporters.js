// Pure serializers accept the adapter's rectangular string grid.
export const FORMATS = {
  csv: { label: 'CSV', mime: 'text/csv;charset=utf-8', extension: 'csv' },
  json: { label: 'JSON', mime: 'application/json;charset=utf-8', extension: 'json' },
  markdown: { label: 'Markdown', mime: 'text/markdown;charset=utf-8', extension: 'md' },
  tsv: { label: 'TSV', mime: 'text/tab-separated-values;charset=utf-8', extension: 'tsv' },
  formatted: { label: 'Formatted Table', mime: 'text/html;charset=utf-8', extension: 'html' }
};

export function spreadsheetText(value, protectFormulas) {
  let text = String(value ?? '');
  if (protectFormulas && (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
  return text;
}

function delimited(rows, delimiter, protectFormulas) {
  return rows.map(row => row.map(value => {
    // Protect spreadsheet imports, including formulas preceded by whitespace/control characters.
    const text = spreadsheetText(value, protectFormulas);
    return text.includes(delimiter) || /["\r\n]/.test(text)
      ? '"' + text.replaceAll('"', '""') + '"' : text;
  }).join(delimiter)).join('\r\n');
}

const markdownCell = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('\\', '\\\\').replaceAll('|', '\\|')
  .replace(/([`*_\[\]])/g, '\\$1').replace(/\r\n|\r|\n/g, '<br>');

export function serialize(table, format, { protectFormulas = true } = {}) {
  const rows = table.rows;
  if (!Object.hasOwn(FORMATS, format)) throw new Error('Unsupported export format.');
  if (format === 'json') return JSON.stringify(rows, null, 2);
  if (format === 'formatted') return formattedTable(table, { protectFormulas });
  if (!rows.length || !rows[0].length) return '';
  if (format === 'csv' || format === 'tsv') return delimited(rows, format === 'csv' ? ',' : '\t', protectFormulas);
  const header = table.header ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`);
  const body = table.header ? rows.slice(1) : rows;
  const line = row => `| ${row.map(markdownCell).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...body.map(line)].join('\n');
}

const escapeHTML = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function formattedTable(table, { protectFormulas = true } = {}) {
  const rows = table.rows;
  const width = rows[0]?.length || 0;
  if (rows.length * width > 200000) throw new Error('Formatted table exceeds the 200,000-cell safety limit.');
  const headerRows = table.headerRowCount ?? (table.header && rows.length ? 1 : 0);
  if (!Number.isInteger(headerRows) || headerRows < 0 || headerRows > rows.length) throw new Error('Invalid table header metadata.');
  const anchors = new Map();
  const covered = new Set();
  for (const cell of table.cells || []) {
    const { row, column, colspan, rowspan } = cell;
    if (![row, column, colspan, rowspan].every(Number.isInteger) || row < 0 || column < 0 ||
        colspan < 1 || rowspan < 1 || row + rowspan > rows.length || column + colspan > width ||
        (row < headerRows && row + rowspan > headerRows)) throw new Error('Invalid merged-cell metadata.');
    const key = row * width + column;
    anchors.set(key, cell);
    for (let r = row; r < row + rowspan; r++) {
      for (let c = column; c < column + colspan; c++) {
        const position = r * width + c;
        if (covered.has(position)) throw new Error('Overlapping merged-cell metadata.');
        covered.add(position);
      }
    }
  }
  const renderRow = (row, r) => {
    const output = [];
    for (let c = 0; c < width; c++) {
      const key = r * width + c;
      const cell = anchors.get(key);
      if (!cell && covered.has(key)) continue;
      const heading = cell ? cell.header === true : r < headerRows;
      const tag = heading ? 'th' : 'td';
      const spans = cell ? `${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ''}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''}` : '';
      const style = 'border:1px solid #cfdcd5;padding:8px 10px;text-align:left;vertical-align:top;white-space:pre-wrap;' +
        (heading ? 'font-weight:bold;background-color:#edf4f0;' : 'font-weight:normal;');
      const value = escapeHTML(spreadsheetText(row[c], protectFormulas)).replace(/\r\n|\r|\n/g, '<br>');
      output.push(`<${tag}${spans} style="${style}">${value}</${tag}>`);
    }
    return `<tr>${output.join('')}</tr>`;
  };
  return '<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:12px;">' +
    `<thead>${rows.slice(0, headerRows).map((row, r) => renderRow(row, r)).join('')}</thead>` +
    `<tbody>${rows.slice(headerRows).map((row, r) => renderRow(row, r + headerRows)).join('')}</tbody></table>`;
}
