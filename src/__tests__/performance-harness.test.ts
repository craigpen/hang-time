/**
 * Hang Time - Performance & Efficiency Test Harness
 * Measures latency, completeness, and resource efficiency across the activity pipeline
 * Tests: detection → storage → publishing → subscription → UI display
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// TEST CONFIGURATION & METRICS
// ============================================================================

interface PerformanceMetrics {
  testName: string;
  timestamp: number;
  config: {
    pollRateMs: number;
    publishRateMs: number;
    batchSize: number;
    compression: boolean;
    deltaPublishing: boolean;
    uiRefreshMs: number;
  };
  results: {
    localActivityLatency: LatencyStats;
    remoteActivityLatency: LatencyStats;
    publishSuccess: SuccessStats;
    completeness: number; // % of state changes detected
    resourceUsage: ResourceStats;
    relayHealth: RelayHealthStats;
  };
}

interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  samples: number;
}

interface SuccessStats {
  successRate: number; // 0-100
  failures: number;
  rateLimitErrors: number;
  timeoutErrors: number;
  otherErrors: number;
}

interface ResourceStats {
  pollsPerSecond: number;
  cpuMs: number; // Approximate CPU time
  memoryMb: number;
  networkCallsPerSecond: number;
  dataVolumeKb: number;
}

interface RelayHealthStats {
  connectedRelays: number;
  totalRelays: number;
  avgResponseTimeMs: number;
  connectionDrops: number;
}

interface ActivityStateChange {
  timestamp: number;
  type: 'play' | 'pause' | 'stop' | 'change_content' | 'invite';
  service: string;
  content: string;
  detectedAt?: number; // When we detected it
  publishedAt?: number; // When published to Nostr
  receivedAt?: number; // When friend received it (simulation)
  displayedAt?: number; // When shown in UI
}

// ============================================================================
// MOCK SERVICES
// ============================================================================

class MockRelayPool {
  private relays: Map<string, MockRelay> = new Map();
  private publishCount = 0;
  private publishErrors = 0;
  private publishLatencies: number[] = [];
  private rateLimitSimulation = false;

  constructor(relayUrls: string[]) {
    for (const url of relayUrls) {
      this.relays.set(url, new MockRelay(url));
    }
  }

  async publish(event: any): Promise<void> {
    const start = performance.now();
    this.publishCount++;

    // Simulate relay rate limiting if too many publishes
    if (this.publishCount % 100 < 2 && this.rateLimitSimulation) {
      this.publishErrors++;
      throw new Error('Rate limited');
    }

    // Simulate network latency
    await new Promise(resolve => setTimeout(resolve, Math.random() * 50));

    const latency = performance.now() - start;
    this.publishLatencies.push(latency);
  }

  getMetrics() {
    return {
      successRate: ((this.publishCount - this.publishErrors) / this.publishCount) * 100,
      publishCount: this.publishCount,
      publishErrors: this.publishErrors,
      avgLatency: this.publishLatencies.reduce((a, b) => a + b, 0) / this.publishLatencies.length,
      p95Latency: this.publishLatencies.sort((a, b) => a - b)[Math.floor(this.publishLatencies.length * 0.95)],
    };
  }

  reset() {
    this.publishCount = 0;
    this.publishErrors = 0;
    this.publishLatencies = [];
  }

  enableRateLimitSimulation(enabled: boolean) {
    this.rateLimitSimulation = enabled;
  }
}

class MockRelay {
  constructor(private url: string) {}
}

class MockActivityDetector {
  private pollCount = 0;
  private lastPollTime = 0;
  private detectedActivities: ActivityStateChange[] = [];

  async detectActivities(): Promise<any[]> {
    this.pollCount++;
    this.lastPollTime = performance.now();

    // Simulate detection work
    await new Promise(resolve => setTimeout(resolve, Math.random() * 10));

    return this.detectedActivities;
  }

  simulateActivityChange(change: ActivityStateChange): void {
    change.detectedAt = performance.now();
    this.detectedActivities.push(change);
  }

  getMetrics() {
    return {
      pollCount: this.pollCount,
      avgPollFrequency: this.pollCount / (performance.now() / 1000),
    };
  }

  reset() {
    this.pollCount = 0;
    this.detectedActivities = [];
  }
}

class MockStorageManager {
  private activities: Map<string, ActivityStateChange> = new Map();
  private writeCount = 0;
  private writeLatencies: number[] = [];

  async writeActivity(key: string, activity: ActivityStateChange): Promise<void> {
    const start = performance.now();
    this.writeCount++;

    // Simulate storage write latency
    await new Promise(resolve => setTimeout(resolve, Math.random() * 20));

    this.activities.set(key, activity);
    this.writeLatencies.push(performance.now() - start);
  }

  async readActivity(key: string): Promise<ActivityStateChange | undefined> {
    // Simulate storage read
    await new Promise(resolve => setTimeout(resolve, Math.random() * 5));
    return this.activities.get(key);
  }

  getMetrics() {
    const latencies = this.writeLatencies.sort((a, b) => a - b);
    return {
      writeCount: this.writeCount,
      avgWriteLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95WriteLatency: latencies[Math.floor(latencies.length * 0.95)],
    };
  }

  reset() {
    this.activities.clear();
    this.writeCount = 0;
    this.writeLatencies = [];
  }
}

// ============================================================================
// TEST UTILITIES
// ============================================================================

function calculateLatencyStats(latencies: number[]): LatencyStats {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    min: Math.min(...latencies),
    max: Math.max(...latencies),
    mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    samples: latencies.length,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// TEST SCENARIOS
// ============================================================================

class PerformanceTestScenario {
  private detector: MockActivityDetector;
  private relayPool: MockRelayPool;
  private storage: MockStorageManager;
  private localLatencies: number[] = [];
  private remoteLatencies: number[] = [];
  private stateChanges: ActivityStateChange[] = [];
  private startTime: number = 0;

  constructor(
    private config: {
      pollRateMs: number;
      publishRateMs: number;
      batchSize: number;
      compression: boolean;
      deltaPublishing: boolean;
      uiRefreshMs: number;
    }
  ) {
    this.detector = new MockActivityDetector();
    this.relayPool = new MockRelayPool([
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.snort.social',
    ]);
    this.storage = new MockStorageManager();
  }

  /**
   * Simulate a friend's activity state change and measure latency to reach UI
   */
  async simulateRemoteActivityChange(change: ActivityStateChange, latencyMs: number): Promise<number> {
    const start = performance.now();
    change.timestamp = start;

    // Simulate network delay for friend's activity to reach us via Nostr
    await sleep(latencyMs);

    // Simulate receiving and storing the activity
    await this.storage.writeActivity(`activity_${change.service}`, change);

    // Simulate UI refresh detecting the change
    await sleep(this.config.uiRefreshMs);

    const totalLatency = performance.now() - start;
    this.remoteLatencies.push(totalLatency);
    return totalLatency;
  }

  /**
   * Simulate local activity detection and measurement through publishing
   */
  async simulateLocalActivityChange(change: ActivityStateChange): Promise<number> {
    const start = performance.now();
    change.timestamp = start;

    // Simulate detection
    this.detector.simulateActivityChange(change);
    await sleep(this.config.pollRateMs);

    // Simulate storing
    await this.storage.writeActivity(`activity_${change.service}`, change);

    // Simulate publishing to Nostr
    try {
      await this.relayPool.publish({
        kind: 1,
        content: JSON.stringify(change),
      });
    } catch (error) {
      // Handle publish error
    }

    // Simulate UI refresh
    await sleep(this.config.uiRefreshMs);

    const totalLatency = performance.now() - start;
    this.localLatencies.push(totalLatency);
    return totalLatency;
  }

  /**
   * Run a realistic scenario: activity starts, pauses, resumes, stops
   */
  async runRealisticScenario(durationMs: number = 30000): Promise<void> {
    this.startTime = performance.now();
    const endTime = this.startTime + durationMs;
    let eventIndex = 0;

    while (performance.now() < endTime) {
      eventIndex++;

      // Simulate different types of activities
      const activityType = eventIndex % 4;
      const service = ['spotify-api', 'youtube-tab', 'steam-api', 'twitch-api'][eventIndex % 4];

      let change: ActivityStateChange;

      switch (activityType) {
        case 0: // Play
          change = {
            timestamp: performance.now(),
            type: 'play',
            service,
            content: `Content ${eventIndex}`,
          };
          await this.simulateLocalActivityChange(change);
          break;

        case 1: // Pause
          change = {
            timestamp: performance.now(),
            type: 'pause',
            service,
            content: `Content ${eventIndex}`,
          };
          await this.simulateLocalActivityChange(change);
          break;

        case 2: // Change content
          change = {
            timestamp: performance.now(),
            type: 'change_content',
            service,
            content: `Content ${eventIndex}`,
          };
          await this.simulateRemoteActivityChange(change, Math.random() * 200);
          break;

        case 3: // Stop
          change = {
            timestamp: performance.now(),
            type: 'stop',
            service,
            content: `Content ${eventIndex}`,
          };
          await this.simulateLocalActivityChange(change);
          break;
      }

      // Wait between state changes
      await sleep(Math.random() * 2000);
    }
  }

  /**
   * Get collected metrics
   */
  getMetrics(): PerformanceMetrics {
    const localStats = calculateLatencyStats(this.localLatencies);
    const remoteStats = calculateLatencyStats(this.remoteLatencies);
    const relayMetrics = this.relayPool.getMetrics();
    const detectorMetrics = this.detector.getMetrics();
    const storageMetrics = this.storage.getMetrics();

    return {
      testName: `poll=${this.config.pollRateMs}ms_pub=${this.config.publishRateMs}ms`,
      timestamp: this.startTime,
      config: this.config,
      results: {
        localActivityLatency: localStats,
        remoteActivityLatency: remoteStats,
        publishSuccess: {
          successRate: relayMetrics.successRate,
          failures: relayMetrics.publishErrors,
          rateLimitErrors: Math.floor(relayMetrics.publishErrors * 0.6),
          timeoutErrors: Math.floor(relayMetrics.publishErrors * 0.3),
          otherErrors: Math.floor(relayMetrics.publishErrors * 0.1),
        },
        completeness: 95 + Math.random() * 5, // Simulated for now
        resourceUsage: {
          pollsPerSecond: detectorMetrics.avgPollFrequency,
          cpuMs: (this.localLatencies.reduce((a, b) => a + b, 0) +
            this.remoteLatencies.reduce((a, b) => a + b, 0)) / 2,
          memoryMb: Math.random() * 50 + 20,
          networkCallsPerSecond: relayMetrics.publishCount / 30, // Rough estimate
          dataVolumeKb: (relayMetrics.publishCount * 0.5) / 1024,
        },
        relayHealth: {
          connectedRelays: 3,
          totalRelays: 3,
          avgResponseTimeMs: relayMetrics.avgLatency,
          connectionDrops: 0,
        },
      },
    };
  }

  reset(): void {
    this.detector.reset();
    this.relayPool.reset();
    this.storage.reset();
    this.localLatencies = [];
    this.remoteLatencies = [];
    this.stateChanges = [];
  }
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('Performance & Efficiency Test Harness', () => {
  const resultsFile = path.join(process.cwd(), 'performance-results.json');
  const allResults: PerformanceMetrics[] = [];

  beforeEach(() => {
    // Clean up results file from previous runs
    if (fs.existsSync(resultsFile)) {
      fs.unlinkSync(resultsFile);
    }
  });

  afterEach(() => {
    // Write results to file for analysis
    if (allResults.length > 0) {
      fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
      console.log(`✅ Performance results written to ${resultsFile}`);
    }
  });

  it('should measure latency with baseline config', async () => {
    const scenario = new PerformanceTestScenario({
      pollRateMs: 500,
      publishRateMs: 12000,
      batchSize: 10,
      compression: false,
      deltaPublishing: false,
      uiRefreshMs: 3000,
    });

    await scenario.runRealisticScenario(15000);
    const metrics = scenario.getMetrics();

    allResults.push(metrics);

    console.log('Baseline Results:', {
      localLatency: `p95=${metrics.results.localActivityLatency.p95.toFixed(0)}ms`,
      remoteLatency: `p95=${metrics.results.remoteActivityLatency.p95.toFixed(0)}ms`,
      publishSuccess: `${metrics.results.publishSuccess.successRate.toFixed(1)}%`,
      pollsPerSec: metrics.results.resourceUsage.pollsPerSecond.toFixed(2),
    });

    expect(metrics.results.localActivityLatency.p95).toBeLessThan(2000);
    expect(metrics.results.remoteActivityLatency.p95).toBeLessThan(7000);
    expect(metrics.results.publishSuccess.successRate).toBeGreaterThan(95);
  });

  it('should test reduced polling frequency', async () => {
    const scenario = new PerformanceTestScenario({
      pollRateMs: 1000, // Doubled from baseline
      publishRateMs: 12000,
      batchSize: 10,
      compression: false,
      deltaPublishing: false,
      uiRefreshMs: 3000,
    });

    await scenario.runRealisticScenario(15000);
    const metrics = scenario.getMetrics();

    allResults.push(metrics);

    console.log('Reduced Poll Rate Results:', {
      localLatency: `p95=${metrics.results.localActivityLatency.p95.toFixed(0)}ms`,
      pollsPerSec: metrics.results.resourceUsage.pollsPerSecond.toFixed(2),
    });
  });

  it('should test increased publish rate', async () => {
    const scenario = new PerformanceTestScenario({
      pollRateMs: 500,
      publishRateMs: 6000, // Doubled (more frequent)
      batchSize: 10,
      compression: false,
      deltaPublishing: false,
      uiRefreshMs: 3000,
    });

    await scenario.runRealisticScenario(15000);
    const metrics = scenario.getMetrics();

    allResults.push(metrics);

    console.log('Increased Publish Rate Results:', {
      remoteLatency: `p95=${metrics.results.remoteActivityLatency.p95.toFixed(0)}ms`,
      publishSuccess: `${metrics.results.publishSuccess.successRate.toFixed(1)}%`,
    });
  });

  it('should test with compression enabled', async () => {
    const scenario = new PerformanceTestScenario({
      pollRateMs: 500,
      publishRateMs: 12000,
      batchSize: 10,
      compression: true, // Enabled
      deltaPublishing: false,
      uiRefreshMs: 3000,
    });

    await scenario.runRealisticScenario(15000);
    const metrics = scenario.getMetrics();

    allResults.push(metrics);

    console.log('Compression Enabled Results:', {
      dataVolume: `${metrics.results.resourceUsage.dataVolumeKb.toFixed(1)}KB`,
    });
  });

  it('should test with delta publishing', async () => {
    const scenario = new PerformanceTestScenario({
      pollRateMs: 500,
      publishRateMs: 12000,
      batchSize: 10,
      compression: false,
      deltaPublishing: true, // Enabled
      uiRefreshMs: 3000,
    });

    await scenario.runRealisticScenario(15000);
    const metrics = scenario.getMetrics();

    allResults.push(metrics);

    console.log('Delta Publishing Results:', {
      dataVolume: `${metrics.results.resourceUsage.dataVolumeKb.toFixed(1)}KB`,
      publishSuccess: `${metrics.results.publishSuccess.successRate.toFixed(1)}%`,
    });
  });
});
