/**
 * Hang Time - File Logger
 * Writes all console logs to storage for debugging
 * Logs are buffered in memory and flushed to StorageManager periodically
 * StorageManager caches logs and syncs every 5 seconds
 */

import { StorageManager } from './storage';

const MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024; // 2MB limit

export class FileLogger {
  private logsBuffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private profileId: string = 'unknown';
  private storageKey: string = '';
  private storage: StorageManager;

  constructor(profileId: string, storage: StorageManager) {
    this.profileId = profileId;
    this.storageKey = `hang_time_file_logs_${profileId}`;
    this.storage = storage;
  }

  /**
   * Initialize logger - call once at startup
   * Clears old logs from previous sessions
   */
  async init(): Promise<void> {
    // Clear old logs from storage for fresh session
    try {
      await this.storage.delete(this.storageKey);
    } catch (error) {
      console.error('[FileLogger] Failed to clear old logs:', error);
    }

    // Initialize fresh log buffer
    this.logsBuffer = [];
    this.logsBuffer.push(`\n${'='.repeat(80)}`);
    this.logsBuffer.push(`Hang Time Logs - Profile: ${this.profileId}`);
    this.logsBuffer.push(`Started: ${new Date().toISOString()}`);
    this.logsBuffer.push(`${'='.repeat(80)}\n`);
    await this.flush();
  }

  /**
   * Log a message
   */
  log(module: string, level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    let logLine = `[${timestamp}] [${level}] [${module}] ${message}`;

    if (data) {
      try {
        logLine += ` | ${JSON.stringify(data)}`;
      } catch {
        logLine += ` | [circular or unstringifiable data]`;
      }
    }

    this.logsBuffer.push(logLine);

    // Auto-flush periodically (every 500ms)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 500);
    }
  }

  /**
   * Flush logs to StorageManager (which caches and batches to storage)
   * Implements size-based trimming: keeps logs under 2MB by removing oldest entries
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.logsBuffer.length === 0) {
      return;
    }

    try {
      let logsText = this.logsBuffer.join('\n');

      // Get existing logs (if any)
      const existing = await this.storage.get<string>(this.storageKey, '');

      // Append new logs to existing logs (append-only pattern)
      const allLogs = existing ? existing + '\n' + logsText : logsText;

      // Store in StorageManager (will be cached and synced to storage)
      await this.storage.set(this.storageKey, allLogs);

      // Check size and trim if necessary
      await this._trimLogsIfNeeded();

      // Clear buffer after successful flush
      this.logsBuffer = [];
    } catch (error) {
      console.error('[FileLogger] Failed to flush logs:', error);
    }
  }

  /**
   * Trim oldest log entries if storage exceeds 2MB
   */
  private async _trimLogsIfNeeded(): Promise<void> {
    try {
      const logsText = await this.storage.get<string>(this.storageKey, '');

      if (!logsText) return;

      // Get size in bytes (UTF-8 encoding)
      const sizeBytes = new Blob([logsText]).size;

      if (sizeBytes > MAX_LOG_SIZE_BYTES) {
        // Logs exceed limit, trim oldest entries
        const lines = logsText.split('\n');

        // Keep header (first 4 lines) and trim from the middle
        const header = lines.slice(0, 4);
        const footer = lines.slice(-10); // Keep last 10 lines
        const middle = lines.slice(4, -10);

        // Remove 25% of middle entries
        const removeCount = Math.ceil(middle.length * 0.25);
        const trimmedMiddle = middle.slice(removeCount);

        const trimmedLogs = [...header, ...trimmedMiddle, ...footer].join('\n');
        await this.storage.set(this.storageKey, trimmedLogs);

        const newSize = new Blob([trimmedLogs]).size;
        console.debug(`[FileLogger] Trimmed logs: ${(sizeBytes / 1024 / 1024).toFixed(2)}MB → ${(newSize / 1024 / 1024).toFixed(2)}MB`);
      }
    } catch (error) {
      console.error('[FileLogger] Failed to trim logs:', error);
    }
  }

  /**
   * Get all buffered logs as text
   */
  async getAllLogs(): Promise<string> {
    await this.flush();
    try {
      return await this.storage.get<string>(this.storageKey, '') || '';
    } catch {
      return this.logsBuffer.join('\n');
    }
  }

  /**
   * Clear all logs
   */
  async clear(): Promise<void> {
    this.logsBuffer = [];
    try {
      await this.storage.delete(this.storageKey);
    } catch (error) {
      console.error('[FileLogger] Failed to clear logs:', error);
    }
  }
}

// Global logger instance
let loggerInstance: FileLogger | null = null;

export function initializeFileLogger(profileId: string, storage: StorageManager): FileLogger {
  loggerInstance = new FileLogger(profileId, storage);
  loggerInstance.init().catch(e => console.error('Failed to init logger:', e));
  return loggerInstance;
}

export function getFileLogger(): FileLogger {
  if (!loggerInstance) {
    throw new Error('FileLogger not initialized. Call initializeFileLogger first.');
  }
  return loggerInstance;
}
