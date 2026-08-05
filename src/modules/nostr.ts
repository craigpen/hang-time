/**
 * Hang Time - Nostr Relay Pool (with nostr-tools SimplePool)
 * Manages WebSocket connections to multiple Nostr relays
 * Uses nostr-tools SimplePool for event broadcasting
 * Keeps RelayConnection for subscription management and sophisticated features
 * NIP-01 compliant with proper OK, NOTICE, and CLOSED handling
 */

import { SimplePool, verifyEvent } from 'nostr-tools';
import { NostrEvent, NostrError, DEFAULT_RELAY_URLS } from '../types';
import { getFileLogger } from './file-logger';
import { nip11Handler } from './nip11-relay-info'; // Phase 4

export interface IRelayConnection {
  url: string;
  isConnected: boolean;
  subscribe(identifier: string, callback: (event: NostrEvent) => Promise<void>): Promise<void>;
  subscribeToDirectMessages(recipientPubkey: string, callback: (event: NostrEvent) => Promise<void>): Promise<void>;
  publish(event: NostrEvent): Promise<void>;
  disconnect(): Promise<void>;
}

export interface RelayPublishResult {
  relay_url: string;
  success: boolean;
  latency_ms?: number;
  error?: string;
  error_type?: string;
  connection_status: 'connected' | 'disconnected' | 'timeout';
}

export interface PublishResults {
  overall_success: boolean;
  total_relays: number;
  successful_relays: number;
  relay_results: RelayPublishResult[];
}

export class RelayConnection implements IRelayConnection {
  url: string;
  isConnected: boolean = false;
  private ws: WebSocket | null = null;
  private subscriptions: Map<string, Set<(event: NostrEvent) => Promise<void>>> = new Map();
  private subscriptionId: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private pendingPublishes: Map<string, {resolve: () => void, reject: (error: Error) => void, timeout: NodeJS.Timeout}> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatTime: number = 0; // Track last time we received any message from relay
  private heartbeatMonitorTimer: NodeJS.Timeout | null = null; // Monitor for stale connections
  private storageManager: any = null; // StorageManager for persisting subscription timestamps

  // Rate-limit tracking with exponential backoff (Phase 4)
  private isRateLimited: boolean = false;
  private rateLimitedUntil: number = 0; // timestamp when relay will be ready
  private rateLimitCount: number = 0;
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, then cap at 60s
  private readonly RATE_LIMIT_BACKOFF_MS = [1, 2, 4, 8, 16, 32, 60, 60, 60, 60].map(s => s * 1000);

  static readonly TIMEOUT_MS = 8000;
  static readonly RECONNECT_DELAY_MS = 3000;
  static readonly PUBLISH_TIMEOUT_MS = 5000;
  static readonly HEARTBEAT_INTERVAL_MS = 25000;

  constructor(url: string) {
    this.url = url;
  }

  /**
   * Set storage manager for persisting subscription timestamps
   */
  setStorageManager(storage: any): void {
    this.storageManager = storage;
  }

  // Health tracking accessors (Phase 4)
  getHealthStatus() {
    return {
      isRateLimited: this.isRateLimited,
      rateLimitedUntil: this.rateLimitedUntil,
      rateLimitCount: this.rateLimitCount,
      canPublish: !this.isRateLimited || Date.now() > this.rateLimitedUntil,
    };
  }

  async connect(): Promise<void> {
    if (this.isConnected || this.ws) {
      return;
    }

    try {
      console.debug(`[Nostr] Connecting to relay: ${this.url}`);

      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this._cleanup();
          reject(new NostrError(`Connection timeout to ${this.url}`, { url: this.url }));
        }, RelayConnection.TIMEOUT_MS);

