import { serialize } from './exporters.js';

export function clipboardPayload(table, options = {}) {
  return {
    'text/html': serialize(table, 'formatted', options),
    'text/plain': serialize(table, 'tsv', options)
  };
}

async function copyTSVFallback(table, options) {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Keep the panel focused or download the data.');
  // Never substitute CSV: spreadsheet paste uses tabs, including when a cell
  // contains a comma (for example "$162,700").
  await navigator.clipboard.writeText(serialize(table, 'tsv', options));
  return { format: 'tsv', rich: false, fallback: true };
}

function unsupportedRichClipboard(error) {
  return error?.name === 'NotSupportedError' ||
    (error?.name === 'TypeError' && /unsupported|not supported|not a constructor/i.test(error.message)) ||
    // Some implementations report an unsupported MIME type as NotAllowedError.
    // Match the explicit type failure, never a generic permission/policy denial.
    /(?:type|format|mime).*?(?:text\/html|text\/plain).*?(?:not supported|unsupported)|(?:not supported|unsupported).*?(?:text\/html|text\/plain)/i.test(error?.message || '');
}

// Invoke from a user click, without awaiting unrelated work before writing.
export async function copyTable(table, format, options = {}) {
  if (format !== 'formatted') {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Keep the panel focused or download the data.');
    await navigator.clipboard.writeText(serialize(table, format, options));
    return { format, rich: false, fallback: false };
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function' ||
      (typeof ClipboardItem.supports === 'function' &&
        (!ClipboardItem.supports('text/html') || !ClipboardItem.supports('text/plain')))) {
    return copyTSVFallback(table, options);
  }
  // Serialize outside the API error handler: malformed merge metadata is an
  // export error and must not be mistaken for unsupported browser features.
  const payload = clipboardPayload(table, options);
  try {
    const item = new ClipboardItem({
      'text/html': new Blob([payload['text/html']], { type: 'text/html' }),
      'text/plain': new Blob([payload['text/plain']], { type: 'text/plain' })
    });
    // One item with two representations lets the receiving app choose its format.
    await navigator.clipboard.write([item]);
    return { format: 'formatted', rich: true, fallback: false };
  } catch (error) {
    if (unsupportedRichClipboard(error)) return copyTSVFallback(table, options);
    throw error; // Permission/security failures must stay visible to the user.
  }
}
