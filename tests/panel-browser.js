// Real Chrome rendering checks with simulated extension APIs. No clipboard is
// accessed and no existing browser profile is opened. Screenshots stay local.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const routes = new Map(['popup.html', 'popup.js', 'popup.css', 'theme.js', 'lib/scanner.js', 'lib/exporters.js', 'lib/clipboard.js', 'lib/page-access.js']
  .map(path => [`/${path}`, new URL(`../${path}`, import.meta.url)]));
const data = { name: 'Quarterly inventory', header: true, headerRowCount: 1, rows: [
  ['Product', 'Category', 'Revenue', 'Stock'], ['Arc desk lamp', 'Lighting', '$12,480', '24'],
  ['Contour chair', 'Furniture', '$34,200', '18'], ['Studio notebook', 'Stationery', '$4,650', '120'],
  ['Oak monitor stand', 'Accessories', '$8,940', '42'], ['Linen desk mat', 'Accessories', '$5,320', '64']
] };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const file = routes.get(url.pathname);
  if (!file) { response.writeHead(404).end(); return; }
  let body = await readFile(file, 'utf8');
  if (url.pathname === '/popup.html') {
    const scenario = url.searchParams.get('scenario') || 'data';
    const mock = `const scenario = ${JSON.stringify(scenario)};
      window.chrome = {
        windows: { getCurrent: async () => ({id: 1}) },
        tabs: { query: async () => [{id: 2, windowId: 1, active: true, status: scenario === 'loading' ? 'loading' : 'complete', url: scenario === 'error' ? 'chrome://extensions' : 'https://example.com/inventory'}] },
        scripting: { executeScript: async options => [{result: {tables: scenario === 'empty' ? [] : [${JSON.stringify(data)}], warnings: []}}] },
        runtime: {id: 'copyclean-render-fixture', onMessage: {addListener: () => {}}}
      };
      Object.defineProperty(navigator, 'clipboard', {value: {write: async () => {}, writeText: async () => {}}, configurable: true});`;
    body = body.replace('<script type="module"', `<script>${mock}</script><script type="module"`);
  }
  response.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html;charset=utf-8');
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(join(tmpdir(), 'copyclean-panel-'));
const artifacts = fileURLToPath(new URL('../.test-artifacts/panel/', import.meta.url));
await mkdir(artifacts, { recursive: true });
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking', '--disable-sync', 'about:blank'
], { windowsHide: true, stdio: 'ignore' });
let socket;
const pending = new Map();
try {
  let port;
  for (let i = 0; i < 150; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, 'Chrome did not expose its test debugging endpoint.');
  const browser = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  socket = new WebSocket(browser.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  let sequence = 0;
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
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  const cases = [
    ...[280, 320, 400].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme, scenario: 'data' }))),
    ...['error', 'empty', 'loading'].flatMap(scenario => ['light', 'dark'].map(theme => ({ width: 320, theme, scenario }))),
    ...['light', 'dark'].map(theme => ({ width: 320, theme, scenario: 'data', height: 600 }))
  ];
  for (const { width, theme, scenario, height = 900 } of cases) {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/popup.html?scenario=${scenario}` }, sessionId);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await evaluate(`document.querySelector('main')?.dataset.phase === ${JSON.stringify(scenario === 'data' || scenario === 'empty' ? 'ready' : scenario)}`);
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(ready, `${theme}/${width}/${scenario} did not render.`);
    const result = await evaluate(`(() => {
      const preview = document.getElementById('preview');
      return {overflow: document.documentElement.scrollWidth > innerWidth, scheme: getComputedStyle(document.documentElement).colorScheme,
        state: preview.dataset.state, copyDisabled: document.getElementById('copy').disabled,
        animation: getComputedStyle(document.querySelector('.dot')).animationName,
        bodyHeight: document.documentElement.scrollHeight, copyBottom: document.getElementById('copy').getBoundingClientRect().bottom};
    })()`);
    assert.equal(result.overflow, false, `Page overflow: ${theme}/${width}/${scenario}`);
    assert.equal(result.scheme, theme);
    assert.equal(result.state, scenario === 'data' ? 'ready' : scenario);
    assert.equal(result.copyDisabled, scenario !== 'data');
    if (scenario === 'data') assert.ok(result.copyBottom <= height, 'Primary action must remain inside the viewport.');
    assert.equal(result.animation, 'none');
    const { data: screenshot } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
    await writeFile(join(artifacts, `${theme}-${width}-${scenario}${height !== 900 ? '-short' : ''}.png`), Buffer.from(screenshot, 'base64'));
    if (scenario === 'data') console.log(`${theme} ${width}px: no page overflow; Copy Table bottom ${Math.round(result.copyBottom)}px; screenshot saved.`);
  }
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId);
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId);
  const focus = await evaluate(`({id: document.activeElement.id, outline: getComputedStyle(document.activeElement).outlineWidth})`);
  assert.equal(focus.id, 'theme-toggle');
  assert.equal(focus.outline, '3px');
  for (const id of ['restart', 'table-select', 'preview', 'format', 'protect', 'copy', 'download']) {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId);
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, sessionId);
    const target = await evaluate(`(() => { const element = document.activeElement; const rect = element.getBoundingClientRect(); return {id: element.id, top: rect.top, bottom: rect.bottom, dockTop: document.querySelector('.action-bar').getBoundingClientRect().top, viewport: innerHeight}; })()`);
    assert.equal(target.id, id, `Keyboard order: expected ${id}`);
    assert.ok(target.top >= 0, `${id} focus is above the viewport`);
    assert.ok(target.bottom <= (['copy', 'download'].includes(id) ? target.viewport : target.dockTop), `${id} focus is obscured by the action bar`);
  }
  const originalTheme = await evaluate('document.documentElement.dataset.theme');
  await evaluate('document.getElementById("theme-toggle").click()');
  const chosenTheme = originalTheme === 'dark' ? 'light' : 'dark';
  assert.equal(await evaluate('getComputedStyle(document.documentElement).colorScheme'), chosenTheme);
  await command('Page.reload', {}, sessionId);
  for (let i = 0; i < 100; i++) {
    if (await evaluate('document.querySelector("main")?.dataset.phase === "ready"')) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(await evaluate('document.documentElement.dataset.theme'), chosenTheme);
  assert.equal(await evaluate('localStorage.getItem("copyclean.theme")'), chosenTheme);
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  const forced = await evaluate(`({active: matchMedia('(forced-colors: active)').matches, border: getComputedStyle(document.getElementById('copy')).borderStyle})`);
  assert.equal(forced.active, true);
  assert.equal(forced.border, 'solid');
  console.log(`${browser.Browser}: ${cases.length} light/dark responsive/state rendering cases plus keyboard focus passed. Chrome APIs were simulated; installed-extension UI was not tested.`);
  console.log(`Screenshots: ${artifacts}`);
} finally {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser test closed.')); }
  if (socket) socket.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
