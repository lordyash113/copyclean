import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanel, settle } from './harness.js';

test('restart uses the existing header position and preserves export preferences', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  const button = panel.$('restart');
  assert.equal(button.parentElement.tagName, 'HEADER');
  assert.equal(button.title, 'Restart CopyClean');
  assert.equal(button.getAttribute('aria-label'), 'Restart CopyClean');
  assert.equal(button.textContent, '↻');
  panel.$('format').value = 'json';
  panel.$('protect').checked = false;
  panel.popup.window.localStorage.setItem('saved-example', 'keep me');
  panel.$('format').dispatchEvent(new panel.popup.window.Event('change'));
  const hint = panel.$('format-hint').textContent;
  panel.page.window.document.querySelector('td').textContent = 'Fresh table data';
  await panel.click('restart');
  assert.equal(panel.$('format').value, 'json');
  assert.equal(panel.$('protect').checked, false);
  assert.equal(panel.$('protect').disabled, true);
  assert.equal(panel.$('format-hint').textContent, hint);
  assert.equal(panel.popup.window.localStorage.getItem('saved-example'), 'keep me');
  assert.match(panel.$('preview').textContent, /Fresh table data/);
  assert.match(panel.$('status').textContent, /CopyClean restarted/);
  assert.equal(panel.$('restart').disabled, false);
  await panel.click('copy');
  assert.equal(JSON.parse(panel.state.copies.at(-1))[1][0], 'Fresh table data');
});

test('restart clears old errors and tables immediately and rejects repeated clicks', async t => {
  const panel = await createPanel({ granted: false });
  t.after(panel.close);
  assert.equal(panel.$('status').dataset.error, 'true');
  panel.state.granted = true;
  let release;
  panel.state.execute = (_options, extract) => new Promise(resolve => { release = () => resolve(extract()); });
  panel.$('restart').click();
  assert.equal(panel.$('count').textContent, 'Restarting CopyClean...');
  assert.equal(panel.$('status').textContent, 'Restarting CopyClean...');
  assert.equal(panel.$('status').dataset.error, 'false');
  assert.equal(panel.$('copy').disabled, true);
  assert.equal(panel.$('download').disabled, true);
  assert.equal(panel.$('restart').disabled, true);
  assert.equal(panel.$('preview').querySelectorAll('table').length, 0);
  await settle();
  const count = panel.state.injections.length;
  panel.$('restart').click();
  panel.$('restart').dispatchEvent(new panel.popup.window.Event('click'));
  await settle();
  assert.equal(panel.state.injections.length, count);
  release();
  await settle();
  assert.equal(panel.$('copy').disabled, false);
  assert.equal(panel.$('restart').disabled, false);
  assert.match(panel.$('status').textContent, /CopyClean restarted/);
});

test('restart can recover a pending scan and its stale response cannot overwrite new data', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  let release;
  panel.state.execute = (_options, extract) => {
    const snapshot = extract();
    return new Promise(resolve => { release = () => resolve(snapshot); });
  };
  panel.notify({ reason: 'toolbar' });
  await settle();
  assert.equal(panel.$('restart').disabled, false); // Available during ordinary loading.
  panel.state.execute = null;
  panel.page.window.document.body.innerHTML = '<table><tr><td>Restarted data</td></tr></table>';
  await panel.click('restart');
  assert.equal(panel.$('preview').textContent, 'Restarted data');
  const success = panel.$('status').textContent;
  release();
  await settle();
  assert.equal(panel.$('preview').textContent, 'Restarted data');
  assert.equal(panel.$('status').textContent, success);
});

test('failed restart unlocks recovery and repeated restarts do not duplicate listeners', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  const listener = panel.events.message;
  panel.state.execute = () => { throw new Error('Injection unavailable'); };
  await panel.click('restart');
  assert.match(panel.$('status').textContent, /Restart failed.*Injection unavailable/);
  assert.equal(panel.$('restart').disabled, false);
  assert.equal(panel.popup.window.document.querySelector('main').getAttribute('aria-busy'), 'false');
  panel.state.execute = null;
  await panel.click('restart');
  await panel.click('restart');
  assert.equal(panel.events.message, listener);
  const count = panel.state.injections.length;
  panel.state.tabId = 8;
  panel.state.url = 'https://example.com/next';
  panel.notify({ reason: 'activated' });
  await settle();
  assert.equal(panel.state.injections.length, count + 1);
  panel.state.tabStatus = 'loading';
  panel.notify({ phase: 'loading' });
  await settle();
  panel.state.tabStatus = 'complete';
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.state.injections.length, count + 2);
});

test('restart during page loading completes after navigation and reports empty-table success', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.state.tabStatus = 'loading';
  await panel.click('restart');
  assert.equal(panel.$('status').textContent, 'Restarting CopyClean...');
  assert.equal(panel.$('restart').disabled, true);
  panel.page.window.document.body.replaceChildren();
  panel.state.tabStatus = 'complete';
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.$('count').textContent, '0 tables detected');
  assert.match(panel.$('status').textContent, /CopyClean restarted. 0 tables/);
  assert.equal(panel.$('restart').disabled, false);
});

test('restart timeout unlocks the panel and invalidates the timed-out extraction', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  let expire;
  let release;
  panel.popup.window.setTimeout = (callback, delay) => {
    if (delay === 3000) return 124;
    assert.equal(delay, 20000);
    expire = callback;
    return 123;
  };
  panel.state.execute = (_options, extract) => new Promise(resolve => { release = () => resolve(extract()); });
  await panel.click('restart');
  expire();
  assert.match(panel.$('status').textContent, /Restart failed.*timed out/);
  assert.equal(panel.$('restart').disabled, false);
  release();
  await settle();
  assert.match(panel.$('status').textContent, /timed out/);
  assert.equal(panel.$('copy').disabled, true);
  panel.state.execute = null;
  await panel.click('restart');
  assert.match(panel.$('status').textContent, /CopyClean restarted/);
});
