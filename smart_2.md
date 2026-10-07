# Smarter Helpers - Deep Audit & Implementation Plan

> **Audit date:** 2026-10-07  
> **Scope:** `src/`, `test/`, `bench/`, `guides/`, `adr/`, and public package metadata  
> **Explicitly excluded:** `notes.md`  
> **Constraint:** dependency-free, ESM/CJS, Node/browser, cross-realm safe

## 1. Executive Summary

The project already has the important control primitives: `PowerServo`, EWMA
latency tracking, AIMD backpressure, adaptive pool admission, TinyLFU
admission, histograms, event-loop monitoring, and pull-based metrics. The next
useful step is not a universal autotuner. It is a small set of composable
observations and guarded decisions that can be measured, disabled, and audited.

### Highest-value conclusions

| ID  | Finding                                                                                                                                              | Judgment                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| F1  | `PowerPool` now enforces adaptive admission, so the main smart.md control-plane gap is closed.                                                       | Build on it; do not add another pool controller.                |
| F2  | Similar signals are not normalized across pool, batch, backpressure, circuit, and rate-limit helpers.                                                | Add a portable observation vocabulary before adding algorithms. |
| F3  | Pull snapshots lack deltas, sample counts, warm-up state, and signal freshness.                                                                      | Highest observability gap.                                      |
| F4  | Latency is not consistently split into queue wait, service time, cancellation, timeout, retry, and rejection.                                        | Controllers can optimize the wrong quantity.                    |
| F5  | Node exposes ELU, event-loop delay, worker CPU, CPU profiles, and heap profiles; browsers expose User Timing and partial scheduling/memory APIs.     | Add optional adapters, never core imports.                      |
| F6  | SLOs, TTLs, burst sizes, retry policy, cache size, and circuit thresholds are application policy.                                                    | Do not silently infer them.                                     |
| F7  | Cross-realm support rules out constructor identity and `Symbol.toStringTag` as type proof.                                                           | Make real second-realm tests a release gate.                    |
| F8  | ML, reinforcement learning, global correlation, predictive scaling, and automatic gain identification lack evidence and increase product complexity. | Reject for v2.                                                  |

### Recommended direction

1. Add portable math only where it removes duplication: deltas, EWMA windows,
   confidence/warm-up state, robust quantiles, and bounded change detection.
2. Make existing controllers consume explicit signals: service latency, queue
   wait, error/rejection rate, saturation, and event-loop pressure.
3. Add opt-in Node/browser profiling adapters. Keep platform capabilities out
   of portable helpers.
4. Treat autotuning as a proposal with minimum samples, rate limits, bounds,
   cooldown, rollback, and a reasoned stats record.
5. Require a deterministic `bench/claims.js` mode and a mutation check before
   shipping each adaptive behavior.

## 2. Current-State Audit

### 2.1 Control primitives already present

- `PowerPool` scales worker count from latency and enforces adaptive admission.
- `PowerBackpressure` has an enforced AIMD refill loop.
- `PowerServo` provides filtering, clamping, and anti-windup.
- `PowerBatch` adapts flush sizing, but its tuning signal is local to batching.
- `PowerCache` has LRU/TTL behavior and TinyLFU admission; `windowSize: null`
  derives a value while `0` remains an explicit opt-out.
- `PowerEventLoopMonitor` measures timer drift, blocked time, percentiles, and
  Node event-loop utilization.
- `PowerHistogram` and metrics snapshots provide raw material, but not a shared
  time-series or controller contract.

### 2.2 Where smart behavior currently stops

| Surface            | Existing signal                     | Missing decision quality                                             |
| ------------------ | ----------------------------------- | -------------------------------------------------------------------- |
| Pool               | EWMA latency, queue, adaptive limit | Separate queue wait from service time; freshness and confidence      |
| Backpressure       | Success/failure, latency            | Explicit outcome taxonomy; protection from stale/correlated feedback |
| Batch              | Flush latency/size                  | Cost model for item count, bytes, deadline, and workload phase       |
| Cache              | Hit/miss, admission sketch          | Byte-weighted capacity, resident-size pressure, scan detection       |
| Rate limit         | Time and token state                | Measured adaptive policy and external overload feedback              |
| Circuit            | Failures and timeout                | Error classification and slow-call budget                            |
| Event loop         | Drift and ELU                       | Portable consumer or explicit controller adapter                     |
| Metrics            | Pull snapshot                       | Deltas, windows, confidence, anomaly state, causal correlation       |
| Workers/transports | Messages and transfers              | Optional clone/transfer cost observations                            |

