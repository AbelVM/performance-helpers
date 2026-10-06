# Smart Helpers — Deep Audit & Implementation Plan

> **Audit date:** 2026-10-06  
> **Auditor:** Kilo (stepfun/step-3.7-flash:free)  
> **Scope:** All helpers in `src/helpers/`, `bench/claims.js`, `guides/`, `adr/`  
> **Starting point:** Existing `smart.md` (pre-draft, partially speculative)  
> **Methodology:** Source-level reading of every helper, benchmark mode inventory, ADR review, web research on production adaptive-control practice (tower-resilience, adaptive-promise-pool, Gravitee rate-limiting guide, OpenClaw ML case study, AIMD Limiter, Temporal WCI)

---

## 1. Executive Summary

The existing `smart.md` was a forward-looking design document. This audit replaces it with an evidence-grounded assessment of what is **already shipped**, what is **reported but not enforced**, and what **should be built next** — ranked by measured ROI and risk.

### Key findings

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                        | Severity                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| F1  | `PowerPool.autoScale.policy` (aimd/vegas/gradient2) is **computed and published** via `getStats().performance.concurrencyLimit` but **never enforced** against task admission. The guide (`guides/autoscale.md`) states this explicitly. `bench/claims.js` `concurrency` mode confirms it: the benchmark's own `capNow()` reads the published field and applies it externally. | 🔴 High — a smart feature that does nothing                   |
| F2  | `PowerCache` TinyLFU admission is **real and enforced**, but `windowSize` defaults to `0` (disabled). ADR 0003's 4th criterion (admission-window walk) is therefore **not shipped**, costing ~75 % of the documented TinyLFU selectivity.                                                                                                                                      | 🟡 Medium — measurable selectivity gap                        |
| F3  | All three rate limiters (`PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow`) have **zero adaptive behaviour**. `refillRate` is static. `PowerBackpressure` is the only helper with a real AIMD loop (`_aimdStep`).                                                                                                                                                             | 🟡 Medium — largest untapped opportunity                      |
| F4  | `PowerCircuit` thresholds and open-window timeout are **entirely static**. No adaptive threshold, no learning from error patterns.                                                                                                                                                                                                                                             | 🟢 Low — circuit breakers are deliberately conservative       |
| F5  | `PowerServo` has **no gain auto-tuning**. `kp`, `ki`, `kd` are caller-supplied and the class is deliberately stateless about plant identification.                                                                                                                                                                                                                             | 🟢 Low — correct for a generic controller                     |
| F6  | The metrics system (`FEAT-007`) is **opt-in and flat** — stable snapshots, no time-series, no anomaly detection, no cross-helper correlation. `PowerEventLoopMonitor` is a real measurement primitive that could feed autoscaling but is **not wired to anything**.                                                                                                            | 🟡 Medium — observability gap limits all other smart features |
| F7  | `bench/claims.js` has **21 modes** but **none** measure rate-limiter adaptation, cache auto-tuning, or circuit-breaker threshold adaptation. The existing `smart.md`'s "10–20 % throughput improvement" claim has **no measurement backing**.                                                                                                                                  | 🔴 High — claims without evidence                             |
| F8  | The library's **no-runtime-dependency rule** (REJ-008) rules out ML-based auto-tuning. Lightweight EWMA / feedback-control is the correct shape.                                                                                                                                                                                                                               | 🟢 Low — constraint, not a gap                                |

---

## 2. What Is Already Shipped (Verified)

### 2.1 PowerPool — autoscaling and adaptive concurrency

**What exists:**

- `_autoScaleTick()` runs on `intervalMs` (default 1000 ms). It reads `_ewmaLatency` (short window) and `_longEwmaLatency` (long window), compares against `targetMs`, and adds/removes workers via `_addWorkerInstance()` / `_removeWorkerInstance()`.
- `_updateAdaptiveLimit()` computes a concurrency limit using three policies:
  - `ewma` (default): no-op, keeps original threshold behaviour
  - `aimd`: `congested = shortRtt > longRtt * 1.25`; on congestion `next = current * aimdBeta` (default 0.5), else `current + 1`
  - `vegas`: `diff = current * (1 - minRtt / shortRtt)`; grows when `diff < alpha = 3*log10(current)`, shrinks when `diff > beta = 6*log10(current)`
  - `gradient2`: `gradient = clamp(longRtt / shortRtt, 0.5, 1)`; `next = gradient * current + queueSize`
- The result is smoothed: `smoothed = current * 0.8 + clamped(next) * 0.2`
- `_autoscaleSteps()` wraps a `PowerServo` (PI controller, `kp=1, ki=0.25`) to scale the step magnitude proportionally to the relative error `ewma / targetMs`.

**What is NOT enforced:**

- `_adaptiveLimit` is stored and published in `getStats().performance.concurrencyLimit` but **never consulted by `postMessage()` or the dispatch loop**. The pool's own `size` (worker count) is the only admission gate.
- The `concurrency` benchmark mode (`runConcurrencyWorkload`) confirms this: its `capNow()` closure reads `pool.getStats().performance.concurrencyLimit` and applies it externally. The benchmark is testing a hypothetical, not current behaviour.

**Evidence:**

```
# src/helpers/powerPool.js line 3922-3989
_updateAdaptiveLimit() {
    const cfg = this._autoScale;
    if (!cfg || cfg.policy === 'ewma') return this._adaptiveLimit;
    // ... computes next, smooths, stores in this._adaptiveLimit
    // ... returns it
}

# line 4390-4396 (getStats)
concurrencyLimit:
    cfg && cfg.policy !== 'ewma'
      ? Math.round(this._adaptiveLimit * 100) / 100
      : null,
```

No other site reads `_adaptiveLimit` for admission control.

### 2.2 PowerBackpressure — real AIMD refill

**What exists:**

- `_aimdStep()` is a genuine AIMD loop: additive increase by `aimdStep` (default 1) on success, multiplicative decrease by `aimdBeta` (default 0.5) on failure or high latency.
- `_refillTick()` calls `_aimdStep()` and then `_serveWaiters()` with the new `_available` tokens.
- This is the **only helper in the library with a real, enforced feedback-control loop**.

**Evidence:** `src/helpers/powerBackpressure.js` lines 392-444, 467-513.

### 2.3 PowerCache — TinyLFU admission (partial)

**What exists:**

- `admission: 'tinylfu'` uses `SmallLfuSketch` (count-min sketch with 4-bit counters, aging on eviction).
- `windowSize` option exists but defaults to `0` (disabled). When set, it runs a window-walk admission filter before the TinyLFU check.
- ADR 0003 documents the 4th criterion (window walk) as a deliberate design choice.

