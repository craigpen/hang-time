/**
 * Hang Time - Game Library Manager
 * Manages game library fetching, caching, and common game discovery
 */

import { OwnedGame, STORAGE_KEYS, NostrEvent, NostrError } from '../types';
import { StorageManager } from './storage';
import { RelayPool } from './nostr';
import { IdentityManager } from './identity';
import { encryptionManager } from './encryption';
import type { PublishQueue } from './publish-queue';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Cached friend game library data
 */
interface CachedFriendGameLibrary {
  pubkey: string;
  appIds: number[];
  lastUpdated: number;
}

/**
 * Manages user's game library and friend's game libraries
 */
export class GameLibraryManager {
  private static instance: GameLibraryManager;
  private relayPool: RelayPool | null = null;
  private identityManager: IdentityManager | null = null;
  private publishQueue: PublishQueue | null = null;
  private activeGameLibrarySubscriptions: Map<string, void> = new Map();

  private constructor(private storage: StorageManager) {}

  /**
   * Get or create singleton instance
   */
  static getInstance(storage: StorageManager): GameLibraryManager {
    if (!GameLibraryManager.instance) {
      GameLibraryManager.instance = new GameLibraryManager(storage);
    }
    return GameLibraryManager.instance;
  }

  /**
   * Set relay pool and identity manager for Nostr integration
   */
  setNostrDependencies(relayPool: RelayPool, identityManager: IdentityManager): void {
    this.relayPool = relayPool;
    this.identityManager = identityManager;
    console.debug('[GameLibrary] Nostr dependencies initialized');
  }

  /**
   * Set the publish queue (called after queue is initialized)
   */
  setPublishQueue(queue: PublishQueue): void {
    this.publishQueue = queue;
  }

  /**
   * Fetch user's owned games from Steam API and cache them
   */
  async fetchMyGameLibrary(): Promise<OwnedGame[]> {
    try {
      console.debug('[GameLibrary] Fetching own game library from Steam API');

      const profile = await this.storage.getUserProfile();
      if (!profile?.steam_config?.steam_id) {
        console.warn('[GameLibrary] Steam ID not configured');
        return [];
      }

      // Call Steam GetOwnedGames API
      const games = await this._fetchFromSteamAPI(profile.steam_config.steam_id);

      // Store in cache with timestamp
      const cacheData = {
        ownedGames: games,
        lastFetched: Date.now(),
        steamId: profile.steam_config.steam_id,
      };

      await this.storage.set(STORAGE_KEYS.MY_GAME_LIBRARY, cacheData);
      console.debug(`[GameLibrary] Cached ${games.length} owned games`);

      return games;
    } catch (error) {
      console.error('[GameLibrary] Failed to fetch game library:', error);
      throw error;
    }
  }

  /**
   * Get user's game library, fetching from Steam if cache is stale
   */
  async getMyGameLibrary(): Promise<OwnedGame[]> {
    try {
      const cached = await this.storage.get<any>(STORAGE_KEYS.MY_GAME_LIBRARY);

      // Check if cache exists and is fresh
      if (cached?.ownedGames && !this.isCacheStale(cached.lastFetched)) {
        console.debug('[GameLibrary] Returning cached game library');
        return cached.ownedGames;
      }

      // Cache is stale or missing - fetch fresh data
      return await this.fetchMyGameLibrary();
    } catch (error) {
      console.error('[GameLibrary] Failed to get game library:', error);
      // Return empty array on error
      return [];
    }
  }

  /**
   * Calculate games in common between user and a friend
   */
  async getCommonGames(friendPubkey: string): Promise<OwnedGame[]> {
    try {
      console.debug('[GameLibrary] Calculating common games for friend:', friendPubkey);

      // Load my games
      const myGames = await this.getMyGameLibrary();
      const myAppIds = myGames.map(g => g.appId);

      // Load friend's games
      const friendLibrary = await this.getFriendGameLibrary(friendPubkey);
      if (!friendLibrary) {
        console.debug('[GameLibrary] Friend game library not found or stale');
        return [];
      }

      // Calculate intersection
      const commonAppIds = this.calculateCommonAppIds(myAppIds, friendLibrary.map(g => g.appId));

      // Return common games as OwnedGame[]
      const commonGames = myGames.filter(g => commonAppIds.includes(g.appId));

      console.debug(`[GameLibrary] Found ${commonGames.length} common games with friend`);
      return commonGames;
    } catch (error) {
      console.error('[GameLibrary] Failed to calculate common games:', error);
      return [];
    }
  }

