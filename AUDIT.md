# CopyClean pre-release security, privacy, and performance audit

Date: 2026-11-08. Manifest version: 3. Extension version: 1.4.2. Node: 26.12.1.

This report supersedes the earlier audit snapshot. Reviewed all first-party runtime files (`manifest.json`, `background.js`, `theme.js`, `popup.html`, `popup.css`, `popup.js`, `content/extract-tables.js`, and all four `lib/*.js` modules), the obsolete non-HTML adapter, test runners/fixtures, package metadata/lockfile, README, prior audit, and ignore rules. Vendor dependency source was not audited line by line. No release package was built, published, or uploaded.

## Findings by severity

Severity reflects demonstrated impact in this implementation, not a guarantee that no unknown vulnerabilities exist.

### Critical

None identified. No demonstrated remote code execution, credential theft, or external data exfiltration path was found.

### High

None identified. No confirmed extension-origin XSS, hostile-page-to-privileged-message path, or unprotected default spreadsheet formula execution was found. Broad host access increases the impact of any future extension compromise; it is retained to preserve the requested automatic cross-site behavior, not treated as a newly discovered exploit.

### Medium

1. **Page-wide extraction resource consumption was unbounded — fixed.** Per-table 200,000-cell/5,000,000-character bounds did not prevent many large tables from accumulating excessive memory and synchronous work. Added page limits of 100 tables, 400,000 allocated/padded cells, 10,000,000 expanded UTF-16 text units, 1,000,000 instrumented work steps, and a cooperative 1.5-second deadline. Failed-table work counts toward budgets. TreeWalker node filtering, row/cell traversal, and merged-cell expansion consume budget. Exhaustion returns a visible warning and stops later extraction. A 1,000-column table limit also bounds preview DOM size; unsupported tables are unavailable, never silently exported with missing columns. The existing per-table limits remain.
2. **Tall-table preview could throw a JavaScript argument-limit error — fixed.** Spreading every row length into `Math.max` fails on sufficiently tall otherwise-supported tables. Replaced it with a reduction. A 150,000-row regression verifies five-row rendering and enabled export actions without argument overflow.

### Low

1. **Unused layout-extraction implementation and tooling — fixed.** Removed `content/extract-layouts.js`, its fixture/test suite, the browser command and native-runner branch, and residual harness/browser mock support. HTML-only detection is covered in the replacement security suite. No working HTML, formatted-copy, or download path was removed.
2. **Stale product/security documentation — fixed.** Manifest and README still advertised non-HTML extraction and the old format default. Updated them and this audit to describe HTML-only support, CSV default, actual privacy behavior, new bounds, and current verification evidence. Historical browser results are not carried forward as current evidence.
3. **Network policy depended solely on absence of calling code — hardened.** Default MV3 CSP blocked remote scripts/eval but did not explicitly prohibit extension-page network connections. Added `default-src 'none'`, packaged-only script/style rules, `connect-src 'none'`, `object-src 'none'`, `base-uri 'none'`, and `form-action 'none'`. No existing runtime feature requires a remote connection. CSP enforcement in the installed extension still requires manual validation; DOM tests cannot establish it.
4. **Message shape validation was implicit — hardened.** Existing extension sender-ID, no-content-tab sender, window, active-tab, lifecycle, visibility, and ordering checks already prevented the tested hostile paths. Added integer tab/window IDs and an explicit loading/scan phase allowlist. Messages never contain code, arbitrary injection filenames, extracted data, or destination URLs.

## Permissions decision

Retained exactly `scripting`, `clipboardWrite`, `sidePanel`, and `http://*/*` / `https://*/*` host access. No unnecessary permission was found to remove.

- `scripting` is used for one-shot packaged extraction. No declarative content scripts, all-frame injection, MAIN-world execution, or page message bridge is used.
- `clipboardWrite` supports explicit user copying, including rich HTML. There is no clipboard read in production.
- `sidePanel` is used by worker configuration/opening.
- Matching host access supports injection and tab URL checks across websites. `activeTab` grants temporary access following a user gesture and loses cross-origin access. Replacing persistent hosts with it would break the current automatic website detection. Optional per-site grants are a possible future consent design, but would change behavior and are not silently substituted here.
- No `tabs`, duplicate `activeTab`, `downloads`, `storage`, cookies, history, webRequest, or external-message permission is requested. Tab lifecycle listeners/query do not alone require the broad `tabs` permission; host grants supply matching sensitive URL properties. Blob-anchor downloads do not use the downloads API.

