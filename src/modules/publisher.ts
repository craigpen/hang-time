/**
 * Hang Time - Activity Publisher
 * Publishes local activity state to Nostr using time-based scheduling
 * 5 publishes per 60 seconds: changed services at 12s, 24s, 36s, 48s + full refresh at 60s
 */

import * as pako from 'pako';
import { Activity, NostrEvent, ServiceName } from '../types';
import { RelayPool } from './nostr';
import { StorageManager } from './storage';
import { IdentityManager } from './identity';
import { encryptionManager } from './encryption';
import { validateActivity, detectCorruption } from './activity-validation';
import { GameLibraryManager } from './game-library';

const SERVICES_TO_PUBLISH: ServiceName[] = ['spotify-api', 'twitch-api', 'steam-api', 'discord-api', 'youtube-tab', 'netflix-tab', 'twitch-tab', 'video-tab'];

export class ActivityPublisher {
  private publishInterval: NodeJS.Timeout | null = null;
  private publishCount = 0; // Increments every 12s, 5th publish (index 4) is full refresh
  private publishRateMs = 12000; // Default: publish every 12 seconds
  private lastGameLibraryPublishTime = 0; // Track last game library publish

  static readonly PUBLISH_INTERVAL_MS = 12000; // Default: publish every 12 seconds (5 per 60s)
  static readonly FULL_REFRESH_CYCLE = 5; // Every 5th publish is a full refresh
  static readonly GAME_LIBRARY_PUBLISH_INTERVAL_MS = 6 * 60 * 60 * 1000; // Every 6 hours

  constructor(
    private relayPool: RelayPool,
    private storageManager: StorageManager,
    private identityManager: IdentityManager
  ) {}

  private async _loadConfig(): Promise<void> {
    const profile = await this.storageManager.getUserProfile();
    if (profile?.publisher_config) {
      this.publishRateMs = profile.publisher_config.rate_ms || 12000;
    }
  }

  async start(): Promise<void> {
    await this._loadConfig();

    const profile = await this.storageManager.getUserProfile();
    const config = profile?.publisher_config;

    if (config && !config.enabled) {
      console.debug('[Publisher] Publishing is disabled in config');
      return;
    }

    console.debug(`[Publisher] Starting activity publisher (rate: ${this.publishRateMs}ms, size: ${config?.size || 'full'}, scope: ${config?.scope || 'updates'})`);

    try {
      this.publishInterval = setInterval(() => {
        this.publishCycle().catch((error) => {
          console.error('[Publisher] Publish cycle error:', error);
        });
      }, this.publishRateMs);

      console.debug(`[Publisher] Publish interval started (every ${this.publishRateMs}ms)`);
    } catch (error) {
      console.error('[Publisher] Failed to start:', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.publishInterval) {
      clearInterval(this.publishInterval);
      this.publishInterval = null;
    }
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

      const pubkey = await this.identityManager.getPubkey();
      const created_at = Math.floor(Date.now() / 1000);

      // Build profile tags
      const tags: Array<[string, string]> = [];
      if (profile.nickname) {
        tags.push(['nickname', profile.nickname]);
      }
      if (profile.discord_info) {
        tags.push(['discord_link', profile.discord_info]);
      }

      // Create kind 0 profile event
      const event: NostrEvent = {
        id: '',
        pubkey,
        created_at,
        kind: 0,
        tags,
        content: '', // Kind 0 typically has empty content for profile data in tags
      };

      // Compute event ID and sign
      const eventData = [0, pubkey, created_at, 0, event.tags, event.content];
      const canonicalJson = JSON.stringify(eventData);
      const eventId = await encryptionManager.sha256(canonicalJson);
      event.id = eventId.substring(0, 64);
      event.sig = encryptionManager.signEvent(event.id, await this.identityManager.getSecretKey());

      // Publish to relays
      console.log(`[Publisher] 📤 Publishing kind-0 profile (nickname: ${profile.nickname || 'none'}, discord: ${profile.discord_info ? 'yes' : 'no'})`);
      const config = profile?.publisher_config;
      await this.relayPool.publish(event, config);
      console.debug('[Publisher] Profile published successfully');
    } catch (error) {
      console.error('[Publisher] Failed to publish profile:', error);
    }
  }

