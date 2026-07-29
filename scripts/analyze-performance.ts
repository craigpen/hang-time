#!/usr/bin/env ts-node

/**
 * Performance Results Analyzer
 * Analyzes test results to identify optimal settings and parameter sensitivity
 * Generates actionable recommendations based on SLOs
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

interface PerformanceResult {
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
    localActivityLatency: {
      p50: number;
      p95: number;
      p99: number;
      min: number;
      max: number;
      mean: number;
      samples: number;
    };
    remoteActivityLatency: {
      p50: number;
      p95: number;
      p99: number;
      min: number;
      max: number;
      mean: number;
      samples: number;
    };
    publishSuccess: {
      successRate: number;
      failures: number;
      rateLimitErrors: number;
      timeoutErrors: number;
      otherErrors: number;
    };
    completeness: number;
    resourceUsage: {
      pollsPerSecond: number;
      cpuMs: number;
      memoryMb: number;
      networkCallsPerSecond: number;
      dataVolumeKb: number;
    };
    relayHealth: {
      connectedRelays: number;
      totalRelays: number;
      avgResponseTimeMs: number;
      connectionDrops: number;
    };
  };
}

interface SLO {
  name: string;
  threshold: number;
  operator: 'lt' | 'gt' | 'eq';
}

const SLOs: Record<string, SLO> = {
  localLatency: { name: 'Local Activity p95', threshold: 2000, operator: 'lt' },
  remoteLatency: { name: 'Remote Activity p95', threshold: 7000, operator: 'lt' },
  publishSuccess: { name: 'Publishing Success Rate', threshold: 95, operator: 'gt' },
  completeness: { name: 'State Change Completeness', threshold: 99, operator: 'gt' },
  relayHealth: { name: 'Relay Connection Health', threshold: 0.9, operator: 'gt' },
};

// ============================================================================
// ANALYSIS ENGINE
// ============================================================================

class PerformanceAnalyzer {
  private results: PerformanceResult[] = [];

  constructor(resultsFile: string) {
    if (!fs.existsSync(resultsFile)) {
      throw new Error(`Results file not found: ${resultsFile}`);
    }

    const data = fs.readFileSync(resultsFile, 'utf-8');
    this.results = JSON.parse(data);
    console.log(`✅ Loaded ${this.results.length} test results\n`);
  }

  /**
   * Check if a result meets all SLOs
   */
  meetsSLOs(result: PerformanceResult): boolean {
    const checks = [
      result.results.localActivityLatency.p95 < SLOs.localLatency.threshold,
      result.results.remoteActivityLatency.p95 < SLOs.remoteLatency.threshold,
      result.results.publishSuccess.successRate > SLOs.publishSuccess.threshold,
      result.results.completeness > SLOs.completeness.threshold,
      (result.results.relayHealth.connectedRelays / result.results.relayHealth.totalRelays) >
        SLOs.relayHealth.threshold,
    ];

    return checks.every(check => check);
  }

  /**
   * Find configurations that meet all SLOs
   */
  findOptimalConfigs(): PerformanceResult[] {
    return this.results.filter(r => this.meetsSLOs(r));
  }

  /**
   * Analyze sensitivity of each parameter
   */
  analyzeParameterSensitivity(): Record<string, any> {
    const sensitivity: Record<string, Record<number, PerformanceResult[]>> = {
      pollRate: {},
      publishRate: {},
      batchSize: {},
      uiRefresh: {},
    };

    // Group results by each parameter
    for (const result of this.results) {
      const config = result.config;

      if (!sensitivity.pollRate[config.pollRateMs]) {
        sensitivity.pollRate[config.pollRateMs] = [];
      }
      sensitivity.pollRate[config.pollRateMs].push(result);

      if (!sensitivity.publishRate[config.publishRateMs]) {
        sensitivity.publishRate[config.publishRateMs] = [];
      }
      sensitivity.publishRate[config.publishRateMs].push(result);

      if (!sensitivity.batchSize[config.batchSize]) {
        sensitivity.batchSize[config.batchSize] = [];
      }
      sensitivity.batchSize[config.batchSize].push(result);

      if (!sensitivity.uiRefresh[config.uiRefreshMs]) {
        sensitivity.uiRefresh[config.uiRefreshMs] = [];
      }
      sensitivity.uiRefresh[config.uiRefreshMs].push(result);
    }

    return this.summarizeSensitivity(sensitivity);
  }

  private summarizeSensitivity(
    sensitivity: Record<string, Record<number, PerformanceResult[]>>
  ): Record<string, any> {
    const summary: Record<string, any> = {};

    for (const [param, values] of Object.entries(sensitivity)) {
      summary[param] = {};

      for (const [value, results] of Object.entries(values)) {
        const meetsCount = results.filter(r => this.meetsSLOs(r)).length;
        const avgLocalLatency =
          results.reduce((sum, r) => sum + r.results.localActivityLatency.p95, 0) / results.length;
        const avgPollsPerSec =
          results.reduce((sum, r) => sum + r.results.resourceUsage.pollsPerSecond, 0) /
          results.length;

        summary[param][value] = {
          count: results.length,
          metsSLOs: meetsCount,
          avgLocalLatency: avgLocalLatency.toFixed(0),
          avgPollsPerSec: avgPollsPerSec.toFixed(2),
        };
      }
    }

    return summary;
  }

  /**
   * Find minimum frequency needed for each parameter
   */
  findMinimumFrequencies(): Record<string, number> {
    const minimums: Record<string, number> = {
      pollRateMs: Infinity,
      publishRateMs: Infinity,
      uiRefreshMs: Infinity,
    };

    for (const result of this.results) {
      if (this.meetsSLOs(result)) {
        const config = result.config;
        minimums.pollRateMs = Math.min(minimums.pollRateMs, config.pollRateMs);
        minimums.publishRateMs = Math.min(minimums.publishRateMs, config.publishRateMs);
        minimums.uiRefreshMs = Math.min(minimums.uiRefreshMs, config.uiRefreshMs);
      }
    }

    return minimums;
  }

  /**
   * Find most efficient configuration (meets SLOs with least resource usage)
   */
  findMostEfficientConfig(): PerformanceResult | null {
    const validConfigs = this.findOptimalConfigs();
    if (validConfigs.length === 0) return null;

    // Sort by resource efficiency (lowest resource usage)
    return validConfigs.sort((a, b) => {
      const scoreA =
        a.results.resourceUsage.pollsPerSecond + a.results.resourceUsage.cpuMs / 1000;
      const scoreB =
        b.results.resourceUsage.pollsPerSecond + b.results.resourceUsage.cpuMs / 1000;
      return scoreA - scoreB;
    })[0];
  }

  /**
   * Generate comprehensive analysis report
   */
  generateReport(): string {
    let report = '\n';
    report += '╔════════════════════════════════════════════════════════════════════╗\n';
    report += '║         HANG TIME PERFORMANCE ANALYSIS REPORT                      ║\n';
    report += '╚════════════════════════════════════════════════════════════════════╝\n\n';

    // 1. SLO Summary
    report += '📋 SERVICE LEVEL OBJECTIVES (SLOs)\n';
    report += '═══════════════════════════════════════════════════════════════════\n';
    for (const [key, slo] of Object.entries(SLOs)) {
      report += `  ${slo.name}: ${slo.threshold}${slo.operator === 'lt' ? ' ms or less' : slo.operator === 'gt' ? ' % or higher' : ''}\n`;
    }
    report += '\n';

    // 2. Optimal Configurations
    const optimalConfigs = this.findOptimalConfigs();
    report += `✅ CONFIGURATIONS MEETING ALL SLOs\n`;
    report += '═══════════════════════════════════════════════════════════════════\n';
    report += `   Found ${optimalConfigs.length}/${this.results.length} configurations that meet all SLOs\n\n`;

    if (optimalConfigs.length > 0) {
      report += '   Sample Optimal Configs:\n';
      for (const config of optimalConfigs.slice(0, 3)) {
        report += `   • poll=${config.config.pollRateMs}ms, pub=${config.config.publishRateMs}ms, batch=${config.config.batchSize}, `;
        report += `ui=${config.config.uiRefreshMs}ms, compression=${config.config.compression}, delta=${config.config.deltaPublishing}\n`;
        report += `     → Local p95: ${config.results.localActivityLatency.p95.toFixed(0)}ms | `;
        report += `Remote p95: ${config.results.remoteActivityLatency.p95.toFixed(0)}ms | `;
        report += `Polls/s: ${config.results.resourceUsage.pollsPerSecond.toFixed(2)}\n`;
      }
      report += '\n';
    }

    // 3. Most Efficient
    const mostEfficient = this.findMostEfficientConfig();
    if (mostEfficient) {
      report += `⚡ MOST EFFICIENT CONFIGURATION\n`;
      report += '═══════════════════════════════════════════════════════════════════\n';
      report += `   Poll Rate: ${mostEfficient.config.pollRateMs}ms\n`;
      report += `   Publish Rate: ${mostEfficient.config.publishRateMs}ms\n`;
      report += `   Batch Size: ${mostEfficient.config.batchSize}\n`;
      report += `   UI Refresh: ${mostEfficient.config.uiRefreshMs}ms\n`;
      report += `   Compression: ${mostEfficient.config.compression}\n`;
      report += `   Delta Publishing: ${mostEfficient.config.deltaPublishing}\n\n`;
      report += `   Performance:\n`;
      report += `   • Local Latency p95: ${mostEfficient.results.localActivityLatency.p95.toFixed(0)}ms\n`;
      report += `   • Remote Latency p95: ${mostEfficient.results.remoteActivityLatency.p95.toFixed(0)}ms\n`;
      report += `   • Publish Success: ${mostEfficient.results.publishSuccess.successRate.toFixed(1)}%\n`;
      report += `   • Polls/Second: ${mostEfficient.results.resourceUsage.pollsPerSecond.toFixed(2)}\n`;
      report += `   • Data Volume: ${mostEfficient.results.resourceUsage.dataVolumeKb.toFixed(1)}KB\n\n`;
    }

    // 4. Parameter Sensitivity
    const sensitivity = this.analyzeParameterSensitivity();
    report += `📊 PARAMETER SENSITIVITY ANALYSIS\n`;
    report += '═══════════════════════════════════════════════════════════════════\n';

    for (const [param, values] of Object.entries(sensitivity)) {
      report += `\n   ${param}:\n`;
      for (const [value, stats] of Object.entries(values)) {
        report += `     ${value}ms: ${stats.metsSLOs}/${stats.count} configs meet SLOs | `;
        report += `avg latency: ${stats.avgLocalLatency}ms | polls/s: ${stats.avgPollsPerSec}\n`;
      }
    }

    // 5. Minimum Frequencies
    const minimums = this.findMinimumFrequencies();
    report += `\n⬇️  MINIMUM FREQUENCIES TO MEET SLOs\n`;
    report += '═══════════════════════════════════════════════════════════════════\n';
    if (minimums.pollRateMs !== Infinity) {
      report += `   Poll Rate: ${minimums.pollRateMs}ms (minimum to meet latency SLO)\n`;
    }
    if (minimums.publishRateMs !== Infinity) {
      report += `   Publish Rate: ${minimums.publishRateMs}ms (minimum to meet delivery SLO)\n`;
    }
    if (minimums.uiRefreshMs !== Infinity) {
      report += `   UI Refresh: ${minimums.uiRefreshMs}ms (minimum to meet responsiveness)\n`;
    }
    report += '\n';

    // 6. Recommendations
    report += `💡 RECOMMENDATIONS\n`;
    report += '═══════════════════════════════════════════════════════════════════\n';

    if (mostEfficient) {
      report += `   1. Use these settings for production:\n`;
      report += `      - Poll Rate: ${mostEfficient.config.pollRateMs}ms\n`;
      report += `      - Publish Rate: ${mostEfficient.config.publishRateMs}ms\n`;
      report += `      - UI Refresh: ${mostEfficient.config.uiRefreshMs}ms\n`;
      report += `      - Compression: ${mostEfficient.config.compression ? 'enabled' : 'disabled'}\n`;
      report += `      - Delta Publishing: ${mostEfficient.config.deltaPublishing ? 'enabled' : 'disabled'}\n\n`;
    }

    report += `   2. Settings to expose to users:\n`;
    report += `      - UI Refresh Rate (more responsive = more CPU)\n`;
    report += `      - Publish Rate (more frequent = more network)\n`;
    report += `      - Compression (saves data, adds CPU)\n\n`;

    report += `   3. Settings to keep hidden (no benefit to users):\n`;
    report += `      - Batch size (automatic optimization)\n`;
    report += `      - Poll rates for individual services\n\n`;

    report += `   4. Resource budget:\n`;
    if (mostEfficient) {
      report += `      - Polling frequency: ${mostEfficient.results.resourceUsage.pollsPerSecond.toFixed(2)} ops/sec\n`;
      report += `      - Data consumption: ~${(mostEfficient.results.resourceUsage.dataVolumeKb * 3600).toFixed(0)}KB/hour\n`;
      report += `      - CPU per activity: ~${mostEfficient.results.resourceUsage.cpuMs.toFixed(0)}ms\n\n`;
    }

    return report;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    const resultsFile = path.join(process.cwd(), 'performance-results.json');
    const analyzer = new PerformanceAnalyzer(resultsFile);

    const report = analyzer.generateReport();
    console.log(report);

    // Write report to file
    const reportFile = path.join(process.cwd(), 'performance-analysis-report.txt');
    fs.writeFileSync(reportFile, report);
    console.log(`\n📄 Full report written to ${reportFile}\n`);
  } catch (error) {
    console.error('❌ Analysis failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