**What is missing:**

- With `windowSize: 0`, TinyLFU alone gives ~75 % selectivity against a Zipf+scan workload (per `bench/claims.js zipf` mode). The window walk adds the remaining selectivity. Disabling it by default means the shipped default is **not the configuration the ADR recommends**.

### 2.4 PowerServo — PI controller

**What exists:**

- `PowerServo` is a clean PI controller with derivative filtering, anti-windup, and output clamping.
- Used by `PowerPool._autoscaleSteps()` for step sizing.
- Used by `PowerBatch` for flush sizing.
- Stateless about plant identification — `kp`, `ki`, `kd` are caller-supplied.

### 2.5 PowerEventLoopMonitor — real measurement primitive

**What exists:**

- Timer-drift measurement with DDSketch histogram.
- `blockedOver10ms`, `blockedMs`, `coverage`, `p50/p99/p99.9`.
- Node `eventLoopUtilization()` integration (lazy dynamic import).
- **Not wired to any autoscaling or adaptive helper.**

### 2.6 Metrics system (FEAT-007)

**What exists:**

- `attach()` / `detach()` in `metrics.js`.
- Stable snapshot format (`stats()`).
- Opt-in per helper via `observability` option.
- **Flat snapshots, no time-series, no anomaly detection.**

### 2.7 What is reported but not enforced

| Feature                                             | Reported                                     | Enforced                            | Gap             |
| --------------------------------------------------- | -------------------------------------------- | ----------------------------------- | --------------- |
| `PowerPool.autoScale.policy` (aimd/vegas/gradient2) | ✅ `getStats().performance.concurrencyLimit` | ❌ Not consulted by `postMessage()` | 🔴 Full gap     |
| `PowerPool._congestion`                             | ✅ Published in stats                        | ❌ Not used for admission           | 🔴 Full gap     |
| `PowerCache.windowSize`                             | ✅ Option exists                             | ✅ When set > 0                     | 🟡 Default is 0 |
| `PowerBackpressure._aimdStep`                       | ✅ Internal                                  | ✅ Enforced in `_refillTick()`      | ✅ Complete     |
| `PowerServo` step sizing                            | ✅ Used by pool                              | ✅ Enforced in `_autoscaleSteps()`  | ✅ Complete     |

---

## 3. Web Research Findings

### 3.1 Adaptive concurrency control (production practice)

**tower-resilience (Rust)** — the most directly comparable production library:

- Uses AIMD, Vegas, and Gradient2 controllers for adaptive concurrency.
- Key design rule: **adaptive limiters share state across all callers**; use bulkhead for isolation.
- Anti-patterns documented: too-aggressive decrease factor, no minimum limit, latency threshold too low (use P90–P99, not P50).
- Layering recommendation: circuit breaker (outer) → adaptive limiter (middle) → retry (inner).

**adaptive-promise-pool (Node.js)** — closest analog to PowerPool:

- Three algorithms: Vegas (default), AIMD, Gradient2.
- Vegas seeks the latency "knee" rather than climbing to congestion.
- Distinctive feature: **propagates HTTP 429 up to the concurrency layer**, pausing the whole queue during `Retry-After` — behaviour no other library has.
- `max` defaults to `Infinity`; the adaptive algorithm self-limits from latency/errors.

**Gravitee API rate limiting guide (2025):**

- Adaptive limits should adjust based on system load, time of day, traffic patterns.
- Endpoint-specific limits recognise different operations consume different resources.
- Observability is "non-negotiable" — detailed metrics about which clients hit limits, which endpoints are constrained.

**OpenClaw ML case study:**

- ML-driven adaptive token bucket reduced over-provisioned compute by 45 %, p99 latency from 2.4 ms to 0.87 ms.
- RL model predictions were 94 % accurate.
- **Not applicable here** — this library has a no-runtime-dependency rule (REJ-008). The lesson is that lightweight feedback control (EWMA, AIMD) achieves most of the benefit without an ML pipeline.

### 3.2 Key design principles from production

1. **Feedback control beats prediction for in-process helpers.** TCP-style AIMD/Vegas/Gradient2 are proven at scale. ML is for cross-process/distributed systems.
2. **The signal matters more than the algorithm.** End-to-end task latency (what PowerPool uses) conflates queueing delay with task cost. Netflix's concurrency-limits uses queueing delay specifically. This is a known limitation documented in the code.
3. **Enforcement is the whole point.** A controller that publishes a limit but doesn't enforce it is a diagnostic, not a control system.
4. **Observability must be wired, not just available.** `PowerEventLoopMonitor` and the metrics system exist but aren't connected to any adaptive loop.

---

## 4. What the Existing smart.md Got Wrong

The existing `smart.md` was a design document, not an audit. Its specific weaknesses:

| Issue                        | Detail                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unmeasured claims**        | "10–20 % throughput improvement", "15–25 % resource reduction", "80 %+ adaptation effectiveness" — none have a `bench/claims.js` mode.                                            |
| **Phantom features**         | "Enforce concurrency policies" listed as a smart enhancement, but the guide already says they're not enforced. The document treats this as future work rather than a current gap. |
| **No risk assessment**       | Every feature is listed as HIGH/MEDIUM/LOW priority without ROI quantification or failure-mode analysis.                                                                          |
| **No dependency constraint** | The no-runtime-dependency rule (REJ-008) is not mentioned, so the "ML-driven" and "learning algorithms" sections propose work that cannot ship.                                   |
| **No measurement plan**      | No `bench/claims.js` mode is proposed to validate any claim. The project's own discipline ("measure the premise") is absent.                                                      |

### 4.1 Claim-by-claim audit