  async publishCycle(): Promise<void> {
    try {
      const profile = await this.storageManager.getUserProfile();
      const config = profile?.publisher_config || {
        enabled: true,
        size: 'full',
        scope: 'updates',
        rate_ms: 12000,
        relays: {
          'nos.lol': true,
          'relay.damus.io': true,
          'relay.snort.social': true,
          'nostr.mom': true,
          'relay.mostr.pub': true,
        },
        retry_backoff_ms: 1000,
        compression: false,
        verbose_logging: false,
        delta_publishing: false,
      };

      // Check if we should publish game library (every 6 hours)
      const now = Date.now();
      if (now - this.lastGameLibraryPublishTime > ActivityPublisher.GAME_LIBRARY_PUBLISH_INTERVAL_MS) {
        try {
          const gameDiscoveryEnabled = profile?.game_discovery_enabled ?? false;
          if (gameDiscoveryEnabled) {
            const gameLibraryManager = GameLibraryManager.getInstance(this.storageManager);
            await gameLibraryManager.publishMyGameLibrary();
            this.lastGameLibraryPublishTime = now;
            console.log('[Publisher] Game library published as part of periodic cycle');
          }
        } catch (error) {
          console.warn('[Publisher] Failed to publish game library:', error);
        }
      }

      // Check if publish rate has changed and restart interval if needed
      if (config.rate_ms !== this.publishRateMs) {
        console.debug(`[Publisher] Publish rate changed from ${this.publishRateMs}ms to ${config.rate_ms}ms, restarting interval`);
        this.publishRateMs = config.rate_ms;
        // Clear old interval and start new one with updated rate
        if (this.publishInterval) {
          clearInterval(this.publishInterval);
        }
        this.publishInterval = setInterval(() => {
          this.publishCycle().catch((error) => {
            console.error('[Publisher] Publish cycle error:', error);
          });
        }, this.publishRateMs);
      }

      // Log active config
      const activeSettings = [];
      if (config.compression) activeSettings.push('compression');
      if (config.verbose_logging) activeSettings.push('verbose_logging');
      if (config.retry_backoff_ms !== 1000) activeSettings.push(`retry_backoff=${config.retry_backoff_ms}ms`);
      const selectedRelays = Object.entries(config.relays)
        .filter(([, enabled]) => enabled)
        .map(([url]) => url.split('/')[2]);
      if (selectedRelays.length > 0 && selectedRelays.length < 5) {
        activeSettings.push(`relays=[${selectedRelays.join(',')}]`);
      }

      if (activeSettings.length > 0) {
        console.log(`[Publisher] ⚙️ Config: size=${config.size}, scope=${config.scope}, rate=${config.rate_ms}ms | Active: ${activeSettings.join(', ')}`);
      }

      const currentActivities = await this.storageManager.getMyActivities();

      // Debug: log what we're about to publish (currentActivities keyed by activity ID, not service)
      // Also validate and skip corrupted activities
      const validActivities: Partial<Record<string, Activity>> = {};
      Object.entries(currentActivities).forEach(([activityId, activity]) => {
        if (!activity) return;

        const issues = detectCorruption(activity);
        if (issues.length > 0) {
          console.warn(`[Publisher] ⚠️ Activity ${activity.service} (ID: ${activityId}) is corrupted:`, issues);
          return;  // Skip corrupted activities
        }

        if (!activity.content) {
          console.warn(`[Publisher] ⚠️ Activity ${activity.service} (ID: ${activityId}) has NO content!`, activity);
          return;  // Skip invalid activities
        }

        validActivities[activityId] = activity;
      });

      // Use only valid activities for publishing
      const currentActivitiesForPublishing = validActivities;

      console.log(`[Publisher] Publishing cycle: ${Object.keys(currentActivitiesForPublishing).length} activities total (${Object.values(currentActivitiesForPublishing).map(a => a?.service).join(', ')})`);

      // Publish all activities with minimized payload
      if (Object.keys(currentActivitiesForPublishing).length > 0) {
        await this._publishServices(currentActivitiesForPublishing, 'all', config);
      } else {
        console.debug('[Publisher] No activities to publish');
      }

      this.publishCount++;
    } catch (error) {
      console.error('[Publisher] Failed to publish cycle:', error);
    }
  }

  private async _publishServices(
    activities: Partial<Record<string, Activity>>,
    mode: 'changed' | 'all' | 'atomic',
    config?: any
  ): Promise<void> {
    // Activities are keyed by activity ID, not service name
    // For 'all'/'atomic': filter to only SERVICES_TO_PUBLISH; for 'changed': use all activities
    const activitiesToPublish: Activity[] = mode === 'all' || mode === 'atomic'
      ? Object.values(activities).filter((a): a is Activity => !!a && SERVICES_TO_PUBLISH.includes(a.service))
      : Object.values(activities).filter((a): a is Activity => !!a);

    if (activitiesToPublish.length === 0) {
      console.debug('[Publisher] No activities to publish');
      return;
    }

    console.debug('[Publisher] Activities to publish:', activitiesToPublish.map(a => ({ service: a.service })));

    // Publish as individual events (atomic) or bundled (full)
    if (mode === 'atomic') {
      // With compression, batch services into groups; without, individual events
      if (config?.compression) {
        const batchSize = Math.ceil(activitiesToPublish.length / 2);
        console.log(`[Publisher] 📦 Compression enabled: batching ${activitiesToPublish.length} services into ${Math.ceil(activitiesToPublish.length / batchSize)} events`);
        for (let i = 0; i < activitiesToPublish.length; i += batchSize) {
          const batch = activitiesToPublish.slice(i, i + batchSize);
          await this._publishBundledActivities(batch, 'compressed', config);
        }
      } else {
        for (const activity of activitiesToPublish) {
          await this._publishActivity(activity);
        }
      }
    } else {
      await this._publishBundledActivities(activitiesToPublish, mode, config);
    }
  }

