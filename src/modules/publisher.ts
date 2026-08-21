/**
 * Hang Time - Activity Publisher
 * Publishes local activity state to Nostr using time-based scheduling
 * 5 publishes per 60 seconds: changed services at 12s, 24s, 36s, 48s + full refresh at 60s
 */

import * as pako from 'pako';
import { finalizeEvent } from 'nostr-tools';
import { Activity, NostrEvent, DEFAULT_RELAY_URLS } from '../types';
import { RelayPool } from './nostr';
import { StorageManager } from './storage';
import { IdentityManager } from './identity';
import { detectCorruption } from './activity-validation';
import type { PublishQueue } from './publish-queue';

// Helper: Convert hex string to Uint8Array (for nostr-tools finalizeEvent)
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
}

export class ActivityPublisher {
  private publishQueue: PublishQueue | null = null;

  static readonly PUBLISH_INTERVAL_MS = 12000; // Default: publish every 12 seconds (5 per 60s)
  static readonly FULL_REFRESH_CYCLE = 5; // Every 5th publish is a full refresh
  static readonly GAME_LIBRARY_PUBLISH_INTERVAL_MS = 6 * 60 * 60 * 1000; // Every 6 hours

  constructor(
    private relayPool: RelayPool,
    private storageManager: StorageManager,
    private identityManager: IdentityManager
  ) {}

  /**
   * Set the publish queue (called after queue is initialized)
   */
  setPublishQueue(queue: PublishQueue): void {
    this.publishQueue = queue;
  }

  async start(): Promise<void> {
    const profile = await this.storageManager.getUserProfile();
    const config = profile?.publisher_config;

    if (config && !config.enabled) {
      console.debug('[Publisher] Publishing is disabled in config');
      return;
    }

    console.debug(`[Publisher] Activity publisher started (ready to publish activities on demand via PublishQueue)`);
    console.debug(`[Publisher] Config:`, config);
  }


  /**
   * Publish user profile information (kind 0)
   * Contains Discord link and other profile metadata
   */
  async publishProfile(): Promise<void> {
    try {
      const profile = await this.storageManager.getUserProfile();
      if (!profile) {
        console.debug('[Publisher] No profile to publish');
        return;
      }

      // Build profile tags
      const tags: Array<[string, string]> = [];
      if (profile.nickname) {
        tags.push(['nickname', profile.nickname]);
      }
      if (profile.discord_info) {
        tags.push(['discord_link', profile.discord_info]);
      }

      // Create and sign kind 0 profile event using nostr-tools
      // Note: created_at will be refreshed by PublishQueue at actual publish time
      const secretKeyHex = await this.identityManager.getSecretKey();
      const event = finalizeEvent({
        kind: 0,
        tags,
        content: '', // Kind 0 typically has empty content for profile data in tags
        created_at: Math.floor(Date.now() / 1000), // Placeholder, will be refreshed at publish time
      }, hexToBytes(secretKeyHex)) as unknown as NostrEvent;

      // Mark profile as pending in queue
      console.log(`[Publisher] 📤 Profile update (nickname: ${profile.nickname || 'none'}, discord: ${profile.discord_info ? 'yes' : 'no'})`);

      if (this.publishQueue) {
        this.publishQueue.markProfileUpdatePending(event);
        console.debug('[Publisher] Profile update marked as pending in queue');
      } else {
        console.warn('[Publisher] PublishQueue not initialized, profile update skipped');
      }
    } catch (error) {
      console.error('[Publisher] Failed to publish profile:', error);
    }
  }

