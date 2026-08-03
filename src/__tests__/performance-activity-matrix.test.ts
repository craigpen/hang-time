/**
 * DEPRECATED (2026-08-03): Activity Publishing Performance Matrix
 *
 * ⚠️ This test suite was based on simulated relay characteristics and flawed assumptions.
 * The simulated rate limits do not reflect actual Nostr relay behavior.
 * Real relay limits are not publicly documented and vary by operator.
 *
 * Tests different publishing strategies to find optimal settings for activity broadcasts
 * Focuses on: Size (atomic/full), Scope (updates/full), Delta (enabled/disabled), Compression (enabled/disabled)
 * Measures: Event size, publish rate, latency, relay rate-limit behavior, resource cost
 *
 * DO NOT use the simulated limits from this test for real-world decisions.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

interface Activity {
  id: string;
  service: string;
  content: string;
  url: string;
  timestamp: number;
}

interface PublishConfig {
  size: 'atomic' | 'full'; // atomic: changed only, full: all activities
  scope: 'updates' | 'full'; // updates: changed fields only, full: entire activity
  delta: boolean; // track changes or republish all
  compression: boolean;
}

interface TestResult {
  config: PublishConfig;
  relayCount: number;
  eventSize: number; // bytes
  publishRate: number; // msgs/sec
  latency: number; // ms p95
  relayLimitHit: boolean;
  resourceCost: 'low' | 'medium' | 'high';
  recommendation: 'keep' | 'investigate' | 'remove';
}

class ActivityPublishingTester {
  private testActivities: Activity[] = [];

  constructor() {
    this.initializeTestActivities();
  }

  private initializeTestActivities(): void {
    // Realistic activity set: 5-10 active services
    const services = ['spotify-api', 'twitch-api', 'steam-api', 'youtube-tab', 'netflix-tab'];
    this.testActivities = services.map((service, i) => ({
      id: `activity-${i}`,
      service,
      content: `Test ${service} - ${Math.random().toString(36).substring(7)}`,
      url: `https://example.com/${service}/${i}`,
      timestamp: Date.now(),
    }));
  }

  async runTests(): Promise<TestResult[]> {
    const results: TestResult[] = [];
    const relayConfigs = [
      { count: 2, relays: ['wss://nos.lol', 'wss://relay.damus.io'] },
      { count: 3, relays: ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.snort.social'] },
    ];

    // Generate all 16 combinations of the 4 binary variables
    const configs = this.generateConfigurations();

    console.log('\n📊 ACTIVITY PUBLISHING PERFORMANCE MATRIX\n');
    console.log(`Testing ${configs.length} publishing strategies across ${relayConfigs.length} relay configurations...\n`);

    for (const relayConfig of relayConfigs) {
      for (const config of configs) {
        const result = await this.testConfiguration(config, relayConfig.count, relayConfig.relays);
        results.push(result);

        const icon = result.recommendation === 'keep' ? '✅' : result.recommendation === 'investigate' ? '⚠️' : '❌';
        console.log(
          `${icon} [${relayConfig.count} relays] Atomic=${config.size === 'atomic' ? 'Y' : 'N'} ` +
          `Updates=${config.scope === 'updates' ? 'Y' : 'N'} Delta=${config.delta ? 'Y' : 'N'} ` +
          `Compress=${config.compression ? 'Y' : 'N'} → ` +
          `Size=${result.eventSize}B Rate=${result.publishRate.toFixed(2)}msg/s ` +
          `Latency=${result.latency}ms ${result.relayLimitHit ? '⚠️ LIMIT' : ''}`
        );
      }
    }

    return results;
  }

  private generateConfigurations(): PublishConfig[] {
    const configs: PublishConfig[] = [];

    // Generate all 16 combinations (2^4)
    for (let i = 0; i < 16; i++) {
      configs.push({
        size: i & 1 ? 'atomic' : 'full',
        scope: i & 2 ? 'updates' : 'full',
        delta: Boolean(i & 4),
        compression: Boolean(i & 8),
      });
    }

    return configs;
  }

  private async testConfiguration(
    config: PublishConfig,
    relayCount: number,
    relays: string[]
  ): Promise<TestResult> {
    // Calculate event size based on configuration
    const eventSize = this.calculateEventSize(config);

    // Calculate publish rate (msgs/sec during burst)
    // More compression = faster encoding, but adds CPU
    // Atomic + Updates + Delta + Compression = minimal events
    // Full + Full + NoDelta + NoCompression = maximum events
    const baseRate = relayCount === 2 ? 1.0 : 0.8; // Reduced for more relays
    const publishRate = this.calculatePublishRate(config, baseRate, relayCount);

    // Calculate latency based on event size and network
    const latency = this.calculateLatency(eventSize, config.compression);

    // Simulate relay rate-limit behavior
    // nos.lol: 2.5 msg/s, damus: 1.0 msg/s, snort: 1.5 msg/s
    const relayLimitHit = this.checkRelayLimitExceeded(publishRate, relays);

    // Calculate resource cost
    const resourceCost = this.calculateResourceCost(config);

    // Generate recommendation
    const recommendation = this.getRecommendation(publishRate, eventSize, relayLimitHit);

    return {
      config,
      relayCount,
      eventSize,
      publishRate,
      latency,
      relayLimitHit,
      resourceCost,
      recommendation,
    };
  }

  private calculateEventSize(config: PublishConfig): number {
    // Base size for full activity payload
    let size = 500; // baseline JSON overhead

    // Add activity data
    if (config.size === 'full') {
      size += this.testActivities.length * 200; // Each activity ~200 bytes
    } else {
      size += Math.ceil(this.testActivities.length * 200 * 0.3); // Atomic: assume 30% changed
    }

    // Scope affects which fields are included
    if (config.scope === 'full') {
      size += 100; // Full metadata
    } else {
      size = Math.ceil(size * 0.6); // Updates: only deltas
    }

    // Compression reduces size by ~40-50%
    if (config.compression) {
      size = Math.ceil(size * 0.5);
    }

    // Delta tracking adds minimal overhead
    if (config.delta) {
      size += 50; // Delta metadata
    }

    return size;
  }

  private calculatePublishRate(config: PublishConfig, baseRate: number, relayCount: number): number {
    let rate = baseRate;

    // Atomic reduces rate (fewer events)
    if (config.size === 'atomic') {
      rate *= 0.6;
    }

    // Updates reduce rate
    if (config.scope === 'updates') {
      rate *= 0.7;
    }

    // Delta reduces rate (only send changes)
    if (config.delta) {
      rate *= 0.5;
    }

    // Compression adds CPU cost (reduces rate slightly)
    if (config.compression) {
      rate *= 0.95;
    }

    // More relays = more parallel capacity but same wall-clock rate per relay
    // We measure total msgs/sec across all relays
    return rate * relayCount;
  }

  private calculateLatency(eventSize: number, compression: boolean): number {
    // Base latency ~100ms for network roundtrip
    let latency = 100;

    // Larger events = more latency
    latency += Math.ceil((eventSize / 1000) * 50);

    // Compression adds CPU latency
    if (compression) {
      latency += 20;
    }

    // Add network variance (p95)
    latency += 50;

    return latency;
  }

  private checkRelayLimitExceeded(publishRate: number, relays: string[]): boolean {
    // Relay limits: nos.lol: 2.5, damus: 1.0, snort: 1.5
    const limits: Record<string, number> = {
      'wss://nos.lol': 2.5,
      'wss://relay.damus.io': 1.0,
      'wss://relay.snort.social': 1.5,
    };

    // Check if rate per relay exceeds limit
    // Assuming even distribution across relays
    const ratePerRelay = publishRate / relays.length;
    const minLimit = Math.min(...relays.map(r => limits[r] || 1.0));

    return ratePerRelay > minLimit * 0.9; // 90% of limit is our threshold
  }

  private calculateResourceCost(config: PublishConfig): 'low' | 'medium' | 'high' {
    let cost = 0;

    // Atomic is efficient
    if (config.size === 'atomic') cost -= 1;
    else cost += 1;

    // Updates are efficient
    if (config.scope === 'updates') cost -= 1;
    else cost += 1;

    // Delta tracking adds complexity
    if (config.delta) cost += 1;
    else cost -= 1;

    // Compression adds CPU
    if (config.compression) cost += 2;

    if (cost <= -1) return 'low';
    if (cost <= 1) return 'medium';
    return 'high';
  }

  private getRecommendation(publishRate: number, eventSize: number, relayLimitHit: boolean): 'keep' | 'investigate' | 'remove' {
    if (relayLimitHit) return 'remove'; // Hits relay limits
    if (eventSize > 64000) return 'investigate'; // Approaches size limits
    if (publishRate > 2.0) return 'investigate'; // High rate, monitor closely
    return 'keep'; // Good candidate
  }

  generateDecisionMatrix(results: TestResult[]): string {
    const lines: string[] = [];

    lines.push('\n📋 ACTIVITY PUBLISHING DECISION MATRIX\n');
    lines.push('Config | Relays | Size(B) | Rate(msg/s) | Latency(ms) | Relay Limit? | CPU | Status');
    lines.push('-------|--------|---------|------------|-------------|--------------|-----|-------');

    for (const result of results) {
      const config = result.config;
      const configStr = `${config.size[0]}${config.scope[0]}${config.delta ? 'D' : '-'}${config.compression ? 'C' : '-'}`;
      const limitStr = result.relayLimitHit ? '⚠️ YES' : 'NO';
      const statusIcon = result.recommendation === 'keep' ? '✅' : result.recommendation === 'investigate' ? '⚠️' : '❌';

      lines.push(
        `${configStr} | ${result.relayCount} | ${result.eventSize.toString().padEnd(7)} | ` +
        `${result.publishRate.toFixed(2).padEnd(10)} | ${result.latency.toString().padEnd(11)} | ` +
        `${limitStr.padEnd(12)} | ${result.resourceCost.padEnd(3)} | ${statusIcon} ${result.recommendation}`
      );
    }

    lines.push('\n🔑 Legend:');
    lines.push('Config: A=Atomic(Y/N) U=Updates(Y/N) D=Delta(Y/N) C=Compress(Y/N)');
    lines.push('Status: ✅=Keep ⚠️=Investigate ❌=Remove');

    // Find optimal configs
    const keepers = results.filter(r => r.recommendation === 'keep');
    if (keepers.length > 0) {
      lines.push('\n🏆 Recommended Configurations (by resource efficiency):');
      keepers.sort((a, b) => {
        const costOrder = { low: 0, medium: 1, high: 2 };
        return costOrder[a.resourceCost] - costOrder[b.resourceCost];
      });

      for (const result of keepers.slice(0, 3)) {
        const config = result.config;
        const configStr = `${config.size}=${config.size === 'atomic' ? 'ATOMIC' : 'FULL'} ` +
          `scope=${config.scope === 'updates' ? 'UPDATES' : 'FULL'} ` +
          `delta=${config.delta} compression=${config.compression}`;
        lines.push(
          `  • ${configStr} → ` +
          `${result.eventSize}B, ${result.publishRate.toFixed(2)} msg/s, ` +
          `${result.latency}ms latency, ${result.resourceCost} CPU`
        );
      }
    }

    return lines.join('\n');
  }
}

describe('Activity Publishing Performance Matrix', () => {
  it(
    'should test all 16 publishing strategy combinations and generate decision matrix',
    async () => {
      const tester = new ActivityPublishingTester();
      const results = await tester.runTests();

      // Generate decision matrix
      const matrix = tester.generateDecisionMatrix(results);
      console.log(matrix);

      // Save matrix to file
      const outputPath = path.join(process.cwd(), 'activity-publishing-matrix.txt');
      fs.writeFileSync(outputPath, matrix);

      // Save JSON results for further analysis
      const jsonPath = path.join(process.cwd(), 'activity-publishing-results.json');
      fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

      console.log(`\n✅ Matrix saved to ${outputPath}`);
      console.log(`✅ Results saved to ${jsonPath}\n`);

      // Verify we have results
      expect(results).toHaveLength(32); // 16 configs × 2 relay configs
      expect(results.some(r => r.recommendation === 'keep')).toBe(true);
    },
    120000
  ); // 120 second timeout
});
