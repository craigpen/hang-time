/**
 * Event Deduplicator
 * Provides atomic check-and-mark operations to prevent race conditions
 * when processing the same Nostr event from multiple relays
 */

export class EventDeduplicator {
  private processed: Set<string> = new Set();
  private readonly lockMap: Map<string, Promise<void>> = new Map();

  /**
   * Atomically check and mark an event as processed
   * Returns true if this is the first time seeing this event, false if duplicate
   *
   * This prevents the check-then-mark race condition where:
   * 1. Event A arrives, passes check
   * 2. Event A arrives again from different relay, passes check (before A is marked)
   * 3. Both process the event
   *
   * By using Promise-based locking, we ensure atomicity across async boundaries
   */
  async checkAndMark(eventId: string): Promise<boolean> {
    // If already processed, return false immediately
    if (this.processed.has(eventId)) {
      return false;
    }

    // Create a lock promise for this event
    let lockResolve: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      lockResolve = resolve;
    });
    const existingLock = this.lockMap.get(eventId);

    // If there's an existing lock, wait for it to complete
    if (existingLock) {
      await existingLock;
      // After lock is released, check again (another thread might have marked it)
      return !this.processed.has(eventId);
    }

    // Set this lock before checking again
    this.lockMap.set(eventId, lockPromise);

    try {
      // Double-check after acquiring lock
      if (this.processed.has(eventId)) {
        return false;
      }

      // Mark as processed atomically
      this.processed.add(eventId);
      return true;
    } finally {
      // Always release the lock
      lockResolve!();
      this.lockMap.delete(eventId);
    }
  }

  /**
   * Unmark an event as processed (for error recovery)
   * Use this if processing fails and you want to retry
   */
  unmark(eventId: string): void {
    this.processed.delete(eventId);
  }

  /**
   * Clear deduplication state (useful for testing)
   */
  clear(): void {
    this.processed.clear();
    this.lockMap.clear();
  }

  /**
   * Get count of processed events
   */
  size(): number {
    return this.processed.size;
  }
}

// Singleton instance
let instance: EventDeduplicator | null = null;

export function getEventDeduplicator(): EventDeduplicator {
  if (!instance) {
    instance = new EventDeduplicator();
  }
  return instance;
}
