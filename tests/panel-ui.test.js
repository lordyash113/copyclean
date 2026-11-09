import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanel, settle } from './harness.js';

test('panel controls expose labels, descriptions, a primary Copy Table action, and a named preview', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  const document = panel.popup.window.document;
  for (const id of ['table-select', 'format', 'protect']) {
    assert.ok(document.querySelector(`label[for="${id}"]`));
    const descriptions = panel.$(id).getAttribute('aria-describedby').split(' ');
    assert.ok(descriptions.every(description => document.getElementById(description)));
  }
  assert.equal(panel.$('copy-label').textContent, 'Copy Table');
  assert.equal(panel.$('format').value, 'csv');
  assert.equal(panel.$('action-summary').textContent, 'CSV · all extracted rows');
  assert.equal(panel.$('download').classList.contains('secondary'), true);
  assert.equal(panel.$('restart').getAttribute('aria-label'), 'Restart CopyClean');
  assert.equal(panel.$('preview').getAttribute('tabindex'), '0');
  assert.equal(panel.$('preview').querySelector('table').getAttribute('aria-label'), 'Table 1 preview');
  assert.match(panel.$('scan-announcement').textContent, /1 table detected/);
  assert.equal(panel.$('scan-announcement').getAttribute('aria-live'), 'polite');
});

test('action context follows the selected format without resetting preferences during a restart', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.$('format').value = 'json';
  panel.$('format').dispatchEvent(new panel.popup.window.Event('change'));
  assert.equal(panel.$('action-summary').textContent, 'JSON · all extracted rows');
  assert.equal(panel.$('download').title, 'Download as JSON');
  await panel.click('restart');
  assert.equal(panel.$('action-summary').textContent, 'JSON · all extracted rows');
  assert.equal(panel.$('format').value, 'json');
});

test('loading, empty, and protected-page states have matching visual and accessible feedback', async t => {
  const panel = await createPanel({ tabStatus: 'loading' });
  t.after(panel.close);
  assert.equal(panel.$('preview').dataset.state, 'loading');
  assert.equal(panel.$('preview').getAttribute('aria-busy'), 'true');
  assert.match(panel.$('scan-announcement').textContent, /Waiting/);
  panel.state.tabStatus = 'complete';
  panel.page.window.document.body.replaceChildren();
  panel.notify({ reason: 'complete' });
  await settle();
  assert.equal(panel.$('preview').dataset.state, 'empty');
  assert.equal(panel.$('preview').getAttribute('aria-busy'), 'false');
  assert.equal(panel.$('copy').disabled, true);
  panel.state.url = 'chrome://extensions';
  panel.notify({ reason: 'toolbar' });
  await settle();
  assert.equal(panel.$('preview').dataset.state, 'error');
  assert.equal(panel.$('feedback').dataset.tone, 'error');
  assert.equal(panel.$('feedback-title').textContent, 'Protected page');
  assert.equal(panel.$('feedback').dataset.active, 'true');
  assert.match(panel.$('status').textContent, /regular HTTP or HTTPS/);
});

test('copy progress prevents repeated writes and recovers after success or permission failure', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  let release;
  let writes = 0;
  panel.state.richCopyWrite = () => {
    writes++;
    return new Promise(resolve => { release = resolve; });
  };
  panel.$('copy').click();
  assert.equal(panel.$('copy-label').textContent, 'Copying…');
  assert.equal(panel.$('copy').getAttribute('aria-busy'), 'true');
  assert.equal(panel.$('copy').disabled, true);
  panel.$('copy').dispatchEvent(new panel.popup.window.Event('click'));
  assert.equal(writes, 1);
  release();
  await settle();
  assert.equal(panel.$('copy-label').textContent, 'Copy Table');
  assert.equal(panel.$('copy').disabled, false);
  assert.equal(panel.$('feedback').dataset.tone, 'success');
  assert.equal(panel.$('feedback-title').textContent, 'Copied to clipboard');
  panel.state.richCopyWrite = null;
  panel.state.clipboardError = new Error('Permission denied');
  await panel.click('copy');
  assert.equal(panel.$('copy').disabled, false);
  assert.equal(panel.$('feedback').dataset.tone, 'error');
  assert.equal(panel.$('feedback-title').textContent, 'Copy failed');
});