### 2.3 Default-policy audit

Smart defaults should answer what is safe without knowing the workload. They
should not replace application policy.

| Helper concern       | Keep caller-owned | Candidate derived default                                       |
| -------------------- | ----------------- | --------------------------------------------------------------- |
| Target latency/SLO   | Yes               | None; require it for closed-loop behavior                       |
| Min/max concurrency  | Yes               | Conservative Node adapter ceiling only; no browser guess        |
| Batch flush interval | Yes               | Derive only from an explicit deadline                           |
| Cache TTL            | Yes               | No universal TTL; support `expiresAt` and lazy stale accounting |
| Cache capacity       | Yes               | Optional byte budget callback, not heap introspection in core   |
| Rate refill/burst    | Yes               | Fixed behavior remains default; adaptive mode is opt-in         |
| Circuit threshold    | Yes               | Optional slow-call/error budget mode                            |
| Sampling rate        | No                | Low baseline; increase on anomaly; decay afterward              |

## 3. Deep Findings and Recommendations

### R1 - Create an observation contract before a meta-helper

Helpers record similar concepts under different names and time scales. A
snapshot can report p99 without saying how many samples produced it, whether it
is current, or whether queue delay is included.

Define an internal/plain-object observation shape, not a mandatory base class:

```js
{
  now,
  samples,
  windowMs,
  queueWaitMs,
  serviceMs,
  latencyMs,
  successRate,
  rejectionRate,
  saturation,
  eventLoopUtilization,
  fresh: true
}
```

Fields should be optional and produced only where cheap. A controller should
return `warmup`, `stale`, `bounded`, and `reason` alongside a proposed value.
This makes “no decision” a first-class result instead of treating zero or an
old value as evidence.

Do not make every helper inherit a controller class or allocate observations on
every hot-path operation. Aggregate at window boundaries or on `stats()`.

### R2 - Separate queue wait from service latency

`PowerPool` and similar helpers can see end-to-end latency, but queueing and
work cost imply different actions. Increasing concurrency can reduce queue wait
while increasing service time and event-loop pressure. A controller with only
end-to-end latency can oscillate or reward overload.

Add optional timestamps at admission, start, and completion. Expose aggregate
queue wait and service-time histograms. Use queue delay as the primary signal
for admission control where available, with service latency and error rate as
guardrails. Keep timestamps opt-in if allocation cost is material.

Validation must compare fixed, queue-aware, and end-to-end controllers over
CPU-bound, I/O-like, bursty, and mixed tasks. Report p50/p95/p99, throughput,
rejections, queue depth, and controller oscillation.

### R3 - Add guarded autotuning, not automatic policy ownership

The reusable abstraction should be a bounded proposal engine:

- input: current value, observed signal, target, bounds, step, and cooldown;
- output: proposed value, confidence, reason, and whether it changed;
- protection: warm-up, max step per window, consecutive evidence, cooldown,
  and rollback on regression.

Build it on `PowerServo` and existing EWMA math. It must not infer an SLO, TTL,
retry policy, or cache semantics. Candidate users are pool admission, batch
size, and backpressure refill, each with its own signal adapter.

### R4 - Upgrade robust statistics before adding more strategies

Mean/EWMA latency is vulnerable to heavy tails and workload phase changes.
Prefer a small dependency-free toolkit:

- exponentially weighted p95/p99 approximation or histogram percentiles;
- median/MAD or winsorized samples for noisy scalar signals;
- sample count and confidence/warm-up state;
- change detection using two windows and hysteresis;
- explicit reset on clock discontinuity or configuration change.

Do not add a generic anomaly detector until a benchmark demonstrates that it
avoids a controller regression. A two-window sustained-change detector is more
explainable and cheaper than a black-box detector.

