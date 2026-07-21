/**
 * Hang Time - Nostr Relay Pool
 * Manages WebSocket connections to multiple Nostr relays
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

  static readonly TIMEOUT_MS = 5000;
  static readonly MAX_RECONNECT_ATTEMPTS = 5;
  static readonly RECONNECT_DELAY_MS = 3000;

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

    try {
      const message = JSON.stringify(['EVENT', event]);
      this.ws.send(message);
      console.debug(`[Nostr] Published event to ${this.url}`);
    } catch (error) {
      throw new NostrError(`Failed to publish to ${this.url}`, { url: this.url, error });
    }
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
      } else if (type === 'EOSE') {
        console.debug(`[Nostr] Subscription ended on ${this.url}`);
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

    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        // Ignore
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.subscriptions.clear();
    this.subscriptionId = 0;
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
    'wss://nostr.pub',
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relayable.org',
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

    const connectedCount = Array.from(this.relays.values()).filter((r) => r.isConnected).length;
    console.debug(`[Nostr] Connected to ${connectedCount}/${relayUrls.length} relays`);

    if (connectedCount === 0) {
      throw new NostrError('Failed to connect to any relays', { urls: relayUrls });
    }
  }

  async publish(event: NostrEvent): Promise<{ successes: number; failures: number }> {
    if (!this._validateEvent(event)) {
      throw new NostrError('Invalid event structure', { event });
    }

    const results = await Promise.allSettled(
      Array.from(this.relays.values())
        .filter((r) => r.isConnected)
        .map((relay) => relay.publish(event))
    );

    const successes = results.filter((r) => r.status === 'fulfilled').length;
    const failures = results.filter((r) => r.status === 'rejected').length;

    console.debug(`[Nostr] Published event: ${successes} success, ${failures} failures`);

    return { successes, failures };
  }

  subscribe(
    identifier: string,
    callback: (event: NostrEvent) => Promise<void>
  ): void {
    if (!this.subscriptions.has(identifier)) {
      this.subscriptions.set(identifier, new Set());
    }

    this.subscriptions.get(identifier)!.add(callback);

    for (const relay of this.relays.values()) {
      relay.subscribe(identifier, callback);
    }

    console.debug(`[Nostr] Subscribed to ${identifier}`);
  }

  unsubscribe(identifier: string): void {
    this.subscriptions.delete(identifier);
    console.debug(`[Nostr] Unsubscribed from ${identifier}`);
  }

  async disconnect(): Promise<void> {
    console.debug('[Nostr] Disconnecting from all relays...');

    await Promise.allSettled(
      Array.from(this.relays.values()).map((relay) => relay.disconnect())
    );

    this.relays.clear();
    this.subscriptions.clear();
    console.debug('[Nostr] Disconnected from all relays');
  }

  getConnectedRelayCount(): number {
    return Array.from(this.relays.values()).filter((r) => r.isConnected).length;
  }

  isConnected(): boolean {
    return this.getConnectedRelayCount() > 0;
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
}

// Singleton instance
export const relayPool = new RelayPool();
