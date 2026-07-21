/**
 * Hang Time - Activity Detection Orchestrator
 * Monitors user's activity across all services and publishes to Nostr
 */

import {
  Activity,
  ServiceName,
  IServiceModule,
  NostrEvent,
  ExtensionResponse,
  ExtensionMessage,
} from '../types';
import { RelayPool } from './nostr';
import { StorageManager } from './storage';
import { IdentityManager } from './identity';
import { encryptionManager } from './encryption';

export class ActivityDetector {
  private services: Map<string, IServiceModule> = new Map();
  private lastPublishedActivity: Activity | null = null;
  private lastPublishedTime: number = 0;
  private pollInterval: NodeJS.Timeout | null = null;

  static readonly PUBLISH_RATE_LIMIT_MS = 2000;
  static readonly POLL_INTERVAL_MS = 5000;

  constructor(
    private relayPool: RelayPool,
    private storageManager: StorageManager,
    private identityManager: IdentityManager
  ) {
    // Services will be registered separately via registerService()
  }

  registerService(name: string, service: IServiceModule): void {
    this.services.set(name, service);
    console.debug(`[Activity] Registered service: ${name}`);
  }

  async start(): Promise<void> {
    console.debug('[Activity] Starting activity detector...');

    // Initial detection
    await this.detectAndPublish();

    // Poll every N seconds
    this.pollInterval = setInterval(() => {
      this.detectAndPublish().catch((error) => {
        console.error('[Activity] Detection error:', error);
      });
    }, ActivityDetector.POLL_INTERVAL_MS);

    console.debug('[Activity] Detector started');
  }

  async stop(): Promise<void> {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.debug('[Activity] Activity detector stopped');
  }

  async detectAndPublish(): Promise<void> {
    try {
      const currentActivity = await this.detectCurrentActivity();
      if (!currentActivity) return;

      // Skip if activity hasn't changed or rate limit not met
      if (!this._activityChanged(currentActivity)) {
        return;
      }

      if (Date.now() - this.lastPublishedTime < ActivityDetector.PUBLISH_RATE_LIMIT_MS) {
        return;
      }

      await this._publishActivity(currentActivity);
      this.lastPublishedActivity = currentActivity;
      this.lastPublishedTime = Date.now();

      // Store current activity
      await this.storageManager.setCurrentActivity(currentActivity);

      // Notify popup if it's open
      await this._notifyPopup({
        type: 'ACTIVITY_CHANGED',
        data: { activity: currentActivity },
      });
    } catch (error) {
      console.error('[Activity] Detection pipeline failed:', error);
    }
  }

  async detectCurrentActivity(): Promise<Activity | null> {
    const profile = await this.storageManager.getUserProfile();
    if (!profile) {
      return { service: 'idle', content: 'Idle', timestamp: Date.now(), metadata: {} };
    }

    // Check each enabled service in order
    const serviceOrder: ServiceName[] = ['spotify', 'twitch', 'steam', 'netflix', 'youtube'];

    for (const serviceName of serviceOrder) {
      if (!profile.services_enabled[serviceName]) {
        continue;
      }

      const service = this.services.get(serviceName);
      if (!service) {
        continue;
      }

      try {
        const activity = await service.getCurrentActivity();
        if (activity && activity.service !== 'idle') {
          return activity;
        }
      } catch (error) {
        console.error(`[Activity] Failed to detect ${serviceName}:`, error);
      }
    }

    // No activity detected
    return { service: 'idle', content: 'Idle', timestamp: Date.now(), metadata: {} };
  }

  private async _publishActivity(activity: Activity): Promise<void> {
    const identifier = await this.identityManager.getIdentifier();

    const event: NostrEvent = {
      id: this._generateEventId(),
      pubkey: identifier,
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [
        ['service', activity.service],
        ['content', activity.content],
      ],
      content: this._buildEventContent(activity),
    };

    if (activity.url) {
      event.tags.push(['url', activity.url]);
    }

    const result = await this.relayPool.publish(event);
    console.debug(`[Activity] Published ${activity.service} to Nostr (${result.successes}/${result.successes + result.failures} relays)`);
  }

  private _buildEventContent(activity: Activity): string {
    const parts: string[] = [];

    if (activity.metadata?.artist) {
      parts.push(activity.metadata.artist);
    }

    parts.push(activity.content);

    return parts.filter((p) => p).join(' - ');
  }

  private _activityChanged(newActivity: Activity): boolean {
    if (!this.lastPublishedActivity) return true;

    return (
      newActivity.service !== this.lastPublishedActivity.service ||
      newActivity.content !== this.lastPublishedActivity.content
    );
  }

  private _generateEventId(): string {
    // Generate a valid Nostr event ID (64-character hex string)
    // Use SHA512 hash but truncate to 64 characters
    const seed = `${Date.now()}-${Math.random()}-${Math.random()}`;
    const fullHash = encryptionManager.hash(seed);
    // Take first 64 characters (32 bytes in hex)
    return fullHash.substring(0, 64);
  }

  private async _notifyPopup(message: ExtensionMessage): Promise<void> {
    try {
      // Try to send to popup if it's open
      await chrome.runtime.sendMessage(message);
    } catch (error) {
      // Popup not open, ignore
    }
  }
}