  /**
   * Cache a friend's game library
   */
  async cacheFriendGameLibrary(friendPubkey: string, appIds: number[]): Promise<void> {
    try {
      console.debug(`[GameLibrary] Caching ${appIds.length} games for friend:`, friendPubkey);

      const friendLibraries = (await this.storage.get<Record<string, CachedFriendGameLibrary>>(
        STORAGE_KEYS.FRIEND_GAME_LIBRARIES,
        {}
      )) || {};

      friendLibraries[friendPubkey] = {
        pubkey: friendPubkey,
        appIds,
        lastUpdated: Date.now(),
      };

      await this.storage.set(STORAGE_KEYS.FRIEND_GAME_LIBRARIES, friendLibraries);
      console.debug('[GameLibrary] Friend game library cached');
    } catch (error) {
      console.error('[GameLibrary] Failed to cache friend game library:', error);
      throw error;
    }
  }

  /**
   * Get cached friend's game library if fresh
   */
  async getFriendGameLibrary(friendPubkey: string): Promise<OwnedGame[] | null> {
    try {
      const friendLibraries = await this.storage.get<Record<string, CachedFriendGameLibrary>>(
        STORAGE_KEYS.FRIEND_GAME_LIBRARIES,
        {}
      );

      const friendData = friendLibraries?.[friendPubkey];
      if (!friendData) {
        console.debug('[GameLibrary] Friend library not cached:', friendPubkey);
        return null;
      }

      // Check if cache is stale
      if (this.isCacheStale(friendData.lastUpdated)) {
        console.debug('[GameLibrary] Friend library cache stale:', friendPubkey);
        return null;
      }

      // Convert appIds back to OwnedGame[]
      const games: OwnedGame[] = friendData.appIds.map(appId => ({
        appId,
        lastUpdated: friendData.lastUpdated,
      }));

      console.debug(`[GameLibrary] Retrieved ${games.length} cached games for friend`);
      return games;
    } catch (error) {
      console.error('[GameLibrary] Failed to get friend game library:', error);
      return null;
    }
  }

  /**
   * Check if cache timestamp is stale (older than 7 days)
   */
  private isCacheStale(timestamp: number): boolean {
    const age = Date.now() - timestamp;
    const isStale = age > CACHE_TTL_MS;
    console.debug(`[GameLibrary] Cache age: ${Math.round(age / 1000 / 60)} minutes, stale: ${isStale}`);
    return isStale;
  }

  /**
   * Calculate intersection of two app ID arrays
   */
  private calculateCommonAppIds(myIds: number[], friendIds: number[]): number[] {
    const friendSet = new Set(friendIds);
    return myIds.filter(id => friendSet.has(id));
  }

