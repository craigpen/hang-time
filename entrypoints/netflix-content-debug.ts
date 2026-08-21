/**
 * Hang Time - Netflix Debug Content Script
 * Captures all DOM text and structure for title extraction analysis
 */

interface DOMSnapshot {
  timestamp: number;
  state: string;
  allTextNodes: Array<{
    text: string;
    tagName: string;
    className: string;
    dataAttributes: Record<string, string>;
    parent: string;
  }>;
  selectedElements: Record<string, Array<{
    selector: string;
    text: string;
    html: string;
  }>>;
  rawDOM: string;
}

const snapshots: DOMSnapshot[] = [];

function captureSnapshot(state: string): void {
  const timestamp = Date.now();
  console.log(`[Netflix Debug] Capturing snapshot: ${state} at ${new Date(timestamp).toLocaleTimeString()}`);

  const allTextNodes: DOMSnapshot['allTextNodes'] = [];

  // Capture all text nodes
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT
  );

  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text && text.length > 0 && text.length < 500) {
      const parent = (node.parentNode as HTMLElement);
      allTextNodes.push({
        text,
        tagName: parent.tagName,
        className: parent.className,
        dataAttributes: Array.from(parent.attributes)
          .filter(attr => attr.name.startsWith('data-'))
          .reduce((acc, attr) => ({ ...acc, [attr.name]: attr.value }), {}),
        parent: parent.outerHTML.substring(0, 200),
      });
    }
  }

  // Capture common title selectors
  const selectors = [
    '[data-uia="video-title"]',
    '[class*="PlayerTitle"]',
    '[class*="player-title"]',
    '[class*="video-title"]',
    '[class*="ContentTitle"]',
    'h1',
    'h2',
    'h3',
    'h4',
    '[data-testid*="title"]',
  ];

  const selectedElements: Record<string, Array<{
    selector: string;
    text: string;
    html: string;
  }>> = {};

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      selectedElements[selector] = Array.from(elements)
        .slice(0, 3)
        .map(el => ({
          selector,
          text: el.textContent?.trim() || '',
          html: el.outerHTML.substring(0, 300),
        }));
    }
  }

  const snapshot: DOMSnapshot = {
    timestamp,
    state,
    allTextNodes,
    selectedElements,
    rawDOM: document.body.outerHTML.substring(0, 5000),
  };

  snapshots.push(snapshot);
  console.log(`[Netflix Debug] Snapshot captured:`, snapshot);

  // Also send to background so we can retrieve it
  chrome.runtime.sendMessage({
    type: 'DEBUG_NETFLIX_SNAPSHOT',
    data: snapshot,
  }).catch(() => {
    // Silently fail if background isn't listening
  });
}

// Capture on page load
window.addEventListener('load', () => {
  setTimeout(() => captureSnapshot('page-load'), 1000);
});

// Also capture immediately
captureSnapshot('immediate');

// Listen for manual capture requests
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CAPTURE_NETFLIX_DEBUG') {
    captureSnapshot(message.data?.state || 'manual');
    sendResponse({ success: true, snapshot: snapshots[snapshots.length - 1] });
  } else if (message.type === 'GET_NETFLIX_DEBUG_SNAPSHOTS') {
    sendResponse({ success: true, snapshots });
  }
});

console.log('[Netflix Debug] Debug script loaded. Snapshots will be captured at key states.');
console.log('[Netflix Debug] Send message "CAPTURE_NETFLIX_DEBUG" to capture manual snapshots.');