### R5 - Add a profiler as an opt-in adapter layer

Node's official `perf_hooks` API provides `eventLoopUtilization()`, event-loop
delay histograms, `createHistogram()` with EWMA support, `PerformanceObserver`,
and `timerify()`. Node workers additionally expose worker ELU, CPU usage, and
recent CPU/heap profiling APIs. Observers and profiles have overhead and are not
portable.

Proposed surfaces:

- `powerProfiler/core`: injected `now`, counters, sampling, and snapshots;
- `powerProfiler/node`: optional ELU, event-loop delay, CPU/memory, and worker
  statistics;
- `powerProfiler/web`: User Timing marks/measures and feature-detected
  `scheduler.postTask` or memory sampling;
- no automatic global hooks, permanent observers, or heap snapshots in hot paths.

Adapters must be explicitly started/stopped and implement disposal. Unavailable
fields should stay unavailable rather than being emulated in browsers.

### R6 - Make profiling sampling adaptive, but keep the core cheap

Always-on per-operation instrumentation defeats the point of a performance
toolbox. Use reservoir or periodic sampling, triggered by an anomaly or an
explicit debug mode. Use low baseline sampling, temporary high-rate sampling
during a detected change, then decay to baseline.

Profiler stats should include sample count, sampling rate, dropped samples, and
estimated overhead. Benchmark disabled, baseline, and anomaly sampling on the
actual helper call path.

### R7 - Improve cache intelligence only around measurable costs

TinyLFU/W-TinyLFU is a sound basis for skewed workloads, and this project has
already measured that changing `windowSize` is not automatically beneficial.
Next experiments should be:

1. byte-weighted capacity via caller-supplied `sizeOf`;
2. scan/change detection that temporarily protects the hot set;
3. admission diagnostics: candidate rejected, victim frequency, hit-rate delta;
4. optional stale-while-revalidate coordination for async callers.

Avoid automatic TTL learning, heap-based sizing in core, and another admission
algorithm without traces. `sizeOf` is user code and is excluded from strict
hot-path guarantees.

### R8 - Measure external rate-limit feedback before adaptation

The rate limiters are intentionally deterministic. Adaptive refill is plausible
only when the caller supplies a trustworthy signal such as HTTP 429/
`Retry-After`, queue saturation, or an error budget. Local rejection mostly
measures the limiter rejecting work it chose to reject.

First add a deterministic benchmark for fixed refill versus AIMD, Vegas, or
gradient control. Include recovery time, fairness across keys, burst behavior,
and overload latency. If a candidate wins materially, expose it as an explicit
policy with bounds and a feedback callback. Do not silently make
`PowerGCRA`, `PowerThrottle`, or `PowerSlidingWindow` adaptive.

### R9 - Scheduling adapters should preserve semantics

The browser Prioritized Task Scheduling API supports priority, delay, and abort,
but is not universal. A scheduler helper may use it when feature-detected,
while preserving existing fallback behavior. Do not claim equivalent priority
semantics when the fallback cannot provide them.

### R10 - Cross-realm safety is a release gate

For new guards:

- use `ArrayBuffer.isView()` for views;
- use an intrinsic accessor such as
  `Reflect.get(ArrayBuffer.prototype, 'byteLength', value)` for ArrayBuffer
  internal-slot checks;
- avoid `instanceof`, realm-local constructors, and `Symbol.toStringTag` as
  type proof;
- use capability checks for optional platform APIs;
- test real second-realm values with `node:vm`, not plain-object impostors.

This applies to profiler input, transfer helpers, message codecs, cache keys,
and future memory/serialization adapters.

### R11 - Meta-helpers should compose metrics, not own all policy

A useful `PowerDiagnostics` layer could attach to existing helpers, collect
periodic snapshots, detect stale or anomalous signals, and emit proposals. It
must not reach into private fields, mutate policies behind the caller's back,
or correlate every helper globally.

Responsibilities:

- register named observations and detach them cleanly;
- aggregate deltas and windows;
- surface saturation, stale data, clock faults, and oscillation;
- expose proposed changes for caller acceptance;
- apply only changes explicitly marked safe by the helper.

