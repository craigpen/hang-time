/**
 * Hang Time - Storage Manager
 * Abstracts chrome.storage.local for all persistence operations
 */

import {
  UserProfile,
  Friend,
  FriendList,
  Activity,
  Message,
  Settings,
  OAuthToken,
  OAuthTokens,
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  StorageError,
  ActivityHistory,
  PendingInvite,
  PendingMessage,
  ActivityAcceptance,
  CoWatchSession,
  ServiceName,
} from '../types';


export class StorageManager {
  // ============================================================================
  // CACHING INFRASTRUCTURE
  // ============================================================================

  private cache: Map<string, any> = new Map();
  private syncTimer: NodeJS.Timeout | null = null;
  private syncScheduled = false;
  private isInitialized = false;
  private sessionId: string = '';
  private sessionIdReady: Promise<void>;
  private resolveSessionId!: () => void;

  constructor() {
    // Generate a unique instance ID on every load (not persisted)
    // This ensures different extension instances (same ID in different profiles) have isolated storage
    const randomId = crypto.getRandomValues(new Uint8Array(4));
    const hexId = Array.from(randomId).map(b => b.toString(16).padStart(2, '0')).join('');
    this.sessionId = hexId.substring(0, 8);
    console.debug(`[Storage] Generated instance ID: ${this.sessionId}`);

    // Create a promise that resolves when sessionId is ready
    this.sessionIdReady = new Promise(resolve => {
      this.resolveSessionId = resolve;
    });
  }

  /**
   * Wait for session ID to be ready before proceeding
   */
  async waitForSessionId(): Promise<void> {
    return this.sessionIdReady;
  }

  /**
   * Set the session ID (derived from user UUID) for storage isolation.
   * Must be called before storage operations to ensure instance isolation.
   * @param uuid - User's UUID (e.g., from IdentityManager)
   */
  async setSessionId(uuid: string): Promise<void> {
    this.sessionId = uuid.substring(0, 8); // Use first 8 chars of UUID
    // Store in unnamespaced bootstrap key for future reloads
    try {
      await chrome.storage.local.set({ 'hang_time_session_id': this.sessionId });
      console.debug(`[Storage] Session ID set to: ${this.sessionId} (persisted)`);
    } catch (error) {
      console.error('[Storage] Failed to persist session ID:', error);
      // Continue anyway - sessionId is set in memory
    }
    // Signal that sessionId is ready
    this.resolveSessionId();
  }

  /**
   * Prefix a storage key with the session ID for instance isolation.
   * Shared keys (like logs) are NOT namespaced so all instances can write to them.
   * If no session ID is set, uses unnamespaced key (during initialization).
   */
  private prefixKey(key: string): string {
    // Shared keys that should NOT be namespaced
    if (key.startsWith('hang_time_file_logs_')) {
      return key; // Logs are shared across all instances
    }

    if (!this.sessionId) {
      // During initialization, before sessionId is set
      return key;
    }
    return `${this.sessionId}:${key}`;
  }

