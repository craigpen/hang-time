/**
 * Hang Time - Nostr Relay Pool (FIXED)
 * Manages WebSocket connections to multiple Nostr relays
 * NIP-01 compliant with proper OK, NOTICE, and CLOSED handling
 */

import { NostrEvent, NostrError } from '../types';

export interface IRelayConnection {
  url: string;
  isConnected: boolean;
  subscribe(identifier: string, callback: (event: NostrEvent) => Promise<void>): void;
  publish(event: NostrEvent): Promise<void>;
  disconnect(): Promise<void>;
}

export class RelayConnection implements IRelayConnection {
  url: string;
  isConnected: boolean = false;
  private ws: WebSocket | null = null;
  private subscriptions: Map<string, (event: NostrEvent) => Promise<void>> = new Map();
  private subscriptionId: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private pendingPublishes: Map<string, {resolve: () => void, reject: (error: Error) => void, timeout: NodeJS.Timeout}> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  static readonly TIMEOUT_MS = 8000;
  static readonly MAX_RECONNECT_ATTEMPTS = 5;
  static readonly RECONNECT_DELAY_MS = 3000;
  static readonly PUBLISH_TIMEOUT_MS = 5000;
  static readonly HEARTBEAT_INTERVAL_MS = 25000;

  constructor(url: string) {
    this.url = url;
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
            for (const [identifier, callback] of this.subscriptions.entries()) {
              this._sendSubscription(identifier, callback);
            }

            resolve();
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
        console.debug(`[Nostr] Publishing event to ${this.url}`);
      } catch (error) {
        this.pendingPublishes.delete(event.id);
        reject(new NostrError(`Failed to publish to ${this.url}`, { url: this.url, error }));
      }
    });
  }

  subscribe(identifier: string, callback: (event: NostrEvent) => Promise<void>): void {
    this.subscriptions.set(identifier, callback);

    if (!this.isConnected || !this.ws) {
      console.debug(`[Nostr] Relay not connected, queueing subscription for ${identifier}`);
      return;
    }

    this._sendSubscription(identifier, callback);
  }

  async disconnect(): Promise<void> {
    this._cleanup();
    console.debug(`[Nostr] Disconnected from relay: ${this.url}`);
  }

  private _sendSubscription(identifier: string, _callback?: (event: NostrEvent) => Promise<void>): void {
    if (!this.isConnected || !this.ws) return;

    try {
      const subscriptionId = `sub_${this.subscriptionId++}`;
      const filter = {
        authors: [identifier],
        kinds: [1, 4],
        limit: 100,
      };

      const message = JSON.stringify(['REQ', subscriptionId, filter]);
      this.ws.send(message);
      console.debug(`[Nostr] Subscribed to ${identifier} on ${this.url}`);
    } catch (error) {
      console.error(`[Nostr] Failed to subscribe on ${this.url}:`, error);
    }
  }

  private _handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);

      if (!Array.isArray(message) || message.length < 2) {
        console.warn(`[Nostr] Invalid message format from ${this.url}`);
        return;
      }

      const [type] = message;

      if (type === 'EVENT' && message.length >= 3) {
        const event = message[2];
        if (this._validateEvent(event)) {
          this._handleEvent(event);
        }
      } else if (type === 'OK' && message.length >= 4) {
        // Handle OK response: ["OK", <event_id>, <true|false>, <message>]
        const [, eventId, accepted, reason] = message;
        const pending = this.pendingPublishes.get(eventId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingPublishes.delete(eventId);
          if (accepted) {
            console.debug(`[Nostr] Event ${eventId} accepted by ${this.url}`);
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

    for (const [identifier, callback] of this.subscriptions.entries()) {
      if (event.pubkey === identifier) {
        callback(event).catch((error) => {
          console.error(`[Nostr] Callback error for ${identifier}:`, error);
        });
      }
    }
  }

  private _validateEvent(event: NostrEvent): boolean {
    return !!(
      event &&
      typeof event.id === 'string' &&
      typeof event.pubkey === 'string' &&
      typeof event.created_at === 'number' &&
      typeof event.kind === 'number' &&
      Array.isArray(event.tags) &&
      typeof event.content === 'string'
    );
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
    // Send heartbeat every 25 seconds to prevent proxy idle timeout
    // Most proxies/NAT devices have 30-60 second idle timeout
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          // Send empty EOSE as heartbeat (valid Nostr message, no side effects)
          this.ws.send(JSON.stringify(['EOSE', 'heartbeat']));
        } catch (error) {
          console.debug(`[Nostr] Heartbeat failed on ${this.url}:`, error);
        }
      }
    }, RelayConnection.HEARTBEAT_INTERVAL_MS);
  }

  private _attemptReconnect(): void {
    if (this.reconnectAttempts >= RelayConnection.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[Nostr] Max reconnect attempts reached for ${this.url}`);
      return;
    }

    this.reconnectAttempts++;
    const delay = RelayConnection.RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);

    console.debug(`[Nostr] Reconnecting to ${this.url} in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error(`[Nostr] Reconnection failed for ${this.url}:`, error);
      });
    }, delay);
  }
}

export class RelayPool {
  private relays: Map<string, RelayConnection> = new Map();
  private subscriptions: Map<string, Set<(event: NostrEvent) => Promise<void>>> = new Map();

  static readonly DEFAULT_RELAYS = [
    'wss://relay.primal.net',
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://nostr.wine',
    'wss://relay.mostr.pub',
  ];

  async connect(relayUrls: string[]): Promise<void> {
    console.debug(`[Nostr] Connecting to ${relayUrls.length} relays...`);

    const connectionPromises = relayUrls.map(async (url) => {
      if (this.relays.has(url)) {
        return;
      }

      const relay = new RelayConnection(url);
      this.relays.set(url, relay);

      try {
        await relay.connect();
      } catch (error) {
        console.warn(`[Nostr] Failed to connect to ${url}:`, error);
      }
    });

    await Promise.allSettled(connectionPromises);

    const connectedCount = this.getConnectedRelayCount();
    if (connectedCount === 0) {
      throw new NostrError('Failed to connect to any relays');
    }

    console.debug(`[Nostr] Successfully connected to ${connectedCount} relay(s)`);
  }

  async publish(event: NostrEvent): Promise<void> {
    const relays = Array.from(this.relays.values()).filter((r) => r.isConnected);

    if (relays.length === 0) {
      throw new NostrError('No connected relays available for publishing');
    }

    // Publish to all relays, wait for at least one success
    const publishPromises = relays.map((relay) => relay.publish(event));
    const results = await Promise.allSettled(publishPromises);

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    if (successful === 0) {
      throw new NostrError('Failed to publish to any relay');
    }

    console.debug(`[Nostr] Event published to ${successful}/${relays.length} relays`);
  }

  subscribe(identifier: string, callback: (event: NostrEvent) => Promise<void>): void {
    if (!this.subscriptions.has(identifier)) {
      this.subscriptions.set(identifier, new Set());
    }

    this.subscriptions.get(identifier)!.add(callback);

    for (const relay of this.relays.values()) {
      relay.subscribe(identifier, callback);
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
