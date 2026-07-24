/**
 * Hang Time - Netflix Comprehensive Debug
 * Captures EVERYTHING for analysis: all DOM, all text, all mutations, all states
 */

interface DebugCapture {
  timestamp: number;
  state: string;
  url: string;
  allTextNodes: Array<{
    text: string;
    length: number;
    parent: {
      tagName: string;
      className: string;
      id: string;
      dataAttributes: Record<string, string>;
    };
    ancestors: Array<{
      tagName: string;
      className: string;
      dataAttributes: Record<string, string>;
    }>;
  }>;
  allHeadings: Array<{
    tagName: string;
    text: string;
    className: string;
    id: string;
    dataAttributes: Record<string, string>;
  }>;
  selectorResults: Record<string, Array<{
    text: string;
    tagName: string;
    className: string;
    dataAttributes: Record<string, string>;
  }>>;
  documentStructure: string; // Full body innerHTML (first 50KB)
  mutations: any[];
}

const debugCaptures: DebugCapture[] = [];
const mutationLog: any[] = [];

function captureEverything(state: string): void {
  console.log(`[DEBUG] CAPTURING EVERYTHING AT STATE: ${state}`);

  const timestamp = Date.now();
  const allTextNodes: DebugCapture['allTextNodes'] = [];
  const allHeadings: DebugCapture['allHeadings'] = [];

  // Capture ALL text nodes
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let node;
  const textNodeCount = { count: 0 };
  while ((node = walker.nextNode())) {
    textNodeCount.count++;
    const text = node.textContent?.trim();
    if (text && text.length > 0) {
      const parent = node.parentNode as HTMLElement;
      const ancestors: DebugCapture['allTextNodes'][0]['ancestors'] = [];

      // Capture all ancestors up to body
      let current = parent;
      while (current && current !== document.body) {
        ancestors.push({
          tagName: current.tagName,
          className: current.className,
          dataAttributes: Array.from((current as any).attributes || [])
            .filter((attr: any) => attr.name.startsWith('data-'))
            .reduce((acc: any, attr: any) => ({ ...acc, [attr.name]: attr.value }), {}),
        });
        current = current.parentElement;
      }

      allTextNodes.push({
        text,
        length: text.length,
        parent: {
          tagName: parent.tagName,
          className: parent.className,
          id: parent.id,
          dataAttributes: Array.from((parent as any).attributes || [])
            .filter((attr: any) => attr.name.startsWith('data-'))
            .reduce((acc: any, attr: any) => ({ ...acc, [attr.name]: attr.value }), {}),
        },
        ancestors,
      });
    }
  }

  // Capture ALL headings
  const headingSelectors = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  for (const selector of headingSelectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      allHeadings.push({
        tagName: el.tagName,
        text: el.textContent?.trim() || '',
        className: el.className,
        id: el.id,
        dataAttributes: Array.from((el as any).attributes || [])
          .filter((attr: any) => attr.name.startsWith('data-'))
          .reduce((acc: any, attr: any) => ({ ...acc, [attr.name]: attr.value }), {}),
      });
    }
  }

  // Test common selectors
  const testSelectors = [
    'h2',
    'h1',
    '[data-uia="video-title"]',
    '[class*="PlayerTitle"]',
    '[class*="player-title"]',
    '[class*="video-title"]',
    '[data-uia*="title"]',
    '.watch-video',
    '[class*="watch-video"]',
  ];

  const selectorResults: DebugCapture['selectorResults'] = {};
  for (const selector of testSelectors) {
    try {
      const elements = document.querySelectorAll(selector);
      selectorResults[selector] = Array.from(elements)
        .slice(0, 5)
        .map((el) => ({
          text: el.textContent?.trim().substring(0, 100) || '',
          tagName: el.tagName,
          className: el.className,
          dataAttributes: Array.from((el as any).attributes || [])
            .filter((attr: any) => attr.name.startsWith('data-'))
            .reduce((acc: any, attr: any) => ({ ...acc, [attr.name]: attr.value }), {}),
        }));
    } catch (e) {
      selectorResults[selector] = [];
    }
  }

  const capture: DebugCapture = {
    timestamp,
    state,
    url: window.location.href,
    allTextNodes,
    allHeadings,
    selectorResults,
    documentStructure: document.body.outerHTML.substring(0, 50000),
    mutations: [...mutationLog],
  };

  debugCaptures.push(capture);

  console.log(`[DEBUG] Captured: ${textNodeCount.count} text nodes, ${allHeadings.length} headings, ${allTextNodes.length} text values`);
  console.log(`[DEBUG] Full capture stored. Total captures: ${debugCaptures.length}`);
}

// Set up mutation observer to log all changes
const mutationObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    mutationLog.push({
      timestamp: Date.now(),
      type: mutation.type,
      nodeName: (mutation.target as any).nodeName,
      className: (mutation.target as any).className,
      addedNodes: mutation.addedNodes.length,
      removedNodes: mutation.removedNodes.length,
    });

    // Keep only last 100 mutations
    if (mutationLog.length > 100) {
      mutationLog.shift();
    }
  }
});

mutationObserver.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['class', 'data-uia', 'data-*'],
});

// Capture on page load
window.addEventListener('load', () => {
  setTimeout(() => captureEverything('page-load'), 2000);
});

// Capture immediately
captureEverything('immediate');

// Auto-save captures to storage every 5 seconds
setInterval(async () => {
  if (debugCaptures.length > 0) {
    try {
      await chrome.storage.local.set({ netflix_debug_captures: debugCaptures });
      console.log(`[NETFLIX_DEBUG] Saved ${debugCaptures.length} captures to storage`);
    } catch (error) {
      console.error('[NETFLIX_DEBUG] Failed to save to storage:', error);
    }
  }
}, 5000);

// Listen for manual capture and retrieval
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DEBUG_NETFLIX_CAPTURE') {
    captureEverything(message.data?.state || 'manual');
    sendResponse({ success: true, captures: debugCaptures.length });
  } else if (message.type === 'DEBUG_NETFLIX_GET_ALL') {
    // Dump to console with filterable prefix
    console.log('[NETFLIX_DEBUG_DATA]', JSON.stringify(debugCaptures, null, 2));
    sendResponse({ success: true, data: debugCaptures });
  }
});

console.log('[NETFLIX_DEBUG] Comprehensive debug loaded');
console.log('[NETFLIX_DEBUG] Available functions (call from page console):');
console.log('[NETFLIX_DEBUG]   __netflixDebug.capture("state-name")  - capture DOM at current state');
console.log('[NETFLIX_DEBUG]   __netflixDebug.dumpAll()              - dump all captures to console');
console.log('[NETFLIX_DEBUG]   __netflixDebug.getCaptureCount()      - get number of captures');
