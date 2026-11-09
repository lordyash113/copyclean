
# CopyClean

A local-only Chrome Manifest V3 side panel for HTML tables. Preview, copy, and download CSV, TSV, JSON, Markdown, or Formatted Table. No runtime dependencies, backend, analytics, or external APIs. Requires Chrome 116+.

## Install and use

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.
2. Pin CopyClean using Chrome's Extensions menu, then open an HTTP(S) webpage and click its icon.
3. Choose **Select table**, review the preview, select an export format, and use **Copy Table** or **Download**.

CSV is the default. For spreadsheet paste into columns, select **Formatted Table** or **TSV**. Formatted Table writes one clipboard item containing escaped HTML and TSV plain text; unsupported rich clipboard APIs fall back to TSV with an explicit warning. Permission denials remain errors. Downloads retain the selected format, including `.html` for Formatted Table. Formula protection is enabled by default for CSV, TSV, and both formatted clipboard representations; turning it off restores raw values and can allow spreadsheet formulas to execute.

The side panel scans when opened, when its window's active tab changes, and after navigation. It never scans in the background without a visible panel. Use **Restart CopyClean** to refresh dynamically inserted/edited tables or recover an error. Restart clears scan data and pending results, preserves format/formula/theme settings, and has a 20-second recovery timeout. It does not reload webpages or close tabs. Chrome controls side-panel placement under Settings → Appearance.

After editing/updating files, reload the extension at `chrome://extensions`. Chrome may require approval of website access. Site access can be restricted per website in Chrome; automatic detection then works only on permitted sites. Internal pages, the Chrome Web Store, protected viewers, and local files are unsupported. Iframes and shadow roots are not scanned.

## UI and extraction limits

- Existing light/dark themes and keyboard focus indicators are preserved. The preview is focusable and horizontally scrollable; an overflow hint appears when needed.
- Preview shows five rows, all supported columns, and up to 1,000 UTF-16 units per cell without splitting emoji surrogate pairs. Shortening is disclosed. Exports contain full supported values.
- Each table supports up to 200,000 rows/cells, 1,000 columns, and 5,000,000 expanded UTF-16 text units, including repeated merged values. Unsupported tables receive an error instead of a partial export.
- Page-wide limits: 100 tables, 400,000 allocated/padded cells, 10,000,000 expanded text units, 1,000,000 instrumented work steps, and a cooperative 1.5-second deadline. Limits can omit later tables with visible warnings. Browser DOM operations are not interruptible; these are safety bounds, not wall-clock guarantees.
- Merged cells are expanded for text exports and preserved in regenerated formatted HTML. CSV/TSV quote delimiters, quotes, and newlines; JSON preserves text; Markdown escapes markup. Downloads use UTF-8 without BOM.
- Only HTML `<table>` elements in the main document are supported. Hidden, nested, empty, and layout tables are included. **This is not a sensitive-data redactor:** hidden/default text inside tables can be exported. Input values, source attributes, scripts, styles, templates, and nested-table text inside a parent cell are not read as cell content. Nested tables are also listed separately.

## Permissions and privacy

| Permission | Purpose |
| --- | --- |
| `scripting` | Inject the packaged HTML extractor into the active tab's main frame in Chrome's default isolated world. |
| `clipboardWrite` | Write the selected export after an explicit Copy click. No clipboard-read access. |
| `sidePanel` | Open the persistent side panel from the toolbar. |
| `http://*/*`, `https://*/*` host access | Preserve automatic scanning across websites and access matching tab URL metadata. |

Persistent host access is broad, but `activeTab` alone would lose access across origins until another user gesture. Optional per-site grants would change the current automatic behavior. No separate `tabs`, `activeTab`, `downloads`, `storage`, cookies, history, or network-interception permission is requested.

The worker sends only tab/window IDs, phase, and reason to the panel. Extracted data returns directly through `executeScript` and stays in panel memory. No runtime fetch, WebSocket, beacon, analytics, telemetry, remote code, fonts, or API calls exist. Only `copyclean.theme` (light/dark) is persisted in localStorage. Navigation, hiding, restart, and disposal invalidate scan state. Download Blob URLs are revoked after ten seconds or on disposal.

All page text is untrusted: labels/preview use `textContent`; exported HTML uses escaped values, constant styles, and validated numeric merge metadata. The explicit MV3 extension-page CSP permits packaged scripts/styles and blocks network connections, objects, forms, and base URL overrides. This is defense in depth, not a replacement for safe rendering. Pasting into another app or saving/syncing a downloaded file can give that application or sync provider the data; the extension does not control it.

## Development and checks

Use Node 22.22.2+, 24.15+, or 26+ as allowed by package engines. `npm ci` installs development-only jsdom and its transitive packages; the extension itself requires no npm installation.

- `npm test`: extraction, escaping/XSS, formula protection, serializers, merged cells, preview bounds, aggregate budgets, notification validation/order, stale results, automatic detection, restart, timer/URL cleanup, clipboard compatibility, themes, and accessibility checks. Chrome APIs are simulated in these DOM tests.
- `npm run test:panel:browser`: isolated headless Chrome, localhost UI fixtures, responsive/theme/state screenshots and keyboard checks; extension APIs are simulated. Screenshots stay under ignored `.test-artifacts/panel/`.
- `npm run test:spreadsheet:browser`: actual Chrome HTML/TSV clipboard readback and fallback on a fixed localhost fixture; does not test Excel Online or Google Sheets.
- `node tests/native-clipboard.js`: headless merged-cell clipboard fixture. `npm run test:clipboard:native` additionally replaces the OS clipboard and creates new unsaved Office documents for native paste checks. Opt-in only; never opens normal browser profiles or existing documents.
- `npm run test:live`: explicit GET to public W3Schools HTML-table examples followed by jsdom extraction/export checks; sends no extracted data and is not installed-extension browser testing.
- `npm audit`: queries npm's advisory registry with dependency metadata. Package installation also contacts npm. These developer operations are not extension runtime traffic.

Production files: `manifest.json`, `background.js`, `theme.js`, `popup.html`, `popup.css`, `popup.js`, `content/extract-tables.js`, and `lib/*.js`. Exclude dependencies, tests, fixtures, temporary profiles, screenshots, and unrelated files from release packaging. No publishing/build/upload is performed by these commands.

See [AUDIT.md](AUDIT.md) for the current pre-release findings, fixes, evidence, and remaining release checks.
