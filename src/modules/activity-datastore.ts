/**
 * Hang Time - Activity Datastore
 * Single API gateway for all activity access with validation and integrity checks
 */

import { Activity } from '../types';
import { StorageManager } from './storage';
import {
  validateActivity,
  validateContent,
  validateState,
  detectCorruption,
  ActivityProvenance,
  ValidatedActivity,
  ValidationError,
} from './activity-validation';

/**
 * Activity with optional corruption warnings
 */
export interface ActivityWithWarning {
  activity: Activity;
  corrupted: boolean;
  issues: string[];
}

/**
 * Activity marked as ghost (no matching open tab)
 */
export interface GhostActivity {
  id: string;
  service: string;
  content: string;
  lastSeen: number;
  reason: string;
}

/**
 * Comprehensive report of activity integrity issues
 */
export interface CorruptionReport {
  totalActivities: number;
  corruptedActivities: Array<{
    id: string;
    service: string;
    content: string;
    issues: string[];
  }>;
  ghostActivities: Array<{
    id: string;
    service: string;
    content: string;
    reason: string;
  }>;
  summary: {
    totalIssues: number;
    corruptionCount: number;
    ghostCount: number;
  };
}

const PROVENANCE_STORAGE_KEY = 'activity_provenance_map';

export class ActivityDatastore {
  constructor(private storage: StorageManager) {}

  /**
   * Get provenance for an activity ID
   */
  private async getProvenance(id: string): Promise<ActivityProvenance> {
    const map = await this.storage.get<Record<string, ActivityProvenance>>(PROVENANCE_STORAGE_KEY, {});
    return map[id] || 'LOCAL_TAB';
  }

  /**
   * Store provenance for an activity ID
   */
  private async setProvenance(id: string, provenance: ActivityProvenance): Promise<void> {
    const map = await this.storage.get<Record<string, ActivityProvenance>>(PROVENANCE_STORAGE_KEY, {});
    map[id] = provenance;
    await this.storage.set(PROVENANCE_STORAGE_KEY, map);
  }

  /**
   * Create a new activity with validation
   * Throws ValidationError if data is invalid
   */
  async createActivity(
    data: Partial<Activity> & { provenance?: ActivityProvenance },
  ): Promise<ValidatedActivity> {
    console.debug('[ActivityDatastore] Creating activity:', data.service, data.content);

    const provenance = data.provenance || 'LOCAL_TAB';

    // Validate before storing
    const validated = validateActivity(data);

    // Store in persistent storage
    const activities = await this.storage.get<Record<string, any>>('activities', {});
    activities[validated.id] = validated;
    await this.storage.set('activities', activities);

    // Store provenance separately
    await this.setProvenance(validated.id, provenance);

    console.debug('[ActivityDatastore] Activity created with ID:', validated.id, 'provenance:', provenance);
    return validated;
  }

  /**
   * Update an existing activity with validation
   * Only allows updates to state, progress, and audio
   * Preserves progress unless a new valid value is provided
   */
  async updateActivity(id: string, updates: Partial<Activity>): Promise<ValidatedActivity> {
    console.debug('[ActivityDatastore] Updating activity:', id);

    // Get current activity
    const current = await this.getActivity(id);
    if (!current) {
      throw new ValidationError('id', 'Activity not found', id);
    }

    // Only allow specific fields to be updated
    const allowedUpdates: Partial<Activity> = {
      state: updates.state,
      audio: updates.audio,
    };

    // Handle progress update (only if new valid value provided)
    if (updates.metadata?.progress !== undefined) {
      allowedUpdates.metadata = {
        ...current.metadata,
        progress: updates.metadata.progress,
      };
    } else {
      // Preserve existing progress
      allowedUpdates.metadata = {
        ...current.metadata,
        progress: current.metadata?.progress,
      };
    }

    // Merge and validate
    const merged = { ...current, ...allowedUpdates };
    const validated = validateActivity(merged);

    // Store updated activity
    const activities = await this.storage.get<Record<string, any>>('activities', {});
    activities[id] = validated;
    await this.storage.set('activities', activities);

    console.debug('[ActivityDatastore] Activity updated:', id);
    return validated;
  }

