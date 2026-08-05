/**
 * Hang Time - Join Action Handler
 * Handles opening/joining friend's activity
 */

import { Activity, Friend } from '../types';
import { StorageManager } from './storage';
import { selectDiscordServer } from './activity-utils';

export class JoinHandler {
  constructor(private storage: StorageManager) {}

  /**
   * Join friend's activity
   */
  async joinActivity(friendId: string, activity: Activity): Promise<void> {
    if (!activity) {
      throw new Error('No active content to join');
    }

    const friend = await this.storage.getFriend(friendId);
    if (!friend) {
      throw new Error(`Friend not found: ${friendId}`);
    }

    console.log(`[JoinHandler] Joining ${friend.local_name}'s activity on ${activity.service}`);

    switch (activity.service) {
      case 'spotify-api':
        await this._joinSpotify(activity);
        break;

      case 'twitch-api':
        await this._joinTwitch(activity);
        break;

      case 'steam-api':
        await this._joinSteam(activity);
        break;

      case 'youtube-tab':
      case 'netflix-tab':
        await this._joinVideo(activity);
        break;

      default:
        throw new Error(`Join action not supported for ${activity.service}`);
    }

    // Prompt for Discord coordination if enabled
    await this._promptDiscord(friend.local_name);
  }

  /**
   * Open Spotify to the same song
   */
  private async _joinSpotify(activity: Activity): Promise<void> {
    // Open Spotify Web Player with search for the track
    const query = encodeURIComponent(`${activity.content} ${activity.metadata?.artist || ''}`);
    const url = `https://open.spotify.com/search/${query}`;

    chrome.tabs.create({ url, active: true });
    console.debug('[JoinHandler] Opened Spotify search');
  }

  /**
   * Open Twitch to friend's channel
   */
  private async _joinTwitch(activity: Activity): Promise<void> {
    if (activity.url) {
      chrome.tabs.create({ url: activity.url, active: true });
      console.debug('[JoinHandler] Opened Twitch channel');
    } else {
      throw new Error('No Twitch URL available');
    }
  }

  /**
   * Open Steam game
   */
  private async _joinSteam(activity: Activity): Promise<void> {
    // Steam games are opened via steam:// protocol
    if (activity.url) {
      chrome.tabs.create({ url: activity.url, active: true });
      console.debug('[JoinHandler] Opened Steam game');
    } else {
      throw new Error('No Steam URL available');
    }
  }

  /**
   * Open video (Netflix/YouTube)
   */
  private async _joinVideo(activity: Activity): Promise<void> {
    console.debug('[JoinHandler] _joinVideo called:', {
      service: activity.service,
      hasUrl: !!activity.url,
      url: activity.url?.substring(0, 50),
      progress: activity.metadata?.progress,
      duration: activity.metadata?.duration,
    });

    if (activity.url) {
      // Open in new tab
      chrome.tabs.create({ url: activity.url, active: true });

      // Try to set time sync if available
      if (activity.metadata?.progress) {
        console.debug(
          `[JoinHandler] Opened video at ${activity.metadata.progress}s / ${activity.metadata.duration}s`
        );
      }
    } else {
      throw new Error(`No URL available for ${activity.service}`);
    }
  }

  /**
   * Prompt user to open Discord for voice coordination
   */
  private async _promptDiscord(friendName: string): Promise<void> {
    try {
      const friend = await this.storage.getFriend(friendName);
      if (!friend) {
        console.debug('[JoinHandler] Friend not found for Discord prompt');
        return;
      }

      const profile = await this.storage.getUserProfile();
      if (!profile) {
        console.debug('[JoinHandler] User profile not found');
        return;
      }

      // Determine which Discord to use: friend's first, then user's, or other friends in alpha order
      const discordInfo = selectDiscordServer(friend.discord_info, [
        { identifier: profile.memorable_identifier, discord_info: profile.discord_info },
      ]);

      if (!discordInfo) {
        console.debug('[JoinHandler] No Discord server configured for coordination');
        return;
      }

      const discordUrl = this._parseDiscordInfo(discordInfo);

      if (discordUrl) {
        // Create notification
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('public/icon-48.png'),
          title: 'Join Discord',
          message: `Want to chat with ${friendName} on Discord?`,
          buttons: [{ title: 'Open Discord' }, { title: 'Dismiss' }],
          requireInteraction: false,
        });

        // Listen for button clicks
        chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
          if (buttonIndex === 0 && discordUrl) {
            chrome.tabs.create({ url: discordUrl, active: true });
          }
        });
      }
    } catch (error) {
      console.debug('[JoinHandler] Discord prompt failed:', error);
    }
  }

  private _parseDiscordInfo(info: string): string | null {
    // Check if it's already a URL
    if (info.startsWith('http')) {
      return info;
    }

    // Check if it's a Discord server ID or invite code
    if (info.includes('discord.gg/')) {
      return `https://${info}`;
    }

    // Return null for username-only format (would need API to convert)
    return null;
  }
}

// Singleton instance
export const joinHandler = new JoinHandler(require('./storage').storageManager);