  /**
   * Called by PublishQueue when it's ready for an activity publish
   * Handles activity detection and publishing
   */
  async publishActivityIfAllowed(): Promise<void> {
    try {
      const profile = await this.storageManager.getUserProfile();
      const config = profile?.publisher_config || {
        enabled: true,
        size: 'full',
        scope: 'updates',
        relays: Object.fromEntries(DEFAULT_RELAY_URLS.map(url => [url.replace('wss://', '').replace('ws://', '').replace(/\/$/, ''), true])),
      };

      if (config && !config.enabled) {
        console.debug('[Publisher] Publishing is disabled in config');
        return;
      }

      // Check if publish queue allows activity publish this cycle
      const shouldPublishActivity = this.publishQueue ? this.publishQueue.shouldPublishActivity() : true;
      if (!shouldPublishActivity) {
        console.debug('[Publisher] Queue blocked activity publish');
        return;
      }

      const currentActivities = await this.storageManager.getMyActivities();

      // Validate and skip corrupted activities
      const validActivities: Partial<Record<string, Activity>> = {};
      Object.entries(currentActivities).forEach(([activityId, activity]) => {
        if (!activity) return;

        const issues = detectCorruption(activity);
        if (issues.length > 0) {
          console.warn(`[Publisher] Activity ${activity.service} (ID: ${activityId}) is corrupted:`, issues);
          return;
        }

        if (!activity.content) {
          console.warn(`[Publisher] Activity ${activity.service} (ID: ${activityId}) has NO content!`);
          return;
        }

        validActivities[activityId] = activity;
      });

      // Publish activities (including empty list on 'all' mode to broadcast idle state)
      await this._publishServices(validActivities, 'all', config);
    } catch (error) {
      console.error('[Publisher] Failed to publish activities:', error);
    }
  }

  private async _publishServices(
    activities: Partial<Record<string, Activity>>,
    mode: 'changed' | 'all' | 'atomic',
    config?: any
  ): Promise<void> {
    try {
      const activeList = Object.values(activities).filter((a): a is Activity => a !== undefined);

      if (mode === 'changed') {
        for (const activity of activeList) {
          await this._publishActivity(activity);
        }
        return;
      }

      await this._publishBundled(activeList, mode, config);
    } catch (error) {
      console.error('[Publisher] Failed to publish services:', error);
    }
  }

  private async _publishBundled(
    activities: Activity[],
    mode: 'changed' | 'all' | 'atomic' | 'compressed',
    config?: any
  ): Promise<void> {
    try {
      const created_at = Math.floor(Date.now() / 1000);
      const kind = 10003; // Replaceable: only latest snapshot stored

      const profile = await this.storageManager.getUserProfile();
      const isDnd = profile?.dnd_enabled ?? false;

      const tags: Array<[string, string]> = [
        ['type', 'bundled'],
        ['count', String(activities.length)],
      ];

      if (isDnd) {
        tags.push(['dnd', 'true']);
      }

      // Serialize activities as JSON array with minimized payload (only published fields)
      const publishableActivities = activities.map(a => this._toPublishableActivity(a, isDnd));
      let content = JSON.stringify(publishableActivities);

      // Apply gzip compression if low_bandwidth_mode is enabled
      if (config?.low_bandwidth_mode) {
        const originalSize = content.length;
        content = await this._compressContent(content);
        const compressedSize = content.length;
        console.debug(`[Publisher] Gzip compression: ${originalSize}b → ${compressedSize}b (${((1 - compressedSize / originalSize) * 100).toFixed(1)}% reduction)`);
        tags.push(['compression', 'gzip']);
      }

      // Create and sign event using nostr-tools
      const secretKeyHex = await this.identityManager.getSecretKey();
      const event = finalizeEvent({
        kind,
        tags,
        content,
        created_at,
      }, hexToBytes(secretKeyHex)) as unknown as NostrEvent;

      // Log event details
      const eventJson = JSON.stringify(event);
      const eventSize = eventJson.length;
      console.debug(`[Publisher] Bundled event (${mode}): ${activities.length} services, size=${eventSize}b`);
      console.debug(`[Publisher] Services: ${activities.map(a => a.service).join(', ')}`);

      // Show which settings are being used for this publish
      const settingsUsed = [];
      if (mode === 'compressed') settingsUsed.push('compression=on');
      if (config?.verbose_logging) settingsUsed.push('verbose_logging=on');
      if (config?.retry_backoff_ms) settingsUsed.push(`retry_backoff=${config.retry_backoff_ms}ms`);
      if (config?.relays) {
        const enabledRelays = Object.entries(config.relays).filter(([, e]) => e).length;
        const totalRelays = Object.keys(config.relays).length;
        if (enabledRelays < totalRelays) settingsUsed.push(`relays=${enabledRelays}/${totalRelays}`);
      }

      console.log(`[Publisher] 📤 Publish [${mode}] size=${eventSize}b | Settings: ${settingsUsed.length > 0 ? settingsUsed.join(', ') : 'default'}`);

      // Verbose logging: log raw event JSON
      if (config?.verbose_logging) {
        console.log(`[Publisher] 📋 Verbose: Event JSON=${eventJson}`);
      }

      await this.relayPool.publish(event, config);
      console.debug(`[Publisher] ✅ Published bundled event with ${activities.length} services`);
    } catch (error) {
      console.error('[Publisher] Failed to publish bundled activities:', error);
    }
  }

