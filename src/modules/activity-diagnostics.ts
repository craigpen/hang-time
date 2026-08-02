/**
 * Hang Time - Activity Diagnostics
 * Tracks complete activity lifecycle and relay health for debugging
 */

import { StorageManager } from './storage';

export interface ActivityDiagnosticRecord {
  activity_id: string;
  service: string;
  detected_at: number;
  source: 'API' | 'TAB_MONITOR';

  // Detection
  content: string;
  metadata: Record<string, any>;
  detection_error?: string;
  audio_state?: 'playing' | 'paused' | 'offline';

  // Validation & Storage
  validated_at?: number;
  validation_errors?: string[];
  stored_at?: number;

  // Publishing
  publish_cycle_triggered_at?: number;
  reason_published?: 'changed' | 'full_refresh' | 'delta';
  config_at_publish?: {
    rate_ms: number;
    size: string;
    scope: string;
    enabled_relays: string[];
  };

  // Relay metrics: { relay_url => relay_diagnostic }
  relay_attempts?: Record<string, RelayAttempt>;

  // Reception (on friend's client)
  received_at?: number;
  received_from_relay?: string;
  received_event_id?: string;
  received_tags?: Array<[string, string]>;

  // Processing (on friend's client)
  processing_started_at?: number;
  validation_checks?: string[];
  validation_errors_on_receive?: string[];
  filtering_applied?: string;
  accepted_at?: number;
  rejection_reason?: string;

  // Context
  extension_version?: string;
  client_identifier?: string;
  sender_identifier?: string; // who sent this (on receive)
}

export interface RelayAttempt {
  relay_url: string;
  connection_status: 'connected' | 'disconnected' | 'timeout';
  publish_attempt_at: number;
  response_received_at?: number;
  latency_ms?: number;
  response_code: string; // 'OK', 'FAILED', error code
  error_type?: string; // 'rate_limit', 'pow_required', 'timeout', etc.
  error_message?: string;
  retry_count: number;
  final_status: 'succeeded' | 'failed' | 'timeout';
  event_id?: string;
  event_size?: number;
}

export interface RelayHealthMetrics {
  relay_url: string;
  total_attempts: number;
  successful_attempts: number;
  success_rate: number; // 0-100
  average_latency_ms: number;
  consecutive_failures: number;
  error_patterns: Record<string, number>; // error_type => count
  last_attempt_at: number;
  last_error?: string;
}

const STORAGE_KEY = 'hang_time_diagnostics';
const MAX_RECORDS = 500; // Keep last 500 activities

export class ActivityDiagnostics {
  private static instance: ActivityDiagnostics;
  private storageManager: StorageManager;

  private constructor(storageManager: StorageManager) {
    this.storageManager = storageManager;
  }

  static getInstance(storageManager: StorageManager): ActivityDiagnostics {
    if (!ActivityDiagnostics.instance) {
      ActivityDiagnostics.instance = new ActivityDiagnostics(storageManager);
    }
    return ActivityDiagnostics.instance;
  }

  /**
   * Record activity detection
   */
  async recordDetection(
    activityId: string,
    service: string,
    source: 'API' | 'TAB_MONITOR',
    content: string,
    metadata: Record<string, any>,
    audioState?: 'playing' | 'paused' | 'offline',
    detectionError?: string
  ): Promise<void> {
    const record: ActivityDiagnosticRecord = {
      activity_id: activityId,
      service,
      detected_at: Date.now(),
      source,
      content,
      metadata,
      audio_state: audioState,
      detection_error: detectionError,
    };

    await this._appendRecord(record);
  }

  /**
   * Record validation results
   */
  async recordValidation(
    activityId: string,
    validationErrors: string[]
  ): Promise<void> {
    const record = await this._findRecord(activityId);
    if (record) {
      record.validated_at = Date.now();
      record.validation_errors = validationErrors;
      await this._updateRecord(record);
    }
  }