  /**
   * Fetch owned games from Steam API
   */
  private async _fetchFromSteamAPI(steamId: string): Promise<OwnedGame[]> {
    const API_BASE = 'https://api.steampowered.com';

    try {
      const url = `${API_BASE}/IPlayerService/GetOwnedGames/v1/`;
      const params = new URLSearchParams({
        steamid: steamId,
        include_appinfo: 'true',
        include_played_free_games: 'true',
      });

      const profile = await this.storage.getUserProfile();
      if (profile?.steam_config?.api_key) {
        params.append('key', profile.steam_config.api_key);
      }

      console.debug('[GameLibrary] Calling Steam API:', url);
      const response = await fetch(`${url}?${params}`);

      if (!response.ok) {
        throw new Error(`Steam API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.debug('[GameLibrary] Steam API response received');

      if (!data.response?.games) {
        console.warn('[GameLibrary] No games in Steam API response');
        return [];
      }

      // Convert Steam API response to OwnedGame[]
      const games: OwnedGame[] = data.response.games.map((game: any) => ({
        appId: game.appid,
        platformsOwned: {
          windows: true, // Steam API doesn't provide platform info, assume Windows
          mac: false,
          linux: false,
        },
        lastUpdated: Date.now(),
        rtime_last_played: game.rtime_last_played ?? 0, // Unix timestamp, 0 if never played
      }));

      console.debug(`[GameLibrary] Parsed ${games.length} games from Steam API`);
      return games;
    } catch (error) {
      console.error('[GameLibrary] Steam API call failed:', error);
      throw error;
    }
  }

  /**
   * Publish user's game library as a Nostr kind 1 event
   */
  async publishMyGameLibrary(): Promise<void> {
    try {
      if (!this.relayPool || !this.identityManager) {
        console.warn('[GameLibrary] Nostr dependencies not initialized, skipping publication');
        return;
      }

      console.debug('[GameLibrary] Publishing my game library to Nostr');

      // Get user's pubkey and secret key
      const pubkey = await this.identityManager.getPubkey();
      const secretKey = await this.identityManager.getSecretKey();

      // Get cached game library
      const cached = await this.storage.get<any>(STORAGE_KEYS.MY_GAME_LIBRARY);
      if (!cached?.ownedGames) {
        console.warn('[GameLibrary] No cached game library to publish');
        return;
      }

      const library = cached.ownedGames;
      const appIds = library.map((game: OwnedGame) => game.appId);

      // Get user's Steam ID for tag
      const profile = await this.storage.getUserProfile();
      const steamId = profile?.steam_config?.steam_id || '';

      // Create Nostr event
      const created_at = Math.floor(Date.now() / 1000);
      const content = JSON.stringify({
        appIds,
        count: library.length,
        timestamp: Date.now(),
      });

      const event: NostrEvent = {
        id: '',
        pubkey,
        created_at,
        kind: 1,
        tags: [
          ['t', 'game-library'],
          ['steam-id', steamId],
        ],
        content,
      };

      // Compute event ID (SHA256 of canonical JSON)
      const eventData = [0, pubkey, created_at, 1, event.tags, content];
      const canonicalJson = JSON.stringify(eventData);
      const eventId = await encryptionManager.sha256(canonicalJson);
      event.id = eventId.substring(0, 64);

      // Sign the event
      event.sig = encryptionManager.signEvent(event.id, secretKey);

      console.debug(`[GameLibrary] Marking game library as due (${appIds.length} games)`);

      if (this.publishQueue) {
        this.publishQueue.markGameLibraryDue(event);
        console.log(`[GameLibrary] ✓ Game library marked as due for publishing`);
      } else {
        // Fallback if queue not initialized
        await this.relayPool.publish(event);
        console.log(`[GameLibrary] ✓ Published game library directly (${appIds.length} games)`);
      }
    } catch (error) {
      console.error('[GameLibrary] Failed to publish game library:', error);
      throw error;
    }
  }

  /**
   * Subscribe to friends' game library events from Nostr
   */
  async subscribeToFriendGames(friendPubkeys: string[]): Promise<void> {
    try {
      if (!this.relayPool) {
        console.warn('[GameLibrary] Relay pool not initialized, skipping subscription');
        return;
      }

      console.debug(`[GameLibrary] Subscribing to ${friendPubkeys.length} friends' game libraries`);

      for (const pubkey of friendPubkeys) {
        if (this.activeGameLibrarySubscriptions.has(pubkey)) {
          continue;
        }

        this.relayPool.subscribe(pubkey, async (event: NostrEvent) => {
          await this.handleGameLibraryEvent(event);
        });

        this.activeGameLibrarySubscriptions.set(pubkey, undefined);
        console.debug(`[GameLibrary] Subscribed to friend game library: ${pubkey.substring(0, 16)}...`);
      }

      console.log(`[GameLibrary] Subscribed to ${friendPubkeys.length} friends' game libraries`);
    } catch (error) {
      console.error('[GameLibrary] Failed to subscribe to friend games:', error);
      throw error;
    }
  }

  /**
   * Unsubscribe from friends' game library events
   */
  async unsubscribeFromFriendGames(friendPubkeys: string[]): Promise<void> {
    try {
      console.debug(`[GameLibrary] Unsubscribing from ${friendPubkeys.length} friends' game libraries`);

      for (const pubkey of friendPubkeys) {
        this.activeGameLibrarySubscriptions.delete(pubkey);
      }

      // Note: Full unsubscribe from relay pool would require additional API
      // For now, we just stop processing events for these friends
      console.log(`[GameLibrary] Unsubscribed from ${friendPubkeys.length} friends' game libraries`);
    } catch (error) {
      console.error('[GameLibrary] Failed to unsubscribe from friend games:', error);
      throw error;
    }
  }

  /**
   * Handle incoming game library event from Nostr
   * Public for integration with RelayPool
   */
  async handleGameLibraryEvent(event: NostrEvent): Promise<void> {
    try {
      // Validate event has game-library tag
      const hasGameLibraryTag = event.tags.find((t) => t[0] === 't' && t[1] === 'game-library');
      if (!hasGameLibraryTag) {
        console.debug('[GameLibrary] Event does not have game-library tag, skipping');
        return;
      }

      // Parse content as JSON
      let data: any;
      try {
        data = JSON.parse(event.content);
      } catch (error) {
        console.error('[GameLibrary] Failed to parse game library event content:', error);
        return;
      }

      // Extract appIds array
      if (!Array.isArray(data.appIds)) {
        console.warn('[GameLibrary] Event content missing appIds array');
        return;
      }

      const appIds = data.appIds as number[];

      // Cache friend's game library
      await this.cacheFriendGameLibrary(event.pubkey, appIds);
      console.log(`[GameLibrary] Received library from friend (${appIds.length} games)`);
    } catch (error) {
      console.error('[GameLibrary] Error handling game library event:', error);
      // Gracefully handle errors without stopping other processing
    }
  }
}

// Singleton instance
export let gameLibraryManager: GameLibraryManager;

/**
 * Initialize singleton (called from background.ts)
 */
export function initializeGameLibraryManager(storage: StorageManager): void {
  gameLibraryManager = GameLibraryManager.getInstance(storage);
  console.debug('[GameLibrary] Initialized GameLibraryManager');
}
