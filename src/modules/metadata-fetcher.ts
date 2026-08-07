/**
 * Hang Time - Metadata Fetcher
 * Fetches and caches game metadata from Steam API
 */

/// <reference types="node" />

import { GameMetadata, STORAGE_KEYS } from '../types';
import { StorageManager } from './storage';

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const FETCH_TIMEOUT_MS = 5000; // 5 seconds
const MAX_RETRIES = 3;
// Conservative: 1 request per 2 seconds to avoid Steam 429 rate limits
const RATE_LIMIT_REQUESTS_PER_SECOND = 0.5;

/**
 * Token bucket rate limiter for API requests
 */
class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private readonly tokensPerSecond: number;

  constructor(tokensPerSecond: number) {
    this.tokensPerSecond = tokensPerSecond;
    this.tokens = tokensPerSecond;
    this.lastRefillTime = Date.now();
  }

  /**
   * Acquire a token, waiting if necessary
   */
  async acquireToken(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRefill = (now - this.lastRefillTime) / 1000;
    const tokensToAdd = timeSinceLastRefill * this.tokensPerSecond;

    this.tokens = Math.min(this.tokensPerSecond, this.tokens + tokensToAdd);
    this.lastRefillTime = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait for a token to become available
    const waitTime = (1 - this.tokens) / this.tokensPerSecond * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
    this.tokens = 0;
    this.lastRefillTime = Date.now();
  }
}

/**
 * Manages game metadata fetching and caching from Steam API
 */
export class MetadataFetcher {
  private static instance: MetadataFetcher;
  private rateLimiter: RateLimiter;
  private fetchQueue: number[] = [];
  private failedAppIds: Map<number, number> = new Map();
  private isProcessing: boolean = false;
  private processingIntervalId: NodeJS.Timeout | null = null;
  private globalRateLimitedUntil: number = 0; // Pause all processing if we hit Steam's limit

  private constructor(private storage: StorageManager) {
    this.rateLimiter = new RateLimiter(RATE_LIMIT_REQUESTS_PER_SECOND);
  }

  /**
   * Get or create singleton instance
   */
  static getInstance(storage: StorageManager): MetadataFetcher {
    if (!MetadataFetcher.instance) {
      MetadataFetcher.instance = new MetadataFetcher(storage);
    }
    return MetadataFetcher.instance;
  }

  /**
   * Fetch metadata for a single game, using cache if available and fresh
   */
  async fetchMetadata(appId: number): Promise<GameMetadata | null> {
    try {
      console.debug(`[Metadata] Fetching metadata for appId: ${appId}`);

      // Check cache first
      const cached = await this.getCachedMetadata(appId);
      if (cached && !this.isCacheStale(cached)) {
        console.debug(`[Metadata] Returning cached metadata for appId: ${appId}`);
        return cached;
      }

      // Cache is missing or stale - fetch from Steam API and SteamSpy in parallel
      const [raw, steamSpyData] = await Promise.all([
        this.fetchFromSteamAPI(appId),
        this.fetchFromSteamSpy(appId),
      ]);

      if (!raw) {
        console.warn(`[Metadata] Failed to fetch from Steam API for appId: ${appId}`);
        return null;
      }

      // Parse and cache the metadata (with SteamSpy data for review score)
      const metadata = this.parseAppDetails(raw, appId, steamSpyData);
      if (!metadata) {
        console.warn(`[Metadata] Failed to parse app details for appId: ${appId}`);
        return null;
      }

      // Store in cache
      await this.setCachedMetadata(appId, metadata);
      console.debug(`[Metadata] Cached metadata for appId: ${appId}`);

      return metadata;
    } catch (error) {
      console.error(`[Metadata] Error fetching metadata for appId ${appId}:`, error);
      return null;
    }
  }

  /**
   * Get metadata for a game (shortcut for fetchMetadata)
   */
  async getMetadata(appId: number): Promise<GameMetadata | null> {
    return this.fetchMetadata(appId);
  }

  /**
   * Batch fetch metadata for multiple games
   */
  async batchFetchMetadata(appIds: number[]): Promise<Map<number, GameMetadata>> {
    const result = new Map<number, GameMetadata>();

    console.debug(`[Metadata] Batch fetching metadata for ${appIds.length} games`);

    for (const appId of appIds) {
      const metadata = await this.fetchMetadata(appId);
      if (metadata) {
        result.set(appId, metadata);
      }
    }

    console.debug(`[Metadata] Batch fetch complete: ${result.size}/${appIds.length} games`);
    return result;
  }

