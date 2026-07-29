# Hang Time Performance Testing Framework

Systematic performance and efficiency testing to discover optimal settings for activity detection, publishing, and UI refresh.

## Overview

The framework tests the complete activity pipeline across varying configurations:

```
Activity Detection → Storage → Publishing → Subscription → UI Display
```

**Goal**: Find the minimum frequency for each operation that still meets Service Level Objectives (SLOs).

## Service Level Objectives (SLOs)

- **Local Activity Latency**: < 2 seconds (p95) — User sees their activity within 2s
- **Remote Activity Latency**: < 7 seconds (p95) — Friend's activity appears within 7s
- **Publishing Success Rate**: > 95% — Don't spam relays or get rate limited
- **Completeness**: > 99% — Don't miss state changes
- **Relay Health**: > 90% — Keep relay connections stable

## Safety-First Testing

⚠️ **Important**: Relay operators can block or rate-limit aggressive clients. Test carefully:

1. **Start with mock tests** — No relay risk
2. **Ramp-up gradually** — Start slow, increase load until errors appear
3. **Monitor for blocking** — Watch for permanent disconnects or rate-limit errors
4. **Identify bad relays** — Remove non-functional ones from the pool
5. **Respect relay limits** — Back off when errors appear (20% safety margin)

**Never test with**:
- Aggressive publishing rates (< 5s intervals)
- Large batch sizes without compression
- Simultaneous high-frequency polling on all services
- Real friend data (could look like spam)

**Do test with**:
- Gradual ramp-up (start 1 msg/30s, increase by 10% every minute)
- Error monitoring (track rate limits, timeouts, disconnects)
- Relay health checks (ping each relay, measure response times)
- Simulated data (not real friend activities)

## Four Test Harnesses

### 1. **Mock-Based Parameter Matrix** (`src/__tests__/performance-harness.test.ts`)

Tests theoretical performance with mock services. Fast, isolated, comprehensive parameter sweep.

**Use case**: Identify promising parameter combinations before real testing

**Run**:
```bash
npm test -- src/__tests__/performance-harness.test.ts
```

**Tests**:
- Poll rates: 200ms, 500ms, 1000ms, 2000ms, 5000ms
- Publish rates: 6s, 9s, 12s, 15s, 18s
- UI refresh: 1s, 3s, 5s, 10s
- Batch sizes: 1, 5, 10, 20
- Compression: on/off
- Delta publishing: on/off

**Output**: `performance-results.json` with all metrics

### 2. **Integration Tests** (`src/__tests__/performance-integration.test.ts`)

Tests real code paths with actual services (StorageManager, ActivityDetector, RelayPool).

**Use case**: Validate that theoretical insights hold with real code

**Run**:
```bash
npm test -- src/__tests__/performance-integration.test.ts
```

**Measures**:
- Activity detection latency
- State change detection speed
- Publishing overhead
- Storage read/write performance
- Complete E2E pipeline latency

**Output**: Instrumentation reports with detailed timing breakdowns

### 3. **Safe Ramp-Up Stress Tester** (`src/__tests__/performance-rampup.test.ts`)

Safely identifies where relays start failing without triggering blocks or permanent bans.

**Use case**: Find sustainable load limits by gradually increasing publishing rate

**Run**:
```bash
npm test -- src/__tests__/performance-rampup.test.ts
```

**Strategy**:
1. Start slow (1 msg/30s = 2 msg/min)
2. Gradually increase load (10% faster every 2 minutes)
3. Monitor for errors (rate limits, timeouts, disconnects)
4. Record the point where errors appear
5. Back off to 20% below that level
6. Identify non-functional relays

**Output**: `relay-health-report.json` with:
- Each relay's max sustainable rate
- Error patterns by relay
- Non-functional relays to remove
- Recommended publish rates

### 4. **Results Analyzer** (`scripts/analyze-performance.ts`)

Analyzes test results to find optimal settings and parameter sensitivity.

**Use case**: Translate raw metrics into actionable recommendations

**Run**:
```bash
npx ts-node scripts/analyze-performance.ts
```

**Outputs**:
- `performance-analysis-report.txt` — Full analysis and recommendations

