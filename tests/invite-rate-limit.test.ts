/**
 * Hang Time - Invite Rate Limiting Tests
 * Tests for 20-second notification deduplication
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the rate limit window
const INVITE_NOTIFICATION_RATE_LIMIT_MS = 20 * 1000; // 20 seconds

describe('Invite Rate Limiting', () => {
  let notifiedInviteIds: Map<string, number>;

  beforeEach(() => {
    notifiedInviteIds = new Map();
  });

  function hasNotifiedForInvite(eventId: string): boolean {
    return notifiedInviteIds.has(eventId);
  }

  function shouldNotifyForInvite(eventId: string): boolean {
    // If never notified, return true
    if (!notifiedInviteIds.has(eventId)) {
      return true;
    }

    // Check if enough time has passed since last notification
    const lastNotifiedAt = notifiedInviteIds.get(eventId)!;
    const timeSinceLastNotification = Date.now() - lastNotifiedAt;

    return timeSinceLastNotification >= INVITE_NOTIFICATION_RATE_LIMIT_MS;
  }

  function markInviteNotified(eventId: string): void {
    const now = Date.now();
    notifiedInviteIds.set(eventId, now);
  }

  describe('shouldNotifyForInvite', () => {
    it('returns true for never-notified invite', () => {
      const result = shouldNotifyForInvite('event-1');
      expect(result).toBe(true);
    });

    it('returns false within 20 seconds', () => {
      markInviteNotified('event-1');
      const result = shouldNotifyForInvite('event-1');
      expect(result).toBe(false);
    });

    it('returns true after 20+ seconds', async () => {
      markInviteNotified('event-1');

      // Mock time passage
      const originalTime = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(originalTime + INVITE_NOTIFICATION_RATE_LIMIT_MS + 1);

      const result = shouldNotifyForInvite('event-1');
      expect(result).toBe(true);

      vi.restoreAllMocks();
    });

    it('handles multiple invites independently', () => {
      markInviteNotified('event-1');
      markInviteNotified('event-2');

      // event-1: recently notified, should not notify again
      expect(shouldNotifyForInvite('event-1')).toBe(false);

      // event-2: recently notified, should not notify again
      expect(shouldNotifyForInvite('event-2')).toBe(false);

      // event-3: never notified, should notify
      expect(shouldNotifyForInvite('event-3')).toBe(true);
    });
  });

  describe('Invite Lifecycle with Rate Limiting', () => {
    it('notifies on first invite, suppresses duplicate within window', () => {
      const eventId = 'event-abc123';

      // First receipt: should notify
      expect(shouldNotifyForInvite(eventId)).toBe(true);
      markInviteNotified(eventId);

      // Second receipt (within 20s): should not notify
      expect(shouldNotifyForInvite(eventId)).toBe(false);

      // Timestamp is preserved
      expect(hasNotifiedForInvite(eventId)).toBe(true);
    });

    it('allows re-notification after 20 seconds', async () => {
      const eventId = 'event-abc123';
      const originalTime = Date.now();

      // First notification
      expect(shouldNotifyForInvite(eventId)).toBe(true);
      markInviteNotified(eventId);

      // Within window: suppress
      expect(shouldNotifyForInvite(eventId)).toBe(false);

      // Simulate 20 seconds passing
      vi.spyOn(Date, 'now').mockReturnValue(originalTime + INVITE_NOTIFICATION_RATE_LIMIT_MS + 1);

      // After window: allow re-notification
      expect(shouldNotifyForInvite(eventId)).toBe(true);
      markInviteNotified(eventId); // Re-mark with new timestamp

      // Immediately after: suppress again
      expect(shouldNotifyForInvite(eventId)).toBe(false);

      vi.restoreAllMocks();
    });

    it('edge case: exactly 20 seconds', async () => {
      const eventId = 'event-abc123';
      const originalTime = Date.now();

      markInviteNotified(eventId);

      // Mock exactly 20 seconds later
      vi.spyOn(Date, 'now').mockReturnValue(originalTime + INVITE_NOTIFICATION_RATE_LIMIT_MS);

      // Should notify (>= 20 seconds)
      expect(shouldNotifyForInvite(eventId)).toBe(true);

      vi.restoreAllMocks();
    });

    it('tracks timestamps across map operations', () => {
      const ids = new Map<string, number>();
      const now = Date.now();

      // Simulate storage load from JSON
      ids.set('event-1', now);
      ids.set('event-2', now - 5000);
      ids.set('event-3', now - 25000);

      // Recreate logic with loaded data
      notifiedInviteIds = ids;

      // event-1: recent, don't notify
      expect(shouldNotifyForInvite('event-1')).toBe(false);

      // event-2: recent, don't notify
      expect(shouldNotifyForInvite('event-2')).toBe(false);

      // event-3: old (>20s), do notify
      expect(shouldNotifyForInvite('event-3')).toBe(true);
    });
  });
});
