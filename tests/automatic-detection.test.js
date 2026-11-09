import test from 'node:test';
import assert from 'node:assert/strict';
import { accessFailure, restrictedPage } from '../lib/page-access.js';
import { createPanel, settle } from './harness.js';

test('direct panel open scans immediately and renders a five-row preview', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  assert.equal(panel.$('count').textContent, '1 table detected');
  assert.equal(panel.$('preview').querySelectorAll('tr').length, 5);
  assert.equal(panel.$('dimensions').textContent, '7 rows · 3 columns');
  assert.equal(panel.$('copy').disabled, false);
  assert.equal(panel.state.injections.length, 1);
  assert.equal(panel.state.injections[0].files[0], 'content/extract-tables.js');
  assert.equal(panel.state.injections[0].target.tabId, 7);
  assert.equal(panel.popup.window.document.querySelector('main').getAttribute('aria-busy'), 'false');
});

test('switching websites updates table list and preview without refresh', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.state.tabId = 8;
  panel.state.url = 'https://example.com/';
  panel.page.window.document.body.innerHTML = '<table><caption>Next website</caption><tr><td>New data</td></tr></table>';
  panel.notify({ reason: 'activated' });
  await settle();
  assert.equal(panel.state.injections.at(-1).target.tabId, 8);
  assert.match(panel.$('table-select').textContent, /Next website/);
  assert.equal(panel.$('preview').textContent, 'New data');
});

test('navigation disables stale exports, waits for complete, and rescans the same URL', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.state.tabStatus = 'loading';
  panel.notify({ phase: 'loading' });
  await settle();
  assert.equal(panel.$('copy').disabled, true);
  assert.equal(panel.$('download').disabled, true);
  assert.match(panel.$('preview').textContent, /Waiting/);
  assert.equal(panel.popup.window.document.querySelector('main').getAttribute('aria-busy'), 'true');
  assert.equal(panel.state.injections.length, 1);
  panel.state.tabStatus = 'complete';
  panel.page.window.document.querySelector('td').textContent = 'Reloaded data';
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.state.injections.length, 2);
  assert.match(panel.$('preview').textContent, /Reloaded data/);
  assert.equal(panel.$('copy').disabled, false);
});

test('opening during navigation waits for completion instead of injecting early', async t => {
  const panel = await createPanel({ tabStatus: 'loading' });
  t.after(panel.close);
  assert.equal(panel.state.injections.length, 0);
  assert.match(panel.$('preview').textContent, /Waiting/);
  panel.state.tabStatus = 'complete';
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.state.injections.length, 1);
});

test('a loading protected page waits for completion without injection or retry polling', async t => {
  const panel = await createPanel({ url: 'chrome://extensions', tabStatus: 'loading' });
  t.after(panel.close);
  assert.equal(panel.state.injections.length, 0);
  assert.match(panel.$('preview').textContent, /Waiting/);
  panel.state.tabStatus = 'complete';
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.$('count').textContent, 'Protected page');
  assert.equal(panel.state.injections.length, 0);
});

test('late extraction results from a previous tab never replace current results', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  let release;
  panel.state.execute = (_options, extract) => {
    const snapshot = extract();
    return new Promise(resolve => { release = () => resolve(snapshot); });
  };
  panel.$('restart').click();
  await settle();
  assert.equal(panel.$('copy').disabled, true);
  panel.state.execute = null;
  panel.state.tabId = 8;
  panel.state.url = 'https://example.com/';
  panel.page.window.document.body.innerHTML = '<table><tr><td>Current tab</td></tr></table>';
  panel.notify({ reason: 'activated' });
  await settle();
  assert.equal(panel.$('preview').textContent, 'Current tab');
  release();
  await settle();
  assert.equal(panel.$('preview').textContent, 'Current tab');
});

test('duplicate notifications share one in-flight injection and completed automatic scans', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  let release;
  panel.state.execute = (_options, extract) => new Promise(resolve => { release = () => resolve(extract()); });
  panel.$('restart').click();
  await settle();
  const count = panel.state.injections.length;
  panel.notify({ reason: 'toolbar' });
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.state.injections.length, count);
  release();
  await settle();
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.state.injections.length, count);
  assert.equal(panel.$('copy').disabled, false);
});

test('post-injection tab identity check catches a switch before its notification arrives', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  let release;
  panel.state.execute = (_options, extract) => {
    const oldResult = extract();
    return new Promise(resolve => { release = () => resolve(oldResult); });
  };
  panel.$('restart').click();
  await settle();
  panel.state.execute = null;
  panel.state.tabId = 8;
  panel.state.url = 'https://example.com/changed';
  panel.page.window.document.body.innerHTML = '<table><tr><td>New active tab</td></tr></table>';
  release(); // No activation message delivered yet.
  await settle();
  assert.equal(panel.$('preview').textContent, 'New active tab');
  assert.equal(panel.state.injections.at(-1).target.tabId, 8);
});