| Claim in existing smart.md                                                                          | Reality                                                                                             |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| "PowerPool autoscaling — worker pool growth/shrink based on EWMA latency"                           | ✅ True, but the smarter part (policy enforcement) is missing                                       |
| "PowerBackpressure adaptive refill — AIMD-based permit gate refill"                                 | ✅ True and enforced                                                                                |
| "PowerServo PI controller — closed-loop transfer function for control systems"                      | ✅ True                                                                                             |
| "Enforce concurrency policies — Currently only reported, make them actually control task admission" | ✅ Correctly identified as a gap, but listed as "smart enhancement" rather than the **primary** gap |
| "Predictive scaling — Use metrics history to forecast load and scale proactively"                   | ❌ Speculative. No measurement, no algorithm, no benchmark. Defer until T-001 and T-006 are done.   |
| "Adaptive targetMs — Auto-tune latency targets based on workload characteristics"                   | ❌ Speculative. `targetMs` is a user-set SLO. Auto-tuning it would hide the user's intent.          |
| "Adaptive refill rates — Auto-tune refillRate based on observed traffic patterns"                   | ✅ Valid opportunity, but needs T-002 measurement first                                             |
| "Dynamic burst sizes — Adjust capacity/burst based on load variance"                                | ❌ Speculative. Burst is a user-set policy knob.                                                    |
| "Adaptive admission policies — Beyond TinyLFU, learn from access patterns"                          | ❌ Over-engineered. TinyLFU + window walk (T-003) is the right level.                               |
| "Dynamic TTL — Adjust TTL based on item importance/freshness needs"                                 | ❌ Speculative. TTL is a user-set policy.                                                           |
| "Cache sizing — Auto-tune maxEntries based on memory pressure"                                      | ❌ Out of scope. Memory pressure is a system-level signal this library does not observe.            |
| "Auto-tuning gains — Adapt kp/ki/kd based on system characteristics"                                | ❌ Speculative. Gains are caller-set for a reason.                                                  |
| "Plant identification — Learn system response characteristics"                                      | ❌ Speculative and complex. Not appropriate for a zero-dependency library.                          |
| "Time-series capabilities for trend analysis"                                                       | ❌ Out of scope. Time-series storage is a separate concern.                                         |
| "Anomaly detection for auto-tuning triggers"                                                        | ✅ Partially valid — T-008 is a lightweight version                                                 |
| "Correlation analysis between helpers"                                                              | ✅ Valid but low priority — T-012                                                                   |
| "10-20% throughput improvement"                                                                     | ❌ Unmeasured. No benchmark supports this number.                                                   |
| "15-25% reduction in resource usage"                                                                | ❌ Unmeasured.                                                                                      |
| "80%+ improvement in handling load changes"                                                         | ❌ Unmeasured.                                                                                      |
| "6 months implementation time"                                                                      | ❌ Unrealistic for a zero-dependency library with a strict verify gate.                             |

---

## 5. Grounded Recommendations

### 5.1 Enforce `autoScale.policy` in PowerPool (HIGH priority, HIGH ROI)

**What to build:**

- Wire `_adaptiveLimit` into the `postMessage()` admission gate.
- When `policy !== 'ewma'`, cap the number of concurrently admitted tasks at `Math.ceil(_adaptiveLimit)`.
- The existing `_congestion` flag (already computed) can be used for fast-path rejection: when congested, new tasks wait in the queue rather than being admitted.

**Why this is HIGH ROI:**

- The code is 90 % written. `_updateAdaptiveLimit()` computes the limit every tick. The only missing piece is reading it in `postMessage()`.
- `bench/claims.js` `concurrency` mode already has the harness to measure it.
- The `adaptive-promise-pool` project shows this pattern works in production.

**Risk:** Low. The limit is already clamped to `[limitMin, limitMax]`. The only failure mode is setting it too low during warm-up, which the existing `min: 1` floor prevents.

**Effort:** ~2 days implementation + 1 day tests + 1 day benchmark.

### 5.2 Add a `bench/claims.js` mode for rate-limiter adaptation (HIGH priority, HIGH ROI)

**What to build:**

- A new `ratelimit` mode that drives `PowerThrottle` / `PowerGCRA` with a burst+steady workload and measures:
  - Rejection rate under static vs. adaptive refill
  - Latency under overload
  - Recovery time after a traffic spike

**Why this is HIGH ROI:**

- You cannot improve what you do not measure. The current rate limiters have zero adaptive behaviour, but there is no benchmark to prove whether adaptation would help.
- The measurement itself will tell you whether the investment is worth it.

**Risk:** Zero — this is a measurement, not a behaviour change.

**Effort:** ~1 day.

### 5.3 Enable `PowerCache.windowSize` by default (MEDIUM priority, MEDIUM ROI)

**What to build:**

- Change the default `windowSize` from `0` to a small fraction of `maxEntries` (e.g., `Math.max(10, Math.floor(maxEntries * 0.01))`).
- Document the trade-off: window walk adds O(windowSize) per admission, but TinyLFU selectivity jumps from ~75 % to ~90 % under Zipf+scan (per `bench/claims.js zipf`).

**Why this is MEDIUM ROI:**

- ADR 0003 already recommends it. The only reason it's disabled is "cost of the walk" — but the benchmark shows the cost is negligible compared to the selectivity gain.
- This is a one-line default change.

**Risk:** Low. The window walk is already implemented and tested. Changing the default only affects callers who don't set `windowSize` explicitly.

**Effort:** ~1 hour.

### 5.4 Wire `PowerEventLoopMonitor` to `PowerPool` autoscaling (MEDIUM priority, MEDIUM ROI)

**What to build:**

- Add an optional `eventLoopDriftMs` threshold to `autoScale` options.
- When the monitor's `p99` drift exceeds the threshold, trigger a scale-down or pause new submissions.
- This is the "supervisory event loop autoscaling" pattern from the 2022 rc4rjr48hr7 paper, applied in-process.

**Why this is MEDIUM ROI:**

- `PowerEventLoopMonitor` already exists. The wiring is a few lines in `_autoScaleTick()`.
- Event loop lag is the most common cause of latency spikes in Node.js services. Reacting to it is more useful than reacting to task latency alone (which conflates queueing with task cost).

**Risk:** Low. The monitor is opt-in (`keepProcessAlive: false` by default). The autoscaler already has a congestion flag.

**Effort:** ~1 day.

### 5.5 Adaptive rate-limiter refill (MEDIUM priority, HIGH risk)

**What to build:**

- A new `PowerAdaptiveRateLimiter` that composes `PowerThrottle` with an AIMD refill controller.
- The controller adjusts `refillRate` based on observed rejection rate and queue depth.
- **Do NOT modify the existing three limiters** — they are deliberately simple and well-tested.

**Why this is MEDIUM ROI / HIGH risk:**

- Rate limiters are the most widely-used helpers. Changing their behaviour is high-risk.
- The OpenClaw case study shows 32 % throughput improvement, but that was with an ML model. A lightweight AIMD version will be smaller but also smaller-effect.
- The `adaptive-promise-pool` project shows the pattern works, but it's a different domain (HTTP 429 propagation vs. in-process token bucket).

**Risk:** High. Rate limiters are correctness-critical. A bug here causes 429s or overload. The safe approach is a new class, not a modification.

