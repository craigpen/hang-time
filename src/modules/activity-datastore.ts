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

export class ActivityDatastore {
  constructor(private storage: StorageManager) {}

  /**
   * Create a new activity with validation
   * Throws ValidationError if data is invalid
   */
  async createActivity(
    data: Partial<Activity> & { provenance?: ActivityProvenance },
  ): Promise<ValidatedActivity> {
    console.debug('[ActivityDatastore] Creating activity:', data.service, data.content);

    // Validate before storing
    const validated = validateActivity(data);

    // Store in persistent storage
    const result = await this.storage.getValue('activities');
    const activities = result || {};
    activities[validated.id] = validated;
    await this.storage.setValue('activities', activities);

    console.debug('[ActivityDatastore] Activity created with ID:', validated.id);
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
    const result = await this.storage.getValue('activities');
    const activities = result || {};
    activities[id] = validated;
    await this.storage.setValue('activities', activities);

    console.debug('[ActivityDatastore] Activity updated:', id);
    return validated;
  }

  /**
   * Get a single activity by ID
   * Returns null if not found
   */
  async getActivity(id: string): Promise<Activity | null> {
    const result = await this.storage.getValue('activities');
    const activities = result || {};
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
   * Get all activities
   */
  async getAllActivities(): Promise<Activity[]> {
    const result = await this.storage.getValue('activities');
    const activities = result || {};
    return Object.values(activities);
  }

  /**
   * Get activities for a specific service
   */
  async getActivitiesByService(service: string): Promise<Activity[]> {
    const all = await this.getAllActivities();
    return all.filter((a) => a.service === service);
  }

  /**
   * Delete an activity by ID
   */
  async deleteActivity(id: string): Promise<void> {
    console.debug('[ActivityDatastore] Deleting activity:', id);

    const result = await this.storage.getValue('activities');
    const activities = result || {};
    delete activities[id];
    await this.storage.setValue('activities', activities);
  }

  /**
   * Validate all stored activities and report issues
   * Does not modify data
   */
  async validateAll(): Promise<CorruptionReport> {
    console.debug('[ActivityDatastore] Running integrity check...');

    const all = await this.getAllActivities();
    const corrupted: CorruptionReport['corruptedActivities'] = [];
    let totalIssues = 0;

    for (const activity of all) {
      const issues = detectCorruption(activity);
      if (issues.length > 0) {
        corrupted.push({
          id: activity.id,
          service: activity.service,
          content: activity.content,
          issues,
        });
        totalIssues += issues.length;
      }
    }

    // TODO: Ghost detection will be implemented in Phase 4
    // (requires comparing against open tabs)
    const ghosts: CorruptionReport['ghostActivities'] = [];

    const report: CorruptionReport = {
      totalActivities: all.length,
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
   * Remove corrupted activities
   * Removes activities with detected corruption issues
   * Does NOT remove ghosts (requires tab verification in Phase 4)
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
