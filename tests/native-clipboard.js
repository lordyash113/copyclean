// Opt-in Windows integration check. Replaces the OS clipboard with fixture data.
// Uses an isolated Chrome profile and new, unsaved Office documents.
// --native uses an offscreen regular Chrome window to reach the Windows clipboard.
// --spreadsheet checks the spreadsheet payload in headless Chrome, not Excel Online/Sheets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serialize } from '../lib/exporters.js';

if (process.platform !== 'win32') throw new Error('This native paste check requires Windows, Chrome, and Office.');
const spreadsheetOnly = process.argv.includes('--spreadsheet');
if (spreadsheetOnly && process.argv.includes('--native')) throw new Error('Use --spreadsheet by itself; online spreadsheet destinations are not automated by this check.');
const profile = await mkdtemp(join(tmpdir(), 'copyclean-clipboard-'));
const routes = new Map([
  ['/', new URL(spreadsheetOnly ? './spreadsheet-fixture.html' : './clipboard-fixture.html', import.meta.url)],
  ['/lib/clipboard.js', new URL('../lib/clipboard.js', import.meta.url)],
  ['/lib/exporters.js', new URL('../lib/exporters.js', import.meta.url)]
]);
const server = createServer(async (request, response) => {
  const file = routes.get(request.url);
  if (!file) { response.writeHead(404).end(); return; }
  try {
    response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : 'text/html;charset=utf-8');
    response.end(await readFile(file));
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const native = process.argv.includes('--native');
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  ...(native ? ['--window-position=-32000,-32000', '--window-size=800,600'] : ['--headless=new']),
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'
], { windowsHide: true, stdio: 'ignore' });
chrome.on('error', error => { console.error(error.message); });
let socket;
try {
  let port;
  for (let i = 0; i < 150; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, 'Chrome did not expose its isolated debugging endpoint.');
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  await command('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await command('Page.navigate', { url: origin }, sessionId);
  if (native) await command('Page.bringToFront', {}, sessionId);
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  for (let i = 0; i < 100; i++) {
    if (await evaluate('document.querySelectorAll("table").length === 1')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const extractor = await readFile(new URL('../content/extract-tables.js', import.meta.url), 'utf8');
  const table = await evaluate(`(${extractor.trim().replace(/;$/, '')}).tables[0]`);
  await evaluate(`(async () => {
    const { copyTable } = await import('/lib/clipboard.js');
    await copyTable(${JSON.stringify(table)}, 'formatted');
    return true;
  })()`);
  const readback = await evaluate(`(async () => {
    const [item] = await navigator.clipboard.read();
    return { types: item.types, html: await (await item.getType('text/html')).text(), plain: await (await item.getType('text/plain')).text() };
  })()`);
  assert.ok(readback.types.includes('text/html'));
  assert.ok(readback.types.includes('text/plain'));
  const plain = serialize(table, 'tsv');
  const nativeLines = value => value.replace(/\r\n|\r|\n/g, '\r\n');
  // Windows normalizes line endings inside quoted multiline cells as well as
  // record separators. Compare semantic line breaks on both sides.
  assert.equal(nativeLines(readback.plain), nativeLines(plain));
  assert.match(readback.html, /rowspan="2"/);
  assert.match(readback.html, /colspan="2"/);
  assert.ok(readback.html.includes('雪 😀 नमस्ते'), 'HTML clipboard lost Unicode.');
  if (spreadsheetOnly) {
    assert.ok(readback.html.includes('$162,700'), 'HTML clipboard lost salary comma.');
    assert.match(readback.plain, /\t\$162,700\t\t/);
    assert.match(readback.plain, /"He said ""hi"""/);
    assert.match(readback.plain, /"Line 1\r?\nLine 2"/);
    const fallback = await evaluate(`(async () => {
      const { copyTable } = await import('/lib/clipboard.js');
      const original = globalThis.ClipboardItem;
      try {
        globalThis.ClipboardItem = undefined;
        const result = await copyTable(${JSON.stringify(table)}, 'formatted');
        return { result, plain: await navigator.clipboard.readText() };
      } finally { globalThis.ClipboardItem = original; }
    })()`);
    assert.deepEqual(fallback.result, { format: 'tsv', rich: false, fallback: true });
    assert.equal(nativeLines(fallback.plain), nativeLines(plain));
    console.log('Spreadsheet fixture: salary commas, quotes, empty cells, Unicode, multiline TSV, HTML merges, and TSV fallback passed in Chrome Clipboard API readback. Excel Online and Google Sheets were not tested.');
  }
  console.log(`Actual ${native ? 'regular' : 'headless'} Chrome Clipboard API: HTML and TSV write/read passed.`);
  if (native) {
    const expectedPath = join(profile, 'expected.json');
    await writeFile(expectedPath, JSON.stringify({ plain, unicode: '雪 😀 नमस्ते' }));
    const pasteScript = fileURLToPath(new URL('./native-paste.ps1', import.meta.url));
    const report = await new Promise((resolve, reject) => {
      const helper = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', pasteScript, '-ExpectedPath', expectedPath], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      helper.stdout.on('data', chunk => { stdout += chunk; });
      helper.stderr.on('data', chunk => { stderr += chunk; });
      helper.on('error', reject);
      helper.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    });
    console.log(report.trim());
    const parsed = JSON.parse(report);
    for (const name of ['plainTextControl', 'excel', 'word']) assert.equal(parsed[name].passed, true, `${name}: ${parsed[name].error || 'Paste check failed'}`);
  } else {
    console.log('Skipped Windows paste targets: headless Chrome can use an isolated clipboard. Use --native for the OS clipboard and native paste checks.');
  }
  console.log('The Chrome test used the actual extraction/export/clipboard modules on a localhost fixture, not the installed extension UI.');
  console.log(`Isolated test profile: ${profile}`);
} finally {
  if (socket) socket.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