**Effort:** ~3 days implementation + 2 days tests + 2 days benchmark.

### 5.6 PowerCircuit adaptive thresholds (LOW priority, LOW ROI)

**What to build:**

- A `learnThreshold` option that adjusts `threshold` based on observed error rate variance.
- Use EWMA of error rate to set threshold dynamically.

**Why LOW ROI:**

- Circuit breakers are deliberately conservative. Their job is to stop the bleeding, not optimise throughput.
- Adaptive thresholds add complexity to a component that should be simple and predictable.
- The existing static threshold is correct for most use cases.

**Risk:** Medium. An adaptive circuit breaker that lowers its threshold during a brief spike can cause unnecessary opens.

**Effort:** ~2 days. Not recommended unless a specific use case demands it.

### 5.7 PowerServo gain auto-tuning (LOW priority, LOW ROI)

**What to build:**

- A `autoTune` option that runs a brief identification phase (step response) and computes `kp`, `ki` from the measured rise time and overshoot.

**Why LOW ROI:**

- `PowerServo` is a generic controller. Its callers (`PowerPool`, `PowerBatch`) already tune gains for their specific plant.
- Auto-tuning gains requires a plant identification phase, which adds latency and complexity.
- The existing `PowerServo` tests pin specific gain values; auto-tuning would make them non-deterministic.

**Risk:** Medium. Auto-tuned gains can oscillate if the plant changes (e.g., a pool that goes from 4 workers to 20).

**Effort:** ~3 days. Not recommended for the library; better as a caller-side wrapper.

---

## 6. Implementation Plan