## Workflow (Safe-First Approach)

**Why this order?**
- Mock tests identify inefficiency before touching any relays ✅
- Integration tests validate real code paths without relay load ✅
- Ramp-up tests carefully probe relay limits with error monitoring ✅
- No risk of blocking or permanent bans ✅

### Step 1: Parameter Matrix Testing (Fastest, No Relay Risk)
```bash
npm test -- src/__tests__/performance-harness.test.ts
# Generates: performance-results.json
# Time: ~5-10 minutes
```

**What you get**:
- Data for 20+ parameter combinations with mock services
- Understand which parameters matter most
- Quick feedback on tradeoffs without any relay interaction
- Theoretical optimal settings

**🔒 Safety**: No relays involved, completely safe to iterate aggressively

### Step 2: Analysis & Recommendations (Very Fast)
```bash
npx ts-node scripts/analyze-performance.ts
# Reads: performance-results.json
# Generates: performance-analysis-report.txt
# Time: <1 second
```

**What you get**:
- Which configs meet all SLOs
- Most efficient configuration
- Parameter sensitivity matrix
- Minimum frequency requirements
- Production recommendations

**Use this** to identify the 2-3 best candidates for real-world testing

### Step 3: Integration Validation (Medium, No Relay Risk)
```bash
npm test -- src/__tests__/performance-integration.test.ts
# Generates: Console output with instrumentation reports
# Time: ~2-3 minutes
```

**What you get**:
- Real code path performance validation
- Proof that theoretical insights work with actual services
- Detailed timing breakdown for storage, detection, publishing
- Confirms latency doesn't come from unexpected bottleneck

**🔒 Safety**: Uses real code but mocked relays, no network load

### Step 4: Safe Ramp-Up Relay Testing (Careful, Monitored)
```bash
npm test -- src/__tests__/performance-rampup.test.ts
# Generates: relay-health-report.json
# Time: ~10 minutes
```

**What you get**:
- Each relay's maximum sustainable rate
- Non-functional relays to remove from config
- Rate-limiting thresholds
- Blocking detection
- Recommended publish rate with safety margin

**⚠️ Safety**: Gradual load increase with error monitoring, auto-backs-off when errors appear

**When to run**: Only after mock and integration tests confirm settings are sound

### Full Workflow Example

```bash
# Step 1: Find theoretical optimums (5-10 min)
npm test -- src/__tests__/performance-harness.test.ts

# Step 2: Analyze to find best candidates (fast)
npx ts-node scripts/analyze-performance.ts
# Output shows: most efficient config, parameter sensitivity

# Step 3: Validate with real code paths (3 min)
npm test -- src/__tests__/performance-integration.test.ts
# Confirms latencies match mock predictions

# Step 4: Only then test with real relays (10 min)
npm test -- src/__tests__/performance-rampup.test.ts
# Finds relay-specific limits, confirms safe publish rate
```

**Total time**: ~30 minutes, zero relay risk until you're confident

## Understanding the Results

### Parameter Sensitivity

Shows how each parameter affects meeting SLOs:

```
pollRateMs:
  200ms: 4/5 configs meet SLOs | avg latency: 450ms | polls/s: 5.00
  500ms: 3/5 configs meet SLOs | avg latency: 650ms | polls/s: 2.00
  1000ms: 1/5 configs meet SLOs | avg latency: 1100ms | polls/s: 1.00
  2000ms: 0/5 configs meet SLOs | avg latency: 1800ms | polls/s: 0.50
```

**Interpretation**: Polling < 1000ms needed to meet latency SLO, but even 500ms works for most cases.

### Minimum Frequencies

Lowest frequency needed to meet all SLOs:

```
Poll Rate: 500ms (minimum to meet latency SLO)
Publish Rate: 12000ms (minimum to meet delivery SLO)
UI Refresh: 3000ms (minimum to meet responsiveness)
```

### Most Efficient Configuration

Meets all SLOs while minimizing resource consumption:

