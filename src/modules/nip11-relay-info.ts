/**
 * NIP-11 Relay Information Queries (Phase 4)
 * Fetches relay capabilities and limitations at startup
 * Enables adaptive behavior based on relay constraints
 *
 * NIP-11 specifies that relay info is available at: GET /.well-known/nostr.json
 */

export interface RelayInfo {
  name?: string;
  description?: string;
  pubkey?: string;
  contact?: string;
  icon?: string;
  supported_nips?: number[];
  software?: string;
  version?: string;
  limitation?: {
    max_message_length?: number;
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    max_event_tags?: number;
    max_content_length?: number;
    min_pow_difficulty?: number;
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
  };
  retention?: {
    max_event_tags?: number;
    max_content_length?: number;
    backup?: boolean;
    // ... other retention fields
  };
}

export interface RelayCapabilities {
  url: string;
  fetched_at: number;
  info: RelayInfo;
  supportsEphemeral: boolean; // Has kind 20000-29999 support
  maxEventSize: number;
  maxSubscriptions: number;
  authRequired: boolean;
  paymentRequired: boolean;
}

export class NIP11Handler {
  private capabilities: Map<string, RelayCapabilities> = new Map();
  static readonly FETCH_TIMEOUT_MS = 5000; // Don't wait too long for relay info

  /**
   * Fetch relay information from a single relay
   * Gracefully handles timeouts and failures (relay info is optional)
   */
  async fetchRelayInfo(relayUrl: string): Promise<RelayCapabilities | null> {
    try {
      const domainUrl = new URL(relayUrl);
      const httpProtocol = domainUrl.protocol === 'ws:' ? 'http:' : 'https:';
      const infoUrl = `${httpProtocol}//${domainUrl.host}${domainUrl.pathname}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), NIP11Handler.FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(infoUrl, {
          signal: controller.signal,
          headers: { 'Accept': 'application/nostr+json, application/json' },
        });

        clearTimeout(timeout);

        if (!response.ok) {
          console.debug(`[NIP-11] Relay ${domainUrl.hostname} returned status ${response.status}`);
          return null;
        }

        const info: RelayInfo = await response.json();
        const capabilities = this._parseCapabilities(relayUrl, info);
        this.capabilities.set(relayUrl, capabilities);

        console.debug(`[NIP-11] Fetched info for ${domainUrl.hostname}: ${info.name || 'unnamed'}`);
        console.debug(`[NIP-11]   Max event size: ${capabilities.maxEventSize}, max subscriptions: ${capabilities.maxSubscriptions}`);

        return capabilities;
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof Error && error.name === 'AbortError') {
          console.debug(`[NIP-11] Timeout fetching info from ${domainUrl.hostname}`);
        } else {
          console.debug(`[NIP-11] Error fetching info from ${domainUrl.hostname}: ${error}`);
        }
        return null;
      }
    } catch (error) {
      console.debug(`[NIP-11] Invalid relay URL for NIP-11: ${relayUrl}`);
      return null;
    }
  }

  /**
   * Fetch info from multiple relays (for startup initialization)
   */
  async fetchRelayInfoBatch(relayUrls: string[]): Promise<Map<string, RelayCapabilities | null>> {
    console.debug(`[NIP-11] Fetching capabilities for ${relayUrls.length} relays...`);
    const results = new Map<string, RelayCapabilities | null>();

    // Fetch in parallel with timeout protection
    const promises = relayUrls.map(async (url) => {
      const caps = await this.fetchRelayInfo(url);
      return { url, caps };
    });

    const fetched = await Promise.all(promises);
    for (const { url, caps } of fetched) {
      results.set(url, caps);
    }

    const successful = Array.from(results.values()).filter(c => c !== null).length;
    console.log(`[NIP-11] Fetched capabilities from ${successful}/${relayUrls.length} relays`);

    return results;
  }

  /**
   * Get cached capability info for a relay
   */
  getCapabilities(relayUrl: string): RelayCapabilities | undefined {
    return this.capabilities.get(relayUrl);
  }

  /**
   * Check if a relay supports ephemeral messages (kinds 20000-29999)
   */
  supportsEphemeral(relayUrl: string): boolean {
    const caps = this.capabilities.get(relayUrl);
    return caps?.supportsEphemeral ?? false; // Assume false if unknown
  }

  private _parseCapabilities(relayUrl: string, info: RelayInfo): RelayCapabilities {
    const limit = info.limitation || {};
    const maxEventSize = limit.max_content_length ?? 262144; // Default 256KB
    const maxSubscriptions = limit.max_subscriptions ?? 20; // Default 20

    // Check if relay lists support for standard event kinds (NIP-01 / NIP-16)
    const supportedNips = info.supported_nips ?? [];
    const supportsEphemeral = supportedNips.length === 0 || supportedNips.includes(1) || supportedNips.includes(16);

    return {
      url: relayUrl,
      fetched_at: Date.now(),
      info,
      supportsEphemeral,
      maxEventSize,
      maxSubscriptions,
      authRequired: limit.auth_required ?? false,
      paymentRequired: limit.payment_required ?? false,
    };
  }
}

// Singleton instance
export const nip11Handler = new NIP11Handler();