  /**
   * Get a single activity by ID
   * Returns null if not found
   * Detects corruption but returns activity anyway
   */
  async getActivity(id: string): Promise<Activity | null> {
    const activities = await this.storage.get<Record<string, any>>('activities', {});
    const activity = activities[id];

    if (!activity) {
      return null;
    }

    // Check for corruption on read
    const corruption = detectCorruption(activity);
    if (corruption.length > 0) {
      console.warn('[ActivityDatastore] Activity has corruption issues:', {
        id,
        issues: corruption,
      });
    }

    return activity;
  }

  /**
   * Get a single activity with corruption details
   * Returns the activity plus corruption status and issues
   */
  async getActivityWithWarning(id: string): Promise<ActivityWithWarning | null> {
    const activity = await this.getActivity(id);
    if (!activity) {
      return null;
    }

    const issues = detectCorruption(activity);
    return {
      activity,
      corrupted: issues.length > 0,
      issues,
    };
  }

  /**
   * Get all activities with corruption detection
   */
  async getAllActivities(): Promise<Activity[]> {
    const activities = await this.storage.get<Record<string, any>>('activities', {});
    return Object.values(activities);
  }

  /**
   * Get all activities with corruption warnings
   */
  async getAllActivitiesWithWarnings(): Promise<ActivityWithWarning[]> {
    const all = await this.getAllActivities();
    return all.map((activity) => ({
      activity,
      corrupted: detectCorruption(activity).length > 0,
      issues: detectCorruption(activity),
    }));
  }

  /**
   * Get activities for a specific service
   */
  async getActivitiesByService(service: string): Promise<Activity[]> {
    const all = await this.getAllActivities();
    return all.filter((a) => a.service === service);
  }

  /**
   * Get activities for a specific service with corruption warnings
   */
  async getActivitiesByServiceWithWarnings(service: string): Promise<ActivityWithWarning[]> {
    const all = await this.getAllActivitiesWithWarnings();
    return all.filter((a) => a.activity.service === service);
  }

  /**
   * Count total activities
   */
  async countActivities(): Promise<number> {
    const all = await this.getAllActivities();
    return all.length;
  }

  /**
   * Count corrupted activities
   */
  async countCorruptedActivities(): Promise<number> {
    const all = await this.getAllActivitiesWithWarnings();
    return all.filter((a) => a.corrupted).length;
  }

  /**
   * Delete an activity by ID
   * Also cleans up provenance metadata
   */
  async deleteActivity(id: string): Promise<void> {
    console.debug('[ActivityDatastore] Deleting activity:', id);

    // Delete from activities
    const activities = await this.storage.get<Record<string, any>>('activities', {});
    delete activities[id];
    await this.storage.set('activities', activities);

    // Delete provenance metadata
    const provenance = await this.storage.get<Record<string, ActivityProvenance>>(PROVENANCE_STORAGE_KEY, {});
    delete provenance[id];
    await this.storage.set(PROVENANCE_STORAGE_KEY, provenance);
  }

  /**
   * Validate all stored activities and report issues
   * Does not modify data, only reports corruption and ghosts
   */
  async validateAll(): Promise<CorruptionReport> {
    console.debug('[ActivityDatastore] Running integrity check...');

    const allWithWarnings = await this.getAllActivitiesWithWarnings();
    const corrupted: CorruptionReport['corruptedActivities'] = [];
    let totalIssues = 0;

    for (const { activity, corrupted: isCorrupted, issues } of allWithWarnings) {
      if (isCorrupted) {
        corrupted.push({
          id: activity.id,
          service: activity.service,
          content: activity.content,
          issues,
        });
        totalIssues += issues.length;
      }
    }

    // Detect ghost activities
    const ghostsList = await this.detectGhosts();
    const ghosts: CorruptionReport['ghostActivities'] = ghostsList.map((g) => ({
      id: g.id,
      service: g.service,
      content: g.content,
      reason: g.reason,
    }));
    totalIssues += ghosts.length;

    const report: CorruptionReport = {
      totalActivities: allWithWarnings.length,
      corruptedActivities: corrupted,
      ghostActivities: ghosts,
      summary: {
        totalIssues,
        corruptionCount: corrupted.length,
        ghostCount: ghosts.length,
      },
    };

    console.debug('[ActivityDatastore] Validation complete:', report.summary);
    return report;
  }