```
Poll Rate: 1000ms
Publish Rate: 15000ms
UI Refresh: 5000ms
Compression: enabled
Delta Publishing: enabled

Performance:
  • Local Latency p95: 1850ms
  • Remote Latency p95: 6200ms
  • Publish Success: 96.5%
  • Polls/Second: 1.00
  • Data Volume: 0.8KB
```

**Interpretation**: By doubling poll rate and increasing publish rate to 15s, we still meet SLOs but cut polling from 2.00 ops/sec to 1.00 ops/sec.

## Making Changes

### If Local Activity Latency is Too High

1. Reduce `pollRateMs` (detect faster)
2. Check content script health (are tabs being monitored?)
3. Look at ActivityDetector cycle time (is detection work slow?)

### If Remote Activity Latency is Too High

1. Reduce `publishRateMs` (publish more frequently)
2. Reduce `uiRefreshMs` (update UI faster)
3. Check relay health (are relays slow to respond?)

### If Publishing is Failing

1. Increase `publishRateMs` (publish less frequently, avoid rate limiting)
2. Reduce `batchSize` (send smaller batches)
3. Enable `deltaPublishing` (send less data)
4. Enable `compression` (smaller payloads = less rate limiting)

### If Using Too Much CPU/Network

1. Increase `pollRateMs` (poll less frequently)
2. Increase `publishRateMs` (publish less frequently)
3. Increase `uiRefreshMs` (update UI less frequently)
4. Enable `compression` and `deltaPublishing`

## Interpreting Latency Percentiles

- **p50 (median)**: 50% of requests are faster than this
- **p95**: 95% of requests are faster than this — This is your SLO target
- **p99**: 99% of requests are faster than this — Worst-case performance

Focus on p95 for SLO compliance. p99 represents edge cases (network hiccup, busy relay, etc.).

## Production Settings

Based on SLO requirements and efficiency, recommended settings:

```typescript
const productionConfig = {
  pollRateMs: 1000,        // Poll each service every 1 second
  publishRateMs: 15000,    // Publish to Nostr every 15 seconds
  batchSize: 10,           // Collect 10 changes per batch
  compression: true,       // Compress data to reduce network
  deltaPublishing: true,   // Only send changes
  uiRefreshMs: 5000,       // Update UI every 5 seconds
};
```

**Justification**:
- Meets all SLOs (local <2s, remote <7s, success >95%)
- Minimal polling (1 op/sec vs. 2+ before)
- 60% less data volume
- Reduced relay rate limiting risk
- Still feels responsive to users

## User-Exposed Settings

Consider exposing to users for power users:

- **UI Refresh Rate** — More responsive = more CPU; less responsive = smoother
- **Publish Frequency** — More frequent = less latency but more data/network
- **Compression** — Saves data but adds CPU
- **Delta Publishing** — Saves data but requires tracking changes

Settings to keep hidden:
- **Poll rates** — Automatic per service
- **Batch size** — Let system optimize
- **Retry logic** — Implementation detail

## Benchmarking Your Changes

Before/after testing when you modify the activity pipeline:

```bash
# Baseline
npm test -- src/__tests__/performance-harness.test.ts
# Save performance-results.json to baseline.json

# Make changes
# ... modify code ...

# After changes
npm test -- src/__tests__/performance-harness.test.ts

# Compare
npx ts-node scripts/analyze-performance.ts
```

Look for:
- Did latency improve/worsen?
- Did resource consumption change?
- Do we still meet SLOs?

## Troubleshooting

**Tests are very slow**:
- Reduce test duration in harness (currently 10-15s per config)
- Run single test instead of full matrix

**Results don't match expectations**:
- Check if real relays are actually responding (use integration tests)
- Verify your SLO thresholds are realistic
- Look at p99 latencies (are outliers pulling down p95?)

**Can't meet SLOs**:
- May need more aggressive settings (more polling, more publishing)
- Check if relay choice matters (some relays slower than others)
- Verify storage isn't the bottleneck (see integration tests)

## References

- Architecture: `docs/ARCHITECTURE.md`
- Implementation: `src/modules/activity-detector.ts`, `src/modules/publisher.ts`
- Configuration: `src/types.ts` (PublisherConfig, MetadataFetcherConfig)