  private async _publishActivity(activity: Activity): Promise<void> {
    try {
      // Skip temporary guidance activities
      if (activity.temporary) {
        return;
      }

      // Don't publish fallback/placeholder activities
      if (activity.content === '(Reload Netflix to identify title)') {
        return;
      }

      const created_at = Math.floor(Date.now() / 1000);
      const kind = 10003; // Replaceable: only latest activity snapshot stored

      // Ensure content is valid
      const activityContent = (activity.content || '').trim();
      if (!activityContent || activityContent.includes('http') || activityContent === activity.url) {
        return;
      }

      const profile = await this.storageManager.getUserProfile();
      const isDnd = profile?.dnd_enabled ?? false;

      const tags: Array<[string, string]> = [
        ['service', activity.service],
        ['content', activityContent],
        ['activity_id', activity.id],
      ];

      if (isDnd) {
        tags.push(['dnd', 'true']);
      }

      // Add state tag if present
      if (activity.state) {
        tags.push(['state', activity.state]);
      }

      // Add URL tag
      if (activity.url) {
        tags.push(['url', activity.url]);
      }

      const content = this._buildEventContent(activity);

      // Create and sign event using nostr-tools
      const secretKeyHex = await this.identityManager.getSecretKey();
      const event = finalizeEvent({
        kind,
        tags,
        content,
        created_at,
      }, hexToBytes(secretKeyHex)) as unknown as NostrEvent;

      const eventJson = JSON.stringify(event);
      const eventSize = eventJson.length;
      console.log(`[Publisher] 📤 Publish [atomic] ${activity.service} size=${eventSize}b | Settings: atomic=on`);

      // Load config for relay selection and retry settings
      const config = profile?.publisher_config;
      await this.relayPool.publish(event, config);
    } catch (error) {
      console.error('[Publisher] Failed to publish activity:', error);
    }
  }

  private _buildEventContent(activity: Activity): string {
    const parts: string[] = [];

    if (activity.metadata?.artist) {
      parts.push(activity.metadata.artist);
    }

    parts.push(activity.content);

    return parts.filter((p) => p).join(' - ');
  }

  private async _compressContent(content: string): Promise<string> {
    try {
      const compressed = pako.gzip(content);
      // Convert Uint8Array to base64 using browser API
      const binaryString = String.fromCharCode(...compressed);
      return btoa(binaryString);
    } catch (error) {
      console.error('[Publisher] Gzip compression failed, sending uncompressed:', error);
      return content;
    }
  }

  static decompressContent(content: string): string {
    try {
      // Convert base64 back to binary using browser API
      const binaryString = atob(content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const decompressedBytes = pako.ungzip(bytes);
      return new TextDecoder().decode(decompressedBytes);
    } catch (error) {
      console.error('[Publisher] Gzip decompression failed, treating as uncompressed:', error);
      return content;
    }
  }

  private _toPublishableActivity(activity: Activity, isDnd?: boolean): any {
    // Only publish fields needed by receivers
    // Normalize disconnected state to 'paused' for publishing (internal state not shared with friends)
    const publishState = activity.state === 'disconnected' ? 'paused' : activity.state;

    console.debug(`[TimestampMigration:Publisher] Publishing activity ${activity.id} with contentTimestamp=${activity.contentTimestamp} (timestamp=${activity.timestamp})`);

    return {
      id: activity.id,
      service: activity.service,
      content: activity.content,
      url: activity.url,
      state: publishState,
      timestamp: activity.timestamp,
      contentTimestamp: activity.contentTimestamp, // Immutable start-watching time for reliable host determination
      dnd: isDnd,
      metadata: activity.metadata ? {
        progress: activity.metadata.progress,
        duration: activity.metadata.duration,
        progress_measured_at: activity.metadata.progress_measured_at,
        dnd: isDnd,
        // Optionally add artist for Spotify when API is implemented
        // artist: activity.metadata.artist,
      } : (isDnd ? { dnd: true } : undefined),
    };
  }
}