This is lower priority than stable per-helper stats; otherwise it creates a
second observability format.

## 4. SOTA Techniques: Adopt, Adapt, Reject

| Technique                        | Decision                 | Reason                                                                          |
| -------------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| AIMD / Vegas / Gradient2         | Adapt                    | Already aligned with pool/backpressure; require queue-aware signals and bounds. |
| TinyLFU / W-TinyLFU              | Keep                     | Evidence-backed and already implemented; optimize integration first.            |
| Tail-aware control and hedging   | Measure                  | Tail latency matters, but hedging duplicates work and needs budgets.            |
| EWMA with hysteresis             | Adopt                    | Cheap, explainable, and suited to phase changes.                                |
| Change-point detection           | Small two-window version | Useful trigger; avoid a general statistical package.                            |
| Bayesian/ML/RL autotuning        | Reject for v2            | Dependency, explainability, persistence, and training-data costs.               |
| Node `perf_hooks` / V8 profiling | Optional adapter         | Strong diagnostics, Node-specific and potentially expensive.                    |
| Browser `scheduler.postTask`     | Feature-detect           | Priority semantics are unavailable in some browsers.                            |
| Browser memory measurement       | Adapter only             | Experimental/limited and requires secure cross-origin isolation.                |
| SharedArrayBuffer permit pool    | Do not assume            | Existing measurements rejected the premise.                                     |
| Global cross-helper correlation  | Defer                    | No stable causal contract; likely hidden coupling.                              |

## 5. Guardrails and Evidence Requirements

Every adaptive change must satisfy all of these:

1. A deterministic benchmark mode in `bench/claims.js` using seeded workloads.
2. A fixed-policy baseline and at least one adversarial workload.
3. Ratios/counters rather than fragile wall-clock thresholds where possible.
4. A minimum sample count and explicit warm-up state.
5. Hard min/max bounds, maximum step, cooldown, and a disable switch.
6. Tests for clock rollback, stale feedback, cancellation, errors, and empty windows.
7. A mutation check that fails when enforcement is removed.
8. Cross-realm fixtures for any type or buffer guard.
9. Stats explaining signal, confidence, proposed value, reason, last change,
   and rejected/rolled-back changes.
10. No regression in disabled-mode overhead or public default behavior.

## 6. Implementation Plan

Status is deliberately conservative: `🟡` means evidence or design work first,
not permission to implement the public API immediately.

