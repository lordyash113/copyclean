import { restrictedPage, accessFailure } from './page-access.js';

// Event-driven, panel-owned scanning. Identical in-flight scans share one
// injection; a navigation starts a new epoch, even when the URL is unchanged.
export class TableScanner {
  constructor({ scripting, readTab, onState, isVisible }) {
    Object.assign(this, { scripting, readTab, onState, isVisible });
    this.requestId = 0;
    this.epoch = 0;
    this.inFlight = new Map();
    this.pendingAdapters = new Set();
    this.cached = null;
  }

  reset() {
    this.requestId++;
    this.epoch++;
    this.cached = null;
    for (const adapter of this.pendingAdapters) adapter.cancel();
    // executeScript cannot be aborted, but old requests can no longer publish
    // results or be reused by a scan after this reset.
    this.inFlight.clear();
  }

  invalidate() {
    this.reset();
    this.onState({ phase: 'loading', message: 'Waiting for the page to finish loading…' });
  }

  async scan({ force = true, discardCache = false } = {}) {
    if (!this.isVisible()) return;
    if (force || discardCache) this.cached = null;
    const requestId = ++this.requestId;
    const isCurrent = () => requestId === this.requestId && this.isVisible();
    this.onState({ phase: 'loading', message: 'Looking for HTML tables…' });
    let tab;
    try {
      tab = await this.readTab();
      if (!isCurrent()) return;
      if (!Number.isInteger(tab?.id) || tab.id < 0) throw new Error('No active tab is available.');
      if (tab.status === 'loading') {
        this.onState({ phase: 'loading', message: 'Waiting for the page to finish loading…' });
        return; // The worker will notify us at status=complete.
      }
      const restricted = restrictedPage(tab.url);
      if (restricted) throw new Error(restricted);
      const key = JSON.stringify([this.epoch, tab.id, tab.url]);
      let results;
      if (!force && this.cached?.key === key) {
        results = this.cached.results;
      } else {
        let flight = this.inFlight.get(key);
        if (!flight) {
          flight = this.extract(tab.id).finally(() => this.inFlight.delete(key));
          this.inFlight.set(key, flight);
        }
        results = await flight;
      }
      if (!isCurrent()) return;
      // Recheck identity after injection, even if a tab event is still queued.
      const current = await this.readTab();
      if (!isCurrent()) return;
      if (current?.id !== tab.id || current?.url !== tab.url || current?.status === 'loading') {
        this.invalidate();
        void this.scan({ force: false });
        return;
      }
      const result = results[0]?.result;
      if (!result || !Array.isArray(result.tables)) throw new Error('The content script returned no table data.');
      this.cached = { key, results };
      this.onState({ phase: 'ready', tabId: tab.id, requestId, tables: result.tables, warnings: result.warnings || [] });
    } catch (error) {
      if (!isCurrent()) return;
      if (tab) {
        try {
          const current = await this.readTab();
          if (!isCurrent()) return;
          if (current?.id !== tab.id || current?.url !== tab.url) {
            this.invalidate();
            void this.scan({ force: false });
            return;
          }
          if (current?.status === 'loading') {
            this.invalidate();
            return; // Wait for the worker's completion event, without retry polling.
          }
        } catch {
          // Preserve the original injection failure if the tab query also fails.
          if (!isCurrent()) return;
        }
      }
      this.onState({ phase: 'error', tabId: tab?.id, requestId, ...accessFailure(error, tab) });
    }
  }

  async extract(tabId) {
    const results = await this.executeAdapter(tabId, 'content/extract-tables.js');
    const result = results[0]?.result;
    if (!result || !Array.isArray(result.tables)) throw new Error('The HTML adapter returned no table data.');
    return results;
  }

  executeAdapter(tabId, file) {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer;
      const finish = (settle, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pendingAdapters.delete(adapter);
        settle(value);
      };
      const adapter = { cancel: () => finish(reject, new Error('Extraction superseded by a newer scan.')) };
      this.pendingAdapters.add(adapter);
      timer = setTimeout(() => finish(reject, new Error('Extraction timed out after 15 seconds. Use Restart CopyClean to retry.')), 15000);
      try {
        Promise.resolve(this.scripting.executeScript({ target: { tabId }, files: [file] }))
          .then(value => finish(resolve, value), error => finish(reject, error));
      } catch (error) { finish(reject, error); }
    });
  }
}
