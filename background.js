// The worker observes tab lifecycle only. Extraction is owned by the visible
// side panel; no script is injected when no panel is listening.
function notifyPanel(change) {
  chrome.runtime.sendMessage({ type: 'copyclean:page-changed', ...change }).catch(error => {
    // No receiver is normal while the panel is closed or still opening.
    if (!/Receiving end does not exist|message port closed/i.test(error.message)) {
      console.error('CopyClean could not notify the side panel:', error);
    }
  });
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  .catch(error => console.error('CopyClean could not enable the side panel:', error));

chrome.action.onClicked.addListener(tab => {
  // Preserve the toolbar user gesture required by sidePanel.open().
  chrome.sidePanel.open({ windowId: tab.windowId }).then(() =>
    notifyPanel({ tabId: tab.id, windowId: tab.windowId, phase: 'scan', reason: 'toolbar' })
  ).catch(error => console.error('CopyClean could not open the side panel:', error));
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  // Invalidate old table data promptly; the panel queries the current active tab.
  notifyPanel({ tabId, windowId, phase: 'scan', reason: 'activated' });
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!tab.active || (!change.url && !['loading', 'complete'].includes(change.status))) return;
  if (change.status === 'loading' || change.url) {
    notifyPanel({ tabId, windowId: tab.windowId, phase: 'loading', reason: 'navigation' });
  }
  // Recheck the active tab after this asynchronous query in case it changed.
  chrome.tabs.query({ active: true, windowId: tab.windowId }).then(([current]) => {
    if (current?.id !== tabId || current.status === 'loading') return;
    notifyPanel({ tabId, windowId: tab.windowId, phase: 'scan', reason: 'complete' });
  }).catch(error => console.error('CopyClean could not identify the active tab:', error));
});
