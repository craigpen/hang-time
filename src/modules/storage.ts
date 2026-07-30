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
} from '../types';


export class StorageManager {
  /**
   * Get value from storage
   */
  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    try {
      const result = await chrome.storage.local.get(key);
      return result[key] ?? defaultValue;
    } catch (error) {
      console.error(`[Storage] Failed to get ${key}:`, error);
      throw new StorageError(`Failed to get ${key}`, { key, error });
    }
  }

  /**
   * Set value in storage
   */
  async set<T>(key: string, value: T): Promise<void> {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (error) {
      console.error(`[Storage] Failed to set ${key}:`, error);
      throw new StorageError(`Failed to set ${key}`, { key, error });
    }
  }

  /**
   * Update nested object in storage (merge with existing)
   */
  async update<T extends Record<string, any>>(key: string, updates: Partial<T>): Promise<void> {
    try {
      const current = (await this.get<T>(key)) as T | undefined;
      const merged = { ...current, ...updates };
      await this.set(key, merged);
    } catch (error) {
      console.error(`[Storage] Failed to update ${key}:`, error);
      throw new StorageError(`Failed to update ${key}`, { key, error });
    }
  }

  /**
   * Delete key from storage
   */
  async delete(key: string): Promise<void> {
    try {
      await chrome.storage.local.remove(key);
    } catch (error) {
      console.error(`[Storage] Failed to delete ${key}:`, error);
      throw new StorageError(`Failed to delete ${key}`, { key, error });
    }
  }

  /**
   * Clear all storage
   */
  async clear(): Promise<void> {
    try {
      await chrome.storage.local.clear();
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
    console.debug('[Storage] Loaded profile with steam_id:', profile?.steam_id);
    return profile;
  }

  async setUserProfile(profile: UserProfile): Promise<void> {
    console.debug('[Storage] Saving profile with steam_id:', profile.steam_id);
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
    console.debug(`[Storage] Found friend: ${friend.local_name}, merging updates:`, updates);
    // Merge activities separately to combine service objects
    if (updates.current_activities) {
      const merged = { ...friend.current_activities, ...updates.current_activities };
      // Clean up old service name keys (e.g., remove 'netflix' if 'netflix-tab' exists)
      const cleaned: Partial<Record<string, any>> = {};
      const serviceMap = new Map<string, string>(); // baseService -> key

      Object.entries(merged).forEach(([key, value]) => {
        const baseService = key.replace('-api', '').replace('-tab', '');
        serviceMap.set(baseService, key);
      });

      // Keep only the qualified service names
      Object.entries(merged).forEach(([key, value]) => {
        if ((key.includes('-api') || key.includes('-tab')) ||
            !Object.keys(merged).some(k => k.replace('-api', '').replace('-tab', '') === key && (k.includes('-api') || k.includes('-tab')))) {
          cleaned[key] = value;
        }
      });

      friend.current_activities = cleaned;
    }
    // Merge other fields
    const { current_activities, ...otherUpdates } = updates;
    Object.assign(friend, otherUpdates);
    const activeServices = Object.keys(friend.current_activities || {});
    console.debug(`[Storage] After merge: active_services=${activeServices.join(',')}`);
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
  async getPendingInvites(): Promise<Record<string, { friendId: string; sentAt: number }>> {
    return this.get<Record<string, { friendId: string; sentAt: number }>>('pending_invites', {});
  }

  /**
   * Set pending invites with timestamps
   */
  async setPendingInvites(invites: Record<string, { friendId: string; sentAt: number }>): Promise<void> {
    await this.set('pending_invites', invites);
  }

  /**
   * Remove expired invites (older than 2 hours)
   * Returns count of removed invites
   */
  async removeExpiredInvites(): Promise<number> {
    const invites = await this.getPendingInvites();
    const now = Date.now();
    const twoHoursMs = 2 * 60 * 60 * 1000;
    let removedCount = 0;

    for (const [activityId, inviteData] of Object.entries(invites)) {
      if (now - inviteData.sentAt > twoHoursMs) {
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
   * Get notified invite IDs with timestamps (for deduplication)
   * Returns Map<eventId, timestamp>
   */
  async getNotifiedInviteIds(): Promise<Map<string, number>> {
    const stored = await this.get<Record<string, number>>('notified_invite_ids', {});
    return new Map(Object.entries(stored));
  }

  /**
   * Set notified invite IDs with timestamps
   */
  async setNotifiedInviteIds(ids: Map<string, number>): Promise<void> {
    const obj = Object.fromEntries(ids);
    await this.set('notified_invite_ids', obj);
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
   * Get all data at once (useful for initialization)
   */
  async getAllData(): Promise<Record<string, unknown>> {
    try {
      const data = await chrome.storage.local.get();
      return data as Record<string, unknown>;
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
   * Import data (for restore)
   */
  async importData(jsonData: string): Promise<void> {
    try {
      const data = JSON.parse(jsonData);
      await chrome.storage.local.clear();
      await chrome.storage.local.set(data);
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
