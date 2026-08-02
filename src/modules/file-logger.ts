/**
 * Hang Time - File Logger
 * Writes all console logs to file for debugging
 */

export class FileLogger {
  private logsBuffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private profileId: string = 'unknown';
  private filePath: string = '';

  constructor(profileId: string) {
    this.profileId = profileId;
    // Use temp directory and include profile ID in filename
    const tempDir = 'hang-time-logs';
    this.filePath = `${tempDir}-${profileId}.txt`;
  }

  /**
   * Initialize logger - call once at startup
   */
  async init(): Promise<void> {
    // Clear any old logs on init
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
   * Flush logs to file via chrome storage (which we can read)
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
      const logsText = this.logsBuffer.join('\n');

      // Store in chrome.storage.local so it persists and we can query it
      const storageKey = `hang_time_file_logs_${this.profileId}`;
      await chrome.storage.local.set({ [storageKey]: logsText });

      // Also attempt to write via chrome.downloads API (won't work in extension context, but try anyway)
      // This is a fallback; the storage approach is primary
    } catch (error) {
      console.error('[FileLogger] Failed to flush logs:', error);
    }
  }

  /**
   * Get all buffered logs as text
   */
  async getAllLogs(): Promise<string> {
    await this.flush();
    const storageKey = `hang_time_file_logs_${this.profileId}`;
    try {
      const data = await chrome.storage.local.get(storageKey);
      return data[storageKey] || '';
    } catch {
      return this.logsBuffer.join('\n');
    }
  }

  /**
   * Clear all logs
   */
  async clear(): Promise<void> {
    this.logsBuffer = [];
    const storageKey = `hang_time_file_logs_${this.profileId}`;
    try {
      await chrome.storage.local.remove(storageKey);
    } catch (error) {
      console.error('[FileLogger] Failed to clear logs:', error);
    }
  }
}

// Global logger instance
let loggerInstance: FileLogger | null = null;

export function initializeFileLogger(profileId: string): FileLogger {
  loggerInstance = new FileLogger(profileId);
  loggerInstance.init().catch(e => console.error('Failed to init logger:', e));
  return loggerInstance;
}

export function getFileLogger(): FileLogger {
  if (!loggerInstance) {
    throw new Error('FileLogger not initialized. Call initializeFileLogger first.');
  }
  return loggerInstance;
}