test('unsupported rich copy shows an accessible warning rather than a permission error', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  panel.$('format').value = 'formatted';
  panel.popup.window.ClipboardItem = undefined;
  await panel.click('copy');
  assert.equal(panel.$('feedback').dataset.tone, 'warning');
  assert.equal(panel.$('feedback-title').textContent, 'Copied as plain text');
  assert.equal(panel.$('status').dataset.error, 'false');
  assert.match(panel.$('status').textContent, /copied TSV/);
});

test('light and dark theme tokens meet text and control-boundary contrast targets', () => {
  const css = readFileSync(new URL('../popup.css', import.meta.url), 'utf8');
  const blocks = [...css.matchAll(/:root(?:\[data-theme="dark"\])?\s*\{([^}]+)\}/g)];
  assert.equal(blocks.length, 2);
  const luminance = hex => {
    const values = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  };
  const contrast = (a, b) => {
    const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
  };
  for (const [index, block] of blocks.entries()) {
    const tokens = Object.fromEntries([...block[1].matchAll(/--([a-z-]+):\s*(#[a-f0-9]{6})\s*;/gi)].map(match => [match[1], match[2]]));
    for (const [foreground, background] of [['text', 'surface'], ['muted', 'surface'], ['muted', 'page'], ['accent', 'tint'], ['on-accent', 'accent'], ['error', 'error-bg'], ['warning', 'warning-bg']]) {
      assert.ok(contrast(tokens[foreground], tokens[background]) >= 4.5, `${index ? 'dark' : 'light'} ${foreground}/${background}`);
    }
    assert.ok(contrast(tokens['control-border'], tokens.surface) >= 3, 'Control boundary contrast');
  }
});

test('theme toggle sits beside restart, saves the preference, and survives CopyClean restart', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  const toggle = panel.$('theme-toggle');
  assert.equal(toggle.nextElementSibling, panel.$('restart'));
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  await panel.click('theme-toggle');
  assert.equal(panel.popup.window.document.documentElement.dataset.theme, 'dark');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.title, 'Switch to light mode');
  assert.equal(panel.popup.window.localStorage.getItem('copyclean.theme'), 'dark');
  await panel.click('restart');
  assert.equal(panel.popup.window.document.documentElement.dataset.theme, 'dark');
  await panel.click('theme-toggle');
  assert.equal(panel.popup.window.document.documentElement.dataset.theme, 'light');
  assert.equal(panel.popup.window.localStorage.getItem('copyclean.theme'), 'light');
});

test('success feedback expires after three seconds and clears timers on replacement and pagehide', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  const timers = new Map();
  let next = 0;
  panel.popup.window.setTimeout = (callback, delay) => { timers.set(++next, { callback, delay }); return next; };
  panel.popup.window.clearTimeout = id => timers.delete(id);
  await panel.click('copy');
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 3000);
  assert.equal(panel.$('feedback').tabIndex, -1);
  assert.equal(panel.popup.window.document.activeElement, panel.popup.window.document.body);
  const expire = [...timers.values()][0].callback;
  expire();
  assert.equal(panel.$('feedback').dataset.active, 'false');
  assert.equal(timers.size, 0);
  await panel.click('copy');
  panel.state.clipboardError = new Error('Denied');
  await panel.click('copy');
  assert.equal(timers.size, 0);
  assert.equal(panel.$('feedback').dataset.tone, 'error');
  panel.state.clipboardError = null;
  await panel.click('copy');
  panel.popup.window.dispatchEvent(new panel.popup.window.Event('pagehide'));
  assert.equal(timers.size, 0);
});

test('horizontal hint follows preview overflow and hides when the panel widens', async t => {
  const panel = await createPanel();
  t.after(panel.close);
  const preview = panel.$('preview');
  Object.defineProperty(preview, 'scrollWidth', { configurable: true, value: 600 });
  Object.defineProperty(preview, 'clientWidth', { configurable: true, value: 240 });
  panel.popup.window.dispatchEvent(new panel.popup.window.Event('resize'));
  assert.equal(panel.$('scroll-hint').hidden, false);
  Object.defineProperty(preview, 'clientWidth', { configurable: true, value: 600 });
  panel.popup.window.dispatchEvent(new panel.popup.window.Event('resize'));
  assert.equal(panel.$('scroll-hint').hidden, true);
});
