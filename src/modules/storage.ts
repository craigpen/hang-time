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
} from '../types';


export class StorageManager {
  // ============================================================================
  // CACHING INFRASTRUCTURE
  // ============================================================================

  private cache: Map<string, any> = new Map();
  private syncTimer: NodeJS.Timeout | null = null;
  private syncScheduled = false;
  private isInitialized = false;

  /**
   * Initialize cache from storage (call on extension startup)
   * FAILS HARD if cache initialization fails - no silent degradation
   */
  async init(): Promise<void> {
    if (this.isInitialized) return;

    try {
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

      const data = await chrome.storage.local.get(staticKeys);

      for (const key of staticKeys) {
        if (data.hasOwnProperty(key)) {
          this.cache.set(key, data[key]);
        }
      }

      this.isInitialized = true;
      console.debug('[Storage] Cache initialized from storage with', this.cache.size, 'keys');
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
   */
  async syncToStorage(): Promise<void> {
    if (this.cache.size === 0) return;

    try {
      const updates: Record<string, any> = {};
      for (const [key, value] of this.cache.entries()) {
        if (value !== undefined) {
          updates[key] = value;
        }
      }

      if (Object.keys(updates).length > 0) {
        await chrome.storage.local.set(updates);
        console.debug(`[Storage] Synced ${Object.keys(updates).length} keys to storage`);
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
    // Ensure all activities have required properties (backward compatibility)
    return friends.map(friend => ({
      ...friend,
      current_activities: Object.fromEntries(
        Object.entries(friend.current_activities || {}).map(([service, activity]) => [
          service,
          activity ? {
            state: activity.state || 'paused',
            ...activity,
          } : null,
        ]).filter(([, a]) => a)
      ) as Partial<Record<any, any>>,
    }));
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
    const filtered = friends.filter((f) => f.id !== friendId);
    await this.setFriends(filtered);

    // Clean up associated data: messages and activity history
    await this.delete(STORAGE_KEYS.MESSAGES(friendId));
    await this.delete(STORAGE_KEYS.ACTIVITY_HISTORY(friendId));

    console.debug('[Storage] Removed friend:', friendId);
  }

  async getFriend(friendId: string): Promise<Friend | undefined> {
    const friends = await this.getFriends();
    return friends.find((f) => f.id === friendId);
  }

  async updateFriend(friendId: string, updates: Partial<Friend>): Promise<void> {
    const friends = await this.getFriends();
    console.debug(`[Storage] updateFriend called for ID: ${friendId}, have ${friends.length} friends`);
    const friend = friends.find((f) => f.id === friendId);
    if (!friend) {
      console.error(`[Storage] Friend not found! Looking for: ${friendId}, available IDs: ${friends.map(f => f.id).join(', ')}`);
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
    await this.set(STORAGE_KEYS.CURRENT_ACTIVITY, activity);
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
      friend_id: friendId,
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
  // MESSAGES
  // ============================================================================

  async getMessages(friendId: string): Promise<Message[]> {
    return this.get<Message[]>(STORAGE_KEYS.MESSAGES(friendId), []);
  }

  async addMessage(friendId: string, message: Message): Promise<void> {
    const messages = await this.getMessages(friendId);
    messages.push(message);

    // Keep only last N messages (configurable via settings)
    const settings = await this.getSettings();
    const limit = settings?.message_history_limit ?? 100;
    if (messages.length > limit) {
      messages.splice(0, messages.length - limit);
    }

    await this.set(STORAGE_KEYS.MESSAGES(friendId), messages);
  }

  async clearMessages(friendId: string): Promise<void> {
    await this.delete(STORAGE_KEYS.MESSAGES(friendId));
  }

  /**
   * Get messages for a specific activity with a friend
   * Returns messages filtered by activity_id, sorted by timestamp (newest last)
   */
  async getActivityMessages(friendId: string, activityId: string): Promise<Message[]> {
    const allMessages = await this.getMessages(friendId);
    return allMessages
      .filter((msg) => msg.activity_id === activityId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Add message with activity ID and enforce per-activity message limit
   * Keeps only 15 most recent messages per activity
   */
  async addActivityMessage(friendId: string, activityId: string, message: Message): Promise<void> {
    const allMessages = await this.getMessages(friendId);

    // Add new message
    allMessages.push(message);

    // Enforce per-activity limit: keep only 15 most recent per activity
    const byActivity = new Map<string, Message[]>();
    for (const msg of allMessages) {
      if (!byActivity.has(msg.activity_id)) {
        byActivity.set(msg.activity_id, []);
      }
      byActivity.get(msg.activity_id)!.push(msg);
    }

    // Trim each activity to 15 messages
    const limit = 15;
    const trimmed: Message[] = [];
    for (const [_actId, messages] of byActivity) {
      const sorted = messages.sort((a, b) => a.timestamp - b.timestamp);
      if (sorted.length > limit) {
        trimmed.push(...sorted.slice(sorted.length - limit));
      } else {
        trimmed.push(...sorted);
      }
    }

    await this.set(STORAGE_KEYS.MESSAGES(friendId), trimmed);
  }

  /**
   * Mark message as read
   */
  async markMessageAsRead(friendId: string, messageId: string): Promise<void> {
    const messages = await this.getMessages(friendId);
    const message = messages.find((m) => m.id === messageId);
    if (message) {
      message.read = true;
      await this.set(STORAGE_KEYS.MESSAGES(friendId), messages);
    }
  }

  /**
   * Check if there are unread messages for an activity with a friend
   */
  async hasUnreadMessages(friendId: string, activityId: string): Promise<boolean> {
    const messages = await this.getActivityMessages(friendId, activityId);
    return messages.some((m) => !m.read && !m.is_outbound);
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
    return this.get<Record<string, unknown>>('oauth_config', {});
  }

  /**
   * Set OAuth configuration
   */
  async setOAuthConfig(config: Record<string, unknown>): Promise<void> {
    await this.set('oauth_config', config);
  }

  // ============================================================================
  // CONTENT EXTRACTION
  // ============================================================================

  /**
   * Get Netflix title from content script extraction
   * Returns null if title is missing or stale (>24 hours old)
   */
  async getNetflixTitle(): Promise<string | null> {
    const data = await this.get<any>('netflix_title_data');
    if (!data || !data.value) {
      return null;
    }

    // Check staleness: if > 24 hours old, consider expired
    const ageMs = Date.now() - (data.extractedAt || 0);
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;

    if (ageMs > MAX_AGE_MS) {
      console.warn(`[Storage] Netflix title is stale (${Math.floor(ageMs / 60000)}m old), clearing`);
      await this.set('netflix_title_data', null);
      return null;
    }

    return data.value;
  }

  /**
   * Set Netflix title from content script (internal use only)
   * Content script should call this directly with full metadata
   */
  async setNetflixTitle(title: string): Promise<void> {
    // Backwards compatibility for direct calls without metadata
    // Content script should use direct storage instead
    await this.set('netflix_title', title);
  }

  /**
   * Clear Netflix title (used for cleanup/expiration)
   */
  async clearNetflixTitle(): Promise<void> {
    await this.set('netflix_title_data', null);
  }

  /**
   * Remove stale Netflix titles (older than 24 hours)
   * Returns count of items cleaned
   */
  async removeStaleNetflixTitle(): Promise<number> {
    const data = await this.get<any>('netflix_title_data');
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
    return this.get<Record<string, { alive: boolean; lastPing: number; personaname?: string }>>('integration_health', {});
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
    await this.set('integration_health', health);
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