  /**
   * Record publishing attempt
   */
  async recordPublishCycle(
    activityId: string,
    reasonPublished: 'changed' | 'full_refresh' | 'delta',
    config: {
      rate_ms: number;
      size: string;
      scope: string;
      enabled_relays: string[];
    }
  ): Promise<void> {
    let record = await this._findRecord(activityId);
    if (!record) {
      // Create minimal record if it doesn't exist yet
      record = {
        activity_id: activityId,
        service: 'unknown',
        detected_at: Date.now(),
        source: 'API' as const,
        content: '',
        metadata: {},
      };
    }
    record.publish_cycle_triggered_at = Date.now();
    record.reason_published = reasonPublished;
    record.config_at_publish = config;
    record.relay_attempts = {};
    await this._updateRecord(record);
  }

  /**
   * Record relay attempt (for each relay we try to publish to)
   */
  async recordRelayAttempt(
    activityId: string,
    relayUrl: string,
    connectionStatus: 'connected' | 'disconnected' | 'timeout',
    responseCode: string,
    latencyMs?: number,
    errorType?: string,
    errorMessage?: string,
    retryCount: number = 0,
    finalStatus: 'succeeded' | 'failed' | 'timeout' = 'failed',
    eventId?: string,
    eventSize?: number
  ): Promise<void> {
    const record = await this._findRecord(activityId);
    if (record) {
      if (!record.relay_attempts) {
        record.relay_attempts = {};
      }

      record.relay_attempts[relayUrl] = {
        relay_url: relayUrl,
        connection_status: connectionStatus,
        publish_attempt_at: Date.now(),
        response_received_at: latencyMs ? Date.now() : undefined,
        latency_ms: latencyMs,
        response_code: responseCode,
        error_type: errorType,
        error_message: errorMessage,
        retry_count: retryCount,
        final_status: finalStatus,
        event_id: eventId,
        event_size: eventSize,
      };

      await this._updateRecord(record);
    }
  }

  /**
   * Record event reception (on receiving client)
   */
  async recordReception(
    activityId: string,
    receivedFromRelay: string,
    receivedEventId: string,
    receivedTags: Array<[string, string]>,
    senderIdentifier: string
  ): Promise<void> {
    const record = await this._findRecord(activityId) || {
      activity_id: activityId,
      service: 'unknown',
      detected_at: Date.now(),
      source: 'API' as const,
      content: '',
      metadata: {},
    };

    record.received_at = Date.now();
    record.received_from_relay = receivedFromRelay;
    record.received_event_id = receivedEventId;
    record.received_tags = receivedTags;
    record.sender_identifier = senderIdentifier;

    await this._updateRecord(record);
  }

  /**
   * Record event processing (on receiving client)
   */
  async recordProcessing(
    activityId: string,
    validationChecks: string[],
    validationErrors?: string[],
    filteringApplied?: string,
    rejectionReason?: string
  ): Promise<void> {
    const record = await this._findRecord(activityId);
    if (record) {
      record.processing_started_at = Date.now();
      record.validation_checks = validationChecks;
      record.validation_errors_on_receive = validationErrors;
      record.filtering_applied = filteringApplied;
      record.rejection_reason = rejectionReason;

      if (!rejectionReason) {
        record.accepted_at = Date.now();
      }

      await this._updateRecord(record);
    }
  }

  /**
   * Get relay health metrics across all activities
   */
  async getRelayHealthMetrics(): Promise<RelayHealthMetrics[]> {
    const records = await this._getAllRecords();
    const relayMetrics: Record<string, RelayHealthMetrics> = {};

    for (const record of records) {
      if (!record.relay_attempts) continue;

      for (const [relayUrl, attempt] of Object.entries(record.relay_attempts)) {
        if (!relayMetrics[relayUrl]) {
          relayMetrics[relayUrl] = {
            relay_url: relayUrl,
            total_attempts: 0,
            successful_attempts: 0,
            success_rate: 0,
            average_latency_ms: 0,
            consecutive_failures: 0,
            error_patterns: {},
            last_attempt_at: 0,
          };
        }

        const metrics = relayMetrics[relayUrl];
        metrics.total_attempts++;
        metrics.last_attempt_at = Math.max(
          metrics.last_attempt_at,
          attempt.publish_attempt_at
        );

        if (attempt.final_status === 'succeeded') {
          metrics.successful_attempts++;
          metrics.consecutive_failures = 0;
        } else {
          metrics.consecutive_failures++;
          if (attempt.error_type) {
            metrics.error_patterns[attempt.error_type] =
              (metrics.error_patterns[attempt.error_type] || 0) + 1;
          }
          if (attempt.error_message) {
            metrics.last_error = attempt.error_message;
          }
        }

        if (attempt.latency_ms) {
          metrics.average_latency_ms =
            (metrics.average_latency_ms * (metrics.total_attempts - 1) +
              attempt.latency_ms) /
            metrics.total_attempts;
        }
      }
    }

    // Compute success rates
    for (const metrics of Object.values(relayMetrics)) {
      metrics.success_rate = Math.round(
        (metrics.successful_attempts / metrics.total_attempts) * 100
      );
    }

    return Object.values(relayMetrics).sort(
      (a, b) => b.last_attempt_at - a.last_attempt_at
    );
  }

