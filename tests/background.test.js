import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { settle } from './harness.js';

function worker() {
  const events = {};
  const state = { messages: [], opened: [], errors: [], tab: { id: 7, windowId: 3, status: 'complete', url: 'https://example.com/', active: true } };
  const event = name => ({ addListener: handler => { events[name] = handler; } });
  vm.runInNewContext(readFileSync(new URL('../background.js', import.meta.url), 'utf8'), {
    chrome: {
      sidePanel: { setPanelBehavior: async () => {}, open: async options => { state.opened.push(options); } },
      action: { onClicked: event('action') },
      tabs: { onActivated: event('activated'), onUpdated: event('updated'), query: async options => {
        assert.equal(options.active, true);
        assert.equal(options.windowId, 3);
        return [state.tab];
      } },
      runtime: { sendMessage: async message => {
        if (state.closed) throw new Error('Could not establish connection. Receiving end does not exist.');
        state.messages.push(message);
      } }
      // Deliberately no scripting API: the worker must never scrape pages.
    },
    console: { error: (...args) => state.errors.push(args) }
  });
  return { state, events };
}

test('manifest grants persistent HTTP(S) access without redundant permissions or declarative scripts', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.permissions, ['scripting', 'clipboardWrite', 'sidePanel']);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.action.default_popup, undefined);
});

test('worker notifies activation, navigation loading, and completed active-tab updates', async () => {
  const { state, events } = worker();
  events.activated({ tabId: 7, windowId: 3 });
  assert.equal(state.messages.at(-1).reason, 'activated');
  state.tab.status = 'loading';
  events.updated(7, { status: 'loading', url: 'https://example.com/next' }, state.tab);
  await settle();
  assert.equal(state.messages.at(-1).phase, 'loading');
  state.tab.status = 'complete';
  events.updated(7, { status: 'complete' }, state.tab);
  await settle();
  assert.equal(state.messages.at(-1).phase, 'scan');
  assert.equal(state.messages.at(-1).tabId, 7);
  assert.equal(state.messages.at(-1).windowId, 3);
});

test('worker ignores inactive tabs, unrelated updates, and outdated completion events', async () => {
  const { state, events } = worker();
  events.updated(8, { status: 'complete' }, { ...state.tab, id: 8, active: false });
  events.updated(7, { title: 'New title' }, state.tab);
  events.updated(8, { status: 'complete' }, { ...state.tab, id: 8 });
  await settle();
  assert.equal(state.messages.length, 0);
});

test('worker handles URL-only navigation and toolbar opens without scraping', async () => {
  const { state, events } = worker();
  events.updated(7, { url: 'https://example.com/push-state' }, state.tab);
  await settle();
  assert.equal(state.messages[0].phase, 'loading');
  assert.equal(state.messages[1].phase, 'scan');
  events.action(state.tab);
  await settle();
  assert.equal(state.opened[0].windowId, 3);
  assert.equal(state.messages.at(-1).reason, 'toolbar');
});

test('closed panel is harmless and worker performs no content extraction', async () => {
  const { state, events } = worker();
  state.closed = true;
  events.activated({ tabId: 7, windowId: 3 });
  events.updated(7, { status: 'complete' }, state.tab);
  await settle();
  assert.equal(state.messages.length, 0);
  assert.equal(state.errors.length, 0);
});