| ID     | Priority | Area            | Proposed work                                                                                     | Evidence gate                                                      | Main risk                                        | Status                                           |
| ------ | -------- | --------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------ |
| S2-001 | P0       | Metrics         | Define optional observation vocabulary with deltas, sample count, window, freshness, and warm-up. | Snapshot compatibility tests; zero allocation when disabled.       | Duplicate stats or become a base class.          | ✅ Shipped in `metrics`                          |
| S2-002 | P0       | Pool            | Split queue-wait and service-time measurement behind an opt-in flag.                              | CPU/I/O/bursty comparison against current controller.              | Timestamp allocation and misleading attribution. | ⏸️ Benchmark first                               |
| S2-003 | P0       | Benchmarks      | Add fixed-vs-adaptive rate-limit claim mode with external feedback and fairness metrics.          | Seeded workload; mutation check; `npm run test`.                   | Candidate measures only self-rejection.          | ⏸️ No external signal contract                   |
| S2-004 | P0       | Safety          | Add cross-realm fixtures for buffers, views, messages, and adapter guards.                        | `node:vm` second realm plus spoof tests.                           | False confidence from same-realm tests.          | ✅ Existing audit/tests                          |
| S2-005 | P1       | Control         | Reuse bounded proposal logic: warm-up, hysteresis, cooldown, max step, rollback.                  | Unit tests plus oscillation benchmark.                             | Over-general abstraction or hidden coupling.     | ⏸️ Existing controllers remain local             |
| S2-006 | P1       | Statistics      | Add two-window change detection and robust tail summaries.                                        | Heavy-tail/phase-change workloads; overhead ratio.                 | False positives drive adaptation.                | ⏸️ Existing DDSketch is sufficient for v2        |
| S2-007 | P1       | Profiling       | Add portable sampler core with explicit lifecycle and disposal.                                   | Disabled/baseline/anomaly overhead benchmark.                      | Profiling becomes always-on or leaky.            | ⛔ Deferred: no proven workload                  |
| S2-008 | P1       | Node adapter    | Integrate optional ELU/event-loop delay/worker CPU via separate entrypoint or provider.           | Node matrix; no browser import; lifecycle tests.                   | Node API leaks into portable bundle.             | ⛔ Deferred: adapter demand absent               |
| S2-009 | P1       | Browser adapter | Add feature-detected User Timing and scheduler integration.                                       | Browser compatibility and fallback semantics tests.                | Inconsistent priorities and bundle growth.       | ⛔ Deferred: semantics differ by runtime         |
| S2-010 | P2       | Cache           | Benchmark byte-weighted capacity and scan/change protection first.                                | Zipf, scan, mixed, and real trace; hit-rate and memory accounting. | `sizeOf` cost or worse hit rate.                 | ⏸️ Existing claims cover current policies        |
| S2-011 | P2       | Cache           | Add admission/rejection/victim diagnostics and optional stale-while-revalidate.                   | Hit-rate delta and duplicate-work benchmark.                       | Async cache state complexity.                    | ⏸️ Defer until a trace requires it               |
| S2-012 | P2       | Batch           | Measure cost across count, bytes, latency, and deadline before tuning.                            | Real call path; p99 and flush overhead.                            | Microbenchmark optimization.                     | ⏸️ Benchmark-only follow-up                      |
| S2-013 | P2       | Supervisor      | Prototype proposal-only diagnostics over public stats.                                            | No private access; detach/dispose; false-positive tests.           | Hidden global controller.                        | ⛔ Rejected for v2: hidden coupling              |
| S2-014 | P3       | Tail latency    | Benchmark hedging/speculative retry with cancellation and budget accounting.                      | Tail improvement must exceed duplicate-work/error cost.            | Amplifies overload.                              | ⏸️ Benchmark only when a production trace exists |
| S2-015 | P3       | Defaults        | Add only evidence-backed derived defaults and report source in stats/docs.                        | Cross-runtime default matrix.                                      | Silent policy changes.                           | ✅ Existing defaults remain explicit             |
| S2-016 | P3       | Decisions       | Record ML/RL, global correlation, predictive scaling, and SAB permits with revisit criteria.      | ADR or guide update when a decision changes.                       | Future work repeats disproven premises.          | ✅ Rejected/deferred with criteria               |

## 7. External References

- [Node.js `perf_hooks`](https://nodejs.org/api/perf_hooks.html): ELU,
  event-loop delay, histograms, User Timing, `PerformanceObserver`, and
  `timerify`; observers add overhead and should not remain subscribed forever.
- [Node.js `worker_threads`](https://nodejs.org/api/worker_threads.html): worker
  ELU, CPU usage, resource limits, and transfer semantics.
- [Node.js `v8`](https://nodejs.org/api/v8.html): optional CPU/heap profiling,
  heap statistics, serialization, and promise hooks; heap snapshots can require
  roughly twice heap memory and block the event loop.
- [MDN `Scheduler.postTask()`](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/postTask):
  priorities, delays, abort signals, and browser support limitations.
- [MDN `measureUserAgentSpecificMemory()`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory):
  memory estimates, secure-context/cross-origin-isolation requirements, and
  limited browser availability.
- [TinyLFU paper](https://arxiv.org/abs/1512.00727): compact approximate
  frequency tracking and W-TinyLFU admission for skewed workloads.
- [The Tail at Scale](https://research.google/pubs/the-tail-at-scale/): tail
  latency as a systems property and the overload risks of hedging.

## 8. Bottom Line

The strongest v2 direction is an evidence layer: make observations comparable,
make controllers explainable and bounded, and make profiling opt-in. The
library should become smarter at recognizing uncertainty and refusing to tune
when evidence is weak. It should not become a hidden policy engine that guesses
application intent.
