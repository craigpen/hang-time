# MV3 Content Script Lifecycle Management Pattern

## Overview

This document describes the recommended pattern for managing content script lifecycle in Chrome Manifest V3 extensions, specifically for handling:
- Extension reload/update recovery (re-injection into existing tabs)
- Automatic cleanup of orphaned instances
- Background service worker suspension and reconnection
- Clean DOM teardown without leaving orphaned resources

## The Problem

In MV3, content scripts can become orphaned when:
1. Extension reloads (service worker restarts)
2. Multiple script instances inject into the same page (background re-injection + manifest injection race)
3. Service worker suspends and reconnects
4. Page reloads while extension has reloaded

Without proper lifecycle management:
- Multiple instances compete for resources
- DOM listeners and elements pile up
- Ports fail to reconnect cleanly
- Extensions hang or leak memory

## The Solution: Ownership Flag + Cleanup Event

### Core Concept

Use a page-level flag to track the "current owner" of a page's content script instance. When a new instance arrives:
1. It checks if the flag is set (indicating an older instance)
2. Dispatches a cleanup event for the old instance
3. Sets the flag to mark itself as the new owner
4. Proceeds with initialization

The old instance listens for the cleanup event and self-destructs, removing all DOM modifications and event listeners.

### Key Insight

**Do NOT skip initialization based on the flag.** Always initialize—let the cleanup listener handle gracefully removing the old instance. This prevents race conditions and ensures exactly one instance is running.

## Implementation

### Step 1: Define Cleanup Event & Flag

```typescript
const CLEANUP_EVENT = 'hang-time-content-script-cleanup';
const INSTANCE_ID = Math.random().toString(36).slice(2, 9); // For debugging
```

### Step 2: Check Flag and Dispatch Cleanup

```typescript
// If an older instance is running, signal it to destroy itself immediately
if ((window as any).hangTimeScriptActive) {
  console.log('[ContentScript] 🔄 Orphaned instance detected, triggering cleanup...');
  window.dispatchEvent(new CustomEvent(CLEANUP_EVENT));
}

// Mark THIS instance as the active one (always set this)
(window as any).hangTimeScriptActive = INSTANCE_ID;
console.log('[ContentScript] ✨ Instance active:', INSTANCE_ID);
```

**Important:** Always set the flag, even if you just dispatched cleanup. The old instance will clean itself up via the listener.

### Step 3: Register Cleanup Listener (BEFORE initialization)

```typescript
// Register cleanup listener FIRST so old instances can clean up when signaled
window.addEventListener(CLEANUP_EVENT, performCleanup);
```

This must happen before initialization so old instances can respond to the cleanup event.

### Step 4: Define Cleanup Function

```typescript
function performCleanup(): void {
  console.log('[ContentScript] 🧹 SELF-DESTRUCT: Starting cleanup');

  // Clear flag (old instance is shutting down)
  (window as any).hangTimeScriptActive = false;

  // Disconnect port safely
  if (port) {
    try { port.disconnect(); } catch(err) {}
    port = null;
  }

  // Remove all event listeners
  for (const { element, eventName, handler } of trackedEventListeners) {
    try {
      element.removeEventListener(eventName, handler);
    } catch (err) {}
  }
  trackedEventListeners.length = 0;

  // Remove any DOM elements created by this extension
  const extensionElements = document.querySelectorAll('[data-hang-time-ui]');
  for (const el of extensionElements) {
    try { el.remove(); } catch (err) {}
  }

  // Unregister this listener so it doesn't pile up
  window.removeEventListener(CLEANUP_EVENT, performCleanup);

  console.log('[ContentScript] ✅ Cleanup complete');
}
```

### Step 5: Track DOM Changes for Cleanup

To ensure cleanup is effective, track all event listeners and DOM elements:

```typescript
// Track event listeners for cleanup
const trackedEventListeners: Array<{
  element: EventTarget;
  eventName: string;
  handler: EventListener;
}> = [];

// When adding a listener:
element.addEventListener('play', handler);
trackedEventListeners.push({
  element,
  eventName: 'play',
  handler,
});

// When creating DOM elements:
const myElement = document.createElement('div');
myElement.setAttribute('data-hang-time-ui', 'true');
document.body.appendChild(myElement);
```