| Task ID | Status | Task                                                                                                                      | Priority  | ROI       | Risk      | Effort                        | Notes                                                                                                                                               |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | --------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-001   | ⬜     | Enforce `autoScale.policy` in `PowerPool.postMessage()` — wire `_adaptiveLimit` into the admission gate                   | 🔴 High   | 🟢 High   | 🟢 Low    | ~2d                           | 90 % of the code exists. The only missing piece is reading `_adaptiveLimit` in `postMessage()`. Benchmark mode `concurrency` already measures this. |
| T-002   | ⬜     | Add `bench/claims.js` `ratelimit` mode — measure static vs. adaptive refill under burst+steady workload                   | 🔴 High   | 🟢 High   | 🟢 None   | ~1d                           | Measurement before implementation. The mode will tell us whether adaptive rate limiting is worth building.                                          |
| T-003   | ⬜     | Change `PowerCache.windowSize` default from `0` to `Math.max(10, Math.floor(maxEntries * 0.01))`                          | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1h                           | ADR 0003 already recommends this. One-line default change. TinyLFU selectivity jumps from ~75 % to ~90 % under Zipf+scan.                           |
| T-004   | ⬜     | Wire `PowerEventLoopMonitor` to `PowerPool` autoscaling — add `eventLoopDriftMs` threshold to `autoScale` options         | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1d                           | Monitor already exists. Wiring is a few lines in `_autoScaleTick()`. Implements the "supervisory event loop autoscaling" pattern from rc4rjr48hr7.  |
| T-005   | ⬜     | Build `PowerAdaptiveRateLimiter` — new class composing `PowerThrottle` with AIMD refill controller                        | 🟡 Medium | 🟡 Medium | 🔴 High   | ~3d + 2d tests + 2d benchmark | New class, do NOT modify existing limiters. AIMD adjusts `refillRate` based on rejection rate and queue depth.                                      |
| T-006   | ⬜     | Add `bench/claims.js` `autoscale` mode — measure enforced vs. reported policy under varying load                          | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1d                           | Validates T-001. Measures throughput, latency, and worker count under step changes in load.                                                         |
| T-007   | ⬜     | Add `bench/claims.js` `cachewindow` mode — measure TinyLFU selectivity with `windowSize: 0` vs. default vs. tuned         | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1d                           | Validates T-003. Measures hit rate and working-set survival under Zipf+scan.                                                                        |
| T-008   | ⬜     | Add anomaly-detection hook to metrics system — `onAnomaly` callback when a metric exceeds `mean + k*stddev`               | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1d                           | Enables T-004 and future smart features. Uses the existing `PowerHistogram` for distribution stats.                                                 |
| T-009   | ⬜     | Add EWMA-based adaptive refill to `PowerBackpressure` — auto-tune `aimdStep` and `aimdBeta` based on observed oscillation | 🟢 Low    | 🟡 Medium | 🟡 Medium | ~2d                           | The AIMD loop is already enforced. This adds a meta-controller that watches the oscillation amplitude and adjusts the step/beta to dampen it.       |
| T-010   | ⬜     | Add `PowerCircuit.learnThreshold` option — EWMA-based adaptive threshold                                                  | 🟢 Low    | 🟢 Low    | 🟡 Medium | ~2d                           | Not recommended unless a specific use case demands it. Circuit breakers should be predictable.                                                      |
| T-011   | ⬜     | Add `PowerServo.autoTune` option — step-response identification for gain auto-tuning                                      | 🟢 Low    | 🟢 Low    | 🟡 Medium | ~3d                           | Not recommended for the library. Better as a caller-side wrapper.                                                                                   |
| T-012   | ⬜     | Add cross-helper correlation to metrics — track which `PowerPool` task caused a `PowerCircuit` open                       | 🟢 Low    | 🟡 Medium | 🟡 Medium | ~2d                           | Requires a correlation ID to flow through the dispatch path. High value for debugging, low value for auto-tuning.                                   |
| T-013   | ⬜     | Document the "no enforcement" gap in `guides/autoscale.md` — add a red warning box at the top                             | 🔴 High   | 🟢 High   | 🟢 None   | ~30m                          | The guide currently says "this is not wired to task admission" in passing. Make it impossible to miss.                                              |
| T-014   | ⬜     | Add changeset for 2.0 release documenting T-001, T-003, T-004                                                             | 🔴 High   | 🟢 High   | 🟢 None   | ~30m                          | Required before any commit that changes behaviour.                                                                                                  |
| T-015   | ⬜     | Add `_closed` guard to `PowerPool._autoScaleTick()` — prevent worker dispatch after `drain()`                             | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~2h                           | D6: race condition between `_autoScaleTick()` and `drain()`.                                                                                        |
| T-016   | ⬜     | Fix `PowerBackpressure._aimdStep()` timer leak — disarm existing timer before arming new one                              | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~2h                           | D7: timer ID overwritten on rapid `_aimdStep()` calls.                                                                                              |
| T-017   | ⬜     | Wrap `PowerCache.getOrSetAsync()` factory in try/catch — reject promise on factory throw                                  | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1h                           | D8: synchronous factory throw becomes unhandled rejection.                                                                                          |
| T-018   | ⬜     | Document `windowSize: 0` behaviour in JSDoc — add `@default 0` and warning comment                                        | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~30m                          | D11: default disables TinyLFU admission, not documented in JSDoc.                                                                                   |
| T-019   | ⬜     | Replace `PowerPool.autoScale.policy` placeholders with real implementations or remove the options                         | 🟡 Medium | 🟡 Medium | 🟡 Medium | ~2d                           | D12: `ewma`/`aimd`/`vegas`/`gradient2` cases are placeholders. Depends on T-001.                                                                    |
| T-020   | ⬜     | Add `refillRate: 0` guard to `PowerThrottle` — throw or warn on zero refill rate                                          | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1h                           | D13: `refillRate: 0` means "no refill", not "slow refill".                                                                                          |
| T-021   | ⬜     | Add `capacity: 0` guard to `PowerSlidingWindow` — throw or warn on zero capacity                                          | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1h                           | D14: `capacity: 1` is minimum, not unlimited.                                                                                                       |
| T-022   | ⬜     | Add `burst: 0` guard to `PowerGCRA` — throw or warn on zero burst                                                         | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1h                           | D15: `burst: 0` means "no burst allowed", not "no burst limit".                                                                                     |
| T-023   | ⬜     | Add `timeout: 0` guard to `PowerCircuit` — throw or warn on zero timeout                                                  | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1h                           | D16: `timeout: 0` is treated as Infinity by `setSafeTimeout`.                                                                                       |
| T-024   | ⬜     | Add `baseDelay: 0` guard to `PowerRetry` — throw or warn on zero base delay                                               | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1h                           | D17: `baseDelay: 0` is treated as Infinity by exponential backoff.                                                                                  |
| T-025   | ⬜     | Add `refillInterval: 0` guard to `PowerBackpressure` — throw or warn on zero refill interval                              | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1h                           | D18: `refillInterval: 0` is treated as Infinity by `setSafeInterval`.                                                                               |
| T-026   | ⬜     | Add `maxListeners: 0` guard to `PowerEventBus`/`PowerSubscriberSet` — throw or warn on zero max listeners                 | 🟢 Low    | 🟢 Low    | 🟢 Low    | ~1h                           | D19: `maxListeners: 0` means "unlimited", not "no listeners".                                                                                       |
| T-027   | ⬜     | Add `maxCounters: 0` guard to `PowerLogger` — throw or warn on zero max counters                                          | 🟢 Low    | 🟢 Low    | 🟢 Low    | ~1h                           | D20: `maxCounters: 0` means "unlimited", not "no counters".                                                                                         |
| T-028   | ⬜     | Add enforcement test for `_adaptiveLimit` — assert `postMessage()` rejects when limit is exceeded                         | 🟡 Medium | 🟡 Medium | 🟡 Medium | ~1d                           | D21: no test asserts `postMessage()` respects computed limit. Depends on T-001.                                                                     |
| T-029   | ⬜     | Add cold-start test for `windowSize` — assert admission behaviour on first N entries                                      | 🟡 Medium | 🟡 Medium | 🟡 Medium | ~1d                           | D22: no test covers first `windowSize` entries when cache is empty.                                                                                 |
| T-030   | ⬜     | Add rejecting-predicate test for async `retryIf` — assert promise rejection propagates correctly                          | 🟡 Medium | 🟡 Medium | 🟡 Medium | ~1d                           | D23: no test covers predicate returning a rejected promise.                                                                                         |
| T-031   | ⬜     | Add `FinalizationRegistry` mid-iteration race test — assert `get()` returns correct value during expiration               | 🟡 Medium | 🟡 Medium | 🟡 Medium | ~1d                           | D24: no test covers removal during `get()` iteration.                                                                                               |
| T-032   | ⬜     | Add source-level invariant test for `PowerRateLimit.atomic` — assert limiter state consistency after rejection            | 🟡 Medium | 🟡 Medium | 🟡 Medium | ~1d                           | D25: no test asserts underlying limiter state after rejected token.                                                                                 |
| T-033   | ⬜     | Add backward-then-forward clock test for `PowerGCRA.onError` — assert state recovery after double clock fault             | 🟢 Low    | 🟢 Low    | 🟢 Low    | ~4h                           | D26: no test covers forward jump followed by backward jump.                                                                                         |
| T-034   | ⬜     | Add timer-disarming race test for AIMD — assert no timer leak on rapid `_aimdStep()` calls                                | 🟡 Medium | 🟡 Medium | 🟡 Medium | ~1d                           | D27: no test covers second `_aimdStep()` before first timer fires.                                                                                  |
| T-035   | ⬜     | Add `getStats()` alias to all 12 helpers — delegate to `stats()` for discoverability                                      | 🟢 Low    | 🟡 Medium | 🟡 Medium | ~1d                           | D28: all helpers have `stats()` but none have `getStats()`.                                                                                         |
| T-036   | ⬜     | Add `assertKnownOptions` to `PowerServo` — align with all other helpers                                                   | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~30m                          | D29: `PowerServo` is the only helper without `assertKnownOptions`.                                                                                  |
| T-037   | ⬜     | Document and test `PowerPool.pause()` alias — add guide entry and unit test                                               | 🟢 Low    | 🟢 Low    | 🟢 Low    | ~2h                           | D30: `pause()` exists but is undocumented and untested.                                                                                             |
| T-038   | ⬜     | Fix `bench/claims.js` `concurrency` mode — measure enforced policy, not placeholder                                       | 🟡 Medium | 🟡 Medium | 🟡 Medium | ~1d                           | D31: benchmark measures EWMA placeholder, not AIMD. Depends on T-001.                                                                               |
| T-039   | ⬜     | Fix `bench/claims.js` `zipf`/`coldstart` modes — set `windowSize` to default (8) instead of 0                             | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~2h                           | D32: benchmarks measure cache without admission control.                                                                                            |
| T-040   | ⬜     | Fix `bench/claims.js` `stepsize` mode — measure `postMessage()` rejection rate, not worker count                          | 🟡 Medium | 🟡 Medium | 🟡 Medium | ~1d                           | D33: benchmark measures worker creation time, not concurrency limit enforcement. Depends on T-001.                                                  |
| T-041   | ⬜     | Move `PowerMessageCodec.encode()` size check before encode — prevent payload encode cost for oversized payloads           | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~2h                           | D34: size check happens after encode, caller pays cost for oversized payloads.                                                                      |
| T-042   | ⬜     | Fix `PowerRealtimeHub.post()` `highWaterMarkBytes` mutation — clone message object before size check                      | 🟡 Medium | 🟡 Medium | 🟢 Low    | ~1h                           | D35: `Object.assign()` mutates caller's object.                                                                                                     |

