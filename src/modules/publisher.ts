/**
 * Hang Time - Activity Publisher
 * Publishes local activity state to Nostr using time-based scheduling
 * 5 publishes per 60 seconds: changed services at 12s, 24s, 36s, 48s + full refresh at 60s
 */

import { Activity, NostrEvent, ServiceName } from '../types';
import { RelayPool } from './nostr';
import { StorageManager } from './storage';
import { IdentityManager } from './identity';
import { encryptionManager } from './encryption';

const SERVICES_TO_PUBLISH: ServiceName[] = ['spotify', 'twitch', 'steam', 'netflix', 'youtube'];

export class ActivityPublisher {
  private lastPublishedState: Partial<Record<string, Activity>> = {};
  private lastPublishedFields: Map<string, Record<string, any>> = new Map(); // For delta publishing: service -> {field: value}
  private publishInterval: NodeJS.Timeout | null = null;
  private publishCount = 0; // Increments every 12s, 5th publish (index 4) is full refresh
  private publishRateMs = 12000; // Default: publish every 12 seconds

  static readonly PUBLISH_INTERVAL_MS = 12000; // Default: publish every 12 seconds (5 per 60s)
  static readonly FULL_REFRESH_CYCLE = 5; // Every 5th publish is a full refresh

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

  async publishCycle(): Promise<void> {
    try {
      const profile = await this.storageManager.getUserProfile();
      const config = profile?.publisher_config || {
        enabled: true,
        size: 'full',
        scope: 'updates',
        rate_ms: 12000,
        filter_idle: false,
        relays: {},
        retry_backoff_ms: 1000,
        compression: false,
        verbose_logging: false,
      };

      // Log active config
      const activeSettings = [];
      if (config.filter_idle) activeSettings.push('filter_idle');
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

      // Check if all activities are idle (audio:off) and filter is enabled
      const allIdle = Object.values(currentActivities).every(a => !a || a.audio === 'off');
      if (config.filter_idle && allIdle) {
        console.log('[Publisher] ⏭️  Skipping publish - all services idle (filter_idle=on)');
        this.publishCount++;
        return;
      }

      // If delta publishing, only publish changed fields (no full refresh)
      if (config.delta_publishing) {
        const changedActivities = await this._getActivityDeltas(currentActivities);

        if (changedActivities.length > 0) {
          console.debug(`[Publisher] Delta mode: ${changedActivities.length} services with changes`);
          await this._publishServices(changedActivities, 'changed', config);
        } else {
          console.debug('[Publisher] Delta mode: no field changes to publish');
        }
      } else {
        // Standard mode: full publish cycles
        const isFullRefreshCycle = this.publishCount % ActivityPublisher.FULL_REFRESH_CYCLE === (ActivityPublisher.FULL_REFRESH_CYCLE - 1);

        // Determine if we should do a full refresh based on scope config
        const doFullRefresh = config.scope === 'all' || isFullRefreshCycle;

        if (doFullRefresh) {
          // Full refresh: publish all active services
          console.debug('[Publisher] Full refresh cycle');
          await this._publishServices(currentActivities, config.size === 'atomic' ? 'atomic' : 'all', config);
          this.lastPublishedState = { ...currentActivities };
        } else {
          // Changed services only: publish only what changed since last publish
          const changedServices: Partial<Record<string, Activity>> = {};
          for (const service of SERVICES_TO_PUBLISH) {
            if (!this._activityUnchanged(currentActivities[service], this.lastPublishedState[service])) {
              changedServices[service] = currentActivities[service];
            }
          }

          if (Object.keys(changedServices).length > 0) {
            console.debug(`[Publisher] Changed services: ${Object.keys(changedServices).join(', ')}`);
            await this._publishServices(changedServices, 'changed', config);
            // Update last published state with what we just published
            this.lastPublishedState = { ...this.lastPublishedState, ...changedServices };
          } else {
            console.debug('[Publisher] No changes to publish');
          }
        }
      }

      this.publishCount++;
    } catch (error) {
      console.error('[Publisher] Failed to publish cycle:', error);
    }
  }

  private async _getActivityDeltas(currentActivities: Partial<Record<string, Activity>>): Promise<Activity[]> {
    const deltas: Activity[] = [];

    for (const service of SERVICES_TO_PUBLISH) {
      const current = currentActivities[service];
      if (!current) continue;

      const lastFields = this.lastPublishedFields.get(service) || {};
      const changedFields: Record<string, any> = { service, id: current.id }; // Always include service and id
      let hasChanges = false;

      // Check each field for changes
      const fieldsToCheck = ['content', 'url', 'audio', 'timestamp', 'metadata'];
      for (const field of fieldsToCheck) {
        const currentValue = (current as any)[field];
        const lastValue = lastFields[field];

        if (JSON.stringify(currentValue) !== JSON.stringify(lastValue)) {
          changedFields[field] = currentValue;
          hasChanges = true;
        }
      }

      if (hasChanges) {
        deltas.push(changedFields as Activity);
        // Update tracked state
        const newTrackedFields: Record<string, any> = { ...lastFields };
        for (const field of fieldsToCheck) {
          newTrackedFields[field] = (current as any)[field];
        }
        this.lastPublishedFields.set(service, newTrackedFields);
      }
    }

    return deltas;
  }

  private async _publishServices(
    activities: Partial<Record<string, Activity>>,
    mode: 'changed' | 'all' | 'atomic',
    config?: any
  ): Promise<void> {
    const servicesToPublish = mode === 'all' || mode === 'atomic'
      ? SERVICES_TO_PUBLISH.filter(s => activities[s])
      : Object.keys(activities) as ServiceName[];

    // Collect activities to bundle
    const activitiesToPublish: Activity[] = servicesToPublish
      .map(service => activities[service])
      .filter((a): a is Activity => !!a);

    if (activitiesToPublish.length === 0) {
      console.debug('[Publisher] No activities to publish');
      return;
    }

    console.debug('[Publisher] Activities to publish:', activitiesToPublish.map(a => ({ service: a.service, audio: a.audio })));

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
        ['type', 'activity-state'],
        ['mode', mode === 'compressed' ? 'atomic' : mode],
        ['count', activities.length.toString()],
      ];

      // Add service tags for each activity
      for (const activity of activities) {
        tags.push(['service', activity.service]);
      }

      // Serialize activities as JSON array in content
      const content = JSON.stringify(activities);

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
      console.debug(`[Publisher] Services: ${activities.map(a => `${a.service}(audio:${a.audio})`).join(', ')}`);

      // Show which settings are being used for this publish
      const settingsUsed = [];
      if (mode === 'compressed') settingsUsed.push('compression=on');
      if (config?.verbose_logging) settingsUsed.push('verbose_logging=on');
      if (config?.filter_idle) settingsUsed.push('filter_idle=on');
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

  private _activityUnchanged(current: Activity | undefined, last: Activity | undefined): boolean {
    // If either is undefined, they're different
    if (!current && !last) return true; // Both empty = unchanged
    if (!current || !last) return false; // One empty, one not = changed

    // Compare key fields
    return (
      current.content === last.content &&
      current.audio === last.audio &&
      current.url === last.url &&
      current.metadata?.progress === last.metadata?.progress
    );
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
}
