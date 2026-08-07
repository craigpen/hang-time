/**
 * Hang Time - Invite Cleanup Tests
 * Tests for orphaned invite removal when friend activities change
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Activity, ServiceName } from '../src/types';

// Mock StorageManager
const mockStorage = new Map<string, any>();

const mockStorageManager = {
  getPendingInvites: async () => {
    return mockStorage.get('pending_invites') || {};
  },
  setPendingInvites: async (invites: Record<string, { friendUuid: string; sentAt: number }>) => {
    mockStorage.set('pending_invites', invites);
  },
};

// Replicate cleanup logic for testing
async function cleanupOrphanedInvites(
  friendUuid: string,
  currentActivities: Partial<Record<ServiceName, Activity>>
): Promise<number> {
  const pendingInvites = await mockStorageManager.getPendingInvites();
  let removed = 0;

  for (const [activityId, inviteData] of Object.entries(pendingInvites)) {
    // Only check invites for this friend
    if (inviteData.friendUuid !== friendUuid) {
      continue;
    }

    // Check if friend still has this activity
    const friendHasActivity = Object.values(currentActivities).some(a => a?.id === activityId);

    if (!friendHasActivity) {
      // Friend no longer has this activity, remove the invite
      delete pendingInvites[activityId];
      removed++;
    }
  }

  if (removed > 0) {
    await mockStorageManager.setPendingInvites(pendingInvites);
  }

  return removed;
}

describe('Invite Cleanup - Orphaned Invites', () => {
  beforeEach(() => {
    mockStorage.clear();
  });

  const createActivity = (id: string, service: ServiceName, content: string): Activity => ({
    id,
    service,
    content,
    state: 'playing',
    progress: 0,
    duration: 3600,
    url: `https://example.com/${id}`,
    timestamp: Date.now(),
    provenance: 'FRIEND',
  });

  describe('cleanupOrphanedInvites', () => {
    it('removes invites when friend stops activity', async () => {
      // Setup: friend has 2 invites
      const friendUuid = 'friend-1';
      const inviteData = {
        'activity-1': { friendUuid, sentAt: Date.now() },
        'activity-2': { friendUuid, sentAt: Date.now() },
        'activity-3': { friendUuid: 'friend-2', sentAt: Date.now() }, // Different friend
      };
      await mockStorageManager.setPendingInvites(inviteData);

      // Friend still has activity-1, but not activity-2
      const currentActivities = {
        youtube: createActivity('activity-1', 'youtube', 'Video Title'),
      };

      // Cleanup
      const removed = await cleanupOrphanedInvites(friendUuid, currentActivities);

      // Verify
      expect(removed).toBe(1);
      const remaining = await mockStorageManager.getPendingInvites();
      expect(remaining).toHaveProperty('activity-1');
      expect(remaining).not.toHaveProperty('activity-2');
      expect(remaining).toHaveProperty('activity-3'); // Different friend, not touched
    });

    it('preserves invites from other friends', async () => {
      const inviteData = {
        'activity-1': { friendUuid: 'friend-1', sentAt: Date.now() },
        'activity-2': { friendUuid: 'friend-2', sentAt: Date.now() },
      };
      await mockStorageManager.setPendingInvites(inviteData);

      // Only clean up friend-1
      const currentActivities = {
        youtube: createActivity('activity-1', 'youtube', 'Video'),
      };

      const removed = await cleanupOrphanedInvites('friend-1', currentActivities);

      const remaining = await mockStorageManager.getPendingInvites();
      expect(remaining).toHaveProperty('activity-1');
      expect(remaining).toHaveProperty('activity-2'); // Untouched
    });

    it('handles no matching activities', async () => {
      const inviteData = {
        'activity-1': { friendUuid: 'friend-1', sentAt: Date.now() },
        'activity-2': { friendUuid: 'friend-1', sentAt: Date.now() },
      };
      await mockStorageManager.setPendingInvites(inviteData);

      // Friend has no matching activities
      const currentActivities = {};

      const removed = await cleanupOrphanedInvites('friend-1', currentActivities);

      expect(removed).toBe(2);
      const remaining = await mockStorageManager.getPendingInvites();
      expect(Object.keys(remaining).length).toBe(0);
    });

    it('handles multiple services', async () => {
      const friendUuid = 'friend-1';
      const inviteData = {
        'youtube-1': { friendUuid, sentAt: Date.now() },
        'spotify-1': { friendUuid, sentAt: Date.now() },
        'twitch-1': { friendUuid, sentAt: Date.now() },
      };
      await mockStorageManager.setPendingInvites(inviteData);

      // Friend still has youtube and spotify, not twitch
      const currentActivities = {
        youtube: createActivity('youtube-1', 'youtube', 'Video'),
        spotify: createActivity('spotify-1', 'spotify', 'Song'),
      };

      const removed = await cleanupOrphanedInvites(friendUuid, currentActivities);

      expect(removed).toBe(1);
      const remaining = await mockStorageManager.getPendingInvites();
      expect(remaining).toHaveProperty('youtube-1');
      expect(remaining).toHaveProperty('spotify-1');
      expect(remaining).not.toHaveProperty('twitch-1');
    });

    it('returns 0 when no invites are orphaned', async () => {
      const friendId = 'friend-1';
      const inviteData = {
        'activity-1': { friendId, sentAt: Date.now() },
      };
      await mockStorageManager.setPendingInvites(inviteData);

      // Friend still has the activity
      const currentActivities = {
        youtube: createActivity('activity-1', 'youtube', 'Video'),
      };

      const removed = await cleanupOrphanedInvites(friendId, currentActivities);

      expect(removed).toBe(0);
    });

    it('returns 0 when no invites exist', async () => {
      const removed = await cleanupOrphanedInvites('friend-1', {});
      expect(removed).toBe(0);
    });

    it('lifecycle: friend switches to new content, old invite expires', async () => {
      const friendId = 'friend-1';

      // Friend sends invite for Video A
      const initialInvites = {
        'video-a': { friendId, sentAt: Date.now() },
      };
      await mockStorageManager.setPendingInvites(initialInvites);

      // Friend updates to watching Video B
      const updatedActivities = {
        youtube: createActivity('video-b', 'youtube', 'Different Video'),
      };

      const removed = await cleanupOrphanedInvites(friendId, updatedActivities);

      expect(removed).toBe(1);
      const remaining = await mockStorageManager.getPendingInvites();
      expect(remaining).toEqual({}); // Video A invite is gone
    });
  });
});