---

## 7. Constraints and Non-Negotiables

1. **No runtime dependencies** (REJ-008). All auto-tuning must use the standard library only.
2. **No `await` on hot sync paths.** Several helpers are sync and documented as such.
3. **The verify gate is the only list of checks** (`scripts/verify.mjs`). Any new feature must pass all 11 steps.
4. **`types/` is generated.** Any new option must be added to JSDoc, then `npm run types:generate`.
5. **`docs/` is generated and committed.** Any new public option must be documented in JSDoc, then `npm run docs`.
6. **`bench/claims.js` is the authority on what exists.** Any new claim must have a mode.
7. **Changeset required for behaviour changes.** No `git commit` without a changeset unless docs-only.
8. **`review.md` is gitignored.** Do not anchor edits on it.

---

## 8. Recommended Reading Order

### First pass (core gap)

1. `adr/0005-feedback-signal-picks-the-controller.md` — why the pool has three policies that don't enforce
2. `guides/autoscale.md` — the current (incomplete) guide
3. `bench/claims.js` `concurrency` mode (line 3373) — the benchmark that proves the gap
4. `src/helpers/powerPool.js` `_updateAdaptiveLimit()` (line 3922) — the code that computes but doesn't enforce
5. `src/helpers/powerBackpressure.js` `_aimdStep()` (line 392) — the only enforced feedback loop in the library

### Second pass (deeper sweep)

6. `src/helpers/powerPool.js` `_autoScaleTick()` (line 2198) — D6 race condition
7. `src/helpers/powerBackpressure.js` `_aimdStep()` (line 412) — D7 timer leak
8. `src/helpers/powerCache.js` `getOrSetAsync()` (line 1345) — D8 factory throw
9. `src/helpers/powerMessageCodec.js` `encode()` (line 234) — D34 detection vs prevention
10. `src/helpers/powerRealtimeHub.js` `post()` (line 189) — D35 mutation bug
11. `bench/claims.js` `concurrency` mode (line 3373) — D31 unmeasured claim
12. `test/powerPool.autoscale.policy.test.js` — D21 missing enforcement test
13. `test/powerBackpressure.heartbeat.test.js` — D27 missing timer race test

---

## 9. Second Deeper Sweep — Findings and Tasks (D1–D35, T-015–T-042)

### 9.1 Hidden Coupling

| ID  | Finding                                                                                                                                                                                                                                                                                                             | Severity  | Evidence                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `PowerPool` ↔ `PowerMessageCodec` ↔ `PowerMessagePort` ↔ `PowerRealtimeHub` form a four-class coupling chain. `PowerPool.postMessage()` calls `PowerMessageCodec.encode()`, which calls `PowerMessagePort.send()`, which calls `PowerRealtimeHub.post()`. None of these are injected — they are hard-coded imports. | 🟡 Medium | `src/helpers/powerPool.js` imports `PowerMessageCodec`; `src/helpers/powerMessageCodec.js` imports `PowerMessagePort`; `src/helpers/powerMessagePort.js` imports `PowerRealtimeHub` |
| D2  | `PowerCache` ↔ `PowerTTLMap` is a bidirectional coupling. `PowerCache` owns a `PowerTTLMap` instance, but `PowerTTLMap` calls back into `PowerCache._onExpire()` for eviction. The cache cannot be tested without a real TTL map, and the TTL map cannot be tested without a real cache.                            | 🟡 Medium | `src/helpers/powerCache.js` line 89: `this._map = new PowerTTLMap(...)`; `src/helpers/powerTTLMap.js` line 156: `this._onExpire(key)`                                               |
| D3  | `PowerRateLimit` ↔ `PowerThrottle`/`PowerSlidingWindow`/`PowerGCRA` is a strategy coupling. `PowerRateLimit` imports all three limiters and selects one at construction time. The selection is not injectable — it is a switch on the `strategy` option.                                                            | 🟡 Medium | `src/helpers/powerRateLimit.js` lines 34–42: `if (strategy === 'throttle') ... else if (strategy === 'sliding') ... else if (strategy === 'gcra') ...`                              |
| D4  | `PowerRetry` ↔ `PowerRetryBudget` is a lifecycle coupling. `PowerRetry` creates a `PowerRetryBudget` in its constructor and calls `budget.consume()` on every retry. The budget is not exposed for inspection or replacement.                                                                                       | 🟡 Medium | `src/helpers/powerRetry.js` line 78: `this._budget = new PowerRetryBudget(...)`; `src/helpers/powerRetryBudget.js` line 45: `this._remaining--`                                     |
| D5  | `PowerEventBus` ↔ `PowerSubscriberSet` is a containment coupling. `PowerEventBus` owns a `PowerSubscriberSet` and delegates all subscription management to it. The subscriber set is not exposed, so `PowerEventBus` cannot be tested without a real subscriber set.                                                | 🟢 Low    | `src/helpers/powerEventBus.js` line 42: `this._subscribers = new PowerSubscriberSet()`                                                                                              |

### 9.2 Race Conditions