  /**
   * Initialize cache from storage (call on extension startup)
   * FAILS HARD if cache initialization fails - no silent degradation
   */
  async init(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Load stored session ID (unnamespaced bootstrap key for instance isolation)
      const bootstrapData = await chrome.storage.local.get(['hang_time_session_id']);
      if (bootstrapData['hang_time_session_id']) {
        this.sessionId = bootstrapData['hang_time_session_id'];
        console.debug('[Storage] Session ID loaded from bootstrap key:', this.sessionId);
        // Signal that sessionId is ready (from previous session)
        this.resolveSessionId();
      } else {
        console.debug('[Storage] No session ID found - will be set after IdentityManager initializes');
      }

      // Only load static string keys (not functions like MESSAGES, ACTIVITY_HISTORY)
      const staticKeys = [
        STORAGE_KEYS.USER_PROFILE,
        STORAGE_KEYS.FRIENDS_LIST,
        STORAGE_KEYS.OAUTH_TOKENS,
        STORAGE_KEYS.CURRENT_ACTIVITY,
        STORAGE_KEYS.MY_ACTIVITIES,
        STORAGE_KEYS.SETTINGS,
        STORAGE_KEYS.VIDEO_DATA_METRICS,
        STORAGE_KEYS.PENDING_INVITES,
        STORAGE_KEYS.RECEIVED_INVITES,
        STORAGE_KEYS.ACTIVITY_DIAGNOSTICS,
        STORAGE_KEYS.PENDING_MESSAGES,
        STORAGE_KEYS.NOTIFIED_INVITE_IDS,
        STORAGE_KEYS.OAUTH_CONFIG,
        STORAGE_KEYS.NETFLIX_TITLE,
        STORAGE_KEYS.NETFLIX_TITLE_DATA,
        STORAGE_KEYS.CONTENT_SCRIPT_HEALTH,
        STORAGE_KEYS.INTEGRATION_HEALTH,
        STORAGE_KEYS.NETFLIX_EXTRACTION_LOGS,
        STORAGE_KEYS.NETFLIX_DEBUG_CAPTURES,
        STORAGE_KEYS.ACTIVITY_PROVENANCE_MAP,
        STORAGE_KEYS.MY_GAME_LIBRARY,
        STORAGE_KEYS.FRIEND_GAME_LIBRARIES,
        STORAGE_KEYS.GAME_METADATA_CACHE,
        STORAGE_KEYS.FRIEND_PROFILES,
        STORAGE_KEYS.ACTIVITY_ACCEPTANCES,
      ];

      // Try to load with session ID prefix; fall back to unnamespaced for migration
      const prefixedKeys = staticKeys.map(key => this.prefixKey(key));
      const prefixedData = await chrome.storage.local.get(prefixedKeys);

      let hasAnyPrefixedData = false;
      for (const prefixedKey of Object.keys(prefixedData)) {
        if (prefixedData[prefixedKey] !== undefined) {
          hasAnyPrefixedData = true;
          break;
        }
      }

      let dataToLoad: Record<string, any>;
      let needsMigration = false;
      if (hasAnyPrefixedData) {
        // Use prefixed keys - we're on a subsequent run after migration
        dataToLoad = prefixedData;
      } else {
        // No prefixed keys found - try unnamespaced keys for migration
        console.debug('[Storage] No namespaced data found, attempting migration from unnamespaced storage');
        dataToLoad = await chrome.storage.local.get(staticKeys);
        needsMigration = true;
      }

      // Load data into cache
      for (let i = 0; i < staticKeys.length; i++) {
        const originalKey = staticKeys[i];
        const prefixedKey = prefixedKeys[i];

        // Check prefixed key first, then unnamespaced as fallback
        if (dataToLoad.hasOwnProperty(prefixedKey) && dataToLoad[prefixedKey] !== undefined) {
          this.cache.set(originalKey, dataToLoad[prefixedKey]);
        } else if (dataToLoad.hasOwnProperty(originalKey) && dataToLoad[originalKey] !== undefined) {
          this.cache.set(originalKey, dataToLoad[originalKey]);
        }
      }

      // Load dynamic keys: activity_messages_*, hang_time_activity_history_*, processed_event_ids, pending_publishes, nostr_* subscriptions
      try {
        const allStorageKeys = await chrome.storage.local.get(null);
        const dynamicPatterns = [
          'activity_messages_',
          'hang_time_activity_history_',
          'nostr_sub_since_',        // Nostr relay subscription timestamps
          'nostr_dm_since_',         // Nostr DM subscription timestamps
        ];
        const hardcodedDynamicKeys = [
          'processed_event_ids',     // EventDeduplicator state
          'pending_publishes',       // PublishQueue pending items
        ];

        for (const [storedKey, storedValue] of Object.entries(allStorageKeys)) {
          // Check if this key matches any dynamic pattern or hardcoded dynamic key
          const matchesPattern = dynamicPatterns.some(pattern => storedKey.includes(pattern)) ||
                               hardcodedDynamicKeys.some(key => storedKey.endsWith(key));
          if (!matchesPattern) continue;

          // Determine the original key (without session ID prefix if present)
          let originalKey = storedKey;
          if (this.sessionId && storedKey.startsWith(`${this.sessionId}:`)) {
            originalKey = storedKey.substring(this.sessionId.length + 1);
          }

          // Load into cache with original key name (cache uses unnamespaced keys)
          if (storedValue !== undefined) {
            this.cache.set(originalKey, storedValue);
          }
        }

        console.debug('[Storage] Loaded dynamic keys (activity_messages_*, hang_time_activity_history_*, nostr_*, processed_event_ids, pending_publishes)');
      } catch (error) {
        console.error('[Storage] Failed to load dynamic keys:', error);
        // Continue anyway - dynamic keys are important but not critical for startup
      }

      // If we migrated from unnamespaced keys, delete them to avoid stale data
      if (needsMigration) {
        console.debug('[Storage] Scheduling cleanup of old unnamespaced keys');
        setTimeout(async () => {
          try {
            await chrome.storage.local.remove(staticKeys);
            console.debug('[Storage] Cleaned up old unnamespaced keys');
          } catch (error) {
            console.error('[Storage] Failed to clean up old keys:', error);
          }
        }, 1000); // Delay to avoid conflicts with ongoing syncs
      }

      this.isInitialized = true;
      console.debug('[Storage] Cache initialized from storage with', this.cache.size, 'keys, session ID:', this.sessionId || '(not set yet)');
    } catch (error) {
      console.error('[Storage] Failed to initialize cache:', error);
      // FAIL HARD - don't mark as initialized if loading fails
      // This ensures get() won't return phantom defaults
      throw new StorageError('Cache initialization failed - cannot continue without valid storage', { error });
    }
  }

  /**
   * Schedule sync to storage (batched, max once per 5 seconds)
   */
  private scheduleSyncToStorage(): void {
    if (this.syncScheduled) return;

    this.syncScheduled = true;
    if (this.syncTimer) clearTimeout(this.syncTimer);

    this.syncTimer = setTimeout(() => {
      this.syncToStorage().catch(error => {
        console.error('[Storage] Sync failed:', error);
      });
      this.syncScheduled = false;
    }, 5000);
  }

  /**
   * Flush all cache changes to storage (called by scheduler and on exit)
   * Prefixes keys with session ID for instance isolation
   */
  async syncToStorage(): Promise<void> {
    if (this.cache.size === 0) return;

    try {
      const updates: Record<string, any> = {};
      for (const [key, value] of this.cache.entries()) {
        if (value !== undefined) {
          const prefixedKey = this.prefixKey(key);
          updates[prefixedKey] = value;
        }
      }

      if (Object.keys(updates).length > 0) {
        await chrome.storage.local.set(updates);
        console.debug(`[Storage] Synced ${Object.keys(updates).length} keys to storage with session ID: ${this.sessionId}`);
      }
    } catch (error) {
      console.error('[Storage] Failed to sync cache to storage:', error);
      throw error;
    }
  }

  /**
   * Force immediate sync (used on extension unload)
   */
  async forceSyncNow(): Promise<void> {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.syncScheduled = false;
    await this.syncToStorage();
  }

  /**
   * Get value from cache (cache-first, never falls back to storage)
   * In cache-first model, if key is not in cache during runtime, it means:
   * 1. Cache wasn't initialized properly (init() failed)
   * 2. Key is not a static key that should be pre-loaded
   * Either way, returning default is correct behavior.
   */
  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    try {
      if (this.cache.has(key)) {
        return this.cache.get(key) ?? defaultValue;
      }
      // Cache miss - return default, don't fallback to storage
      return defaultValue;
    } catch (error) {
      console.error(`[Storage] Failed to get ${key}:`, error);
      throw new StorageError(`Failed to get ${key}`, { key, error });
    }
  }

  /**
   * Set value in cache and schedule storage sync
   */
  async set<T>(key: string, value: T): Promise<void> {
    try {
      this.cache.set(key, value);
      this.scheduleSyncToStorage();
    } catch (error) {
      console.error(`[Storage] Failed to set ${key}:`, error);
      throw new StorageError(`Failed to set ${key}`, { key, error });
    }
  }

  /**
   * Update nested object in cache and schedule storage sync
   */
  async update<T extends Record<string, any>>(key: string, updates: Partial<T>): Promise<void> {
    try {
      const current = (await this.get<T>(key)) as T | undefined;
      const merged = { ...current, ...updates };
      this.cache.set(key, merged);
      this.scheduleSyncToStorage();
    } catch (error) {
      console.error(`[Storage] Failed to update ${key}:`, error);
      throw new StorageError(`Failed to update ${key}`, { key, error });
    }
  }

  /**
   * Delete key from cache and schedule storage sync
   * Sets to undefined so syncToStorage removes it from persistent storage
   */
  async delete(key: string): Promise<void> {
    try {
      this.cache.set(key, undefined);
      this.scheduleSyncToStorage();
    } catch (error) {
      console.error(`[Storage] Failed to delete ${key}:`, error);
      throw new StorageError(`Failed to delete ${key}`, { key, error });
    }
  }

  /**
   * Clear all cache and schedule storage sync (via forceSyncNow for immediate effect)
   */
  async clear(): Promise<void> {
    try {
      this.cache.clear();
      // Use immediate sync to clear storage right away
      await this.forceSyncNow();
      console.debug('[Storage] Cleared all data');
    } catch (error) {
      console.error('[Storage] Failed to clear:', error);
      throw new StorageError('Failed to clear storage', { error });
    }
  }

  // ============================================================================
  // USER PROFILE
  // ============================================================================

  async getUserProfile(): Promise<UserProfile | undefined> {
    const profile = await this.get<UserProfile>(STORAGE_KEYS.USER_PROFILE);
    return profile;
  }

  async setUserProfile(profile: UserProfile): Promise<void> {
    console.debug('[Storage] Saving profile with steam_config:', profile.steam_config?.steam_id ? 'configured' : 'not set');
    await this.set(STORAGE_KEYS.USER_PROFILE, profile);
  }

  async updateUserProfile(updates: Partial<UserProfile>): Promise<void> {
    await this.update(STORAGE_KEYS.USER_PROFILE, updates);
  }

  // ============================================================================
  // FRIENDS
  // ============================================================================

  async getFriends(): Promise<FriendList> {
    const friends = await this.get<Friend[]>(STORAGE_KEYS.FRIENDS_LIST, []);
    return friends;
  }

  async setFriends(friends: Friend[]): Promise<void> {
    await this.set(STORAGE_KEYS.FRIENDS_LIST, friends);
  }

  async addFriend(friend: Friend): Promise<void> {
    const friends = await this.getFriends();
    friends.push(friend);
    await this.setFriends(friends);
    console.debug('[Storage] Added friend:', friend.local_name);
  }

  async removeFriend(friendId: string): Promise<void> {
    const friends = await this.getFriends();
    const filtered = friends.filter((f) => f.uuid !== friendId);
    await this.setFriends(filtered);

    // Clean up associated data: activity history
    await this.delete(STORAGE_KEYS.ACTIVITY_HISTORY(friendId));

    console.debug('[Storage] Removed friend:', friendId);
  }

  async getFriend(friendId: string): Promise<Friend | undefined> {
    const friends = await this.getFriends();
    return friends.find((f) => f.uuid === friendId);
  }

  async updateFriend(friendId: string, updates: Partial<Friend>): Promise<void> {
    const friends = await this.getFriends();
    console.debug(`[Storage] updateFriend called for ID: ${friendId}, have ${friends.length} friends`);
    const friend = friends.find((f) => f.uuid === friendId);
    if (!friend) {
      console.error(`[Storage] Friend not found! Looking for: ${friendId}, available UUIDs: ${friends.map(f => f.uuid).join(', ')}`);
      throw new StorageError('Friend not found', { friendId });
    }
    console.debug(`[Storage] Found friend: ${friend.local_name}, applying updates`);
    // Replace activities completely (no merge—we always publish full state)
    if (updates.current_activities) {
      friend.current_activities = updates.current_activities;
    }
    // Apply other updates
    const { current_activities, ...otherUpdates } = updates;
    Object.assign(friend, otherUpdates);
    const activeServices = Object.keys(friend.current_activities || {});
    console.debug(`[Storage] Updated friend: active_services=${activeServices.join(',')}`);
    await this.setFriends(friends);
    console.debug(`[Storage] setFriends completed`);
  }

  // ============================================================================
  // OAUTH TOKENS
  // ============================================================================

  async getOAuthTokens(): Promise<OAuthTokens> {
    return this.get<OAuthTokens>(STORAGE_KEYS.OAUTH_TOKENS, {});
  }

  async setOAuthTokens(tokens: OAuthTokens): Promise<void> {
    await this.set(STORAGE_KEYS.OAUTH_TOKENS, tokens);
  }

  async getOAuthToken(service: 'spotify-api' | 'twitch-api' | 'steam-api' | 'discord-api'): Promise<OAuthToken | undefined> {
    const tokens = await this.getOAuthTokens();
    return tokens[service];
  }

  async setOAuthToken(service: 'spotify-api' | 'twitch-api' | 'steam-api' | 'discord-api', token: OAuthToken): Promise<void> {
    const tokens = await this.getOAuthTokens();
    tokens[service] = token;
    await this.setOAuthTokens(tokens);
    console.debug(`[Storage] Stored OAuth token for ${service}`);
  }

  async clearOAuthToken(service: 'spotify-api' | 'twitch-api' | 'steam-api' | 'discord-api'): Promise<void> {
    const tokens = await this.getOAuthTokens();
    delete tokens[service];
    await this.setOAuthTokens(tokens);
    console.debug(`[Storage] Cleared OAuth token for ${service}`);
  }

  // ============================================================================
  // ACTIVITY
  // ============================================================================

  async getCurrentActivity(): Promise<Activity | undefined> {
    return this.get<Activity>(STORAGE_KEYS.CURRENT_ACTIVITY);
  }

  async setCurrentActivity(activity: Activity): Promise<void> {
    console.log(`[Storage] setCurrentActivity called with:`, { id: activity.id, service: activity.service, content: activity.content?.substring(0, 30) });
    await this.set(STORAGE_KEYS.CURRENT_ACTIVITY, activity);
    // Verify it was set
    const verify = await this.get<Activity>(STORAGE_KEYS.CURRENT_ACTIVITY);
    console.log(`[Storage] ✅ setCurrentActivity verified in cache:`, { id: verify?.id, service: verify?.service });
  }

  async getMyActivities(): Promise<Partial<Record<string, Activity>>> {
    return this.get<Partial<Record<string, Activity>>>(STORAGE_KEYS.MY_ACTIVITIES, {});
  }

  async setMyActivities(activities: Partial<Record<string, Activity>>): Promise<void> {
    await this.set(STORAGE_KEYS.MY_ACTIVITIES, activities);
  }

  async updateMyActivity(activityId: string, activity: Activity): Promise<void> {
    const myActivities = await this.getMyActivities();
    myActivities[activityId] = activity;
    await this.setMyActivities(myActivities);
  }

  async getActivityHistory(friendId: string): Promise<Activity[]> {
    const history = await this.get<ActivityHistory>(
      STORAGE_KEYS.ACTIVITY_HISTORY(friendId)
    );
    return history?.activities ?? [];
  }

  async addActivityToHistory(friendId: string, activity: Activity): Promise<void> {
    const key = STORAGE_KEYS.ACTIVITY_HISTORY(friendId);
    const history = await this.get<ActivityHistory>(key, {
      friend_uuid: friendId,
      activities: [],
      updated_at: Date.now(),
    });

    if (!history.activities) history.activities = [];
    history.activities.push(activity);

    // Keep only last 100 activities
    if (history.activities.length > 100) {
      history.activities = history.activities.slice(-100);
    }

    history.updated_at = Date.now();
    await this.set(key, history);
  }

  // ============================================================================
  // MESSAGES (Activity-centric approach)
  // ============================================================================

  /**
   * Get all messages for a specific activity (from all senders, including self)
   * Returns messages sorted by timestamp (oldest to newest)
   */
  async getActivityMessages(activityId: string): Promise<Message[]> {
    const key = `activity_messages_${activityId}`;
    const messages = await this.get<Message[]>(key);
    return messages ? messages.sort((a, b) => a.timestamp - b.timestamp) : [];
  }

  /**
   * Add message to an activity (single activity-centric storage)
   * Keeps only 50 most recent messages per activity
   */
  async addActivityMessage(activityId: string, message: Message): Promise<void> {
    const key = `activity_messages_${activityId}`;
    const messages = await this.get<Message[]>(key) || [];

    // Add new message
    messages.push(message);

    await this.set(key, messages);
  }

  /**
   * Mark message as read in an activity
   */
  async markMessageAsRead(activityId: string, messageId: string): Promise<void> {
    const key = `activity_messages_${activityId}`;
    const messages = await this.get<Message[]>(key) || [];
    const message = messages.find((m) => m.id === messageId);
    if (message) {
      message.read = true;
      await this.set(key, messages);
    }
  }

  /**
   * Check if there are unread messages for an activity from any sender
   */
  async hasUnreadMessages(activityId: string): Promise<boolean> {
    const messages = await this.getActivityMessages(activityId);
    return messages.some((m) => !m.read && !m.is_outbound);
  }

  // ============================================================================
  // MESSAGES (Unified session-centric approach - NEW MODEL)
  // ============================================================================

  /**
   * Get all messages ever stored (unified model)
   * Returns messages sorted by timestamp (oldest to newest)
   */
  async getAllMessages(): Promise<Message[]> {
    const messages = await this.get<Message[]>('messages', []);
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Add message to unified messages array
   * New model: messages have from (sender UUID) and recipients[] (recipient UUIDs)
   */
  async addMessage(message: Message): Promise<void> {
    const messages = await this.get<Message[]>('messages', []);
    messages.push(message);
    await this.set('messages', messages);
  }

  /**
   * Get messages visible to current user in a co-watch session
   * Filters to show only messages where:
   * - Current user is sender (from === myUUID) OR current user is a recipient
   * - AND message involves someone in the co_watchers list
   * @param myUUID - Current user's UUID
   * @param coWatchers - Array of co-watcher UUIDs in current session
   */
  async getVisibleMessages(myUUID: string, coWatchers: string[]): Promise<Message[]> {
    const allMessages = await this.getAllMessages();
    const coWatcherSet = new Set(coWatchers);

    return allMessages.filter(m => {
      // Check if current user is involved (sender or recipient)
      const isFromMe = m.from === myUUID;
      const isToMe = m.recipients?.includes(myUUID) ?? false;
      const userInvolved = isFromMe || isToMe;

      // Check if message involves a co-watcher
      const senderIsCoWatcher = coWatcherSet.has(m.from || '');
      const anyRecipientIsCoWatcher = (m.recipients || []).some(r => coWatcherSet.has(r));
      const messageInvolvesCowatcher = senderIsCoWatcher || anyRecipientIsCoWatcher;

      return userInvolved && messageInvolvesCowatcher;
    });
  }

  // ============================================================================
  // CO-WATCH SESSIONS
  // ============================================================================

  async getActiveSession(): Promise<CoWatchSession | null> {
    return this.get<CoWatchSession | null>('active_session', null);
  }

  async setActiveSession(session: CoWatchSession): Promise<void> {
    await this.set('active_session', session);
  }

  async clearActiveSession(): Promise<void> {
    await this.delete('active_session');
  }

  // ============================================================================
  // SETTINGS
  // ============================================================================

  async getSettings(): Promise<Settings> {
    return this.get<Settings>(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
  }

  async setSettings(settings: Settings): Promise<void> {
    await this.set(STORAGE_KEYS.SETTINGS, settings);
  }

  async updateSettings(updates: Partial<Settings>): Promise<void> {
    await this.update(STORAGE_KEYS.SETTINGS, updates);
  }

  async getServiceEnabled(service: ServiceName): Promise<boolean> {
    const profile = await this.getUserProfile();
    if (!profile) return false;
    return profile.services_enabled[service] ?? false;
  }

  async setServiceEnabled(service: ServiceName, enabled: boolean): Promise<void> {
    const profile = await this.getUserProfile();
    if (!profile) {
      throw new StorageError('User profile not found');
    }
    profile.services_enabled[service] = enabled;
    await this.setUserProfile(profile);
  }

  // ============================================================================
  // INVITES & NOTIFICATIONS
  // ============================================================================

  /**
   * Pending invite data with timestamp
   */
  async getPendingInvites(): Promise<Record<string, PendingInvite>> {
    return this.get<Record<string, PendingInvite>>(STORAGE_KEYS.PENDING_INVITES, {});
  }

  /**
   * Set pending invites
   */
  async setPendingInvites(invites: Record<string, PendingInvite>): Promise<void> {
    await this.set(STORAGE_KEYS.PENDING_INVITES, invites);
  }

  /**
   * Add or update a pending invite
   */
  async upsertPendingInvite(activityId: string, invite: PendingInvite): Promise<void> {
    const invites = await this.getPendingInvites();
    invites[activityId] = invite;
    await this.setPendingInvites(invites);
  }

  /**
   * Remove a pending invite
   */
  async removePendingInvite(activityId: string): Promise<void> {
    const invites = await this.getPendingInvites();
    delete invites[activityId];
    await this.setPendingInvites(invites);
  }

  /**
   * Remove expired invites (older than 24 hours)
   * Returns count of removed invites
   */
  async removeExpiredInvites(): Promise<number> {
    const invites = await this.getPendingInvites();
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    let removedCount = 0;

    for (const [activityId, inviteData] of Object.entries(invites)) {
      if (now - inviteData.sentAt > oneDayMs) {
        delete invites[activityId];
        removedCount++;
      }
    }

    if (removedCount > 0) {
      await this.setPendingInvites(invites);
    }

    return removedCount;
  }

  /**
   * Get received invites (invites we received FROM friends, used for UI display)
   */
  async getReceivedInvites(): Promise<Record<string, any>> {
    return this.get<Record<string, any>>(STORAGE_KEYS.RECEIVED_INVITES, {});
  }

  /**
   * Set received invites
   */
  async setReceivedInvites(invites: Record<string, any>): Promise<void> {
    await this.set(STORAGE_KEYS.RECEIVED_INVITES, invites);
  }

  /**
   * Add or update a received invite
   */
  async upsertReceivedInvite(activityId: string, invite: any): Promise<void> {
    const invites = await this.getReceivedInvites();
    invites[activityId] = invite;
    await this.setReceivedInvites(invites);
  }

  /**
   * Remove a received invite
   */
  async removeReceivedInvite(activityId: string): Promise<void> {
    const invites = await this.getReceivedInvites();
    delete invites[activityId];
    await this.setReceivedInvites(invites);
  }

  /**
   * Refresh specific keys from storage into cache (used when storage changes externally)
   * This keeps the cache in sync when other components update storage
   * Prefixes keys with session ID for instance isolation
   */
  async refreshKeysFromStorage(keys: string[]): Promise<void> {
    const prefixedKeys = keys.map(key => this.prefixKey(key));
    const data = await chrome.storage.local.get(prefixedKeys);
    for (let i = 0; i < keys.length; i++) {
      const originalKey = keys[i];
      const prefixedKey = prefixedKeys[i];
      if (data.hasOwnProperty(prefixedKey)) {
        this.cache.set(originalKey, data[prefixedKey]);
      }
    }
  }

  /**
   * Refresh received invites from storage (convenience method for common case)
   */
  async refreshReceivedInvitesFromStorage(): Promise<void> {
    await this.refreshKeysFromStorage([STORAGE_KEYS.RECEIVED_INVITES]);
  }

  /**
   * Get pending messages (kind-4: chat, accept, decline, friend_request)
   */
  async getPendingMessages(): Promise<Record<string, PendingMessage>> {
    return this.get<Record<string, PendingMessage>>(STORAGE_KEYS.PENDING_MESSAGES, {});
  }

  /**
   * Set pending messages
   */
  async setPendingMessages(messages: Record<string, PendingMessage>): Promise<void> {
    await this.set(STORAGE_KEYS.PENDING_MESSAGES, messages);
  }

  /**
   * Add or update a pending message
   */
  async upsertPendingMessage(messageId: string, message: PendingMessage): Promise<void> {
    const messages = await this.getPendingMessages();
    messages[messageId] = message;
    await this.setPendingMessages(messages);
  }

  /**
   * Remove a pending message
   */
  async removePendingMessage(messageId: string): Promise<void> {
    const messages = await this.getPendingMessages();
    delete messages[messageId];
    await this.setPendingMessages(messages);
  }

  /**
   * Track which activities have already triggered acceptance notifications
   * Prevents showing duplicate notifications when multiple people accept
   */
  async getActivityAcceptances(): Promise<Record<string, ActivityAcceptance>> {
    return this.get<Record<string, ActivityAcceptance>>(STORAGE_KEYS.ACTIVITY_ACCEPTANCES, {});
  }

  /**
   * Record that we've shown a notification for an activity's first acceptance
   */
  async recordActivityAcceptance(acceptance: ActivityAcceptance): Promise<void> {
    const acceptances = await this.getActivityAcceptances();
    acceptances[acceptance.activityId] = acceptance;
    await this.set(STORAGE_KEYS.ACTIVITY_ACCEPTANCES, acceptances);
  }

  /**
   * Check if we've already notified about an activity being accepted
   */
  async hasNotifiedActivityAcceptance(activityId: string): Promise<boolean> {
    const acceptances = await this.getActivityAcceptances();
    return !!acceptances[activityId];
  }

  /**
   * Get notified invite IDs with timestamps (for deduplication)
   * Returns Map<eventId, timestamp>
   */
  async getNotifiedInviteIds(): Promise<Map<string, number>> {
    const stored = await this.get<Record<string, number>>(STORAGE_KEYS.NOTIFIED_INVITE_IDS, {});
    return new Map(Object.entries(stored));
  }

  /**
   * Set notified invite IDs with timestamps
   */
  async setNotifiedInviteIds(ids: Map<string, number>): Promise<void> {
    const obj = Object.fromEntries(ids);
    await this.set(STORAGE_KEYS.NOTIFIED_INVITE_IDS, obj);
  }

  /**
   * Get processed event IDs (for deduplication across reloads)
   */
  async getProcessedEventIds(): Promise<Set<string>> {
    const stored = await this.get<string[]>('processed_event_ids', []);
    return new Set(stored);
  }

  /**
   * Set processed event IDs with 7-day retention
   */
  async setProcessedEventIds(ids: Set<string>): Promise<void> {
    // Only keep recent events (last 7 days worth)
    const recentIds = Array.from(ids);
    await this.set('processed_event_ids', recentIds);
  }

  // ============================================================================
  // FRIEND PROFILES
  // ============================================================================

  /**
   * Get all cached friend profiles (pubkey -> {discord_link})
   */
  async getFriendProfiles(): Promise<Record<string, { discord_link?: string }>> {
    return this.get<Record<string, { discord_link?: string }>>(STORAGE_KEYS.FRIEND_PROFILES, {});
  }

  /**
   * Store a friend's profile data
   */
  async setFriendProfile(pubkey: string, profile: { discord_link?: string }): Promise<void> {
    const profiles = await this.getFriendProfiles();
    profiles[pubkey] = profile;
    await this.set(STORAGE_KEYS.FRIEND_PROFILES, profiles);
  }

  /**
   * Get a specific friend's profile
   */
  async getFriendProfile(pubkey: string): Promise<{ discord_link?: string } | null> {
    const profiles = await this.getFriendProfiles();
    return profiles[pubkey] || null;
  }

  // ============================================================================
  // OAUTH & CONFIG
  // ============================================================================

  /**
   * Get OAuth configuration
   */
  async getOAuthConfig(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(STORAGE_KEYS.OAUTH_CONFIG, {});
  }

  /**
   * Set OAuth configuration
   */
  async setOAuthConfig(config: Record<string, unknown>): Promise<void> {
    await this.set(STORAGE_KEYS.OAUTH_CONFIG, config);
  }

  // ============================================================================
  // CONTENT EXTRACTION
  // ============================================================================

  /**
   * Get Netflix title from content script extraction
   * Returns null if title is missing or stale (>24 hours old)
   */
  async getNetflixTitle(): Promise<string | null> {
    const data = await this.get<any>(STORAGE_KEYS.NETFLIX_TITLE_DATA);
    if (!data || !data.value) {
      return null;
    }

    // Check staleness: if > 24 hours old, consider expired
    const ageMs = Date.now() - (data.extractedAt || 0);
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;

    if (ageMs > MAX_AGE_MS) {
      console.warn(`[Storage] Netflix title is stale (${Math.floor(ageMs / 60000)}m old), clearing`);
      await this.set(STORAGE_KEYS.NETFLIX_TITLE_DATA, null);
      return null;
    }

    return data.value;
  }

  /**
   * Clear Netflix title (used for cleanup/expiration)
   */
  async clearNetflixTitle(): Promise<void> {
    await this.set(STORAGE_KEYS.NETFLIX_TITLE_DATA, null);
  }

  /**
   * Remove stale Netflix titles (older than 24 hours)
   * Returns count of items cleaned
   */
  async removeStaleNetflixTitle(): Promise<number> {
    const data = await this.get<any>(STORAGE_KEYS.NETFLIX_TITLE_DATA);
    if (!data || !data.value) {
      return 0;
    }

    const ageMs = Date.now() - (data.extractedAt || 0);
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;

    if (ageMs > MAX_AGE_MS) {
      await this.clearNetflixTitle();
      return 1;
    }

    return 0;
  }

  // ============================================================================
  // CONTENT SCRIPT HEALTH MONITORING
  // ============================================================================

  /**
   * Get health status for all content scripts
   */

  // ============================================================================
  // INTEGRATION HEALTH (API/OAuth service monitoring)
  // ============================================================================

  /**
   * Get health status for all integrations
   */
  async getIntegrationHealth(): Promise<Record<string, { alive: boolean; lastPing: number; personaname?: string }>> {
    return this.get<Record<string, { alive: boolean; lastPing: number; personaname?: string }>>(STORAGE_KEYS.INTEGRATION_HEALTH, {});
  }

  /**
   * Update health status for an integration
   */
  async updateIntegrationHealth(service: string, alive: boolean, personaname?: string): Promise<void> {
    const health = await this.getIntegrationHealth();
    health[service] = {
      alive,
      lastPing: Date.now(),
      personaname,
    };
    await this.set(STORAGE_KEYS.INTEGRATION_HEALTH, health);
  }

  // ============================================================================
  // VIDEO DATA METRICS (Content script reliability tracking)
  // ============================================================================


  // ============================================================================
  // BATCH OPERATIONS
  // ============================================================================

  /**
   * Get all data from cache (never from storage)
   */
  async getAllData(): Promise<Record<string, unknown>> {
    try {
      const data: Record<string, unknown> = {};
      for (const [key, value] of this.cache.entries()) {
        if (value !== undefined) {
          data[key] = value;
        }
      }
      return data;
    } catch (error) {
      console.error('[Storage] Failed to get all data:', error);
      throw new StorageError('Failed to get all data', { error });
    }
  }

  /**
   * Get storage usage
   */
  async getUsage(): Promise<{ bytesInUse: number; bytesAvailable: number }> {
    try {
      const bytesInUse = await chrome.storage.local.getBytesInUse();
      // Chrome storage has ~10MB limit per extension
      const bytesAvailable = 10 * 1024 * 1024 - bytesInUse;
      return { bytesInUse, bytesAvailable };
    } catch (error) {
      console.error('[Storage] Failed to get usage:', error);
      throw new StorageError('Failed to get storage usage', { error });
    }
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Initialize storage with defaults if empty
   */
  async initialize(): Promise<void> {
    try {
      // Initialize cache from storage first
      await this.init();

      const profile = await this.getUserProfile();
      if (!profile) {
        console.debug('[Storage] Initializing storage with defaults');
        await this.setSettings(DEFAULT_SETTINGS);
      }
    } catch (error) {
      console.error('[Storage] Initialization failed:', error);
      throw new StorageError('Failed to initialize storage', { error });
    }
  }

  /**
   * Export all data (for backup)
   */
  async exportData(): Promise<string> {
    try {
      const data = await this.getAllData();
      return JSON.stringify(data, null, 2);
    } catch (error) {
      console.error('[Storage] Export failed:', error);
      throw new StorageError('Failed to export data', { error });
    }
  }

  /**
   * Import data (for restore) - loads into cache and syncs to storage
   */
  async importData(jsonData: string): Promise<void> {
    try {
      const data = JSON.parse(jsonData);
      // Clear cache and load imported data
      this.cache.clear();
      for (const [key, value] of Object.entries(data)) {
        this.cache.set(key, value);
      }
      // Force immediate sync to storage
      await this.forceSyncNow();
      console.debug('[Storage] Data imported successfully');
    } catch (error) {
      console.error('[Storage] Import failed:', error);
      throw new StorageError('Failed to import data', { error });
    }
  }

  // ============================================================================
  // HEALTH MONITORING & DEBUG (Legacy)
  // ============================================================================

/**
   * Get Netflix extraction logs (for debugging)
   */
  async getNetflixExtractionLogs(): Promise<string[]> {
    try {
      return await this.get<string[]>(STORAGE_KEYS.NETFLIX_EXTRACTION_LOGS, []);
    } catch (error) {
      console.error('[Storage] Failed to get Netflix extraction logs:', error);
      return [];
    }
  }

  /**
   * Get Netflix debug captures (for debugging)
   */
  async getNetflixDebugCaptures(): Promise<Record<string, any>[]> {
    try {
      return await this.get<Record<string, any>[]>(STORAGE_KEYS.NETFLIX_DEBUG_CAPTURES, []);
    } catch (error) {
      console.error('[Storage] Failed to get Netflix debug captures:', error);
      return [];
    }
  }
}

// Singleton instance
export const storageManager = new StorageManager();
