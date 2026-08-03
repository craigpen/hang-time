# Hang Time Performance Testing Framework

⚠️ **DEPRECATED (2026-08-03)**: The performance testing in this framework was based on simulated relay characteristics and flawed assumptions about relay limits. The simulated rate limits (1.0 msg/s, 0.5 msg/s) do not reflect actual Nostr relay behavior. Real relay limits are not publicly documented and vary by operator.

Systematic performance and efficiency testing to discover optimal settings for activity detection, publishing, and UI refresh, plus relay pool validation to standardize relay configuration.

## Implementation Status

### Currently Implemented ✅
- **Step 1: Parameter Matrix** (`src/__tests__/performance-harness.test.ts`) — Mock-based testing with configurable parameters
- **Step 2: Results Analyzer** (`scripts/analyze-performance.ts`) — Analyzes results and recommendations
- **Step 3: Integration Tests** (`src/__tests__/performance-integration.test.ts`) — Real code paths with mocked relays
- **Step 4: Ramp-Up Stress Test** (`src/__tests__/performance-rampup.test.ts`) — Simulated relay testing with RelayHealthMonitor

### Planned (Not Yet Implemented) 🔄
- **Step 5: Relay Pool Validation** (`src/__tests__/relay-validation.test.ts`) — Real relay testing
  - Relay health checks (connectivity, response times)
  - Rate limit discovery per relay
  - Size constraint testing (max event size, batch sizes)
  - Failure mode comparison (which relays fail under which conditions)
  - Reliability scoring and recommendations
  - Generates `relay-scorecard.json` with per-relay metrics and recommendations

### Not Yet Tested 🚫
- Actual testing against real Nostr relays (requires Step 5 implementation)
- Size/batch limit constraints per relay
- Relay-specific failure patterns and recovery
- Standardized relay pool configuration

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

### 5. **Relay Pool Validation** (`src/__tests__/relay-validation.test.ts`)

Tests each relay in the pool to determine reliability, rate limits, and constraints. Goal: standardize on a proven relay set (no user configuration).

**Use case**: Answer critical questions about relay behavior and recommend stable pool

**Relay Questions Answered**:
1. Are all relays valid and responsive?
2. Which relays fail under certain conditions?
3. Do relays have different rate or size limits?
4. Which relays are most reliable?
5. What's the safest publish rate across all relays?

**Run**:
```bash
npm test -- src/__tests__/relay-validation.test.ts
```

**Sub-Tests**:

#### 5a. Relay Health Check
- Connect to each relay
- Send simple test events
- Measure response time (p50, p95, p99)
- Record success rate
- Identify dead/unresponsive relays

#### 5b. Rate Limit Discovery
- For each relay, gradually increase publish rate
- Start: 1 msg/30s, increase 10% every minute
- Record when relay starts rejecting
- Measure: max sustainable rate per relay
- Compare rates across relays

#### 5c. Size Constraint Testing
- For each relay, test event sizes:
  - Small: 100 bytes
  - Medium: 1KB
  - Large: 10KB
  - XLarge: 100KB+
- Record max accepted size per relay
- Test batch sizes: 1, 5, 10, 50 events
- Identify relays with strict size limits

#### 5d. Failure Mode Comparison
- Send identical event sequences to all relays simultaneously
- Record which relays accept/reject each event
- Compare failure patterns:
  - All fail same way? (network issue)
  - Some fail, others succeed? (relay-specific)
  - Consistent failures? (policy) vs random? (flakiness)
- Measure time-to-first-error per relay
- Measure recovery time (if applicable)

#### 5e. Reliability Under Load
- Sustained load test over 5-10 minutes
- Send events at max sustainable rate per relay
- Record error rate, timeouts, disconnects
- Measure connection stability
- Calculate uptime percentage

**Output**: `relay-scorecard.json`
```json
{
  "relays": [
    {
      "url": "wss://nos.lol",
      "status": "ACTIVE",
      "response_time_p50_ms": 45,
      "response_time_p95_ms": 120,
      "response_time_p99_ms": 250,
      "max_sustainable_rate_msgs_per_sec": 2.5,
      "max_event_size_bytes": 65536,
      "max_batch_size": 50,
      "reliability_score_percent": 98.5,
      "error_patterns": ["occasional_timeout"],
      "recommendation": "KEEP"
    },
    {
      "url": "wss://relay.damus.io",
      "status": "ACTIVE",
      "response_time_p50_ms": 80,
      "response_time_p95_ms": 200,
      "response_time_p99_ms": 500,
      "max_sustainable_rate_msgs_per_sec": 1.0,
      "max_event_size_bytes": 32768,
      "max_batch_size": 20,
      "reliability_score_percent": 94.2,
      "error_patterns": ["rate_limit_aggressive", "slow_response"],
      "recommendation": "KEEP_BUT_MONITOR"
    }
  ],
  "summary": {
    "active_relays": 2,
    "dead_relays": 0,
    "recommended_publish_rate_msgs_per_sec": 1.0,
    "recommended_max_event_size_bytes": 32768,
    "recommended_batch_size": 20,
    "pooled_reliability_score_percent": 96.4
  }
}
```

