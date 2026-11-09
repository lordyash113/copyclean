import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as exporters from '../lib/exporters.js';
import { TableScanner } from '../lib/scanner.js';

const popupHTML = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const popupJS = readFileSync(new URL('../popup.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const extractor = readFileSync(new URL('../content/extract-tables.js', import.meta.url), 'utf8');
const clipboardJS = readFileSync(new URL('../lib/clipboard.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const themeJS = readFileSync(new URL('../theme.js', import.meta.url), 'utf8');
export const sampleHTML = `<table id="customers"><tr><th>Company</th><th>Contact</th><th>Country</th></tr>
<tr><td>Alfreds Futterkiste</td><td>Maria Anders</td><td>Germany</td></tr>
<tr><td>Centro comercial Moctezuma</td><td>Francisco Chang</td><td>Mexico</td></tr>
<tr><td>Ernst Handel</td><td>Roland Mendel</td><td>Austria</td></tr>
<tr><td>Island Trading</td><td>Helen Bennett</td><td>UK</td></tr>
<tr><td>Laughing Bacchus Winecellars</td><td>Yoshi Tannamuri</td><td>Canada</td></tr>
<tr><td>Magazzini Alimentari Riuniti</td><td>Giovanni Rovelli</td><td>Italy</td></tr></table>`;

export async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}
export async function createPanel({ html = sampleHTML, granted = true, url = 'https://www.w3schools.com/html/html_tables.asp', hiddenURL = false, tabStatus = 'complete', visible = true } = {}) {
  const page = new JSDOM(html, { url, runScripts: 'outside-only' });
  const popup = new JSDOM(popupHTML, { url: 'https://copyclean.test/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const events = {};
  const state = { granted, url, tabId: 7, tabStatus, visible, injections: [], copies: [], clipboardWrites: [], downloads: [], blobs: [], revoked: [], listenerCounts: {} };
  Object.defineProperty(popup.window.document, 'hidden', { get: () => !state.visible });
  const event = name => ({ addListener: handler => {
    state.listenerCounts[name] = (state.listenerCounts[name] || 0) + 1;
    events[name] = handler;
  } });
  const chrome = {
    windows: { getCurrent: async () => ({ id: 3 }) },
    tabs: {
      query: async options => {
        if (options.windowId !== 3) throw new Error('Wrong panel window');
        const current = () => !state.tabId ? [] : [{ id: state.tabId, windowId: 3, active: true, status: state.tabStatus, ...(!hiddenURL || state.granted ? { url: state.url } : {}) }];
        return state.query ? state.query(options, current) : current();
      },
      onActivated: event('activated'), onUpdated: event('updated')
    },
    scripting: { executeScript: async options => {
      state.injections.push(options);
      if (!state.granted) throw new Error('Cannot access contents of the page. Extension manifest must request permission to access this host.');
      const extract = () => [{ result: page.window.eval(extractor) }];
      const hook = state.execute;
      return hook ? hook(options, extract) : extract();
    } },
    runtime: { id: 'copyclean-test', onMessage: event('message') }
  };
  Object.assign(popup.window, exporters, { chrome, TableScanner });
  popup.window.Blob = Blob;
  popup.window.ClipboardItem = class {
    constructor(data) { this.data = data; this.types = Object.keys(data); }
    async getType(type) { return this.data[type]; }
  };
  Object.defineProperty(popup.window.navigator, 'clipboard', { value: {
    writeText: async text => {
      if (state.clipboardError) throw state.clipboardError;
      if (state.copyWrite) return state.copyWrite(text);
      state.copies.push(text);
    },
    write: async items => {
      if (state.richClipboardError) throw state.richClipboardError;
      if (state.clipboardError) throw state.clipboardError;
      if (state.richCopyWrite) return state.richCopyWrite(items);
      state.clipboardWrites.push(items);
    }
  } });
  popup.window.URL.createObjectURL = blob => { state.blobs.push(blob); return `blob:test-${state.blobs.length}`; };
  popup.window.URL.revokeObjectURL = url => { state.revoked.push(url); };
  popup.window.HTMLAnchorElement.prototype.click = function () { state.downloads.push(this.download); };
  const $ = id => popup.window.document.getElementById(id);
  popup.window.eval(themeJS);
  popup.window.eval(clipboardJS);
  popup.window.eval(popupJS);
  await settle();
  return { state, $, page, popup, events,
    notify: message => events.message({ type: 'copyclean:page-changed', windowId: 3, tabId: state.tabId, phase: 'scan', reason: 'complete', ...message }, { id: chrome.runtime.id }),
    visibility: value => {
      state.visible = value;
      popup.window.document.dispatchEvent(new popup.window.Event('visibilitychange'));
    },
    click: async id => {
      $(id).click();
      await settle();
    },
    close: () => { popup.window.close(); page.window.close(); }
  };
}