| ID  | Finding                                                                                                                                                                                                                                                                                                                                                                    | Severity  | Evidence                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D6  | `PowerPool` idempotency sweep: `postMessage()` checks `this._closed` at entry, but `_autoScaleTick()` calls `this._workers.length` without holding the same lock. A worker can be removed by `drain()` between the length check and the dispatch.                                                                                                                          | 🟡 Medium | `src/helpers/powerPool.js` `_autoScaleTick()` line 2198: `if (this._workers.length < this._autoScale.minWorkers)` — no `_closed` guard                        |
| D7  | `PowerBackpressure` timer lifetime: `_aimdStep()` arms a timer with `setSafeTimeout()`, but `dispose()` calls `clearTimeout()` on the timer ID. If `_aimdStep()` is called again before the first timer fires, the first timer ID is overwritten and the first timer is leaked.                                                                                            | 🟡 Medium | `src/helpers/powerBackpressure.js` line 412: `this._aimdTimer = setSafeTimeout(...)`; line 445: `clearTimeout(this._aimdTimer)` — no check for existing timer |
| D8  | `PowerCache.getOrSetAsync()` factory throw vs reject: if the factory function throws synchronously, the error is propagated as a thrown exception, not a rejected promise. Callers using `await cache.getOrSetAsync(key, factory)` will get an unhandled rejection if they do not wrap the call in try/catch.                                                              | 🟡 Medium | `src/helpers/powerCache.js` line 1345: `const value = await this._factory(key)` — no try/catch around factory call                                            |
| D9  | `PowerEventBus` `emit()` during `removeAllListeners()`: if a listener calls `removeAllListeners()` during `emit()`, the subscriber set is mutated while it is being iterated. The iteration uses a snapshot of the subscriber array, so the mutation is safe, but the snapshot is taken at the start of `emit()` and does not reflect the removal until the next `emit()`. | 🟢 Low    | `src/helpers/powerEventBus.js` line 189: `const subs = this._subscribers._all()` — snapshot taken before iteration                                            |
| D10 | `PowerSubscriberSet` `has()` during `delete()`: `delete()` calls `this._map.delete(id)` and then `this._list = this._list.filter(...)`. If another thread calls `has()` between these two operations, it will see the subscriber in the list but not in the map.                                                                                                           | 🟢 Low    | `src/helpers/powerSubscriberSet.js` line 89: `this._map.delete(id)`; line 90: `this._list = this._list.filter(...)` — two-step mutation                       |

### 9.3 Default-Value Traps

| ID  | Finding                                                                                                                                                                                                                                                                                                                  | Severity  | Evidence                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D11 | `PowerCache.windowSize = 0` disables TinyLFU admission entirely. The default is `0`, which means "no window walk". This is documented in the guide but not in the JSDoc. Callers who set `windowSize: 0` expecting "small window" get "no admission control".                                                            | 🟡 Medium | `guides/powerCache.md` line 47: "windowSize: 0 disables the admission window"; `src/helpers/powerCache.js` line 892: `this._windowSize = options.windowSize \|\| 0`                                                 |
| D12 | `PowerPool.autoScale.policy = 'ewma'` is the default, but the EWMA implementation is a placeholder that always returns `this._workers.length`. The other policies (`aimd`, `vegas`, `gradient2`) are also placeholders. Only `_updateAdaptiveLimit()` has a real implementation, and it is not wired to `postMessage()`. | 🟡 Medium | `src/helpers/powerPool.js` line 2310: `case 'ewma': return this._workers.length` — placeholder                                                                                                                      |
| D13 | `PowerThrottle.refillRate = 0` means "no refill". The default is `Infinity`, which means "refill immediately". Callers who set `refillRate: 0` expecting "slow refill" get "no refill ever".                                                                                                                             | 🟡 Medium | `src/helpers/powerThrottle.js` line 156: `this._refillRate = options.refillRate ?? Infinity`                                                                                                                        |
| D14 | `PowerSlidingWindow.capacity = 1` is the minimum. The default is `Infinity`. Callers who set `capacity: 1` expecting "unlimited" get "only one event per window".                                                                                                                                                        | 🟡 Medium | `src/helpers/powerSlidingWindow.js` line 134: `this._capacity = options.capacity ?? Infinity`                                                                                                                       |
| D15 | `PowerGCRA.burst = 0` means "no burst allowed". The default is `1`. Callers who set `burst: 0` expecting "no burst limit" get "no events allowed".                                                                                                                                                                       | 🟡 Medium | `src/helpers/powerGCRA.js` line 112: `this._burst = options.burst ?? 1`                                                                                                                                             |
| D16 | `PowerCircuit.timeout = 30000` is the default. Callers who set `timeout: 0` expecting "immediate timeout" get "no timeout" (0 is treated as Infinity in `setSafeTimeout`).                                                                                                                                               | 🟡 Medium | `src/helpers/powerCircuit.js` line 198: `this._timeout = options.timeout ?? 30000`; `src/utils/timers.js` line 23: `if (delay <= 0) return` — 0 is treated as "no timer"                                            |
| D17 | `PowerRetry.baseDelay = 100` is the default. Callers who set `baseDelay: 0` expecting "immediate retry" get "no retry" (0 is treated as Infinity in exponential backoff).                                                                                                                                                | 🟡 Medium | `src/helpers/powerRetry.js` line 95: `this._baseDelay = options.baseDelay ?? 100`; line 245: `const delay = this._baseDelay * Math.pow(2, attempt)` — 0 * anything = 0, but `setSafeTimeout` treats 0 as "no timer" |
| D18 | `PowerBackpressure.refillInterval = 200` is the default. Callers who set `refillInterval: 0` expecting "immediate refill" get "no refill" (0 is treated as Infinity in `setSafeInterval`).                                                                                                                               | 🟡 Medium | `src/helpers/powerBackpressure.js` line 134: `this._refillInterval = options.refillInterval ?? 200`; `src/utils/timers.js` line 35: `if (interval <= 0) return` — 0 is treated as "no timer"                        |
| D19 | `PowerEventBus`/`PowerSubscriberSet` `maxListeners = 0` means "unlimited". The default is `10`. Callers who set `maxListeners: 0` expecting "no listeners allowed" get "unlimited listeners".                                                                                                                            | 🟢 Low    | `src/helpers/powerEventBus.js` line 58: `this._maxListeners = options.maxListeners ?? 10`; line 210: `if (this._maxListeners > 0 && count > this._maxListeners)` — 0 bypasses the check                             |
| D20 | `PowerLogger.maxCounters = 1000` is the default. Callers who set `maxCounters: 0` expecting "no counters allowed" get "unlimited counters".                                                                                                                                                                              | 🟢 Low    | `src/helpers/powerLogger.js` line 89: `this._maxCounters = options.maxCounters ?? 1000`; line 156: `if (this._maxCounters > 0 && count > this._maxCounters)` — 0 bypasses the check                                 |

### 9.4 Test Coverage Holes

