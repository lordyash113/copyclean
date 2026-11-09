// Adapter contract: { tables: [{ name, rows: string[][], header: boolean,
//   cells?: { row, column, colspan, rowspan, header }[], headerRowCount?: number }], warnings: string[] }.
// Future adapters can return this same shape without changing the popup or exporters.
(() => {
  const MAX_CELLS = 200000;
  const MAX_TEXT = 5000000;
  // Bound aggregate output and synchronous work, including rejected tables.
  const MAX_TABLES = 100;
  const MAX_COLUMNS = 1000;
  const started = Date.now();
  let pageCells = 0;
  let pageText = 0;
  let work = 0;
  let exhausted = false;
  const budget = () => {
    if (++work > 1000000 || (work % 256 === 0 && Date.now() - started > 1500)) {
      exhausted = true;
      throw new Error('Page extraction stopped at its work/time safety limit; some tables may be omitted.');
    }
  };
  const warnings = [];
  const tables = [];
  const text = (cell) => {
    // Read text without cloning elements: cloning can construct custom elements
    // or create image/resource nodes even when the clone is never attached.
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        budget();
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        const tag = node.nodeName.toUpperCase();
        if (['TABLE', 'SCRIPT', 'STYLE', 'TEMPLATE'].includes(tag)) return NodeFilter.FILTER_REJECT;
        return tag === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    const pieces = [];
    let length = 0;
    let node;
    while ((node = walker.nextNode())) {
      budget();
      const value = node.nodeType === Node.TEXT_NODE ? node.nodeValue : '\n';
      length += value.length;
      if (length > MAX_TEXT) throw new Error('Table exceeds the 5,000,000-character text safety limit.');
      pieces.push(value);
    }
    return pieces.join('').replace(/\u00a0/g, ' ').trim();
  };
  for (const [index, table] of document.querySelectorAll('table').entries()) {
    if (index >= MAX_TABLES) { warnings.push('Page exceeds the 100-table safety limit; additional tables were omitted.'); break; }
    try {
      budget();
      if (table.rows.length > MAX_CELLS) throw new Error('Table exceeds the 200,000-row safety limit.');
      const sourceRows = Array.from(table.rows).filter(row => { budget(); return row.closest('table') === table; });
      if (sourceRows.length > MAX_CELLS) throw new Error('Table exceeds the 200,000-row safety limit.');
      const grid = sourceRows.map(() => []);
      const cells = [];
      const groupEnds = new Array(sourceRows.length);
      for (let r = sourceRows.length - 1; r >= 0; r--) {
        groupEnds[r] = sourceRows[r + 1]?.parentElement === sourceRows[r].parentElement ? groupEnds[r + 1] : r + 1;
      }
      let allocated = 0;
      let textSize = 0;
      let width = 0;
      sourceRows.forEach((row, r) => {
        budget();
        let c = 0;
        if (row.cells.length > MAX_COLUMNS) throw new Error('Table exceeds the 1,000-column safety limit.');
        Array.from(row.cells).forEach(cell => {
          budget();
          while (grid[r][c] !== undefined) { budget(); c++; }
          const colspan = Math.max(1, cell.colSpan);
          if (c + colspan > MAX_COLUMNS) throw new Error('Table exceeds the 1,000-column safety limit.');
          // rowspan=0 extends through the current row group, not the whole table.
          const groupEnd = groupEnds[r];
          const rowspan = cell.rowSpan === 0 ? groupEnd - r : Math.min(Math.max(1, cell.rowSpan), groupEnd - r);
          if (c + colspan > MAX_CELLS || allocated + rowspan * colspan > MAX_CELLS) {
            throw new Error('Table exceeds the 200,000-cell safety limit.');
          }
          const value = text(cell);
          textSize += value.length * rowspan * colspan;
          pageText += value.length * rowspan * colspan;
          if (pageText > 10000000 || pageCells + rowspan * colspan > 400000) {
            exhausted = true;
            throw new Error('Page exceeds the aggregate cell/text safety limit; some tables may be omitted.');
          }
          if (textSize > MAX_TEXT) throw new Error('Table exceeds the 5,000,000-character expanded text safety limit.');
          cells.push({ row: r, column: c, colspan, rowspan, header: cell.tagName === 'TH' });
          for (let y = r; y < r + rowspan; y++) {
            for (let x = c; x < c + colspan; x++) {
              budget();
              if (grid[y][x] !== undefined) throw new Error('Table contains overlapping merged cells.');
              grid[y][x] = value;
              allocated++;
              pageCells++;
            }
          }
          c += colspan;
          width = Math.max(width, c);
        });
      });
      if (width * grid.length > MAX_CELLS) throw new Error('Table exceeds the 200,000-cell safety limit.');
      const padding = width * grid.length - allocated;
      pageCells += padding;
      if (pageCells > 400000) { exhausted = true; throw new Error('Page exceeds the aggregate cell safety limit; some tables may be omitted.'); }
      const rows = grid.map(row => Array.from({ length: width }, (_, c) => row[c] ?? ''));
      let headerRowCount = 0;
      while (sourceRows[headerRowCount]?.parentElement.tagName === 'THEAD') headerRowCount++;
      if (!headerRowCount) {
        while (sourceRows[headerRowCount]?.cells.length &&
          Array.from(sourceRows[headerRowCount].cells).every(cell => cell.tagName === 'TH')) headerRowCount++;
        // Inferred headings cannot split a merge across thead/tbody boundaries.
        if (cells.some(cell => cell.row < headerRowCount && cell.row + cell.rowspan > headerRowCount)) headerRowCount = 0;
      }
      const caption = Array.from(table.children).find(node => node.tagName === 'CAPTION');
      tables.push({
        name: caption?.textContent.trim().slice(0, 120) || `Table ${index + 1}`,
        rows,
        cells,
        headerRowCount,
        header: Boolean(sourceRows[0]?.cells.length && Array.from(sourceRows[0].cells).every(cell => cell.tagName === 'TH'))
      });
    } catch (error) {
      tables.push({ name: `Table ${index + 1}`, rows: [], header: false, error: error.message });
      warnings.push(`Table ${index + 1}: ${error.message}`);
    }
    if (exhausted) break;
  }
  return { tables, warnings };
})();
