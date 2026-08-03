/**
 * DEPRECATED (2026-08-03): Safe Ramp-Up Stress Tester
 *
 * ⚠️ This test was based on simulated relay characteristics and flawed assumptions.
 * Real relay limits are not publicly documented and cannot be reliably tested this way.
 *
 * Originally: Gradually increases publishing load to find relay limits without triggering blocks
 * Identifies non-functional relays and sustainable rate limits
 *
 * DO NOT use results from this test for production decisions.
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// RELAY HEALTH TRACKING
// ============================================================================

interface RelayStats {
  url: string;
  messagesAttempted: number;
  messagesSucceeded: number;
  messagesFailed: number;
  rateLimitErrors: number;
  timeoutErrors: number;
  disconnectErrors: number;
  otherErrors: number;
  avgResponseTimeMs: number;
  maxSuccessfulRate: number; // msg/sec before errors started
  lastErrorRate: number; // msg/sec when errors appeared
  healthy: boolean;
  blockingSuspected: boolean;
}

interface RampUpReport {
  timestamp: number;
  testDuration: number;
  relayStats: RelayStats[];
  summary: {
    recommendedPublishRateMs: number;
    rateLimitedRelays: string[];
    timeoutRelays: string[];
    blockedRelays: string[];
    healthyRelays: string[];
    nonFunctionalRelays: string[];
  };
}

class RelayHealthMonitor {
  private stats: Map<string, RelayStats> = new Map();
  private errorPatterns: Map<string, string[]> = new Map();

  constructor(relayUrls: string[]) {
    for (const url of relayUrls) {
      this.stats.set(url, {
        url,
        messagesAttempted: 0,
        messagesSucceeded: 0,
        messagesFailed: 0,
        rateLimitErrors: 0,
        timeoutErrors: 0,
        disconnectErrors: 0,
        otherErrors: 0,
        avgResponseTimeMs: 0,
        maxSuccessfulRate: 0,
        lastErrorRate: 0,
        healthy: true,
        blockingSuspected: false,
      });
      this.errorPatterns.set(url, []);
    }
  }

  recordAttempt(relay: string, success: boolean, latencyMs: number, error?: string): void {
    const stats = this.stats.get(relay);
    if (!stats) return;

    stats.messagesAttempted++;

    if (success) {
      stats.messagesSucceeded++;
      stats.avgResponseTimeMs = (stats.avgResponseTimeMs + latencyMs) / 2;
    } else {
      stats.messagesFailed++;

      if (error?.includes('rate')) {
        stats.rateLimitErrors++;
        stats.healthy = false;
      } else if (error?.includes('timeout')) {
        stats.timeoutErrors++;
      } else if (error?.includes('disconnect')) {
        stats.disconnectErrors++;
        stats.blockingSuspected = true;
        stats.healthy = false;
      } else {
        stats.otherErrors++;
      }

      this.errorPatterns.get(relay)?.push(error || 'unknown');
    }
  }

  getSuccessRate(relay: string): number {
    const stats = this.stats.get(relay);
    if (!stats || stats.messagesAttempted === 0) return 100;
    return (stats.messagesSucceeded / stats.messagesAttempted) * 100;
  }

  detectBlocking(relay: string): boolean {
    const stats = this.stats.get(relay);
    if (!stats) return false;

    // Blocking indicators:
    // 1. High disconnect rate
    // 2. Success rate drops from 100% to 0% suddenly
    // 3. Repeated timeouts followed by connection loss
    // 4. Very high error rate after successful publishes

    const disconnectRate = (stats.disconnectErrors / Math.max(stats.messagesFailed, 1)) * 100;
    const successRate = this.getSuccessRate(relay);

    return disconnectRate > 30 || (successRate < 10 && stats.messagesAttempted > 10);
  }

  getReport(): RampUpReport {
    const stats = Array.from(this.stats.values());

    const healthyRelays = stats.filter(s => s.healthy && !this.detectBlocking(s.url)).map(s => s.url);
    const rateLimitedRelays = stats.filter(s => s.rateLimitErrors > 0).map(s => s.url);
    const timeoutRelays = stats.filter(s => s.timeoutErrors > 10).map(s => s.url);
    const blockedRelays = stats.filter(s => this.detectBlocking(s.url)).map(s => s.url);
    const nonFunctionalRelays = stats
      .filter(s => s.messagesAttempted > 5 && this.getSuccessRate(s.url) < 50)
      .map(s => s.url);

    // Recommended rate based on slowest healthy relay
    const healthyStats = stats.filter(s => s.healthy && !this.detectBlocking(s.url));
    const slowestHealthy = healthyStats.reduce((min, s) =>
      s.avgResponseTimeMs > min.avgResponseTimeMs ? s : min, healthyStats[0]
    );

    // If slowest relay responds in 100ms, we can safely send ~1 msg/sec without overwhelming
    // Apply 20% safety margin
    const recommendedRate = Math.floor((1000 / (slowestHealthy?.avgResponseTimeMs || 200)) * 0.8 * 1000);

    return {
      timestamp: Date.now(),
      testDuration: 0,
      relayStats: stats,
      summary: {
        recommendedPublishRateMs: Math.max(recommendedRate, 5000), // At least 5s between publishes
        rateLimitedRelays,
        timeoutRelays,
        blockedRelays,
        healthyRelays,
        nonFunctionalRelays,
      },
    };
  }
}

// ============================================================================
// RAMP-UP STRESS TEST
// ============================================================================

class RampUpStressTest {
  private monitor: RelayHealthMonitor;
  private currentRate: number; // msg/sec
  private startTime: number = 0;

  constructor(
    private relayUrls: string[],
    private durationMinutes: number = 10
  ) {
    this.monitor = new RelayHealthMonitor(relayUrls);
    this.currentRate = 2 / 60; // Start at 2 messages per minute = 0.033 msg/sec
  }

  /**
   * Simulate publishing to a relay
   */
  private async simulatePublish(relay: string): Promise<{ success: boolean; latency: number; error?: string }> {
    const start = performance.now();

    // Simulate different relay behaviors
    const rand = Math.random();

    if (relay.includes('damus')) {
      // Damus: reliable, ~50ms latency
      await new Promise(resolve => setTimeout(resolve, 50));
      return { success: true, latency: 50 };
    } else if (relay.includes('nos.lol')) {
      // nos.lol: good, ~80ms latency
      await new Promise(resolve => setTimeout(resolve, 80));
      return { success: true, latency: 80 };
    } else if (relay.includes('snort')) {
      // snort: variable, sometimes rate limits
      if (rand < 0.05) {
        return { success: false, latency: 200, error: 'rate limited' };
      }
      await new Promise(resolve => setTimeout(resolve, 70));
      return { success: true, latency: 70 };
    } else if (relay.includes('mostr')) {
      // mostr: older, slower, timeouts at high load
      if (this.currentRate > 0.5) {
        return { success: false, latency: 5000, error: 'timeout' };
      }
      await new Promise(resolve => setTimeout(resolve, 150));
      return { success: true, latency: 150 };
    } else if (relay.includes('mom')) {
      // mom: non-functional, simulated failure
      return { success: false, latency: 0, error: 'connection refused' };
    }

    await new Promise(resolve => setTimeout(resolve, 100));
    return { success: true, latency: 100 };
  }

  /**
   * Run ramp-up test
   */
  async run(): Promise<RampUpReport> {
    this.startTime = performance.now();
    const endTime = this.startTime + this.durationMinutes * 60 * 1000;
    let publishCount = 0;
    const rampUpSteps = 20; // Increase rate 20 times over test duration

    console.log(`\n📊 Starting safe ramp-up stress test (${this.durationMinutes} minutes)\n`);
    console.log('Starting rate: 2 msg/min (0.033 msg/sec)');
    console.log('Target: Find error threshold without triggering blocks\n');

    while (performance.now() < endTime) {
      const progress = (performance.now() - this.startTime) / (endTime - this.startTime);

      // Gradually increase rate: exponential ramp-up
      // Start at 0.033 msg/sec, reach peak at 1 msg/sec
      this.currentRate = 0.033 * Math.pow(30, progress);

      const msPerPublish = 1000 / this.currentRate;
      const intervalStart = performance.now();

      // Publish to all relays at current rate
      for (const relay of this.relayUrls) {
        const { success, latency, error } = await this.simulatePublish(relay);
        this.monitor.recordAttempt(relay, success, latency, error);
        publishCount++;

        // Log if relay health changes
        if (!success && publishCount % 10 === 0) {
          const successRate = this.monitor.getSuccessRate(relay);
          if (successRate < 90) {
            console.log(`⚠️  ${relay}: ${successRate.toFixed(0)}% success rate at ${this.currentRate.toFixed(2)} msg/sec`);
          }
        }
      }

      // Wait until next interval
      const elapsed = performance.now() - intervalStart;
      if (elapsed < msPerPublish) {
        await new Promise(resolve => setTimeout(resolve, msPerPublish - elapsed));
      }

      // Print progress every 2 minutes
      if (progress % 0.2 < 0.05) {
        console.log(
          `⏱️  ${Math.floor(progress * 100)}% complete | ` +
          `Rate: ${this.currentRate.toFixed(3)} msg/sec | ` +
          `Published: ${publishCount} messages`
        );
      }
    }

    console.log('\n✅ Ramp-up test complete\n');

    const report = this.monitor.getReport();
    report.testDuration = this.durationMinutes * 60;

    return report;
  }
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('Performance Ramp-Up Stress Test', () => {
  const reportFile = path.join(process.cwd(), 'relay-health-report.json');

  beforeEach(() => {
    if (fs.existsSync(reportFile)) {
      fs.unlinkSync(reportFile);
    }
  });

  afterEach(() => {
    console.log(`\n📁 Relay health report written to ${reportFile}\n`);
  });

  it('should run safe ramp-up test and identify relay limits', async () => {
    const relayUrls = [
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.snort.social',
      'wss://relay.mostr.pub',
      'wss://nostr.mom',
    ];

    const tester = new RampUpStressTest(relayUrls, 5); // 5 minute test (shorter for testing)
    const report = await tester.run();

    // Write report
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    // Print summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('RELAY HEALTH SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('✅ Healthy Relays:');
    report.summary.healthyRelays.forEach(r => console.log(`   ${r}`));

    if (report.summary.rateLimitedRelays.length > 0) {
      console.log('\n⚠️  Rate-Limited Relays:');
      report.summary.rateLimitedRelays.forEach(r => console.log(`   ${r}`));
    }

    if (report.summary.timeoutRelays.length > 0) {
      console.log('\n⏱️  Timeout-Prone Relays:');
      report.summary.timeoutRelays.forEach(r => console.log(`   ${r}`));
    }

    if (report.summary.blockedRelays.length > 0) {
      console.log('\n🚫 Likely Blocked Relays:');
      report.summary.blockedRelays.forEach(r => console.log(`   ${r}`));
    }

    if (report.summary.nonFunctionalRelays.length > 0) {
      console.log('\n❌ Non-Functional Relays (remove from config):');
      report.summary.nonFunctionalRelays.forEach(r => console.log(`   ${r}`));
    }

    console.log(
      `\n📌 Recommended Publish Rate: ${report.summary.recommendedPublishRateMs}ms ` +
      `(${(1000 / report.summary.recommendedPublishRateMs).toFixed(2)} msg/sec)`
    );

    console.log(
      '\n💡 Interpretation:\n' +
      '   - Use healthy relays in production\n' +
      '   - Avoid rate-limited relays or publish less frequently\n' +
      '   - Remove non-functional relays from manifest.json\n' +
      '   - Use recommended publish rate with 20% safety margin built in\n'
    );

    // Assertions
    expect(report.summary.healthyRelays.length).toBeGreaterThan(0);
    expect(report.summary.recommendedPublishRateMs).toBeGreaterThan(0);
  });
});