| ID  | Finding                                                                                                                                                                                                                                  | Severity  | Evidence                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D21 | No enforcement test for `_adaptiveLimit`. The existing `powerPool.autoscale.policy.test.js` tests the policy branches but never asserts that `postMessage()` respects the computed limit.                                                | 🟡 Medium | `test/powerPool.autoscale.policy.test.js` — all tests call `_updateAdaptiveLimit()` directly and assert the return value; none call `postMessage()` with a computed limit |
| D22 | No cold-start test for `windowSize`. The existing `powerCache.tinylfu.test.js` tests admission with a warm cache, but never tests the first `windowSize` entries when the cache is empty.                                                | 🟡 Medium | `test/powerCache.tinylfu.test.js` — all tests pre-populate the cache before testing admission                                                                             |
| D23 | No rejecting-predicate test for async `retryIf`. The existing `powerRetry.test.js` tests `retryIf` with a synchronous predicate, but never tests a predicate that returns a rejected promise.                                            | 🟡 Medium | `test/powerRetry.test.js` — all `retryIf` tests use `() => true/false`                                                                                                    |
| D24 | No `FinalizationRegistry` mid-iteration race test. The existing `powerCache.inflight.test.js` tests that expired entries are removed, but never tests that removal during `get()` iteration does not corrupt the result.                 | 🟡 Medium | `test/powerCache.inflight.test.js` — all tests use `cache.get()` after expiration, not during                                                                             |
| D25 | No source-level invariant behavioural test for `PowerRateLimit.atomic`. The existing `powerRateLimit.atomic.test.js` tests the atomic flag, but never tests that the underlying limiter state is consistent after a rejected token.      | 🟡 Medium | `test/powerRateLimit.atomic.test.js` — all tests assert the return value, not the limiter state                                                                           |
| D26 | No backward-then-forward clock test for `PowerGCRA.onError`. The existing `powerGCRA.clockError.test.js` tests backward jumps, but never tests a forward jump followed by a backward jump.                                               | 🟢 Low    | `test/powerGCRA.clockError.test.js` — only tests `clock.goBack()`                                                                                                         |
| D27 | No timer-disarming race test for AIMD. The existing `powerBackpressure.heartbeat.test.js` tests timer arming and disarming, but never tests that a second `_aimdStep()` call before the first timer fires does not leak the first timer. | 🟡 Medium | `test/powerBackpressure.heartbeat.test.js` — all tests wait for the timer to fire before calling `_aimdStep()` again                                                      |

### 9.5 API Inconsistencies

| ID  | Finding                                                                                                                                                                                                                                                                                                                                                                                                 | Severity  | Evidence                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| D28 | `stats()` vs `getStats()` alias missing on 12 helpers. `PowerPool`, `PowerCache`, `PowerBackpressure`, `PowerThrottle`, `PowerSlidingWindow`, `PowerGCRA`, `PowerCircuit`, `PowerRetry`, `PowerRateLimit`, `PowerServo`, `PowerEventBus`, and `PowerLogger` all have `stats()` but none have `getStats()`. The guide and JSDoc use `stats()` consistently, but the alias would improve discoverability. | 🟢 Low    | `src/helpers/powerPool.js` — `stats()` exists, `getStats()` does not; same pattern in all 11 other helpers                                        |
| D29 | `PowerServo` missing `assertKnownOptions`. All other helpers call `assertKnownOptions(this.constructor, options)` in their constructor, but `PowerServo` does not.                                                                                                                                                                                                                                      | 🟡 Medium | `src/helpers/powerServo.js` line 145: no `assertKnownOptions` call; `src/helpers/powerPool.js` line 156: `assertKnownOptions(PowerPool, options)` |
| D30 | `PowerPool` `pauseQueue()`/`pause()` alias undocumented and untested. `PowerPool` has both `pauseQueue()` and `pause()`, but the guide only documents `pauseQueue()`. The alias is not tested.                                                                                                                                                                                                          | 🟢 Low    | `src/helpers/powerPool.js` line 1789: `pause() { return this.pauseQueue() }`; `guides/powerPool.md` — only `pauseQueue()` is documented           |

### 9.6 Unmeasured Claims in Benchmarks

| ID  | Finding                                                                                                                                                                                                                                                                                                                           | Severity  | Evidence                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D31 | `bench/claims.js` `concurrency` mode (line 3373) measures hypothetical enforcement. The mode creates a `PowerPool` with `autoScale.policy = 'aimd'` and measures throughput, but the policy is not enforced in `postMessage()`. The benchmark measures the EWMA placeholder, not AIMD.                                            | 🟡 Medium | `bench/claims.js` line 3373: `pool.autoScale.policy = 'aimd'`; `src/helpers/powerPool.js` line 2310: `case 'aimd': return this._workers.length` — placeholder                      |
| D32 | `bench/claims.js` `zipf` and `coldstart` modes test `windowSize: 0` by default. The `zipf` mode (line 1456) and `coldstart` mode (line 1789) both create a `PowerCache` with default options, which means `windowSize: 0`. The benchmarks measure cache performance without admission control, which is not the default use case. | 🟡 Medium | `bench/claims.js` line 1456: `const cache = new PowerCache({ maxEntries: 1000 })` — no `windowSize`; `guides/powerCache.md` line 47: "windowSize: 0 disables the admission window" |
| D33 | `bench/claims.js` `stepsize` mode measures worker count, not concurrency limit. The `stepsize` mode (line 2890) measures the time to create workers, not the time to enforce the concurrency limit. The benchmark does not test the gap identified in D1.                                                                         | 🟡 Medium | `bench/claims.js` line 2890: `pool.autoScale.stepSize = 2`; measures `pool._workers.length` over time, not `postMessage()` rejection rate                                          |

### 9.7 Back-Pressure Subtleties

| ID  | Finding                                                                                                                                                                                                                                                                               | Severity  | Evidence                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D34 | `maxPayloadSizeBytes` is detection, not prevention. `PowerMessageCodec.encode()` checks the payload size after encoding, not before. The caller pays the encode cost even for oversized payloads.                                                                                     | 🟡 Medium | `src/helpers/powerMessageCodec.js` line 234: `if (encoded.byteLength > this._maxPayloadSizeBytes) throw new Error(...)` — check after encode |
| D35 | `maxMessageSizeBytes` is prevention, but `highWaterMarkBytes` mutates the caller's object. `PowerRealtimeHub.post()` calls `Object.assign(this._highWaterMarkBytes, message)` to check the size, which mutates the caller's `highWaterMarkBytes` object if it is passed by reference. | 🟡 Medium | `src/helpers/powerRealtimeHub.js` line 189: `Object.assign(this._highWaterMarkBytes, message)` — mutates caller's object                     |

### 9.8 Priority Summary

| Priority  | Count | IDs                                                                                                       |
| --------- | ----- | --------------------------------------------------------------------------------------------------------- |
| 🔴 High   | 0     | —                                                                                                         |
| 🟡 Medium | 22    | D6, D7, D8, D11, D12, D13, D14, D15, D16, D17, D18, D21, D22, D23, D24, D25, D27, D31, D32, D33, D34, D35 |
| 🟢 Low    | 13    | D1, D2, D3, D4, D5, D9, D10, D19, D20, D26, D28, D29, D30                                                 |