**Recommendations Generated**:
- `KEEP` — Relay is reliable, use as-is
- `KEEP_BUT_MONITOR` — Functional but watch for issues
- `INVESTIGATE` — Intermittent failures, needs diagnosis
- `REMOVE` — Dead, unreliable, or too restrictive
- `UPGRADE_NEEDED` — Can upgrade if relay updates infrastructure

**Integration with Publishing**:
- Final publish rate = min(optimal_rate_from_perf_test, relay_pool_max_rate)
- Final event size = relay_pool_max_size
- All users get standardized settings (derived from pooled limits)

## Workflow (Safe-First Approach)

**Why this order?**
- Mock tests identify inefficiency before touching any relays ✅ (implemented)
- Integration tests validate real code paths without relay load ✅ (implemented)
- Ramp-up tests carefully probe relay limits with error monitoring (simulated) ✅ (implemented with simulated relays)
- Relay validation tests discover pool characteristics (planned) 🔄 (not yet implemented)
- No risk of blocking or permanent bans (simulated steps) or carefully monitored (real steps) ✅

**Current Status**: Steps 1-4 are implemented with simulated/mocked data. Step 5 (real relay validation) is planned.

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
# ✅ IMPLEMENTED: Step 1 - Find theoretical optimums (5-10 min)
npm test -- src/__tests__/performance-harness.test.ts
# Uses mock services, no relay involvement

# ✅ IMPLEMENTED: Step 2 - Analyze to find best candidates (fast)
npx ts-node scripts/analyze-performance.ts
# Output shows: most efficient config, parameter sensitivity

# ✅ IMPLEMENTED: Step 3 - Validate with real code paths (3 min)
npm test -- src/__tests__/performance-integration.test.ts
# Confirms latencies match mock predictions (uses mocked relays)

# ✅ IMPLEMENTED: Step 4 - Simulated ramp-up relay testing (10 min)
npm test -- src/__tests__/performance-rampup.test.ts
# Tests against simulated relays, finds theoretical rate limits
# Generates: relay-health-report.json (with simulated data)

# 🔄 PLANNED: Step 5 - Real relay pool validation (15 min)
# npm test -- src/__tests__/relay-validation.test.ts
# TODO: Implement real relay connectivity testing
# Will test: health checks, rate limits, size constraints, reliability
# Will generate: relay-scorecard.json with recommendations

# 🔄 PLANNED: Step 6 - Real relay stress testing (10 min)
# npm test -- src/__tests__/performance-rampup-real.test.ts
# TODO: Test against actual Nostr relays with real limits
# Uses results from Step 5 to set safe thresholds
```

**Current Time**: ~25 minutes (steps 1-4, all with simulated data)
**Total Time (when complete)**: ~50 minutes (including real relay testing)

**Note**: Current implementation is safe for iteration (all simulated). Real relay testing (Steps 5-6) requires implementation and careful execution to avoid blocking.

### Integration: Publishing Rate Formula

**Current (Simulated)**: After completing steps 1-4 (all with simulated data):
```
Final Publish Rate = optimal_rate_from_step_2 with safety margin
(Relay limits from step 4 are simulated; use for initial guidance only)
```

**Future (Real Relays)**: After implementing and completing steps 5-6 (real relay testing):
```
Final Publish Rate = min(
  optimal_rate_from_step_2,
  relay_pool_max_rate_from_step_5
)

Final Max Event Size = relay_pool_max_size_from_step_5
Final Batch Size = relay_pool_max_batch_from_step_5
```

This ensures all users have safe, standardized settings based on:
1. Performance requirements (what the system needs)
2. Relay constraints (what relays allow)
3. Reliability thresholds (what keeps us below rate-limit/rejection rates)

**Relay Pool Decision**: Once step 5 generates recommendations, we hardcode the relay list in the extension (no user configuration).

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
