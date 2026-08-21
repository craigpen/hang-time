/**
 * Hang Time - Join Action Handler
 * Handles opening/joining friend's activity
 */

import { Activity } from '../types';
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
  private async _promptDiscord(friendId: string): Promise<void> {
    try {
      const friend = await this.storage.getFriend(friendId);
      if (!friend) {
        console.debug('[JoinHandler] Friend not found for Discord prompt');
        return;
      }

      const profile = await this.storage.getUserProfile();
      if (!profile) {
        console.debug('[JoinHandler] User profile not found');
        return;
      }

      // Check friend's discord_info (might be cached)
      let discordInfo = friend.discord_info;
      let friendName = friend.local_name;

      // If not in friend record, check friend_profiles cache (where kind 0 profile data is stored)
      if (!discordInfo && friend.pubkey) {
        const cachedProfile = await this.storage.getFriendProfile(friend.pubkey);
        if (cachedProfile?.discord_link) {
          discordInfo = cachedProfile.discord_link;
          console.debug('[JoinHandler] Found Discord info in friend_profiles cache:', discordInfo);
        }
      }

      if (!discordInfo) {
        return;
      }

      // Format Discord URL: validate it's a discord.gg or discord.com invite link
      let discordUrl: string | null = null;
      if (discordInfo.startsWith('https://discord.gg/') || discordInfo.startsWith('https://discord.com/invite/')) {
        discordUrl = discordInfo;
      } else if (discordInfo.startsWith('discord.gg/')) {
        discordUrl = `https://${discordInfo}`;
      } else {
        console.debug('[JoinHandler] Invalid Discord invite URL format:', discordInfo);
        return;
      }

      // If friend is in a co-watch session, prefer host's server
      if (profile.current_co_watch_session) {
        const session = profile.current_co_watch_session;
        // Collect all potential Discord servers from session members
        const candidateServers: Array<{ pubkey: string; discord_link?: string }> = [];

        // Add self
        if (profile.discord_info) {
          candidateServers.push({ pubkey: profile.pubkey, discord_link: profile.discord_info });
        }

        // Add friends in session
        const allFriends = await this.storage.getFriends();
        for (const uuid of session.co_watchers) {
          const f = allFriends.find(fr => fr.uuid === uuid);
          if (f?.discord_info) {
            candidateServers.push({ pubkey: f.pubkey, discord_link: f.discord_info });
          } else if (f?.pubkey) {
            const cached = await this.storage.getFriendProfile(f.pubkey);
            if (cached?.discord_link) {
              candidateServers.push({ pubkey: f.pubkey, discord_link: cached.discord_link });
            }
          }
        }

        // Use deterministic server selection
        const hostFriend = allFriends.find(fr => fr.uuid === session.host_friend_uuid);
        const hostPubkey = hostFriend ? hostFriend.pubkey : (session.host_friend_uuid === profile.uuid ? profile.pubkey : '');
        const hostServer = candidateServers.find(s => s.pubkey === hostPubkey)?.discord_link;
        const otherServers = candidateServers.filter(s => s.pubkey !== hostPubkey).map(s => ({ identifier: s.pubkey, discord_info: s.discord_link }));
        const selected = selectDiscordServer(hostServer, otherServers);

        if (selected) {
          discordUrl = selected;
          friendName = session.host_friend_uuid === profile.uuid ? 'your session' : (hostFriend?.local_name || 'the host');
        }
      }

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
        chrome.notifications.onButtonClicked.addListener((_notificationId, buttonIndex) => {
          if (buttonIndex === 0 && discordUrl) {
            chrome.tabs.create({ url: discordUrl, active: true });
          }
        });
      }
    } catch (error) {
      console.debug('[JoinHandler] Discord prompt failed:', error);
    }
  }
}

// Singleton instance
export const joinHandler = new JoinHandler(require('./storage').storageManager);