### Step 6: Initialize After Small Delay

```typescript
// Initialize with a small delay to let old instance register cleanup listener
setTimeout(() => {
  establishConnection();
  tracker.init();
}, 50);
```

The 50ms delay gives the old instance time to set up its cleanup listener before the new instance starts doing work.

### Step 7: Port Reconnection (Simplified)

Since we've handled instance cleanup via the flag pattern, reconnection logic can be simpler:

```typescript
function establishConnection(): void {
  try {
    port = chrome.runtime.connect({ name: 'content-script-video-tab' });

    port.onDisconnect.addListener(() => {
      console.warn('[ContentScript] Port disconnected');
      port = null;

      // Simple exponential backoff - port failure is the signal we need reconnection
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, reconnectAttempts);
        reconnectAttempts++;
        
        setTimeout(() => {
          establishConnection();
        }, backoff);
      }
    });

    reconnectAttempts = 0; // Reset on successful connection
    console.log('[ContentScript] ✅ Connected to background');

    // Send keep-alive pings (no instance ID checks needed)
    setInterval(() => {
      if (port) {
        try { port.postMessage({ type: 'PING' }); }
        catch (e) { clearInterval(pingInterval); }
      }
    }, 5000);

  } catch (err) {
    // Retry on error (simpler logic, no flag checks)
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, reconnectAttempts);
      reconnectAttempts++;
      
      setTimeout(() => {
        establishConnection();
      }, backoff);
    }
  }
}
```

## Complete Flow Example

### Extension Reload Scenario

```
1. Extension reloads
2. Background service worker restarts
3. _reinjectionContentScripts() injects scripts into all open tabs
4. YouTube tab has OLD instance (port disconnected but still alive)
5. NEW instance injects, checks flag:
   - Flag is set to OLD_ID
   - Dispatches cleanup event
   - Sets flag to NEW_ID
   - Registers cleanup listener
6. OLD instance hears cleanup event:
   - Removes all listeners
   - Disconnects port
   - Removes DOM elements
   - Clears flag
7. NEW instance initializes (after 50ms delay):
   - Connects new port to restarted background
   - Starts tracking videos
   - Everything works again
```

### Tab Reload Scenario (After Extension Reload)

```
1. User presses F5 on YouTube tab
2. Old window context dies (all page-level state lost)
3. Manifest injects fresh script
4. NEW script checks flag:
   - Flag is undefined (new window)
   - No cleanup event dispatched (no old instance)
   - Sets flag to its own ID
   - Registers cleanup listener
5. NEW script initializes:
   - Connects port to background
   - Starts tracking videos
   - No orphan detection message (as expected!)
```

## Key Takeaways

### Do's ✅
- **Always set the flag** when your script runs
- **Dispatch cleanup if flag exists** before setting yours
- **Register cleanup listener before initializing** so old instances can respond
- **Track all DOM changes** in a cleanup-accessible data structure
- **Use try-catch on cleanup operations** (elements might already be gone)
- **Small delay before initialization** (50-100ms) to let listeners register

### Don'ts ❌
- **Don't skip initialization** if flag exists—let cleanup listeners handle it
- **Don't check instance ID in reconnection logic**—port failure is sufficient signal
- **Don't clear the flag conditionally**—always clear it in cleanup
- **Don't forget to unregister cleanup listeners**—prevents event listener pile-up
- **Don't assume DOM elements still exist** during cleanup—wrap in try-catch

## Testing Checklist

- [ ] Extension reload → YouTube tab still plays/pauses correctly (no orphan detection message)
- [ ] YouTube tab reload after extension reload → fresh script initializes cleanly
- [ ] Port disconnection → reconnection succeeds with exponential backoff
- [ ] Multiple quick reloads → only one instance is active at any time
- [ ] Browser DevTools → no memory leaks or event listener pile-up

## See Also

- **Implementation**: `entrypoints/content-script.ts` (Hang Time extension)
- **Background Service Worker**: `entrypoints/background.ts` (handles re-injection)
- **Reference Samples**: Multiple examples of this pattern across modern Chrome extensions
