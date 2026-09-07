/**
 * Hang Time - Activity Message Router
 * Handles activity queries, tab inspection, join flows, and content-script updates
 */

import { ExtensionResponse } from '../../types';
import { storageManager } from '../storage';
import { getFriendManager } from '../friends';
import { joinHandler } from '../join-handler';
import { ActivityDetector } from '../activity';

export class ActivityRouter {
  static async getCurrentActivity(activityDetector: ActivityDetector | null, service?: string): Promise<ExtensionResponse> {
    if (!activityDetector) {
      return { success: false, error: 'Activity detector not initialized' };
    }
    if (service) {
      try {
        const serviceModule = activityDetector['services']?.get(service);
        if (serviceModule) {
          const activity = await serviceModule.getCurrentActivity();
          return { success: true, data: activity };
        }
        return { success: false, error: `Service not found: ${service}` };
      } catch (error) {
        return { success: false, error: `Failed to get ${service} activity` };
      }
    }
    const activity = await activityDetector.detectCurrentActivity();
    return { success: true, data: activity };
  }

  static async getAllActiveActivities(activityDetector: ActivityDetector | null): Promise<ExtensionResponse> {
    if (!activityDetector) {
      return { success: false, error: 'Activity detector not initialized' };
    }
    const activities = await activityDetector.detectAllActiveActivities();
    return { success: true, data: activities };
  }

  static async getAllActivities(): Promise<ExtensionResponse> {
    try {
      const myActivities = await storageManager.getMyActivities();
      const friendManager = getFriendManager();
      const friends = await friendManager.getAllFriends();

      const friendsData = friends.map((friend) => ({
        uuid: friend.uuid,
        local_name: friend.local_name,
        current_activities: friend.current_activities || {},
        state: friend.state,
        dnd: friend.dnd ?? false,
        muted: friend.muted ?? false,
        initiated_by_me: friend.initiated_by_me,
        pubkey: friend.pubkey,
        last_seen: friend.last_seen,
      }));

      return {
        success: true,
        data: {
          userActivities: myActivities,
          friends: friendsData,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get activities' };
    }
  }

  static async getBrowserActivities(activityDetector: ActivityDetector | null): Promise<ExtensionResponse> {
    if (!activityDetector) {
      return { success: true, data: { 'netflix-tab': null, 'youtube-tab': null, 'twitch-tab': null } };
    }
    const tabService = activityDetector.getService('tabs') as any;
    if (!tabService) {
      return { success: true, data: { 'netflix-tab': null, 'youtube-tab': null, 'twitch-tab': null } };
    }
    await tabService.getCurrentActivity();
    return {
      success: true,
      data: {
        'netflix-tab': tabService.getDetectedActivity?.('netflix-tab') || null,
        'youtube-tab': tabService.getDetectedActivity?.('youtube-tab') || null,
        'twitch-tab': tabService.getDetectedActivity?.('twitch-tab') || null,
      },
    };
  }

  static async toggleService(service?: string, enabled?: boolean): Promise<ExtensionResponse> {
    if (!service || enabled === undefined) return { success: false, error: 'Service and enabled required' };
    try {
      const profile = await storageManager.getUserProfile();
      if (!profile) return { success: false, error: 'User profile not found' };

      const serviceTyped = service as keyof typeof profile.services_enabled;
      profile.services_enabled[serviceTyped] = enabled;
      await storageManager.setUserProfile(profile);

      return { success: true, data: { service, enabled } };
    } catch (error) {
      return { success: false, error: 'Failed to toggle service' };
    }
  }

  static async joinActivity(friendId?: string, activity?: any): Promise<ExtensionResponse> {
    if (!friendId || !activity) return { success: false, error: 'friendId and activity required' };
    try {
      await joinHandler.joinActivity(friendId, activity);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to join activity' };
    }
  }
}
