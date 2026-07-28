/**
 * Hang Time - Activity Validation
 * Validation rules and error types for activity data integrity
 */

import { Activity } from '../types';

export class ValidationError extends Error {
  constructor(
    public field: string,
    public reason: string,
    public value?: unknown,
  ) {
    super(`[${field}] ${reason}`);
    this.name = 'ValidationError';
  }
}

export type ActivityProvenance = 'LOCAL_TAB' | 'FRIEND' | 'TEST';

export interface ValidatedActivity extends Activity {
  provenance: ActivityProvenance;
}

/**
 * Validates that content field is valid
 */
export function validateContent(content: unknown): string {
  if (typeof content !== 'string') {
    throw new ValidationError('content', 'Must be a string', content);
  }

  if (content.trim().length === 0) {
    throw new ValidationError('content', 'Cannot be empty', content);
  }

  if (content.length > 200) {
    throw new ValidationError('content', 'Cannot exceed 200 characters', content.length);
  }

  // Check for contaminated content (bullets, notification fragments)
  if (content.includes('•')) {
    throw new ValidationError('content', 'Contains bullet point (•) — possible contamination', content);
  }

  if (content.includes('invited you to')) {
    throw new ValidationError('content', 'Contains notification fragment — possible contamination', content);
  }

  if (content.match(/^[-\s]*[•]/)) {
    throw new ValidationError('content', 'Starts with bullet or dash — possible contamination', content);
  }

  // Check for encoding artifacts
  if (/[\x00-\x1F\x7F]/.test(content)) {
    throw new ValidationError('content', 'Contains control characters or encoding artifacts', content);
  }

  return content.trim();
}

/**
 * Validates that service field is valid
 */
export function validateService(service: unknown): string {
  const validServices = ['spotify-api', 'twitch-api', 'steam-api', 'discord-api', 'netflix-tab', 'youtube-tab', 'twitch-tab'];

  if (typeof service !== 'string') {
    throw new ValidationError('service', 'Must be a string', service);
  }

  if (!validServices.includes(service)) {
    throw new ValidationError('service', `Must be one of: ${validServices.join(', ')}`, service);
  }

  return service;
}

/**
 * Validates that state field is valid
 */
export function validateState(state: unknown): string {
  const validStates = ['playing', 'paused', 'stopped'];

  if (typeof state !== 'string') {
    throw new ValidationError('state', 'Must be a string', state);
  }

  if (state.trim().length === 0) {
    throw new ValidationError('state', 'Cannot be empty', state);
  }

  if (!validStates.includes(state)) {
    throw new ValidationError('state', `Must be one of: ${validStates.join(', ')}`, state);
  }

  return state;
}

/**
 * Validates that progress field is valid if provided
 * Returns the validated progress value or undefined if not provided
 * Note: For live streams (duration=0), progress is not bounded
 */
export function validateProgress(progress: unknown, duration?: number): number | undefined {
  if (progress === null || progress === undefined) {
    return undefined;
  }

  if (typeof progress !== 'number') {
    throw new ValidationError('progress', 'Must be a number if provided', progress);
  }

  if (progress < 0) {
    throw new ValidationError('progress', 'Cannot be negative', progress);
  }

  if (!isFinite(progress)) {
    throw new ValidationError('progress', 'Must be a finite number', progress);
  }

  // For live streams (duration=0 or undefined), don't enforce bounds
  if (duration !== undefined && duration > 0 && progress > duration) {
    throw new ValidationError('progress', `Cannot exceed duration (${duration}s)`, progress);
  }

  return progress;
}

/**
 * Validates that duration field is valid if provided
 * Note: Duration can be 0 or undefined for live streams (Twitch, etc)
 */
export function validateDuration(duration: unknown): number | undefined {
  if (duration === null || duration === undefined) {
    return undefined;
  }

  if (typeof duration !== 'number') {
    throw new ValidationError('duration', 'Must be a number if provided', duration);
  }

  if (duration < 0) {
    throw new ValidationError('duration', 'Cannot be negative', duration);
  }

  if (!isFinite(duration)) {
    throw new ValidationError('duration', 'Must be a finite number', duration);
  }

  // Duration of 0 is OK for live streams (Twitch, etc)
  return duration;
}

/**
 * Validates complete activity object
 * Returns a sanitized copy with validated fields
 */
export function validateActivity(data: Partial<Activity> & { provenance?: ActivityProvenance }): ValidatedActivity {
  // Required fields
  if (!data.id) {
    throw new ValidationError('id', 'Activity ID is required');
  }

  if (!data.service) {
    throw new ValidationError('service', 'Service is required');
  }

  if (!data.content) {
    throw new ValidationError('content', 'Content is required');
  }

  if (!data.timestamp) {
    throw new ValidationError('timestamp', 'Timestamp is required');
  }

  // State is required
  if (!data.state) {
    throw new ValidationError('state', 'State is required');
  }

  // Validate each field
  const validatedContent = validateContent(data.content);
  const validatedService = validateService(data.service);
  const validatedState = validateState(data.state);

  // Validate metadata fields
  const duration = validateDuration(data.metadata?.duration);
  const progress = validateProgress(data.metadata?.progress, duration);

  return {
    id: data.id,
    service: validatedService,
    content: validatedContent,
    url: data.url,
    state: validatedState,
    audio: data.audio || 'off',
    timestamp: data.timestamp,
    isStale: data.isStale || false,
    metadata: {
      lastAccessed: data.metadata?.lastAccessed,
      progress,
      duration,
      artist: data.metadata?.artist,
      thumbnailUrl: data.metadata?.thumbnailUrl,
      tabId: data.metadata?.tabId,
    },
    provenance: data.provenance || 'LOCAL_TAB',
  };
}

/**
 * Checks if an activity appears corrupted
 * Returns array of issues found (empty if clean)
 */
export function detectCorruption(activity: Activity): string[] {
  const issues: string[] = [];

  // Check content for contamination
  if (activity.content.includes('•')) {
    issues.push('Content contains bullet point (contamination)');
  }

  if (activity.content.includes('invited you to')) {
    issues.push('Content contains notification fragment (contamination)');
  }

  // Check for encoding artifacts
  if (/[\x00-\x1F\x7F]/.test(activity.content)) {
    issues.push('Content has encoding artifacts');
  }

  // Check state validity
  if (!['playing', 'paused', 'stopped'].includes(activity.state || '')) {
    issues.push(`Invalid state: ${activity.state}`);
  }

  // Check progress bounds
  if (activity.metadata?.progress !== undefined && activity.metadata?.duration !== undefined) {
    if (activity.metadata.progress < 0 || activity.metadata.progress > activity.metadata.duration) {
      issues.push(`Progress out of bounds: ${activity.metadata.progress}/${activity.metadata.duration}`);
    }
  }

  return issues;
}