Official references: [activeTab lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [host permissions and tab metadata](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), [MV3 CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy), and [isolated content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).

## Data flow and external requests

| Runtime component | Data read/written | Destination/lifetime |
| --- | --- | --- |
| Worker | Tab/window IDs and navigation phase/reason | Internal `runtime.sendMessage`; no URL or table payload. No extraction when no panel is listening. |
| Panel/scanner | Current active tab ID/URL, extracted rows and merge metadata | Local panel memory; cache/request IDs reset on navigation, restart, hiding, and disposal. |
| HTML extractor | Main-document HTML table text and numeric merge/header metadata | Return value of isolated `executeScript`; no DOM mutation, resource cloning, input-value reading, storage, network, or message listeners. |
| Theme | Light/dark preference | Only `copyclean.theme` in extension-origin localStorage. No page data persists there. |
| Copy | Selected serialized table | Browser clipboard on user click. Rich copy uses one HTML/TSV item; unsupported rich APIs explicitly fall back to TSV. |
| Download | Selected serialized table | Local Blob/anchor download; URL revoked after ten seconds or disposal. Destination disk/cloud synchronization is outside extension control. |

No runtime fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon, analytics/telemetry SDK, remote script/style/font import, AI integration, API credentials, or data-transmission endpoint was found. All executable assets are packaged. No runtime npm dependency exists. The only npm direct dependency, jsdom, is development-only and still required by automated tests; no safe dependency removal was warranted. Diagnostic `console.error` calls in the worker report operational failures, not page data; they were retained. Test-runner progress logs are intentional. No production debug dumps or debugger statements were found.

Developer-only external traffic actually performed:

- `npm audit --json` queried the npm advisory service with dependency names/versions; 28 development packages, zero reported vulnerabilities. `npm audit --omit=dev --json` also reported zero vulnerabilities, but there are no production npm dependencies to audit.
- `npm run test:live` fetched the public W3Schools HTML-table page without submitting extracted data. This is outside installed-extension runtime.
- Browser fixture tests used loopback HTTP and a loopback Chrome DevTools WebSocket with fixed test data, source modules, commands, and results. Screenshots are local and ignored. Chrome's own independent browser traffic is not audited by source inspection.

Sandboxed advisory/live/browser attempts failed or timed out. Authorized reruns outside the sandbox succeeded as recorded below. No OS clipboard/native Office mode was run in this audit.

## Injection and content security review

- **XSS/untrusted DOM:** Preview, captions, selector labels, errors, and status strings use `textContent`/DOM creation. No production `innerHTML`, `insertAdjacentHTML`, string eval, or page-derived URL insertion exists. The extractor reads text without cloning resource-bearing or custom elements; scripts/styles/templates and nested-table text are rejected in a parent cell. Source attributes, URLs, event handlers, and source CSS are not copied.
- **Formatted HTML/clipboard:** HTML is regenerated from escaped text and constant styles. Row/column/spans are validated integers within bounds; overlapping metadata and cross-header merges are rejected. It contains no active source links/images/scripts. Both clipboard representations apply the same formula policy. Generic permission failures are not disguised as successful fallback.
- **CSV/TSV formulas:** Default-on apostrophe protection covers leading =, +, -, @ after whitespace/control characters, and leading tab/CR/LF. Delimiter/newline/quote escaping prevents fields escaping their serialization boundary. JSON is unchanged text, Markdown escapes markup. Spreadsheet consumers differ; protection is not a universal guarantee. Explicitly disabling protection permits raw formula content by design.
- **Messages:** Production has one panel runtime listener and no external listener, web-accessible resource, externally-connectable declaration, or `window.postMessage` bridge. Sender and tab/window identities are checked; injection always uses a freshly queried active tab and a fixed packaged script path. Page content cannot select an arbitrary privileged action through these messages.
- **Content script:** Runs in Chrome's default isolated world, reads shared DOM only, returns plain text/metadata, and installs no persistent listener or observer. Hostile page DOM can still be huge or mutate during extraction. Isolation is not a sensitive-data redaction guarantee.

## Performance, lifecycle, and error handling

One visible-panel scan uses one HTML injection. No runtime polling, background scraping, DOM mutation observer, or non-HTML adapter remains. Duplicate in-flight requests share a promise; duplicate completed notifications can reuse cache. Tab switches/navigation discard old results; request IDs, navigation epochs, lifecycle IDs, tab/URL rechecks, and notification arrival/application order prevent tested stale-result races. Same-URL navigation is covered. Restart cancels waiting adapters, clears caches, and keeps existing listeners rather than registering duplicates.

Adapter wait deadline: 15 seconds. Restart recovery deadline: 20 seconds. Success feedback: three seconds, replacement/hidden/disposal cleanup. Blob cleanup: ten seconds/disposal. ResizeObserver disconnects on pagehide and reconnects on persisted pageshow. Pending copies cannot overwrite a new scan/selection's status; an already-issued clipboard write cannot be physically cancelled. Errors for protected pages, withheld permissions, vanished frames, malformed merges, oversized tables, and clipboard failures are recoverable. Read-tab errors are handled without exposing HTML.

Five-row preview still exposes every supported column through horizontal scrolling; cells are capped only in preview text, with disclosure. No UI/theme changes were made by this audit. A 1,000-column limit intentionally rejects pathological tables that previously could create hundreds of thousands of preview cells. Limits can omit tables on large pages; warnings disclose this rather than claiming a complete page extraction.

## Checks performed this audit

| Check | Result and limits |
| --- | --- |
| `npm test` | 79 tests passed, zero failed after removal of obsolete layout tests and addition of eight security regressions. Final verification recorded below if this count changes. Chrome APIs simulated. |
| JavaScript syntax checks | All 21 JavaScript source/test files passed `node --check`. |
| `npm audit --json` | Zero known vulnerabilities reported across 28 development packages. Advisory evidence is point-in-time, not a source-code certification. |
| `npm audit --omit=dev --json` | Zero reported vulnerabilities; no runtime npm dependencies. |
| `npm run test:live` | Actual W3Schools GET; two tables found. Main table 7 rows × 3 columns; direct/toolbar paths and all five copy/download formats passed under jsdom/simulated Chrome APIs. Not native browser UI testing. |
| `npm run test:panel:browser` | Actual Chrome 157.0.8103.38, 14 light/dark responsive/state cases (280/320/400 px, plus short-height cases), keyboard focus/order/visibility, and local screenshots passed. Extension APIs were mocked on localhost; installed-extension permissions/CSP/worker behavior was not tested. |
| `npm run test:spreadsheet:browser` | Actual isolated headless Chrome HTML/TSV write/read, merged cells, salary commas, quotes, empty cells, Unicode, multiline data, and explicit TSV fallback passed on localhost. No installed extension, native Office, Excel Online, or Google Sheets validation. |

## Remaining risks and release checks

1. Load the unpacked extension and verify manifest/CSP acceptance, actual toolbar/side-panel APIs, real permission withholding/regranting, multiple windows, service-worker restart, rapid reload/tab changes, close/reopen, copy/download, and OS clipboard behavior. The passing browser fixtures do not substitute for this installed-extension check.
2. Broad host access is necessary for current automatic cross-site behavior but exposes all permitted sites if a future extension compromise occurs. Chrome's site-access controls can restrict it. No claim is made that optional permissions are impossible; they require a changed consent flow.
3. HTML extraction includes hidden/default text, nested/layout tables, and semantically sensitive table values. It does not redact secrets or inspect only visibly painted cells. Users must review exports; no filter can be inferred from removal of the old heuristic adapter.
4. Budgets are cooperative. Initial DOM discovery, DOM collection materialization, individual browser operations, and serialization can still consume time/memory. Chrome cannot abort already-running synchronous injected code. Very large source DOMs and repeated user rescans remain local availability risks, even though retained output is bounded.
5. Formula protection can be disabled; destination apps vary in formula/text/Unicode/merge interpretation. Do not run untrusted pasted shell commands. JSON/Markdown later imported into another tool may need that tool's own safeguards. Pasting/syncing data transfers it to the chosen application/provider.
6. Screenshots, test profiles under OS temporary storage, downloaded exports, and clipboard contents can outlive the panel. This audit did not erase clipboard/profile artifacts or inspect all browser/OS telemetry. Do not package development files or dependencies for release.
7. No new automatic rescan on arbitrary DOM mutations is added. Dynamically edited tables require Restart or navigation, preserving existing behavior.

## Modified files in this audit

- `manifest.json`: HTML-only description and explicit restrictive extension-page CSP; permissions retained.
- `content/extract-tables.js`: aggregate/work/time/width budgets and earlier row/cell guards.
- `popup.js`: safe tall-table width calculation and explicit notification shape validation.
- `package.json`: remove obsolete layout browser command; dependencies unchanged.
- `tests/harness.js`, `tests/panel-browser.js`, `tests/native-clipboard.js`: remove dead layout extraction/mocks/branch.
- `tests/security.test.js` (new): CSP/runtime sink inventory, HTML-only/table count, width/aggregate/deadline limits, tall previews, untrusted/malformed messages, and control-prefixed formula regressions.
- `README.md`, `AUDIT.md`: current behavior, privacy/permission rationale, limits, severity findings, performed checks, and remaining risks.
- Deleted: `content/extract-layouts.js`, `tests/layouts.test.js`, `tests/layouts-fixture.html`.

`package-lock.json`, dependencies, `background.js`, serializers, clipboard implementation, theme, and panel HTML/CSS were not changed in this audit. No publication/upload action was taken.
