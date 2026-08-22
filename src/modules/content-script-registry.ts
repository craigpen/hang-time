/**
 * Hang Time - Content Script Registry
 * Handles dynamic content script registration and programmatic re-injection into tabs
 */

let isRegisteringContentScripts = false;

/**
 * Register content scripts persistently for all tabs
 * Uses registerContentScripts() which survives extension restart/reload
 */
export async function registerContentScripts(): Promise<void> {
  // Prevent concurrent registration attempts
  if (isRegisteringContentScripts) {
    console.debug('[ContentScriptRegistry] Registration already in progress, skipping');
    return;
  }

  isRegisteringContentScripts = true;

  try {
    if (!chrome?.scripting) {
      console.warn('[ContentScriptRegistry] chrome.scripting not available');
      return;
    }

    // Unregister existing scripts if they exist
    try {
      await chrome.scripting.unregisterContentScripts({
        ids: ['hang-time-video-tracker'],
      });
      console.debug('[ContentScriptRegistry] Unregistered existing content scripts');
    } catch (err) {
      // Scripts might not be registered yet, that's ok
      console.debug('[ContentScriptRegistry] No existing scripts to unregister');
    }

    // Register content scripts persistently
    await chrome.scripting.registerContentScripts([
      {
        id: 'hang-time-video-tracker',
        matches: ['https://*/*', 'http://*/*'],
        js: ['content-script.js'],
        runAt: 'document_end',
      },
    ]);

    console.log('[ContentScriptRegistry] ✅ Content scripts registered persistently');
  } catch (err) {
    console.error('[ContentScriptRegistry] ❌ Failed to register content scripts:', err instanceof Error ? err.message : String(err));
  } finally {
    isRegisteringContentScripts = false;
  }
}

/**
 * Re-inject content scripts into all open HTTP(S) tabs
 * Called on extension update and startup to ensure seamless reconnection
 */
export async function reinjectContentScripts(): Promise<void> {
  console.log('[ContentScriptRegistry] 🔄 REINJECTION: Starting content script re-injection...');
  try {
    if (!chrome?.scripting) {
      console.error('[ContentScriptRegistry] ❌ REINJECTION: chrome.scripting API not available');
      return;
    }

    const allTabs = await chrome.tabs.query({
      url: ['http://*/*', 'https://*/*'],
    });

    console.log(`[ContentScriptRegistry] REINJECTION: Found ${allTabs.length} eligible tabs`);
    if (allTabs.length === 0) {
      console.log('[ContentScriptRegistry] REINJECTION: No tabs to re-inject into');
      return;
    }

    let successCount = 0;
    let failureCount = 0;
    const suspendedTabs: number[] = [];

    for (const tab of allTabs) {
      if (!tab.id) continue;

      try {
        const tabStatus = tab.status || 'unknown';
        const tabUrl = tab.url || 'unknown';

        // Skip extension pages and special URLs that can't be injected into
        if (tabUrl.startsWith('chrome-extension://') ||
            tabUrl.startsWith('chrome://')) {
          console.debug(`[ContentScriptRegistry] REINJECTION: Skipping tab ${tab.id} (extension page) - ${tabUrl}`);
          continue;
        }

        console.log(`[ContentScriptRegistry] REINJECTION: Injecting into tab ${tab.id} (${tabStatus}) - ${tabUrl}`);

        const injectionPromise = chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-script.js'],
        });

        // Longer timeout for suspended tabs (they may take time to respond)
        const timeoutMs = tabStatus === 'unloaded' ? 10000 : 8000;
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Injection timeout after ${timeoutMs}ms`)), timeoutMs)
        );

        await Promise.race([injectionPromise, timeoutPromise]);

        // Note: on suspended tabs, executeScript() succeeds at API level but script runs after tab wakes up
        if (tabStatus === 'unloaded') {
          suspendedTabs.push(tab.id);
          console.log(`[ContentScriptRegistry] ⏳ REINJECTION: Tab ${tab.id} is suspended - injection queued for when tab becomes active`);
        }

        successCount++;
        console.log(`[ContentScriptRegistry] ✅ REINJECTION: Successfully injected into tab ${tab.id}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Filter out expected errors that we shouldn't retry
        if (errMsg.includes('Cannot access contents of the page')) {
          console.debug(`[ContentScriptRegistry] REINJECTION: Tab ${tab.id} denied extension access (Netflix, etc.) - skipping`);
          continue;
        }

        failureCount++;
        console.warn(
          `[ContentScriptRegistry] ⚠️ REINJECTION: Failed to inject into tab ${tab.id} (may retry on activation):`,
          errMsg
        );
      }
    }

    console.log(`[ContentScriptRegistry] 🏁 REINJECTION COMPLETE: ${successCount} successful, ${failureCount} failed${suspendedTabs.length > 0 ? ` (${suspendedTabs.length} suspended tabs queued)` : ''}`);

    // Set up listener to re-inject into suspended tabs when they become active
    if (suspendedTabs.length > 0) {
      const handleTabUpdated = (tabId: number, changeInfo: { status?: string }) => {
        if (suspendedTabs.includes(tabId) && changeInfo.status === 'complete') {
          console.log(`[ContentScriptRegistry] REINJECTION: Suspended tab ${tabId} is now active, content script already injected`);
          suspendedTabs.splice(suspendedTabs.indexOf(tabId), 1);
          if (suspendedTabs.length === 0) {
            chrome.tabs.onUpdated.removeListener(handleTabUpdated);
          }
        }
      };
      chrome.tabs.onUpdated.addListener(handleTabUpdated);
    }
  } catch (err) {
    console.error('[ContentScriptRegistry] ❌ REINJECTION: Routine failed:', err instanceof Error ? err.message : String(err));
  }
}