  /**
   * Get a human-readable summary of data integrity
   */
  async getSummary(): Promise<string> {
    const total = await this.countActivities();
    const corrupted = await this.countCorruptedActivities();
    const clean = total - corrupted;

    return `Activities: ${total} total, ${clean} clean, ${corrupted} corrupted`;
  }

  /**
   * Detect ghost activities (activities from closed tabs)
   * Compares LOCAL_TAB activities against currently open tabs
   */
  async detectGhosts(): Promise<GhostActivity[]> {
    console.debug('[ActivityDatastore] Detecting ghost activities...');

    // Get all open tabs
    let openTabs: chrome.tabs.Tab[] = [];
    try {
      openTabs = await chrome.tabs.query({ windowType: 'normal' });
    } catch (error) {
      console.warn('[ActivityDatastore] Could not query open tabs:', error);
      return [];
    }

    const openTabUrls = new Set<string>();
    for (const tab of openTabs) {
      if (tab.url) {
        openTabUrls.add(tab.url);
      }
    }

    const ghosts: GhostActivity[] = [];
    const all = await this.getAllActivities();

    for (const activity of all) {
      // Get this activity's provenance
      const provenance = await this.getProvenance(activity.id);

      // Only check LOCAL_TAB activities (FRIEND and TEST don't require a tab)
      if (provenance === 'LOCAL_TAB') {
        // Activity should have a matching open tab
        if (!activity.url || !openTabUrls.has(activity.url)) {
          ghosts.push({
            id: activity.id,
            service: activity.service,
            content: activity.content,
            lastSeen: activity.timestamp,
            reason: `No matching open tab for ${activity.service}`,
          });
        }
      }
    }

    console.debug('[ActivityDatastore] Found', ghosts.length, 'ghost activities');
    return ghosts;
  }

  /**
   * Remove corrupted activities
   * Removes activities with detected corruption issues
   */
  async cleanupCorrupted(): Promise<number> {
    console.debug('[ActivityDatastore] Cleaning up corrupted activities...');

    const all = await this.getAllActivities();
    let removed = 0;

    for (const activity of all) {
      const issues = detectCorruption(activity);
      if (issues.length > 0) {
        console.debug('[ActivityDatastore] Removing corrupted:', activity.id, issues);
        await this.deleteActivity(activity.id);
        removed++;
      }
    }

    console.debug('[ActivityDatastore] Cleanup complete. Removed:', removed);
    return removed;
  }

  /**
   * Remove ghost activities (from closed tabs)
   */
  async cleanupGhosts(): Promise<number> {
    console.debug('[ActivityDatastore] Cleaning up ghost activities...');

    const ghosts = await this.detectGhosts();
    let removed = 0;

    for (const ghost of ghosts) {
      console.debug('[ActivityDatastore] Removing ghost:', ghost.id, ghost.reason);
      await this.deleteActivity(ghost.id);
      removed++;
    }

    console.debug('[ActivityDatastore] Ghost cleanup complete. Removed:', removed);
    return removed;
  }

  /**
   * Complete cleanup: remove both corrupted and ghost activities
   */
  async cleanup(): Promise<{ corruptedRemoved: number; ghostsRemoved: number }> {
    console.debug('[ActivityDatastore] Running complete cleanup...');

    const corruptedRemoved = await this.cleanupCorrupted();
    const ghostsRemoved = await this.cleanupGhosts();

    console.debug('[ActivityDatastore] Complete cleanup done:', {
      corruptedRemoved,
      ghostsRemoved,
    });

    return { corruptedRemoved, ghostsRemoved };
  }
}

// Singleton instance
let datastore: ActivityDatastore | null = null;

export function initializeActivityDatastore(storage: StorageManager): void {
  datastore = new ActivityDatastore(storage);
}

export function getActivityDatastore(): ActivityDatastore {
  if (!datastore) {
    throw new Error('ActivityDatastore not initialized');
  }
  return datastore;
}