  /**
   * Schedule app IDs for background refresh with queue and retry logic
   */
  async scheduleBackgroundRefresh(appIds: number[]): Promise<void> {
    try {
      console.debug(`[Metadata] Scheduling ${appIds.length} games for background refresh`);

      // Add to fetch queue for background processing
      this.fetchQueue.push(...appIds);

      console.debug(
        `[Metadata] Fetch queue now has ${this.fetchQueue.length} items`
      );
    } catch (error) {
      console.error('[Metadata] Failed to schedule background refresh:', error);
      throw error;
    }
  }

  /**
   * Start background fetcher - processes queue continuously
   */
  async startBackgroundFetcher(): Promise<void> {
    if (this.processingIntervalId !== null) {
      console.debug('[Metadata] Background fetcher already running');
      return;
    }

    console.log('[Metadata] Background fetcher started');

    this.processingIntervalId = setInterval(async () => {
      try {
        await this.processQueue();
      } catch (error) {
        console.error('[Metadata] Error in background fetch cycle:', error);
      }
    }, 100); // Process queue every 100ms
  }

  /**
   * Stop background fetcher
   */
  async stopBackgroundFetcher(): Promise<void> {
    if (this.processingIntervalId !== null) {
      clearInterval(this.processingIntervalId);
      this.processingIntervalId = null;
      this.isProcessing = false;
      console.log('[Metadata] Background fetcher stopped');
    }
  }

  /**
   * Process the fetch queue - called periodically by background fetcher
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.fetchQueue.length === 0) {
      return;
    }

    // Check if globally rate limited by Steam
    if (Date.now() < this.globalRateLimitedUntil) {
      const waitMs = this.globalRateLimitedUntil - Date.now();
      console.warn(
        `[Metadata] 🛑 Steam API globally rate limited, pausing for ${Math.round(waitMs / 1000)}s (${this.fetchQueue.length} items queued)`
      );
      return;
    }

    this.isProcessing = true;

    try {
      while (this.fetchQueue.length > 0) {
        const appId = this.fetchQueue.shift();
        if (appId === undefined) break;

        try {
          const result = await this.fetchFromSteamAPI(appId);

          // Handle rate limit response (429)
          if (result && result.__rateLimited) {
            // Implement exponential global backoff: start at 30s, increase with each event
            const globalBackoffMs = Math.min(60000, 30000 * Math.pow(1.5, this.failedAppIds.size));
            this.globalRateLimitedUntil = Date.now() + globalBackoffMs;

            console.warn(
              `[Metadata] ⚠️  Steam API returned 429 for appId ${appId}, pausing ALL requests for ${Math.round(globalBackoffMs / 1000)}s`
            );

            // Re-queue this appId at front of queue for later retry
            const retryCount = this.failedAppIds.get(appId) || 0;
            if (retryCount < MAX_RETRIES) {
              this.fetchQueue.unshift(appId); // Put back at front
              this.failedAppIds.set(appId, retryCount + 1);
            } else {
              console.warn(`[Metadata] ⚠️  Max retries exceeded for appId ${appId} (rate limit)`);
              this.failedAppIds.delete(appId);
            }
            break; // Stop processing; wait for global backoff to expire
          }

          // Handle timeout response
          if (result && result.__timeout) {
            const retryCount = this.failedAppIds.get(appId) || 0;
            if (retryCount < MAX_RETRIES) {
              const backoffMs = this.calculateBackoff(retryCount);
              console.debug(`[Metadata] Timeout for appId ${appId}, retrying after ${backoffMs}ms`);
              setTimeout(() => this.fetchQueue.push(appId), backoffMs);
              this.failedAppIds.set(appId, retryCount + 1);
            } else {
              console.warn(`[Metadata] ⚠️  Max retries exceeded for appId ${appId} (timeout)`);
              this.failedAppIds.delete(appId);
            }
            continue;
          }

          // Handle network error response
          if (result && result.__networkError) {
            const retryCount = this.failedAppIds.get(appId) || 0;
            if (retryCount < MAX_RETRIES) {
              const backoffMs = this.calculateBackoff(retryCount);
              console.debug(`[Metadata] Network error for appId ${appId}, retrying after ${backoffMs}ms`);
              setTimeout(() => this.fetchQueue.push(appId), backoffMs);
              this.failedAppIds.set(appId, retryCount + 1);
            } else {
              console.warn(`[Metadata] ⚠️  Max retries exceeded for appId ${appId} (network error)`);
              this.failedAppIds.delete(appId);
            }
            continue;
          }

          // Handle 404 (not found) - don't retry
          if (result === null) {
            // Check if this was a 404 or other error
            // For now, treat null as "not found" and don't retry
            console.debug(`[Metadata] App ${appId} not found or invalid, skipping retry`);
            this.failedAppIds.delete(appId);
            continue;
          }

          // Success - fetch SteamSpy data and parse
          if (result) {
            // Fetch SteamSpy data to get review score
            const steamSpyData = await this.fetchFromSteamSpy(appId);
            const metadata = this.parseAppDetails(result, appId, steamSpyData);
            if (metadata) {
              await this.setCachedMetadata(appId, metadata);
              console.debug(`[Metadata] ✅ Successfully fetched and cached appId ${appId} in background`);
              this.failedAppIds.delete(appId);
            }
          }
        } catch (error) {
          console.error(`[Metadata] Unexpected error processing appId ${appId}:`, error);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Calculate exponential backoff: 2^retryCount seconds
   */
  private calculateBackoff(retryCount: number): number {
    const seconds = Math.pow(2, retryCount);
    return seconds * 1000; // Convert to milliseconds
  }

