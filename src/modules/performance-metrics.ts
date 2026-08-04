/**
 * Performance Metrics Collection Infrastructure
 * Generic interfaces for measuring system performance
 * Can be used for future performance testing and profiling work
 */

export interface PerformanceMetrics {
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

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  samples: number;
}

export interface SuccessStats {
  successRate: number; // 0-100
  failures: number;
  rateLimitErrors: number;
  timeoutErrors: number;
  otherErrors: number;
}

export interface ResourceStats {
  pollsPerSecond: number;
  cpuMs: number; // Approximate CPU time
  memoryMb: number;
  networkCallsPerSecond: number;
  dataVolumeKb: number;
}

export interface RelayHealthStats {
  connectedRelays: number;
  totalRelays: number;
  avgResponseTimeMs: number;
  connectionDrops: number;
}

export interface ActivityStateChange {
  timestamp: number;
  type: 'play' | 'pause' | 'stop' | 'change_content' | 'invite';
  service: string;
  content: string;
  detectedAt?: number; // When we detected it
  publishedAt?: number; // When published to Nostr
  receivedAt?: number; // When friend received it (simulation)
  displayedAt?: number; // When shown in UI
}

/**
 * Helper: Calculate percentile from sorted array of numbers
 */
export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Helper: Calculate mean/average
 */
export function calculateMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Helper: Build LatencyStats from raw samples
 */
export function buildLatencyStats(samples: number[]): LatencyStats {
  return {
    p50: calculatePercentile(samples, 50),
    p95: calculatePercentile(samples, 95),
    p99: calculatePercentile(samples, 99),
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: calculateMean(samples),
    samples: samples.length,
  };
}