test('same-URL reload ignores the prior document extraction and starts a new injection', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  let release;
  panel.state.execute = (_options, extract) => {
    const oldResult = extract();
    return new Promise(resolve => { release = () => resolve(oldResult); });
  };
  panel.$('restart').click();
  await settle();
  panel.state.tabStatus = 'loading';
  panel.notify({ phase: 'loading' });
  await settle();
  panel.state.execute = null;
  panel.state.tabStatus = 'complete';
  panel.page.window.document.body.innerHTML = '<table><tr><td>New document</td></tr></table>';
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.$('preview').textContent, 'New document');
  release();
  await settle();
  assert.equal(panel.$('preview').textContent, 'New document');
});

test('delayed old-tab and other-window messages cannot clear the current preview', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.notify({ tabId: 99, phase: 'loading' });
  panel.notify({ windowId: 99, phase: 'loading' });
  panel.events.message({ type: 'copyclean:page-changed', tabId: 7, windowId: 3, phase: 'loading' }, { id: 'foreign-extension' });
  panel.events.message({ type: 'copyclean:page-changed', tabId: 7, windowId: 3, phase: 'loading' }, { id: 'copyclean-test', tab: { id: 7 } });
  await settle();
  assert.equal(panel.$('count').textContent, '1 table detected');
  assert.equal(panel.state.injections.length, 1);
});

test('hidden panel never scans and scans the current page when shown again', async t => {
  const panel = await createPanel({ visible: false });
  t.after(panel.close);
  panel.notify({ reason: 'activated' });
  await settle();
  assert.equal(panel.state.injections.length, 0);
  panel.visibility(true);
  await settle();
  assert.equal(panel.state.injections.length, 1);
  panel.visibility(false);
  panel.notify({ reason: 'toolbar' });
  await settle();
  assert.equal(panel.state.injections.length, 1);
});

test('restricted pages skip injection and withheld permission explains Chrome site access', async t => {
  for (const url of ['chrome://extensions', 'https://chromewebstore.google.com/detail/x', 'chrome-extension://abc/viewer.html']) {
    assert.match(restrictedPage(url), /protects/);
    const panel = await createPanel({ url });
    t.after(panel.close);
    assert.equal(panel.state.injections.length, 0);
    assert.equal(panel.$('copy').disabled, true);
    assert.match(panel.$('status').textContent, /protects/);
  }
  const panel = await createPanel({ granted: false, hiddenURL: true });
  t.after(panel.close);
  assert.equal(panel.$('count').textContent, 'Website access blocked');
  assert.match(panel.$('status').textContent, /Site access/);
  assert.equal(panel.$('copy').disabled, true);
  panel.state.granted = true;
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.$('count').textContent, '1 table detected');
  assert.match(accessFailure(new Error('Frame was removed'), {}).message, /navigated/);
});

test('injection failure clears data and a later successful scan recovers', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.state.execute = () => { throw new Error('Unexpected injection failure'); };
  await panel.click('restart');
  assert.equal(panel.$('count').textContent, 'Scan failed');
  assert.match(panel.$('status').textContent, /Unexpected injection failure/);
  assert.equal(panel.$('copy').disabled, true);
  panel.state.execute = null;
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.$('count').textContent, '1 table detected');
  assert.equal(panel.state.injections.length, 3); // A failed restart must not restore a stale cached result.
});

test('all four copy and download formats preserve rows beyond the preview', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  for (const [format, extension] of [['csv', 'csv'], ['json', 'json'], ['markdown', 'md'], ['tsv', 'tsv']]) {
    panel.$('format').value = format;
    await panel.click('copy');
    const result = panel.state.copies.at(-1);
    assert.match(result, /Company/);
    assert.match(result, /Magazzini Alimentari Riuniti/);
    if (format === 'json') assert.equal(JSON.parse(result).length, 7);
    if (format === 'csv') assert.ok(result.startsWith('Company,Contact,Country\r\n'));
    if (format === 'tsv') assert.ok(result.startsWith('Company\tContact\tCountry\r\n'));
    if (format === 'markdown') assert.ok(result.startsWith('| Company | Contact | Country |\n| --- | --- | --- |'));
    await panel.click('download');
    assert.equal(panel.state.downloads.at(-1), `copyclean-table-1.${extension}`);
  }
});