  private async _publishBundledActivities(activities: Activity[], mode: 'changed' | 'all' | 'compressed', config?: any): Promise<void> {
    try {
      const pubkey = await this.identityManager.getPubkey();
      const created_at = Math.floor(Date.now() / 1000);
      const kind = 1;

      // Create tags
      const tags: Array<[string, string]> = [
        ['is_activity', 'true'],
        ['type', 'activity-state'],
        ['mode', mode === 'compressed' ? 'atomic' : mode],
        ['count', activities.length.toString()],
      ];

      // Add service tags for each activity
      for (const activity of activities) {
        tags.push(['service', activity.service]);
      }

      // Serialize activities as JSON array with minimized payload (only published fields)
      const publishableActivities = activities.map(a => this._toPublishableActivity(a));
      let content = JSON.stringify(publishableActivities);

      // Apply gzip compression if low_bandwidth_mode is enabled
      let isCompressed = false;
      if (config?.low_bandwidth_mode) {
        const originalSize = content.length;
        content = await this._compressContent(content);
        const compressedSize = content.length;
        isCompressed = true;
        console.debug(`[Publisher] Gzip compression: ${originalSize}b → ${compressedSize}b (${((1 - compressedSize / originalSize) * 100).toFixed(1)}% reduction)`);
        tags.push(['compression', 'gzip']);
      }

      // Compute event ID
      const id = await this._computeEventId(pubkey, created_at, kind, tags, content);

      // Sign the event
      const secretKey = await this.identityManager.getSecretKey();
      const sig = encryptionManager.signEvent(id, secretKey);

      const event: NostrEvent = {
        id,
        pubkey,
        created_at,
        kind,
        tags,
        content,
        sig,
      };

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

      const pubkey = await this.identityManager.getPubkey();
      const created_at = Math.floor(Date.now() / 1000);
      const kind = 1;

      // Ensure content is valid
      const activityContent = (activity.content || '').trim();
      if (!activityContent || activityContent.includes('http') || activityContent === activity.url) {
        return;
      }

      const tags: Array<[string, string]> = [
        ['service', activity.service],
        ['content', activityContent],
        ['activity_id', activity.id],
      ];

      // Add state tag if present
      if (activity.state) {
        tags.push(['state', activity.state]);
      }

      // Add URL tag
      if (activity.url) {
        tags.push(['url', activity.url]);
      }

      const content = this._buildEventContent(activity);

      // Compute event ID
      const id = await this._computeEventId(pubkey, created_at, kind, tags, content);

      // Sign the event
      const secretKey = await this.identityManager.getSecretKey();
      const sig = encryptionManager.signEvent(id, secretKey);

      const event: NostrEvent = {
        id,
        pubkey,
        created_at,
        kind,
        tags,
        content,
        sig,
      };

      const eventJson = JSON.stringify(event);
      const eventSize = eventJson.length;
      console.log(`[Publisher] 📤 Publish [atomic] ${activity.service} size=${eventSize}b | Settings: atomic=on`);

      // Load config for relay selection and retry settings
      const profile = await this.storageManager.getUserProfile();
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

  private async _computeEventId(
    pubkey: string,
    created_at: number,
    kind: number,
    tags: Array<[string, string]>,
    content: string
  ): Promise<string> {
    // Nostr event ID = SHA-256 hash of canonical event format (NIP-01)
    const eventData = [0, pubkey, created_at, kind, tags, content];
    const canonicalJson = JSON.stringify(eventData);
    const hash256 = await encryptionManager.sha256(canonicalJson);
    return hash256.substring(0, 64);
  }

  private async _compressContent(content: string): Promise<string> {
    try {
      const compressed = pako.gzip(content);
      return Buffer.from(compressed).toString('base64');
    } catch (error) {
      console.error('[Publisher] Gzip compression failed, sending uncompressed:', error);
      return content;
    }
  }

  private async _decompressContent(content: string): Promise<string> {
    try {
      const binary = Buffer.from(content, 'base64');
      const decompressed = pako.ungzip(binary, { to: 'string' });
      return decompressed;
    } catch (error) {
      console.error('[Publisher] Gzip decompression failed, treating as uncompressed:', error);
      return content;
    }
  }

  private _toPublishableActivity(activity: Activity): any {
    // Only publish fields needed by receivers
    return {
      id: activity.id,
      service: activity.service,
      content: activity.content,
      url: activity.url,
      state: activity.state,
      timestamp: activity.timestamp,
      metadata: activity.metadata ? {
        progress: activity.metadata.progress,
        duration: activity.metadata.duration,
        // Optionally add artist for Spotify when API is implemented
        // artist: activity.metadata.artist,
      } : undefined,
    };
  }
}
