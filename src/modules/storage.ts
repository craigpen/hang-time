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

/**
 * Content script health status for a service in a tab
 */
export interface ContentScriptHealth {
  tabId: number;
  service: 'netflix' | 'youtube' | 'twitch';
  alive: boolean;
  lastPing: number; // timestamp
}

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
      friend.current_activities = { ...friend.current_activities, ...updates.current_activities };
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

  async getOAuthToken(service: 'spotify' | 'twitch'): Promise<OAuthToken | undefined> {
    const tokens = await this.getOAuthTokens();
    return tokens[service];
  }

  async setOAuthToken(service: 'spotify' | 'twitch', token: OAuthToken): Promise<void> {
    const tokens = await this.getOAuthTokens();
    tokens[service] = token;
    await this.setOAuthTokens(tokens);
    console.debug(`[Storage] Stored OAuth token for ${service}`);
  }

  async clearOAuthToken(service: 'spotify' | 'twitch'): Promise<void> {
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
  async getContentScriptHealth(): Promise<ContentScriptHealth[]> {
    return this.get<ContentScriptHealth[]>('content_script_health', []);
  }

  /**
   * Update health status for a content script
   * Creates entry if doesn't exist, updates lastPing and alive status
   */
  async updateContentScriptHealth(
    tabId: number,
    service: 'netflix' | 'youtube' | 'twitch',
    alive: boolean
  ): Promise<void> {
    const health = await this.getContentScriptHealth();

    // Find existing entry
    const existing = health.find(h => h.tabId === tabId && h.service === service);

    if (existing) {
      existing.alive = alive;
      existing.lastPing = Date.now();
    } else {
      health.push({
        tabId,
        service,
        alive,
        lastPing: Date.now(),
      });
    }

    await this.set('content_script_health', health);
  }

  /**
   * Clear dead content scripts (no ping for 2+ minutes)
   * Returns count of removed entries
   */
  async clearStaleContentScriptHealth(): Promise<number> {
    const health = await this.getContentScriptHealth();
    const now = Date.now();
    const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

    const filtered = health.filter(h => {
      const ageSinceLastPing = now - h.lastPing;
      return ageSinceLastPing <= STALE_THRESHOLD_MS;
    });

    const removed = health.length - filtered.length;
    if (removed > 0) {
      await this.set('content_script_health', filtered);
    }

    return removed;
  }

  // ============================================================================
  // DEBUG & LOGGING
  // ============================================================================

  /**
   * Get Netflix extraction logs (debug only)
   */
  async getNetflixExtractionLogs(): Promise<string[]> {
    return this.get<string[]>('netflix_extraction_logs', []);
  }

  /**
   * Add Netflix extraction log (debug only)
   */
  async addNetflixExtractionLog(log: string): Promise<void> {
    const logs = await this.getNetflixExtractionLogs();
    logs.push(log);
    // Keep only last 100 logs
    if (logs.length > 100) {
      logs.shift();
    }
    await this.set('netflix_extraction_logs', logs);
  }

  /**
   * Get Netflix debug captures (debug only)
   */
  async getNetflixDebugCaptures(): Promise<unknown[]> {
    return this.get<unknown[]>('netflix_debug_captures', []);
  }

  /**
   * Set Netflix debug captures (debug only)
   */
  async setNetflixDebugCaptures(captures: unknown[]): Promise<void> {
    await this.set('netflix_debug_captures', captures);
  }

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
}

// Singleton instance
export const storageManager = new StorageManager();