  /**
   * Fetch metadata from Steam API with rate limiting
   */
  private async fetchFromSteamAPI(appId: number): Promise<any> {
    const API_BASE = 'https://store.steampowered.com/api';

    try {
      // Acquire rate limit token before making request
      await this.rateLimiter.acquireToken();

      const url = `${API_BASE}/appdetails?appids=${appId}`;

      console.debug(`[Metadata] Calling Steam API: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        // Handle rate limit response
        if (response.status === 429) {
          console.warn(`[Metadata] Steam API rate limited (429) for appId ${appId}`);
          // Return special value to indicate rate limit
          return { __rateLimited: true };
        }

        if (!response.ok) {
          console.warn(`[Metadata] Steam API returned ${response.status} for appId ${appId}`);
          return null;
        }

        const data = await response.json();

        // Check if app exists in response
        if (!data[appId]) {
          console.debug(`[Metadata] App ${appId} not found in Steam API response`);
          return null;
        }

        // Check if app data is valid
        const appData = data[appId];
        if (!appData.success) {
          console.debug(`[Metadata] Steam API returned success=false for appId ${appId}`);
          return null;
        }

        console.debug(`[Metadata] Steam API response received for appId ${appId}`);
        return appData;
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          console.warn(`[Metadata] ⚠️  Steam API request timeout (${FETCH_TIMEOUT_MS}ms) for appId ${appId}`);
          return { __timeout: true };
        } else {
          console.warn(`[Metadata] ⚠️  Steam API fetch error for appId ${appId}:`, error.message);
          return { __networkError: true };
        }
      }
    } catch (error) {
      console.error(`[Metadata] Unexpected error calling Steam API for appId ${appId}:`, error);
      return null;
    }
  }

  /**
   * Fetch review data from SteamSpy API (no rate limiting needed)
   */
  private async fetchFromSteamSpy(appId: number): Promise<any> {
    try {
      const url = `https://steamspy.com/api.php?request=appdetails&appid=${appId}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
          console.debug(`[Metadata] SteamSpy returned ${response.status} for appId ${appId}`);
          return null;
        }

        const data = await response.json();
        console.debug(`[Metadata] SteamSpy response received for appId ${appId}`);
        return data;
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          console.debug(`[Metadata] SteamSpy request timeout for appId ${appId}`);
        } else {
          console.debug(`[Metadata] SteamSpy fetch error for appId ${appId}:`, error.message);
        }
        return null;
      }
    } catch (error) {
      console.error(`[Metadata] Unexpected error calling SteamSpy for appId ${appId}:`, error);
      return null;
    }
  }

  /**
   * Parse app details response from Steam API and SteamSpy
   */
  private parseAppDetails(raw: any, appId: number, steamSpyData?: any): GameMetadata | null {
    try {
      const data = raw.data;

      if (!data) {
        console.warn(`[Metadata] No data field in Steam API response for appId ${appId}`);
        return null;
      }

      // Extract basic info
      const name = data.name || `Unknown Game (${appId})`;
      const storePageUrl = `https://store.steampowered.com/app/${appId}/`;
      const capsuleImageUrl = data.header_image || '';

      // Extract genres
      const genres: string[] = [];
      if (data.genres && Array.isArray(data.genres)) {
        data.genres.forEach((genreObj: any) => {
          if (genreObj.description) {
            genres.push(genreObj.description);
          }
        });
      }

      // Extract categories
      const categories: string[] = [];
      if (data.categories && Array.isArray(data.categories)) {
        data.categories.forEach((categoryObj: any) => {
          if (categoryObj.description) {
            categories.push(categoryObj.description);
          }
        });
      }

      // Extract platforms
      const platforms = {
        windows: data.platforms?.windows || false,
        mac: data.platforms?.mac || false,
        linux: data.platforms?.linux || false,
      };

      // Extract user review score from SteamSpy (calculated from positive/negative)
      let metacriticScore: number | undefined;
      if (steamSpyData && steamSpyData.positive && steamSpyData.negative) {
        const total = steamSpyData.positive + steamSpyData.negative;
        if (total > 0) {
          metacriticScore = Math.round((steamSpyData.positive / total) * 100);
          console.debug(`[Metadata] SteamSpy score for appId ${appId}: ${metacriticScore}% (${steamSpyData.positive} positive, ${steamSpyData.negative} negative)`);
        }
      }

      // Detect cross-platform support
      const isCrossPlayable = this.isCrossPlayable({
        appId,
        name,
        genres,
        categories,
        platforms,
        metacriticScore,
        capsuleImageUrl,
        storePageUrl,
        lastFetched: Date.now(),
      });

      const metadata: GameMetadata = {
        appId,
        name,
        genres,
        categories,
        platforms,
        metacriticScore,
        capsuleImageUrl,
        storePageUrl,
        lastFetched: Date.now(),
        isCrossPlayable,
      };

      console.debug(
        `[Metadata] Parsed metadata for ${name} (${appId}): ${genres.length} genres, cross-playable: ${isCrossPlayable}`
      );

      return metadata;
    } catch (error) {
      console.error(`[Metadata] Error parsing app details for appId ${appId}:`, error);
      return null;
    }
  }

  /**
   * Check if cache is stale (older than 30 days)
   */
  private isCacheStale(metadata: GameMetadata): boolean {
    const age = Date.now() - metadata.lastFetched;
    const isStale = age > CACHE_TTL_MS;
    const ageInDays = Math.round(age / 1000 / 60 / 60 / 24);
    console.debug(`[Metadata] Cache age: ${ageInDays} days, stale: ${isStale}`);
    return isStale;
  }

  /**
   * Check if game is cross-playable (2+ platforms)
   */
  private isCrossPlayable(metadata: GameMetadata): boolean {
    const platformCount = [
      metadata.platforms.windows,
      metadata.platforms.mac,
      metadata.platforms.linux,
    ].filter(Boolean).length;

    return platformCount >= 2;
  }

  /**
   * Get metadata from cache
   */
  async getCachedMetadata(appId: number): Promise<GameMetadata | null> {
    try {
      const cache = await this.storage.get<Record<number, GameMetadata>>(
        STORAGE_KEYS.GAME_METADATA_CACHE,
        {}
      );

      if (!cache || !cache[appId]) {
        return null;
      }

      return cache[appId];
    } catch (error) {
      console.error(`[Metadata] Error reading cache for appId ${appId}:`, error);
      return null;
    }
  }

  /**
   * Store metadata in cache
   */
  private async setCachedMetadata(appId: number, metadata: GameMetadata): Promise<void> {
    try {
      const cache = (await this.storage.get<Record<number, GameMetadata>>(
        STORAGE_KEYS.GAME_METADATA_CACHE,
        {}
      )) || {};

      cache[appId] = metadata;

      await this.storage.set(STORAGE_KEYS.GAME_METADATA_CACHE, cache);
      console.debug(`[Metadata] Stored metadata in cache for appId ${appId}`);
    } catch (error) {
      console.error(`[Metadata] Error writing cache for appId ${appId}:`, error);
      throw error;
    }
  }

  /**
   * Get current fetch queue (for testing)
   */
  getFetchQueue(): number[] {
    return [...this.fetchQueue];
  }

  /**
   * Clear fetch queue (for testing)
   */
  clearFetchQueue(): void {
    this.fetchQueue = [];
  }

  /**
   * Get failed appIds and their retry counts (for testing)
   */
  getFailedAppIds(): Map<number, number> {
    return new Map(this.failedAppIds);
  }

  /**
   * Check if background fetcher is running (for testing)
   */
  isBackgroundFetcherRunning(): boolean {
    return this.processingIntervalId !== null;
  }

  /**
   * Check if queue is currently being processed (for testing)
   */
  isQueueProcessing(): boolean {
    return this.isProcessing;
  }
}

// Singleton instance
export let metadataFetcher: MetadataFetcher;

/**
 * Initialize singleton (called from background.ts)
 */
export function initializeMetadataFetcher(storage: StorageManager): void {
  metadataFetcher = MetadataFetcher.getInstance(storage);
  console.debug('[Metadata] Initialized MetadataFetcher');
}
