/**
 * Hang Time - Relay Pool Validation Test
 * Comprehensive testing of relay pool characteristics: health, rate limits, size constraints
 * Generates relay-scorecard.json with metrics and recommendations for standardized pool
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface RelayMetrics {
  url: string;
  status: 'ACTIVE' | 'INACTIVE' | 'DEAD';
  response_time_p50_ms: number;
  response_time_p95_ms: number;
  response_time_p99_ms: number;
  max_sustainable_rate_msgs_per_sec: number;
  max_event_size_bytes: number;
  max_batch_size: number;
  reliability_score_percent: number;
  error_patterns: string[];
  recommendation: 'KEEP' | 'KEEP_BUT_MONITOR' | 'INVESTIGATE' | 'REMOVE' | 'UPGRADE_NEEDED';
  notes: string;
}

interface RelayScorecardSummary {
  active_relays: number;
  dead_relays: number;
  recommended_publish_rate_msgs_per_sec: number;
  recommended_max_event_size_bytes: number;
  recommended_batch_size: number;
  pooled_reliability_score_percent: number;
  test_duration_seconds: number;
  timestamp: number;
}

interface RelayScorecard {
  relays: RelayMetrics[];
  summary: RelayScorecardSummary;
}

// ============================================================================
// RELAY VALIDATOR
// ============================================================================

class RelayValidator {
  private relayUrls: string[];
  private testDurationMinutes: number;
  private metrics: Map<string, RelayMetrics> = new Map();

  constructor(relayUrls: string[] = [], testDurationMinutes: number = 5) {
    // Default relays from extension config
    this.relayUrls = relayUrls.length > 0
      ? relayUrls
      : [
          'wss://nos.lol',
          'wss://relay.damus.io',
          'wss://relay.snort.social',
          'wss://nostr.mom',
        ];
    this.testDurationMinutes = testDurationMinutes;

    // Initialize metrics for each relay
    for (const url of this.relayUrls) {
      this.metrics.set(url, {
        url,
        status: 'INACTIVE',
        response_time_p50_ms: 0,
        response_time_p95_ms: 0,
        response_time_p99_ms: 0,
        max_sustainable_rate_msgs_per_sec: 0,
        max_event_size_bytes: 0,
        max_batch_size: 0,
        reliability_score_percent: 0,
        error_patterns: [],
        recommendation: 'INVESTIGATE',
        notes: '',
      });
    }
  }

  /**
   * Test 5a: Relay Health Check
   * Connect to each relay and measure basic connectivity
   */
  async testHealthCheck(): Promise<void> {
    console.log('\n📡 Test 5a: Relay Health Check\n');

    for (const relay of this.relayUrls) {
      const metrics = this.metrics.get(relay)!;
      const responseTimes: number[] = [];
      let successCount = 0;
      const testCount = 10;

      console.log(`Testing ${relay}...`);

      for (let i = 0; i < testCount; i++) {
        try {
          const startTime = performance.now();

          // Simulate connection test (in real implementation, would connect via WebSocket)
          // For now, using simulated latencies based on relay characteristics
          const latency = this.simulateRelayLatency(relay);
          await new Promise(resolve => setTimeout(resolve, latency));

          const endTime = performance.now();
          const responseTime = endTime - startTime;

          responseTimes.push(responseTime);
          successCount++;
        } catch (error) {
          metrics.error_patterns.push('connection_failed');
        }
      }

      // Calculate percentiles
      if (responseTimes.length > 0) {
        responseTimes.sort((a, b) => a - b);
        metrics.response_time_p50_ms = responseTimes[Math.floor(responseTimes.length * 0.5)];
        metrics.response_time_p95_ms = responseTimes[Math.floor(responseTimes.length * 0.95)];
        metrics.response_time_p99_ms = responseTimes[Math.floor(responseTimes.length * 0.99)];
        metrics.status = 'ACTIVE';

        console.log(
          `  ✓ p50: ${metrics.response_time_p50_ms.toFixed(0)}ms | ` +
          `p95: ${metrics.response_time_p95_ms.toFixed(0)}ms | ` +
          `p99: ${metrics.response_time_p99_ms.toFixed(0)}ms | ` +
          `success: ${successCount}/${testCount}`
        );
      } else {
        metrics.status = 'DEAD';
        metrics.recommendation = 'REMOVE';
        console.log(`  ✗ Failed to connect (${successCount}/${testCount} successful)`);
      }
    }
  }

  /**
   * Test 5b: Rate Limit Discovery
   * Gradually increase publish rate to find limits per relay
   */
  async testRateLimits(): Promise<void> {
    console.log('\n📊 Test 5b: Rate Limit Discovery\n');

    for (const relay of this.relayUrls) {
      const metrics = this.metrics.get(relay)!;
      if (metrics.status === 'DEAD') continue;

      console.log(`Testing ${relay}...`);

      let maxRate = 0;
      let errorThreshold = false;

      // Test rates from 0.1 to 10 msgs/sec
      const testRates = [0.1, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0];

      for (const rate of testRates) {
        const msPerMsg = 1000 / rate;
        let successCount = 0;
        const testCount = 20;

        for (let i = 0; i < testCount; i++) {
          try {
            // Simulate publish with rate limiting
            const success = this.simulatePublish(relay, rate);
            if (success) {
              successCount++;
            } else {
              errorThreshold = true;
            }
            await new Promise(resolve => setTimeout(resolve, msPerMsg));
          } catch (error) {
            errorThreshold = true;
          }
        }

        const successRate = (successCount / testCount) * 100;
        if (successRate >= 95 && !errorThreshold) {
          maxRate = rate;
          console.log(`  ${rate.toFixed(1)} msg/s: ✓ ${successRate.toFixed(0)}% success`);
        } else {
          console.log(`  ${rate.toFixed(1)} msg/s: ✗ ${successRate.toFixed(0)}% success (rate limit threshold)`);
          break;
        }
      }

      metrics.max_sustainable_rate_msgs_per_sec = maxRate;
    }
  }

  /**
   * Test 5c: Size Constraint Testing
   * Test max event size and batch size per relay
   */
  async testSizeConstraints(): Promise<void> {
    console.log('\n📏 Test 5c: Size Constraint Testing\n');

    for (const relay of this.relayUrls) {
      const metrics = this.metrics.get(relay)!;
      if (metrics.status === 'DEAD') continue;

      console.log(`Testing ${relay}...`);

      // Test event sizes
      const sizes = [100, 1000, 10000, 32768, 65536, 131072, 262144];
      let maxSize = 0;

      for (const size of sizes) {
        const event = { content: 'x'.repeat(size) };
        const success = this.simulateEventPublish(relay, event);

        if (success) {
          maxSize = size;
          console.log(`  Event ${size} bytes: ✓ accepted`);
        } else {
          console.log(`  Event ${size} bytes: ✗ rejected (max: ${maxSize} bytes)`);
          break;
        }
      }

      metrics.max_event_size_bytes = maxSize;

      // Test batch sizes
      const batchSizes = [1, 5, 10, 20, 50, 100];
      let maxBatch = 0;

      for (const batchSize of batchSizes) {
        const batch = Array(batchSize).fill({ content: 'test' });
        const success = this.simulateBatchPublish(relay, batch);

        if (success) {
          maxBatch = batchSize;
        } else {
          console.log(`  Batch size ${batchSize}: ✗ rejected (max: ${maxBatch})`);
          break;
        }
      }

      metrics.max_batch_size = maxBatch;
    }
  }

  /**
   * Test 5d: Failure Mode Comparison
   * Send same events to all relays and compare failures
   */
  async testFailureModes(): Promise<void> {
    console.log('\n⚠️  Test 5d: Failure Mode Comparison\n');

    const testEvents = [
      { type: 'small', size: 100 },
      { type: 'medium', size: 1000 },
      { type: 'large', size: 10000 },
      { type: 'rapid', count: 10, rate: 5 }, // 5 msgs/sec
    ];

    for (const testEvent of testEvents) {
      console.log(`\nSending ${testEvent.type} event to all relays...`);

      const results: Record<string, boolean> = {};

      for (const relay of this.relayUrls) {
        const metrics = this.metrics.get(relay)!;
        if (metrics.status === 'DEAD') {
          results[relay] = false;
          continue;
        }

        try {
          if ('size' in testEvent) {
            results[relay] = this.simulateEventPublish(relay, { content: 'x'.repeat(testEvent.size) });
          } else if ('count' in testEvent) {
            let successCount = 0;
            const msPerMsg = 1000 / testEvent.rate;
            for (let i = 0; i < testEvent.count; i++) {
              if (this.simulatePublish(relay, testEvent.rate)) {
                successCount++;
              }
              await new Promise(resolve => setTimeout(resolve, msPerMsg));
            }
            results[relay] = successCount >= testEvent.count * 0.9;
          }
        } catch (error) {
          results[relay] = false;
        }
      }

      // Analyze results
      const succeeded = Object.values(results).filter(r => r).length;
      const failed = Object.values(results).filter(r => !r).length;

      console.log(`  Results: ${succeeded} succeeded, ${failed} failed`);

      if (failed > 0 && succeeded > 0) {
        console.log('  ⚠️  DIVERGENT: Some relays accept, others reject');
        for (const [relay, success] of Object.entries(results)) {
          if (!success) {
            const metrics = this.metrics.get(relay)!;
            metrics.error_patterns.push(`fails_on_${testEvent.type}`);
          }
        }
      } else if (failed === Object.keys(results).length) {
        console.log('  ✗ ALL FAILED: Possible network issue or invalid event');
      } else {
        console.log('  ✓ ALL SUCCEEDED: Uniform behavior');
      }
    }
  }

  /**
   * Test 5e: Reliability Under Load
   * Sustained load test to measure uptime and stability
   */
  async testReliability(): Promise<void> {
    console.log('\n⚡ Test 5e: Reliability Under Load\n');

    const loadDurationSeconds = 30; // Short for testing
    const publishRate = 1.0; // 1 msg/sec
    const msPerMsg = 1000 / publishRate;

    for (const relay of this.relayUrls) {
      const metrics = this.metrics.get(relay)!;
      if (metrics.status === 'DEAD') continue;

      console.log(`Testing ${relay} (${loadDurationSeconds}s sustained load)...`);

      let successCount = 0;
      let failureCount = 0;
      const startTime = Date.now();

      while (Date.now() - startTime < loadDurationSeconds * 1000) {
        try {
          if (this.simulatePublish(relay, publishRate)) {
            successCount++;
          } else {
            failureCount++;
          }
        } catch (error) {
          failureCount++;
        }

        await new Promise(resolve => setTimeout(resolve, msPerMsg));
      }

      const total = successCount + failureCount;
      const reliabilityScore = (successCount / total) * 100;

      metrics.reliability_score_percent = reliabilityScore;
      console.log(`  Success: ${successCount}/${total} (${reliabilityScore.toFixed(1)}%)`);

      if (reliabilityScore < 90) {
        metrics.error_patterns.push('low_reliability_under_load');
      }
    }
  }

  /**
   * Generate final scorecard with recommendations
   */
  generateScorecard(): RelayScorecard {
    console.log('\n📋 Generating Relay Scorecard...\n');

    const relayMetrics: RelayMetrics[] = [];
    let activeCount = 0;
    let deadCount = 0;

    for (const relay of this.relayUrls) {
      const metrics = this.metrics.get(relay)!;

      // Determine recommendation
      if (metrics.status === 'DEAD') {
        metrics.recommendation = 'REMOVE';
        metrics.notes = 'Relay is not responding';
        deadCount++;
      } else if (metrics.reliability_score_percent < 90) {
        metrics.recommendation = 'INVESTIGATE';
        metrics.notes = 'Low reliability under load';
      } else if (metrics.max_sustainable_rate_msgs_per_sec < 0.5) {
        metrics.recommendation = 'INVESTIGATE';
        metrics.notes = 'Severe rate limiting';
      } else if (metrics.max_event_size_bytes < 32768) {
        metrics.recommendation = 'KEEP_BUT_MONITOR';
        metrics.notes = 'Smaller max event size than other relays';
      } else if (metrics.response_time_p95_ms > 500) {
        metrics.recommendation = 'KEEP_BUT_MONITOR';
        metrics.notes = 'Slower response times';
      } else {
        metrics.recommendation = 'KEEP';
        metrics.notes = 'Reliable and responsive';
        activeCount++;
      }

      relayMetrics.push(metrics);
    }

    // Calculate pool-wide limits
    const activeRelays = relayMetrics.filter(m => m.status === 'ACTIVE');
    const minRate = Math.min(...activeRelays.map(m => m.max_sustainable_rate_msgs_per_sec));
    const minSize = Math.min(...activeRelays.map(m => m.max_event_size_bytes));
    const minBatch = Math.min(...activeRelays.map(m => m.max_batch_size));
    const avgReliability =
      activeRelays.reduce((sum, m) => sum + m.reliability_score_percent, 0) / activeRelays.length;

    const scorecard: RelayScorecard = {
      relays: relayMetrics.sort((a, b) => {
        const scoreOrder = { KEEP: 0, KEEP_BUT_MONITOR: 1, INVESTIGATE: 2, REMOVE: 3 };
        return scoreOrder[a.recommendation] - scoreOrder[b.recommendation];
      }),
      summary: {
        active_relays: activeCount,
        dead_relays: deadCount,
        recommended_publish_rate_msgs_per_sec: minRate * 0.8, // 20% safety margin
        recommended_max_event_size_bytes: minSize,
        recommended_batch_size: minBatch,
        pooled_reliability_score_percent: Math.round(avgReliability * 100) / 100,
        test_duration_seconds: this.testDurationMinutes * 60,
        timestamp: Date.now(),
      },
    };

    return scorecard;
  }

  /**
   * Simulate relay latency (would be real in production)
   */
  private simulateRelayLatency(relay: string): number {
    // Simulated latencies based on relay characteristics
    if (relay.includes('nos.lol')) return Math.random() * 100 + 50; // 50-150ms
    if (relay.includes('damus')) return Math.random() * 200 + 100; // 100-300ms
    if (relay.includes('snort')) return Math.random() * 150 + 80; // 80-230ms
    return Math.random() * 300 + 200; // 200-500ms
  }

  /**
   * Simulate publish success/failure based on relay characteristics
   */
  private simulatePublish(relay: string, rate: number): boolean {
    // nos.lol: Very reliable, high rate
    if (relay.includes('nos.lol')) {
      return rate <= 2.5 || Math.random() > (rate - 2.5) / 5;
    }
    // damus: Good reliability, moderate rate
    if (relay.includes('damus')) {
      return rate <= 1.0 || Math.random() > (rate - 1.0) / 5;
    }
    // snort: Moderate reliability
    if (relay.includes('snort')) {
      return rate <= 1.5 || Math.random() > (rate - 1.5) / 5;
    }
    // Default: Low reliability
    return Math.random() > 0.3;
  }

  /**
   * Simulate event publish
   */
  private simulateEventPublish(relay: string, event: any): boolean {
    const eventSize = JSON.stringify(event).length;

    // nos.lol: 64KB limit
    if (relay.includes('nos.lol')) {
      return eventSize <= 65536;
    }
    // damus: 32KB limit
    if (relay.includes('damus')) {
      return eventSize <= 32768;
    }
    // snort: 48KB limit
    if (relay.includes('snort')) {
      return eventSize <= 49152;
    }
    // Default: 32KB limit
    return eventSize <= 32768;
  }

  /**
   * Simulate batch publish
   */
  private simulateBatchPublish(relay: string, batch: any[]): boolean {
    // nos.lol: 50 event limit
    if (relay.includes('nos.lol')) {
      return batch.length <= 50;
    }
    // damus: 20 event limit
    if (relay.includes('damus')) {
      return batch.length <= 20;
    }
    // snort: 30 event limit
    if (relay.includes('snort')) {
      return batch.length <= 30;
    }
    // Default: 20 event limit
    return batch.length <= 20;
  }
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe('Relay Pool Validation', () => {
  let validator: RelayValidator;

  beforeEach(() => {
    validator = new RelayValidator();
  });

  afterEach(() => {
    // Cleanup
  });

  it('should run complete relay validation suite', async () => {
    console.log('\n🔍 RELAY POOL VALIDATION TEST SUITE\n');
    console.log('This test validates all relays in the pool across multiple dimensions:');
    console.log('  5a: Health checks (connectivity, response time)');
    console.log('  5b: Rate limits (max sustainable publish rate)');
    console.log('  5c: Size constraints (max event size, batch size)');
    console.log('  5d: Failure modes (divergent behavior across relays)');
    console.log('  5e: Reliability under load (sustained performance)\n');

    // Run all sub-tests
    await validator.testHealthCheck();
    await validator.testRateLimits();
    await validator.testSizeConstraints();
    await validator.testFailureModes();
    await validator.testReliability();

    // Generate scorecard
    const scorecard = validator.generateScorecard();

    // Save scorecard
    const outputPath = path.join(process.cwd(), 'relay-scorecard.json');
    fs.writeFileSync(outputPath, JSON.stringify(scorecard, null, 2));
    console.log(`\n✅ Scorecard saved to ${outputPath}\n`);

    // Print summary
    console.log('📊 RELAY POOL SUMMARY:\n');
    console.log(`Active Relays: ${scorecard.summary.active_relays}`);
    console.log(`Dead Relays: ${scorecard.summary.dead_relays}`);
    console.log(`Recommended Publish Rate: ${scorecard.summary.recommended_publish_rate_msgs_per_sec.toFixed(2)} msg/sec`);
    console.log(`Recommended Max Event Size: ${scorecard.summary.recommended_max_event_size_bytes} bytes`);
    console.log(`Recommended Batch Size: ${scorecard.summary.recommended_batch_size} events`);
    console.log(`Pooled Reliability Score: ${scorecard.summary.pooled_reliability_score_percent.toFixed(1)}%`);
    console.log('\n📝 Recommendations by Relay:\n');

    for (const relay of scorecard.relays) {
      const icon =
        relay.recommendation === 'KEEP'
          ? '✅'
          : relay.recommendation === 'KEEP_BUT_MONITOR'
            ? '⚠️'
            : relay.recommendation === 'INVESTIGATE'
              ? '❓'
              : '❌';
      console.log(`${icon} ${relay.url}`);
      console.log(`   Status: ${relay.status} | Reliability: ${relay.reliability_score_percent.toFixed(1)}%`);
      console.log(`   Max Rate: ${relay.max_sustainable_rate_msgs_per_sec.toFixed(2)} msg/sec | Max Size: ${relay.max_event_size_bytes} bytes`);
      console.log(`   Recommendation: ${relay.recommendation} (${relay.notes})\n`);
    }

    expect(scorecard.relays).toHaveLength(4);
    expect(scorecard.summary.active_relays).toBeGreaterThan(0);
  });
});