        try {
          this.ws = new WebSocket(this.url);

          this.ws.onopen = () => {
            clearTimeout(timeout);
            this.isConnected = true;
            this.reconnectAttempts = 0;
            console.debug(`[Nostr] Connected to relay: ${this.url}`);

            // Start heartbeat to prevent proxy timeout
            this._startHeartbeat();

            // Re-send all queued subscriptions
            console.debug(`[Nostr] Connection opened to ${this.url}, re-sending ${this.subscriptions.size} subscriptions`);
            const subscriptionPromises: Promise<void>[] = [];
            for (const [identifier, callbacks] of this.subscriptions.entries()) {
              console.debug(`[Nostr] Re-sending subscription for ${identifier.substring(0, 16)}... (${callbacks.size} callbacks)`);
              if (identifier.startsWith('dm_')) {
                // DM subscription: extract pubkey from dm_<pubkey> key
                const pubkey = identifier.substring(3);
                const anyCallback = callbacks.values().next().value; // Get any callback (just for protocol compliance)
                subscriptionPromises.push(this._sendDMSubscription(pubkey, anyCallback));
              } else {
                const anyCallback = callbacks.values().next().value; // Get any callback (just for protocol compliance)
                subscriptionPromises.push(this._sendSubscription(identifier, anyCallback));
              }
            }

            // Wait for all subscriptions to be sent
            Promise.all(subscriptionPromises).then(() => resolve()).catch((err) => {
              console.error(`[Nostr] Error sending subscriptions: ${err}`);
              resolve(); // Resolve anyway to continue connection
            });
          };

          this.ws.onmessage = (event) => {
            this._handleMessage(event.data);
          };

          this.ws.onerror = (error) => {
            clearTimeout(timeout);
            console.error(`[Nostr] WebSocket error on ${this.url}:`, error);
            this._cleanup();
            reject(new NostrError(`WebSocket error on ${this.url}`, { url: this.url, error }));
          };

          this.ws.onclose = () => {
            this._cleanup();
            this._attemptReconnect();
          };
        } catch (error) {
          clearTimeout(timeout);
          reject(new NostrError(`Failed to create WebSocket to ${this.url}`, { url: this.url, error }));
        }
      });
    } catch (error) {
      console.error(`[Nostr] Connection failed to ${this.url}:`, error);
      throw error;
    }
  }

  async publish(event: NostrEvent): Promise<void> {
    // Phase 4: Check if rate-limit cooldown has expired
    if (this.isRateLimited && Date.now() > this.rateLimitedUntil) {
      this.isRateLimited = false;
      console.debug(`[Nostr] Rate-limit cooldown expired for ${this.url}, ready to publish again`);
    }

    console.debug(`[Nostr] Publish check for ${this.url}: isConnected=${this.isConnected}, ws=${this.ws ? 'exists' : 'null'}, ws.readyState=${this.ws?.readyState}`);

    if (!this.isConnected || !this.ws) {
      throw new NostrError(`Relay ${this.url} is not connected`, { url: this.url });
    }

    return new Promise((resolve, reject) => {
      try {
        // Set up a timeout for the OK response
        const timeout = setTimeout(() => {
          this.pendingPublishes.delete(event.id);
          reject(new NostrError(`No OK response from ${this.url} for event ${event.id}`));
        }, RelayConnection.PUBLISH_TIMEOUT_MS);

        // Store the promise handlers
        this.pendingPublishes.set(event.id, {
          resolve,
          reject,
          timeout,
        });

        // Send the EVENT message
        const message = JSON.stringify(['EVENT', event]);
        this.ws!.send(message);
        console.debug(`[Nostr] Publishing event (pubkey: ${event.pubkey.substring(0, 16)}..., kind: ${event.kind}) to ${this.url}`);
      } catch (error) {
        this.pendingPublishes.delete(event.id);
        reject(new NostrError(`Failed to publish to ${this.url}`, { url: this.url, error }));
      }
    });
  }

  async subscribe(identifier: string, callback: (event: NostrEvent) => Promise<void>): Promise<void> {
    if (!this.subscriptions.has(identifier)) {
      this.subscriptions.set(identifier, new Set());
    }
    this.subscriptions.get(identifier)!.add(callback);
    console.debug(`[Nostr] Subscribe called for ${identifier.substring(0, 16)}... on ${this.url}, connected: ${this.isConnected}`);

    if (!this.isConnected || !this.ws) {
      console.debug(`[Nostr] Relay not connected, queueing subscription for ${identifier.substring(0, 16)}... on ${this.url}`);
      return;
    }

    await this._sendSubscription(identifier, callback);
  }

  async subscribeToDirectMessages(recipientPubkey: string, callback: (event: NostrEvent) => Promise<void>): Promise<void> {
    const key = `dm_${recipientPubkey}`;
    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, new Set());
    }
    this.subscriptions.get(key)!.add(callback);
    console.debug(`[Nostr] Subscribe to DMs for ${recipientPubkey.substring(0, 16)}... on ${this.url}, connected: ${this.isConnected}`);

    if (!this.isConnected || !this.ws) {
      console.debug(`[Nostr] Relay not connected, queueing DM subscription for ${recipientPubkey.substring(0, 16)}... on ${this.url}`);
      return;
    }

    await this._sendDMSubscription(recipientPubkey, callback);
  }

  async disconnect(): Promise<void> {
    this._cleanup();
    console.debug(`[Nostr] Disconnected from relay: ${this.url}`);
  }

  private async _sendSubscription(identifier: string, _callback?: (event: NostrEvent) => Promise<void>): Promise<void> {
    if (!this.isConnected || !this.ws) {
      try {
        const logger = getFileLogger();
        logger.log('RelayConnection', 'WARN', 'Cannot subscribe: not connected', {
          identifier: identifier.substring(0, 16),
          url: this.url
        });
      } catch {}
      return;
    }

    try {
      const subscriptionId = `sub_${this.subscriptionId++}`;

      // Calculate "since" timestamp: load persisted value or default to 24 hours ago
      let since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

      if (this.storageManager) {
        try {
          const lastSync = await this.storageManager.get(`nostr_sub_since_${this.url}_${identifier}`);
          if (lastSync && typeof lastSync === 'number') {
            // Only move forward, never backward (prevent re-requesting old data)
            since = Math.max(since, lastSync);
          }
        } catch (error) {
          console.debug(`[Nostr] Failed to load persisted "since" for ${identifier}:`, error);
        }
      }

      const filter = {
        authors: [identifier],
        kinds: [10003], // Activities (replaceable event)
        // Note: Kind-1059 encrypted messages are handled by a separate subscription with #p filtering
        since,
      };

      console.debug(`[Nostr] 📡 Sending subscription to ${this.url}`);
      console.debug(`[Nostr]    Authors (pubkey): ${identifier}`);
      console.debug(`[Nostr]    Kinds: ${filter.kinds.join(', ')}`);
      console.debug(`[Nostr]    Since: ${new Date(since * 1000).toISOString()}`);

      const message = JSON.stringify(['REQ', subscriptionId, filter]);
      this.ws.send(message);
      try {
        const logger = getFileLogger();
        logger.log('RelayConnection', 'INFO', 'Subscription sent', {
          identifier: identifier.substring(0, 16),
          subscription_id: subscriptionId,
          url: this.url,
          filter
        });
      } catch {}
      console.debug(`[Nostr] Subscribed to author ${identifier.substring(0, 16)}... (filter: ${JSON.stringify(filter)}) on ${this.url}`);

      // Persist the "since" timestamp to resume from this point on reconnect
      if (this.storageManager) {
        try {
          await this.storageManager.set(`nostr_sub_since_${this.url}_${identifier}`, since);
        } catch (error) {
          console.debug(`[Nostr] Failed to persist "since" timestamp:`, error);
        }
      }
    } catch (error) {
      try {
        const logger = getFileLogger();
        logger.log('RelayConnection', 'ERROR', 'Failed to send subscription', { error: String(error), url: this.url });
      } catch {}
      console.error(`[Nostr] Failed to subscribe on ${this.url}:`, error);
    }
  }

  private async _sendDMSubscription(recipientPubkey: string, _callback?: (event: NostrEvent) => Promise<void>): Promise<void> {
    if (!this.isConnected || !this.ws) return;

    try {
      const subscriptionId = `dm_sub_${this.subscriptionId++}`;

      // Load persisted "since" or default to 24 hours ago
      let since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

      if (this.storageManager) {
        try {
          const lastSync = await this.storageManager.get(`nostr_dm_since_${this.url}_${recipientPubkey}`);
          if (lastSync && typeof lastSync === 'number') {
            since = Math.max(since, lastSync);
          }
        } catch (error) {
          console.debug(`[Nostr] Failed to load persisted DM "since":`, error);
        }
      }

      // Subscribe to kind-1059 events (NIP-17 encrypted messages)
      // Use #p tag filter to only receive events where recipient's pubkey is in the p-tag
      const filter = {
        kinds: [1059],
        '#p': [recipientPubkey],
        since,
        limit: 1000,
      };

      const message = JSON.stringify(['REQ', subscriptionId, filter]);
      this.ws.send(message);
      console.debug(`[Nostr] Subscribed to encrypted messages for ${recipientPubkey.substring(0, 16)}... (filter: ${JSON.stringify(filter)}) on ${this.url}`);

      // Persist the "since" timestamp
      if (this.storageManager) {
        try {
          await this.storageManager.set(`nostr_dm_since_${this.url}_${recipientPubkey}`, since);
        } catch (error) {
          console.debug(`[Nostr] Failed to persist DM "since" timestamp:`, error);
        }
      }
    } catch (error) {
      console.error(`[Nostr] Failed to subscribe to DMs on ${this.url}:`, error);
    }
  }

  private _handleMessage(data: string): void {
    try {
      // Update heartbeat tracking - we received a response from relay
      this.lastHeartbeatTime = Date.now();

      const message = JSON.parse(data);

      if (!Array.isArray(message) || message.length < 2) {
        console.warn(`[Nostr] Invalid message format from ${this.url}`);
        return;
      }

      const [type] = message;
      console.debug(`[Nostr] Received message type "${type}" from ${this.url}`);

      if (type === 'EVENT' && message.length >= 3) {
        const event = message[2];
        if (this._validateEvent(event)) {
          this._handleEvent(event);
        }
      } else if (type === 'OK' && message.length >= 4) {
        // Handle OK response: ["OK", <event_id>, <true|false>, <message>]
        const [, eventId, accepted, reason] = message;

        // Phase 4: Rate-limit detection with exponential backoff
        if (!accepted && typeof reason === 'string' && reason.includes('rate-limited')) {
          this.isRateLimited = true;
          this.rateLimitCount++;

          // Calculate exponential backoff with jitter
          const backoffIndex = Math.min(this.rateLimitCount - 1, this.RATE_LIMIT_BACKOFF_MS.length - 1);
          const baseBackoffMs = this.RATE_LIMIT_BACKOFF_MS[backoffIndex];
          const jitter = Math.random() * 1000; // Add 0-1s jitter
          const totalBackoffMs = baseBackoffMs + jitter;

          this.rateLimitedUntil = Date.now() + totalBackoffMs;
          console.warn(`[Nostr] Rate-limited by ${this.url}: ${reason} (attempt ${this.rateLimitCount}, backoff: ${Math.round(totalBackoffMs)}ms)`);
        }

        const pending = this.pendingPublishes.get(eventId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingPublishes.delete(eventId);
          if (accepted) {
            console.debug(`[Nostr] Event ${eventId} accepted by ${this.url}`);
            // Reset rate-limit counter on success
            this.rateLimitCount = 0;
            this.isRateLimited = false;
            pending.resolve();
          } else {
            console.error(`[Nostr] Event ${eventId} rejected by ${this.url}: ${reason}`);
            pending.reject(new NostrError(`Event rejected: ${reason}`));
          }
        }
      } else if (type === 'EOSE') {
        // End of stored events: ["EOSE", <subscription_id>]
        const subscriptionId = message[1];
        console.debug(`[Nostr] End of stored events for subscription ${subscriptionId} on ${this.url}`);
      } else if (type === 'CLOSED') {
        // Subscription closed: ["CLOSED", <subscription_id>, <message>]
        const [, subscriptionId, reason] = message;
        console.warn(`[Nostr] Subscription ${subscriptionId} closed on ${this.url}: ${reason}`);
      } else if (type === 'NOTICE') {
        // Relay notice: ["NOTICE", <message>]
        const notice = message[1];
        console.warn(`[Nostr] Notice from ${this.url}: ${notice}`);
      } else if (type === 'AUTH') {
        // Auth required: ["AUTH", <challenge>]
        console.warn(`[Nostr] Relay ${this.url} requires NIP-42 authentication (skipping for MVP)`);
      }
    } catch (error) {
      console.error(`[Nostr] Failed to parse message from ${this.url}:`, error);
    }
  }

  private _handleEvent(event: NostrEvent): void {
    if (!this._validateEvent(event)) {
      console.warn(`[Nostr] Invalid event from ${this.url}:`, event);
      return;
    }

    console.debug(`[Nostr] Received event (pubkey: ${event.pubkey.substring(0, 16)}..., kind: ${event.kind}) from ${this.url}`);
    console.debug(`[Nostr] Current subscriptions: ${Array.from(this.subscriptions.keys()).map(k => k.substring(0, 16) + '...').join(', ')}`);

    let found = false;
    for (const [identifier, callbacks] of this.subscriptions.entries()) {
      let matches = false;

      if (identifier.startsWith('dm_')) {
        // DM subscription: route if event is kind-1059 (NIP-44 encrypted messages)
        if (event.kind === 1059) {
          matches = true;
        }
      } else {
        // Regular subscription: route if event pubkey matches
        if (event.pubkey === identifier) {
          matches = true;
        } else {
          // DEBUG: Show mismatch for non-DM events
          if (event.kind === 1) {
            console.debug(`[Nostr] KIND-1 EVENT MISMATCH: event.pubkey=${event.pubkey.substring(0, 16)}... vs subscription identifier=${identifier.substring(0, 16)}...`);
          }
        }
      }

      if (matches) {
        found = true;
        console.debug(`[Nostr] Event matches subscription for ${identifier.substring(0, 16)}..., invoking ${callbacks.size} callback(s)`);
        for (const callback of callbacks) {
          try {
            const result = callback(event);
            if (result instanceof Promise) {
              result.catch((error) => {
                console.error(`[Nostr] ❌ Async callback error for ${identifier.substring(0, 16)}...:`, error instanceof Error ? error.message : error);
              });
            }
          } catch (error) {
            console.error(`[Nostr] ❌ Sync callback error for ${identifier.substring(0, 16)}...:`, error instanceof Error ? error.message : error);
          }
        }
      }
    }
    if (!found && this.subscriptions.size > 0) {
      console.debug(`[Nostr] Event pubkey ${event.pubkey.substring(0, 16)}... does NOT match any subscriptions`);
    }
  }

  private _validateEvent(event: NostrEvent): boolean {
    try {
      // Verify event structure, signature, and hash per NIP-01
      if (!verifyEvent(event)) {
        return false;
      }

      // Validate created_at is reasonably close to current time (±60 minutes)
      const now = Math.floor(Date.now() / 1000);
      const timeDiffSeconds = Math.abs(event.created_at - now);
      const MAX_TIME_DIFF_SECONDS = 3600; // 60 minutes

      if (timeDiffSeconds > MAX_TIME_DIFF_SECONDS) {
        console.warn(
          `[Nostr] Event ${event.id.substring(0, 16)}... has unreasonable created_at: ${new Date(
            event.created_at * 1000
          ).toISOString()} (${Math.round(timeDiffSeconds / 60)} minutes off current time)`
        );
        return false;
      }

      return true;
    } catch (error) {
      console.debug(`[Nostr] Invalid event: ${error instanceof Error ? error.message : 'unknown error'}`);
      return false;
    }
  }

  private _cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.heartbeatMonitorTimer) {
      clearInterval(this.heartbeatMonitorTimer);
      this.heartbeatMonitorTimer = null;
    }

    // Clean up pending publishes
    for (const [, pending] of this.pendingPublishes.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new NostrError(`Relay connection closed: ${this.url}`));
    }
    this.pendingPublishes.clear();

    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        // Ignore
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.subscriptionId = 0;
  }

  private _startHeartbeat(): void {
    // Initialize heartbeat timestamp
    this.lastHeartbeatTime = Date.now();

    // Send heartbeat every 25 seconds to prevent proxy idle timeout
    // Most proxies/NAT devices have 30-60 second idle timeout
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          // Send a CLOSE message for a dummy subscription to keep connection alive
          // This is a valid Nostr protocol message with no side effects
          this.ws.send(JSON.stringify(['CLOSE', 'heartbeat']));
        } catch (error) {
          console.debug(`[Nostr] Heartbeat failed on ${this.url}:`, error);
        }
      }
    }, RelayConnection.HEARTBEAT_INTERVAL_MS);

    // Monitor connection health: verify we're receiving responses from relay
    this.heartbeatMonitorTimer = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        const timeSinceLastMessage = Date.now() - this.lastHeartbeatTime;
        // If we haven't heard from relay in 50+ seconds (double heartbeat interval + margin), connection is stale
        if (timeSinceLastMessage > 50000) {
          console.warn(
            `[Nostr] Connection to ${this.url} is stale (no response for ${Math.round(timeSinceLastMessage / 1000)}s), reconnecting...`
          );
          this._cleanup();
          this._attemptReconnect();
        }
      }
    }, RelayConnection.HEARTBEAT_INTERVAL_MS);
  }

  private _attemptReconnect(): void {
    this.reconnectAttempts++;
    // Cap delay at 60 seconds to avoid excessive backoff, but keep retrying forever
    const delay = Math.min(RelayConnection.RECONNECT_DELAY_MS * Math.pow(2, Math.min(this.reconnectAttempts - 1, 4)), 60000);

    console.debug(`[Nostr] Reconnecting to ${this.url} in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error(`[Nostr] Reconnection failed for ${this.url}:`, error);
        // Automatically schedule next reconnect attempt
        this._attemptReconnect();
      });
    }, delay);
  }
}

export class RelayPool {
  private relays: Map<string, RelayConnection> = new Map();
  private subscriptions: Map<string, Set<(event: NostrEvent) => Promise<void>>> = new Map();
  private simplePool: SimplePool;
  private storageManager: any = null;

  static readonly DEFAULT_RELAYS = DEFAULT_RELAY_URLS;

  constructor() {
    this.simplePool = new SimplePool();
  }

  /**
   * Set storage manager for persisting subscription timestamps
   */
  setStorageManager(storage: any): void {
    this.storageManager = storage;
    // Set it on all existing relay connections
    for (const relay of this.relays.values()) {
      relay.setStorageManager(storage);
    }
  }

  async connect(relayUrls: string[]): Promise<void> {
    try {
      const logger = getFileLogger();
      logger.log('RelayPool', 'INFO', 'Connecting to relays', { count: relayUrls.length, urls: relayUrls });
    } catch {}
    console.debug(`[Nostr] Connecting to ${relayUrls.length} relays...`);

    const connectionPromises = relayUrls.map(async (url) => {
      if (this.relays.has(url)) {
        return;
      }

      const relay = new RelayConnection(url);
      if (this.storageManager) {
        relay.setStorageManager(this.storageManager);
      }
      this.relays.set(url, relay);

      try {
        await relay.connect();
        try {
          const logger = getFileLogger();
          logger.log('RelayPool', 'INFO', 'Relay connected', { url });
        } catch {}
      } catch (error) {
        try {
          const logger = getFileLogger();
          logger.log('RelayPool', 'WARN', 'Failed to connect to relay', { url, error: String(error) });
        } catch {}
        console.warn(`[Nostr] Failed to connect to ${url}:`, error);
      }
    });

    await Promise.allSettled(connectionPromises);

    const connectedCount = this.getConnectedRelayCount();
    if (connectedCount === 0) {
      try {
        const logger = getFileLogger();
        logger.log('RelayPool', 'ERROR', 'Failed to connect to any relays');
      } catch {}
      throw new NostrError('Failed to connect to any relays');
    }

    // Phase 4: Fetch NIP-11 relay capabilities in background (non-blocking)
    const connectedUrls = Array.from(this.relays.values())
      .filter(r => r.isConnected)
      .map(r => r.url);
    if (connectedUrls.length > 0) {
      nip11Handler.fetchRelayInfoBatch(connectedUrls).catch(err => {
        console.debug('[NIP-11] Background fetch failed (non-critical):', err);
      });
    }

    try {
      const logger = getFileLogger();
      logger.log('RelayPool', 'INFO', 'Connected to relays', { count: connectedCount });
    } catch {}
    console.debug(`[Nostr] Successfully connected to ${connectedCount} relay(s)`);
  }

  async publish(event: NostrEvent, config?: any): Promise<PublishResults> {
    const maxRetries = 3;
    let lastError: Error | null = null;
    let lastResults: PublishResults | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Filter relays: connected + not rate-limited + selected in config (Phase 4)
        let relays = Array.from(this.relays.values()).filter((r) => {
          const health = r.getHealthStatus();
          return r.isConnected && health.canPublish;
        });
        const allConnected = relays.map(r => r.url);

        if (config?.relays && typeof config.relays === 'object') {
          relays = relays.filter((r) => {
            // Extract domain from relay URL (e.g., "wss://nos.lol/" -> "nos.lol")
            try {
              const relayUrl = new URL(r.url);
              const domain = relayUrl.hostname;
              return config.relays[domain] !== false;
            } catch {
              return true; // If URL parse fails, include relay
            }
          });
          const selectedUrls = relays.map(r => r.url);
          const disabled = allConnected.filter(u => !selectedUrls.includes(u));
          if (disabled.length > 0) {
            console.log(`[Nostr] 🔄 Config: Relay selection - using ${selectedUrls.length}/${allConnected.length} relays (disabled: ${disabled.map(u => new URL(u).hostname).join(', ')})`);
          }
        }

        // Phase 4: Log if relays are excluded due to rate-limiting
        const allRelays = Array.from(this.relays.values()).filter(r => r.isConnected);
        const rateLimited = allRelays.filter(r => {
          const health = r.getHealthStatus();
          return health.isRateLimited && Date.now() < health.rateLimitedUntil;
        });
        if (rateLimited.length > 0) {
          console.log(`[Nostr] ⏱️ Rate-limited relays excluded: ${rateLimited.map(r => new URL(r.url).hostname).join(', ')}`);
        }

        if (relays.length === 0) {
          throw new NostrError('No connected relays available for publishing');
        }

        // Publish to all relays using SimplePool for better connection management
        const publishStart = Date.now();
        const relayUrls = relays.map(r => r.url);

        // Use SimplePool to broadcast to all relays
        const publishPromises = relayUrls.map(async (url) => {
          try {
            console.debug(`[Nostr] Publishing event (kind=${event.kind}, id=${event.id.substring(0, 16)}..., created_at=${event.created_at}, now=${Math.floor(Date.now()/1000)}) to ${url}`);
            await this.simplePool.publish([url], event as any);
            return { relay: url, success: true, latency_ms: Date.now() - publishStart };
          } catch (error) {
            const errorMsg = (error as Error).message;
            console.error(`[Nostr] Publish FAILED (kind=${event.kind}, id=${event.id.substring(0, 16)}..., created_at=${event.created_at}) to ${url}: ${errorMsg}`);
            return { relay: url, success: false, error: errorMsg, latency_ms: Date.now() - publishStart };
          }
        });
        const relayAttempts = await Promise.all(publishPromises);

        // Build results with per-relay info
        const relayResults: RelayPublishResult[] = relays.map((relay, idx) => {
          const attempt = relayAttempts[idx];
          return {
            relay_url: relay.url,
            success: attempt.success,
            latency_ms: attempt.latency_ms,
            error: attempt.error,
            error_type: attempt.error ? this._parseErrorType(attempt.error) : undefined,
            connection_status: relay.isConnected ? 'connected' : 'disconnected',
          };
        });

        const successful = relayResults.filter((r) => r.success).length;
        lastResults = {
          overall_success: successful > 0,
          total_relays: relays.length,
          successful_relays: successful,
          relay_results: relayResults,
        };

        if (successful === 0) {
          // All relays rejected - extract and log detailed errors
          const errors = relayResults.map(r => r.error || 'unknown error');

          console.error(`[Nostr] ❌ Publish failed: All ${relays.length} relays rejected`);
          errors.forEach((error, idx) => {
            console.error(`[Nostr]   Relay ${idx + 1}: ${error}`);
          });

          const powError = errors.some((e) => e?.includes('pow:'));
          if (powError && attempt < maxRetries - 1) {
            const backoff = (config?.retry_backoff_ms || 1000) * Math.pow(2, attempt);
            console.log(`[Nostr] 🔄 Config: Retry backoff - PoW detected, retrying in ${backoff}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise((resolve) => setTimeout(resolve, backoff));
            continue;
          }

          throw new NostrError('Failed to publish to any relay', { errors });
        }

        console.debug(`[Nostr] kind-${event.kind} published to ${successful}/${relays.length} relays`);
        return lastResults; // Success
      } catch (error) {
        lastError = error as Error;
        if (attempt < maxRetries - 1) {
          const backoff = (config?.retry_backoff_ms || 1000) * Math.pow(2, attempt);
          console.warn(`[Nostr] 🔄 Config: Retry backoff - Publish failed, retrying in ${backoff}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    // Return last results even on error
    if (lastResults) {
      return lastResults;
    }

    throw lastError || new NostrError('Failed to publish after retries');
  }

  private _parseErrorType(error: string): string {
    if (error.includes('pow:')) return 'rate_limit';
    if (error.includes('auth')) return 'auth_required';
    if (error.includes('timeout')) return 'timeout';
    if (error.includes('rejection')) return 'rejection';
    return 'unknown';
  }

  subscribe(identifier: string, callback: (event: NostrEvent) => Promise<void>): void {
    try {
      const logger = getFileLogger();
      logger.log('RelayPool', 'INFO', 'Subscribing to identifier', {
        identifier: identifier.substring(0, 16),
        relay_count: this.relays.size
      });
    } catch {}

    if (!this.subscriptions.has(identifier)) {
      this.subscriptions.set(identifier, new Set());
    }

    this.subscriptions.get(identifier)!.add(callback);

    for (const relay of this.relays.values()) {
      try {
        const logger = getFileLogger();
        logger.log('RelayPool', 'DEBUG', 'Calling relay.subscribe', {
          identifier: identifier.substring(0, 16),
          url: relay.url,
          connected: relay.isConnected
        });
      } catch {}
      relay.subscribe(identifier, callback);
    }
  }

  subscribeToDirectMessages(recipientPubkey: string, callback: (event: NostrEvent) => Promise<void>): void {
    const key = `dm_${recipientPubkey}`;
    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, new Set());
    }

    this.subscriptions.get(key)!.add(callback);

    for (const relay of this.relays.values()) {
      relay.subscribeToDirectMessages(recipientPubkey, callback);
    }
  }

  async disconnect(): Promise<void> {
    const disconnectPromises = Array.from(this.relays.values()).map((relay) => relay.disconnect());
    await Promise.all(disconnectPromises);
    this.relays.clear();
    this.subscriptions.clear();
  }

  getConnectedRelayCount(): number {
    return Array.from(this.relays.values()).filter((r) => r.isConnected).length;
  }
}

export const relayPool = new RelayPool();