  /**
   * Find activities that were published but not received by a friend
   */
  async findUndeliveredActivities(
    senderIdentifier?: string
  ): Promise<ActivityDiagnosticRecord[]> {
    const records = await this._getAllRecords();
    return records.filter((r) => {
      const wasPublished = r.publish_cycle_triggered_at && r.relay_attempts;
      const wasReceived = r.received_at;
      const matchesSender = !senderIdentifier || r.sender_identifier === senderIdentifier;
      return wasPublished && !wasReceived && matchesSender;
    });
  }

  /**
   * Find activities that were received but rejected
   */
  async findRejectedActivities(): Promise<ActivityDiagnosticRecord[]> {
    const records = await this._getAllRecords();
    return records.filter((r) => r.rejection_reason);
  }

  /**
   * Get activity flow timeline for debugging
   */
  async getActivityTimeline(
    activityId: string
  ): Promise<ActivityDiagnosticRecord | null> {
    return this._findRecord(activityId);
  }

  /**
   * Clear all diagnostics
   */
  async clearAll(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  /**
   * Export diagnostics as JSON
   */
  async exportDiagnostics(): Promise<string> {
    const records = await this._getAllRecords();
    const relayMetrics = await this.getRelayHealthMetrics();
    const undelivered = await this.findUndeliveredActivities();
    const rejected = await this.findRejectedActivities();

    return JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        total_records: records.length,
        relay_health: relayMetrics,
        undelivered_activities: undelivered,
        rejected_activities: rejected,
        all_activity_records: records,
      },
      null,
      2
    );
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private async _getAllRecords(): Promise<ActivityDiagnosticRecord[]> {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      return data[STORAGE_KEY] || [];
    } catch (error) {
      console.error('[ActivityDiagnostics] Failed to read records:', error);
      return [];
    }
  }

  private async _findRecord(
    activityId: string
  ): Promise<ActivityDiagnosticRecord | null> {
    const records = await this._getAllRecords();
    return records.find((r) => r.activity_id === activityId) || null;
  }

  private async _appendRecord(record: ActivityDiagnosticRecord): Promise<void> {
    const records = await this._getAllRecords();
    records.push(record);

    // Keep only recent records
    if (records.length > MAX_RECORDS) {
      records.splice(0, records.length - MAX_RECORDS);
    }

    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: records });
    } catch (error) {
      console.error('[ActivityDiagnostics] Failed to append record:', error);
    }
  }

  private async _updateRecord(record: ActivityDiagnosticRecord): Promise<void> {
    const records = await this._getAllRecords();
    const idx = records.findIndex((r) => r.activity_id === record.activity_id);

    if (idx >= 0) {
      // Update existing record
      records[idx] = record;
    } else {
      // Create new record if doesn't exist
      records.push(record);
      // Keep only recent records
      if (records.length > MAX_RECORDS) {
        records.splice(0, records.length - MAX_RECORDS);
      }
    }

    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: records });
    } catch (error) {
      console.error('[ActivityDiagnostics] Failed to update record:', error);
    }
  }
}

export function getActivityDiagnostics(
  storageManager: StorageManager
): ActivityDiagnostics {
  return ActivityDiagnostics.getInstance(storageManager);
}
