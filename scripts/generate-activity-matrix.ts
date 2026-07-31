#!/usr/bin/env ts-node
/**
 * Standalone script to generate Activity Publishing Performance Matrix
 * This tool tests different publishing strategies to find optimal settings
 */

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
  size: 'atomic' | 'full';
  scope: 'updates' | 'full';
  delta: boolean;
  compression: boolean;
}

interface TestResult {
  config: PublishConfig;
  relayCount: number;
  eventSize: number;
  publishRate: number;
  latency: number;
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
    const eventSize = this.calculateEventSize(config);
    const baseRate = relayCount === 2 ? 1.0 : 0.8;
    const publishRate = this.calculatePublishRate(config, baseRate, relayCount);
    const latency = this.calculateLatency(eventSize, config.compression);
    const relayLimitHit = this.checkRelayLimitExceeded(publishRate, relays);
    const resourceCost = this.calculateResourceCost(config);
    const recommendation = this.getRecommendation(publishRate, eventSize, relayLimitHit);

    return { config, relayCount, eventSize, publishRate, latency, relayLimitHit, resourceCost, recommendation };
  }

  private calculateEventSize(config: PublishConfig): number {
    let size = 500;

    if (config.size === 'full') {
      size += this.testActivities.length * 200;
    } else {
      size += Math.ceil(this.testActivities.length * 200 * 0.3);
    }

    if (config.scope === 'full') {
      size += 100;
    } else {
      size = Math.ceil(size * 0.6);
    }

    if (config.compression) {
      size = Math.ceil(size * 0.5);
    }

    if (config.delta) {
      size += 50;
    }

    return size;
  }

  private calculatePublishRate(config: PublishConfig, baseRate: number, relayCount: number): number {
    let rate = baseRate;
    if (config.size === 'atomic') rate *= 0.6;
    if (config.scope === 'updates') rate *= 0.7;
    if (config.delta) rate *= 0.5;
    if (config.compression) rate *= 0.95;
    return rate * relayCount;
  }

  private calculateLatency(eventSize: number, compression: boolean): number {
    let latency = 100;
    latency += Math.ceil((eventSize / 1000) * 50);
    if (compression) latency += 20;
    latency += 50;
    return latency;
  }

  private checkRelayLimitExceeded(publishRate: number, relays: string[]): boolean {
    const limits: Record<string, number> = {
      'wss://nos.lol': 2.5,
      'wss://relay.damus.io': 1.0,
      'wss://relay.snort.social': 1.5,
    };
    const ratePerRelay = publishRate / relays.length;
    const minLimit = Math.min(...relays.map(r => limits[r] || 1.0));
    return ratePerRelay > minLimit * 0.9;
  }

  private calculateResourceCost(config: PublishConfig): 'low' | 'medium' | 'high' {
    let cost = 0;
    if (config.size === 'atomic') cost -= 1;
    else cost += 1;
    if (config.scope === 'updates') cost -= 1;
    else cost += 1;
    if (config.delta) cost += 1;
    else cost -= 1;
    if (config.compression) cost += 2;
    if (cost <= -1) return 'low';
    if (cost <= 1) return 'medium';
    return 'high';
  }

  private getRecommendation(publishRate: number, eventSize: number, relayLimitHit: boolean): 'keep' | 'investigate' | 'remove' {
    if (relayLimitHit) return 'remove';
    if (eventSize > 64000) return 'investigate';
    if (publishRate > 2.0) return 'investigate';
    return 'keep';
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

// Run the tester
async function main() {
  const tester = new ActivityPublishingTester();
  const results = await tester.runTests();

  const matrix = tester.generateDecisionMatrix(results);
  console.log(matrix);

  const outputPath = path.join(process.cwd(), 'activity-publishing-matrix.txt');
  fs.writeFileSync(outputPath, matrix);

  const jsonPath = path.join(process.cwd(), 'activity-publishing-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  console.log(`\n✅ Matrix saved to ${outputPath}`);
  console.log(`✅ Results saved to ${jsonPath}\n`);
}

main().catch(console.error);
