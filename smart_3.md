# Smart 3 Proposal Ledger

| Proposal                                    | Status    | Evidence / boundary                                                                                                                                                                                                       |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retry-budget propagation                    | COVERED   | `PowerRetryBudget.execute()` and the shared `budget` option let a caller pass one budget through retries, hedges, batches, and downstream calls; arbitrary application calls cannot be threaded automatically.            |
| Fair load shedding                          | COVERED   | `PowerPool` priority aging, `PowerBulkhead` partitions, and keyed rate limits provide opt-in local fairness; weighted tenant scheduling remains deferred without a workload/API requirement.                              |
| Fault-injection test harness                | DONE      | `test/adaptive.resilience.scenario.test.js` provides deterministic overload, shedding, and recovery coverage.                                                                                                             |
| Adaptive recovery mode                      | DONE      | AIMD recovery and `PowerAdaptiveProposal` cooldown, rollback, snapshot, and restore exist.                                                                                                                                |
| Explicit degradation policies               | COVERED   | Bulkhead `onShed` and rate-limit `local` / `fail-closed` paths expose library decisions; cache-refresh and batch semantics correctly remain caller policy.                                                                |
| Cross-helper pressure signals               | DONE      | Pool queue pressure, bulkhead pressure, retry rates, rate-limit rejection rate, and event-loop pressure are exposed locally.                                                                                              |
| External feedback adapter                   | DONE      | Retry classification, Retry-After, shared rate-limit state, and backpressure feedback exist.                                                                                                                              |
| Reusable bounded proposal controller        | DONE      | `PowerAdaptiveProposal` owns bounded steps, hysteresis, cooldown, rollback, confidence, and persistence.                                                                                                                  |
| Queue-wait vs service-time metrics          | DONE      | Pool queue-wait and service-time measurements are exposed.                                                                                                                                                                |
| Failure-class-aware budgets                 | DONE      | Retry outcomes distinguish throttling and other failure classes.                                                                                                                                                          |
| Explainable decisions                       | DONE      | Proposal results and snapshots expose reason, signal, confidence, and cooldown state.                                                                                                                                     |
| Deterministic fault scenarios               | DONE      | Seeded/deterministic resilience scenarios and focused helper tests exist.                                                                                                                                                 |
| Cache intelligence                          | DEFERRED  | Add only after workload traces and benchmark evidence justify it.                                                                                                                                                         |
| Adaptive fairness                           | COVERED   | Aging prevents starvation and partition/keyed admission isolates tenants; weighted tenant fairness remains deferred without workload evidence.                                                                            |
| Circuit half-open probing                   | DONE      | Bounded half-open probing and observability exist.                                                                                                                                                                        |
| Snapshot and restore control state          | DONE      | Limiter and adaptive proposal snapshots validate bounds before restore.                                                                                                                                                   |
| Cache diagnostics                           | DONE      | Existing cache hit/miss, stale, eviction, and refresh diagnostics are covered.                                                                                                                                            |
| Explainable decision records                | DONE      | Adaptive proposal results provide bounded decision records.                                                                                                                                                               |
| Deadline-aware admission                    | DONE      | Pool operations reject expired work before dispatch and remove expired queued responses with `EDEADLINE`.                                                                                                                 |
| Adaptive hedging                            | DONE      | `PowerRetry` accepts an opt-in `hedgeIf` gate while preserving hedge delay and retry budget.                                                                                                                              |
| Retry and circuit coordination              | DONE      | `PowerRetry` can wrap attempts in a circuit and stops immediately on `ECIRCUITOPEN`.                                                                                                                                      |
| Brownout mode                               | DONE      | `PowerBrownout` provides caller-controlled optional-work shedding with pressure telemetry.                                                                                                                                |
| Cache refresh governor                      | COVERED   | Single-flight refreshes and `maxInflightRefreshes` already bound stampedes; add pressure-aware admission only if it remains minimal.                                                                                      |
| Resource-aware adaptation                   | DONE      | `getResourcePressure()` combines capability-detected Node heap pressure with caller-supplied event-loop pressure without starting a sampler.                                                                              |
| Controller stability diagnostics            | DONE      | `PowerAdaptiveProposal.stats()` exposes adjustments, reversals, peak signal, bounds, and last reason.                                                                                                                     |
| Unified operation context                   | DONE      | `createOperationContext()` returns a frozen plain object with signal, deadline, retry budget, correlation id, and priority.                                                                                               |
| Queue-aware adaptive control                | DEFERRED  | The existing `claims.js concurrency` workload found enforced AIMD within noise of the best fixed cap and gradient2 slightly worse; it does not separate queue wait from service time well enough to justify a new signal. |
| Observation freshness and confidence        | DONE      | `createObservation()` records validated `samples`, `windowMs`, `fresh`, and `confidence`; `diffObservation()` refuses missing or non-finite evidence.                                                                     |
| Change-point detection                      | DEFERRED  | A deterministic two-window probe detected a step immediately but reversed twice on the step workload and eight times under alternating noise; the raw divergence fails the no-oscillation bar.                            |
| Adaptive diagnostic sampling                | DEFERRED  | Add opt-in low-rate sampling that temporarily increases on anomalies; benchmark overhead before introducing a profiler layer.                                                                                             |
| Cache byte-pressure and scan detection      | DEFERRED  | Measure caller-supplied `sizeOf`, hot-set protection, and admission diagnostics against real traces before adding policy.                                                                                                 |
| Resilience composition recipes              | COVERED   | `metaGuide.md` documents deadline/circuit/retry/bulkhead/rate-limit ordering, cancellation, and idempotency boundaries without adding a generic wrapper.                                                                  |
| Operation-context propagation               | COVERED   | `powerOperationContext.md` shows explicit field propagation and keeps adapter policy with the caller.                                                                                                                     |
| Runtime capability matrix                   | DONE      | `metaGuide.md` records portable, Node-only, browser-only, and capability-probed surfaces.                                                                                                                                 |
| Adaptive-limit contract reconciliation      | DONE      | `PowerPool` enforces the bounded adaptive limit at admission; README and adaptive-concurrency tests now state and pin that contract.                                                                                      |
| External rate-limit adaptation              | DEFERRED  | `bench/claims.js ratelimit` shows the local-rejection AIMD candidate underperforms fixed refill; keep refill deterministic until a caller-supplied upstream-feedback workload proves a material win.                      |
| Suspension and clock discontinuity handling | COVERED   | Injected-clock tests pin nonnegative elapsed time, capacity-clamped forward jumps, backward-clock safety, and GCRA clock-fault reporting; no controller reset policy is needed for the current bounded helpers.           |
| Work-amplification accounting               | RECOMMEND | Existing retry tests bound hedge multiplication, but nested retries and downstream fan-out remain unmeasured; add an opt-in total-work budget only after tracing real amplification.                                      |
| Weighted queue/resource budgets             | MEASURE   | Cache residency and bulkhead permits already support caller-supplied weights; `PowerPool` queue admission remains count-based, so benchmark pool work weighting before extending the API.                                 |
| Cancellation contract matrix                | COVERED   | `metaGuide.md` now consolidates waiting, retry-wait, running-work, and transport-delivery cancellation boundaries; existing helper tests cover the underlying signal paths.                                               |
| Transport recovery semantics                | MEASURE   | Existing tests pin adapter-specific behavior: reconnect bounds for WebSocket/WebTransport, close-only SSE delivery, and bounded drop-oldest datagram queues; replay and acknowledgement remain unimplemented.             |
| Feedback provenance and conflict resolution | RECOMMEND | External feedback needs freshness, source, and precedence rules so stale or contradictory signals cannot drive adaptation; keep this caller-owned until multiple adapters repeat the shape.                               |
| Observer lifetime invariants                | COVERED   | Metrics registrations detach on helper teardown, transport listeners have disposal tests, and the shared collector tests idempotent cleanup and no post-dispose sampling.                                                 |
| Cross-helper overload budget                | MEASURE   | The resilience scenario proves retry-budget tightening, bulkhead shedding, and backpressure recovery independently; it does not yet count downstream calls or amplification across a shared operation context.            |

The status table is the working ledger. The proposal lists below retain the
original design detail and rationale.

## Beyond Smart 3

These are the remaining high-leverage directions found by tracing the control
loops and their evidence boundaries. They are recommendations, not permission
to add a global supervisor or predictive model.

### B1 - Make queueing the control signal where queueing is the problem

`PowerPool` computes adaptive limits from latency signals, but its own notes
acknowledge that end-to-end latency mixes queue wait with service cost. A heavy
task can therefore look like congestion and cause a false decrease; a growing
queue can be hidden by a fast task and cause a false increase.

Recommendation: benchmark three bounded controllers over CPU-bound, I/O-like,
bursty, and mixed workloads:

1. current end-to-end latency;
2. queue wait as the primary signal with service time and errors as guards;
3. queue wait plus service time as separate signals.

Record throughput, p95/p99, queue depth, refusals, recovery time, and reversal
count. Do not change the default until one signal wins on the real call path.

Result: the current queued-worker benchmark is not discriminating enough for
this decision. Across three repeats, enforced AIMD admitted `920` versus `928`
for the best fixed cap, a `-0.9%` difference inside the measured `0.9%` shipped
noise floor; enforced gradient2 admitted `912`. The workload confirms the
controller is bounded, but it does not prove queue wait is a better control
signal than service time. Keep the existing behavior until a mixed workload
with separately reported queue-wait and service-time outcomes is available.

### B2 - Treat stale observations as no observation

Snapshots currently expose useful values, but a controller cannot safely tell
whether a value is warm, current, or based on enough samples. Reusing an old
pressure value after a quiet period is worse than making no proposal.

Recommendation: use a plain optional observation envelope with `now`,
`samples`, `windowMs`, `fresh`, and `confidence`. Controllers should return a
bounded `reason: 'warmup'|'stale'|'insufficient-samples'` result instead of
acting on zero or old data. Aggregate at window boundaries; do not allocate an
observation object per hot-path operation.

### B3 - Detect phase changes with two windows, not ML

The helpers already have short and long EWMAs. A small sustained divergence
detector can identify a workload phase change, reset stale baselines, and
temporarily increase diagnostic sampling. This is more explainable and cheaper
than a general anomaly detector.

Acceptance check: inject a step change and alternating workload into a seeded
benchmark; require bounded detection delay, no single-sample trigger, and no
controller oscillation under noise.

Probe result: with short-window alpha `0.2`, long-window alpha `0.05`, and a
`1.25x` divergence threshold, a step from `10` to `40` detected at the first
changed sample but produced two state reversals; an alternating `10/40`
workload detected after one sample and produced eight reversals. The existing
EWMA pair is therefore useful as a raw diagnostic, but not yet as a stable
change-point controller. Keep this opt-in and unimplemented until hysteresis,
minimum dwell time, or an equivalent anti-oscillation rule is measured.

### B4 - Keep profiling opt-in and disposable

Node `perf_hooks`, worker ELU, event-loop delay, and `timerify()` can explain
pressure that application-level metrics cannot. They are platform-specific and
have measurable overhead.

Recommendation: add adapters only after a benchmark proves the diagnosis is
needed. Sampling should be low-rate by default, increase during a detected
change, then decay. Every observer must have explicit start/stop/dispose; the
core must remain dependency-free and browser-safe.

### B5 - Improve cache intelligence only around measured costs

The next useful cache signals are resident bytes, candidate/victim frequency,
hit-rate delta, and scan detection. None has a universal default: heap
introspection is platform-specific and automatic TTL learning can encode bad
application policy.

Recommendation: first support caller-supplied `sizeOf` and byte budgets, then
benchmark hot-set protection and admission diagnostics against real traces.
Keep refresh single-flight and `maxInflightRefreshes` as the default governor.

### B6 - Teach composition before abstracting it

The library now has retry, deadline, circuit, bulkhead, rate-limit, pool, and
context primitives, but ordering controls failure amplification. Add tested
recipes for:

- one total deadline outside retry;
- circuit outside retry so an open circuit consumes no retry attempt;
- bulkhead/rate limit before expensive work, with refusal mapped to shedding.

Each recipe must state cancellation propagation, idempotency assumptions, and
which errors are never retried. A generic `compose()` API should wait until
real consumers repeat the same wrapper shape.

### B7 - Reconcile contracts and publish capability boundaries

The pool source currently enforces `_adaptiveLimit` before admission, while the
README says that limit is only reported. This is a resilience contract bug even
if runtime behavior is correct: operators will tune the wrong expectation.

Recommendation: resolve the source/docs mismatch, add a regression test proving
the chosen contract, and publish a runtime matrix for Node, browser main
thread, browser worker, and feature-probed transports. Unsupported fields must
remain unavailable rather than being emulated.

### B8 - Measure external overload before adaptive refill

Local rejection measures the limiter's own decision, not upstream health.
Adaptive refill should consume caller-supplied 429, `Retry-After`, timeout, or
error-budget feedback and remain opt-in.

Acceptance check: seeded fixed-vs-adaptive benchmark covering recovery time,
fairness, burst behavior, and overload latency. Without a material win, keep
`PowerThrottle`, `PowerGCRA`, and `PowerSlidingWindow` deterministic.

Result: the current seeded burst-plus-steady benchmark does not justify a
public adaptive refill policy. With capacity `20`, bursts of `30` every
`1000ms`, and one steady request every `40ms`, the full run produced:

| Arm           | Admitted | Rejected | Rejection rate |
| ------------- | -------: | -------: | -------------: |
| fixed:5       |       70 |      511 |          88.0% |
| fixed:15      |      169 |      412 |          70.9% |
| fixed:30      |      319 |      262 |          45.1% |
| adaptive:aimd |       35 |      546 |          94.0% |

This candidate adapts to local rejection, not upstream overload, and its
multiplicative decrease makes the refusal problem worse in this workload. B8 is
therefore deferred rather than implemented as a new limiter mode. The supported
path remains caller-owned: feed trusted upstream outcomes into
`PowerRetryBudget.recordOutcome()` or `PowerAdaptiveProposal`, then explicitly
apply a bounded proposal to a limiter when the caller has a workload-specific
policy and evidence.

1. **Retry-budget propagation**
   Pass one request-scoped budget through retries, hedges, batches, and downstream calls. This prevents layered helpers from multiplying work during outages. Track remaining attempts, elapsed budget, and retry causes.

2. **Fair load shedding**
   Add optional per-key or weighted fairness to `PowerPool`, `PowerBulkhead`, and rate limiters. Current capacity controls can protect the system while starving noisy or low-volume tenants.

3. **Fault-injection test harness**
   Provide deterministic scenarios for slow work, clock rollback, cancellation, partial worker failure, dropped messages, retry storms, and queue saturation. Resilience claims become reproducible instead of test-by-test invention.

4. **Adaptive recovery mode**
   After overload, recover capacity gradually with a probe/hold/rollback cycle rather than immediately returning to the previous limit. This would complement the existing cooldown and bounded-control ideas.

5. **Explicit degradation policies**
   Let callers define what to shed first: queue entries, retries, stale cache refreshes, optional metrics, or batch work. The library should expose decisions, not silently choose application semantics.

6. **Cross-helper pressure signals**
   Keep policy local, but standardize signals such as `queueDepth`, `saturation`, `rejectionRate`, `retryRate`, and `eventLoopPressure`. This would let applications compose helpers without introducing the rejected global supervisor.

===========================================================

1. **External feedback adapter**
   Let callers report `429`, `Retry-After`, upstream latency, timeout, or dependency health. Local queue rejection alone cannot distinguish overload from intentional shedding.
   Best fit: opt-in feedback methods on retry/rate-limit helpers.

2. **Reusable bounded proposal controller**
   Share only the mechanics: warm-up, hysteresis, cooldown, maximum step, rollback, and confidence. Each helper still owns its policy.
   This addresses the open `S2-005` item in `smart_2.md`.

3. **Queue-wait versus service-time metrics**
   Add separate measurements to `PowerPool`, bulkheads, and backpressure. This lets adaptation identify whether the bottleneck is admission or the downstream operation.
   This is the most useful diagnostic improvement after external feedback.

4. **Failure-class-aware budgets**
   Spend retry budget differently for timeouts, connection failures, throttling, cancellations, and application errors. Never retry caller cancellation; heavily penalize upstream throttling.

5. **Explainable decisions**
   Include fields such as `reason`, `signal`, `confidence`, `cooldownRemaining`, and `lastAdjustment` in stats. “Window decreased because 8/8 permits remained held” is far more operationally useful than just `refillAmount: 2`.

6. **Deterministic fault scenarios**
   Add seeded scenarios for slow consumers, burst overload, cancellation storms, dependency recovery, retry amplification, and alternating hot partitions. Assert recovery time, fairness, refusal count, and duplicate work.

7. **Cache intelligence only after traces**
   Consider stale-while-revalidate, byte-weighted capacity, and admission/victim diagnostics only when a real workload shows need. The current plan correctly defers these.

## Beyond B8: deeper resilience findings

The next layer is not a smarter prediction algorithm. It is making the
feedback loop trustworthy when the runtime pauses, work is duplicated, or
several helpers make locally reasonable decisions at once. These proposals
come from the remaining boundaries in the adaptive helpers, retry path,
metrics lifecycle, and realtime transports.

### C1 - Treat suspension and clock discontinuities as control events

Browser tabs can sleep, workers can be suspended, and a process can resume
after a long stop. An injected clock can also jump in tests or in an adapter.
Cooldown counters and elapsed-time refill must not interpret a long gap as a
large healthy sample or a burst of normal progress.

Recommendation: benchmark three explicit policies after a forward jump,
backward jump, and long idle period:

1. clamp elapsed time;
2. reset warm-up and stale state;
3. mark the observation unavailable until a fresh window exists.

Require no negative elapsed durations, no instant refill to an unsafe maximum,
and explainable `stale`/`warmup` decisions. Do not silently add a universal
clock abstraction: the existing injected clocks are enough if each helper
documents its discontinuity policy.

### C2 - Bound total work amplification, not only retries

`PowerRetryBudget` limits retry attempts, but a request can still multiply work
through hedges, batch fan-out, nested retries, or a pool dispatching duplicates.
The dangerous quantity during an outage is total downstream work, not the
number of retries in one helper.

Recommendation: first instrument a scenario matrix for retries x hedges x
fan-out and report peak in-flight work and duplicate-work ratio. If real
callers need it, add an opt-in request-scoped work budget that reserves for
hedges before dispatch, propagates through nested helpers, and refunds on
cancellation. It must reject before sending work and remain separate from a
latency deadline. Do not make every helper discover or enforce it implicitly.

Current boundary: `PowerRetry` charges a hedge as a retry, hedges only the
first attempt, and the existing three-attempt fixture sends 4 calls rather than
the 6 calls produced by hedging every attempt. That protects this helper's
local retry path, but it does not measure nested retry or downstream fan-out
amplification, so no shared work-budget API is justified yet.

### C3 - Use weighted budgets where counts hide the resource

Queue length and cache entry count are useful but incomplete. One queued 4 MB
message and one queued 4 KB message consume different memory; one task may
consume a very different amount of worker time than another. A count-only
limit can therefore report healthy saturation while the actual resource is
exhausted.

Recommendation: benchmark caller-supplied `weight` or `sizeOf` functions for
queue memory, cache residency, and pool work. Measure accounting overhead,
fairness, throughput, and refusal behavior under adversarial large items. Add
weighted limits only where a trace shows count-based admission misses the
failure mode; keep counts as the portable default and never guess object size.

Current boundary: `PowerCache` already accepts `weightFn`, explicit entry
weights, `maxWeight`, and oversized-entry rejection; `PowerBulkhead` already
reserves integer permit weights and rejects a task heavier than a partition.
The remaining gap is pool queue admission, where `maxQueueLength` counts
items rather than worker cost or payload size. Keep the count-based pool
contract until a real pool workload justifies a weight hook.

### C4 - Make cancellation semantics one compositional contract

The helpers already distinguish cancelling a wait, cancelling an observation,
and cancelling user work, but that distinction is spread across guides. A
caller composing deadline, retry, pool, semaphore, and transport can otherwise
assume that an `AbortSignal` interrupts work it cannot control.

Recommendation: publish one matrix covering what each signal cancels, whether
running work continues, the rejection code/reason, listener cleanup, and
whether an operation is safe to retry. Add one cross-helper test for each
semantic class. Preserve explicit opt-in propagation; a wrapper must not claim
to interrupt arbitrary synchronous or worker code without a cooperative
signal path.

### C5 - Treat transport recovery as a delivery contract

Reconnect logic is not automatically resilience. After a disconnect, a
transport must decide whether messages are lost, replayed, duplicated, or
reordered. Sequence numbers and acknowledgements help only when the caller
also defines deduplication and idempotency boundaries.

Recommendation: benchmark bounded reconnect scenarios for each transport:
disconnect before send, after send, after acknowledgement, and during replay.
Record duplicate delivery, loss, ordering, queue growth, and recovery time.
Document the chosen contract per adapter. Keep replay/session coordination
adapter-specific until at least two transports demonstrate the same exact
semantics; a universal recovery layer would hide important differences.

Current boundary: the adapters already expose different delivery contracts.
`PowerDatagramChannel` bounds its pre-open queue and drops the oldest item when
full; SSE closes its stream on detach; WebSocket and WebTransport bound
reconnect attempts but do not claim replay, acknowledgement, or deduplication.
The tests cover those local contracts, so the remaining work is a seeded
disconnect matrix, not a shared transport session abstraction.

### C6 - Require provenance and precedence for external feedback

Confidence alone does not say who produced a signal, how old it is, or whether
it conflicts with another signal. A stale `Retry-After`, local queue pressure,
and a successful probe can all arrive in different orders.

Recommendation: represent external feedback as caller-owned data with source,
observed-at time, expiry, and failure class. Define precedence explicitly:
caller safety limits and cancellation first, fresh explicit upstream refusal
next, local pressure after that, and recovery evidence last. Reject expired or
contradictory updates rather than averaging unlike signals. Keep the core
controller unaware of transports and trust domains.

### C7 - Make observer ownership a resilience invariant

An event-loop sampler, metrics registration, listener, or transport observer
that survives its owner can keep work and memory alive indefinitely. This is a
resilience failure that ordinary value tests rarely expose.

Recommendation: add a small lifecycle matrix and tests asserting that every
observer has one owner, an idempotent terminal teardown, listener removal, and
no post-dispose updates. Test reversible `reset()`/`stop()` separately from
terminal `dispose()`/`terminate()`. Do not add lifecycle methods to stateless
helpers merely for visual uniformity.

### C8 - Measure composed overload, not isolated safeguards

Pool admission, bulkhead shedding, retry budgets, rate limits, and brownout
policies each look protective in isolation. Together they can still amplify
latency or duplicate work if every layer retries, queues, or probes locally.

Recommendation: add a seeded cross-helper scenario with one shared operation
context and compare isolated versus composed limits. Track admitted work,
queue time, retries, hedges, shed optional work, downstream calls, and recovery
time. Promote a shared overload budget or recipe only if composition produces
measurable amplification that existing explicit propagation cannot prevent.

Current boundary: `adaptive.resilience.scenario.test.js` already composes
external retry feedback, a saturated bulkhead, and adaptive backpressure, but
its assertions stop at each helper's local counters. It does not send nested
retry or hedge traffic through the bulkhead, so it cannot distinguish
protection from amplification. Keep coordination explicit through
`createOperationContext()` and add the seeded matrix only when a realistic
downstream call path is available.

### What remains deliberately out of scope

Do not add machine learning, predictive scaling, automatic target-SLO changes,
automatic TTL learning, a global supervisor, or a universal transport session
layer. Those choices either hide caller policy, require workload-specific
training data, or erase adapter-specific semantics. The optimal behavior is
objective-dependent; the library should make the objective and feedback
visible, bounded, and caller-owned.

===========================================================

Yes. The next useful layer would be **feedback-aware coordination**, while keeping behavior opt-in and explainable:

1. **Queue wait vs. service-time metrics**  
   Separate “waiting for capacity” from “work execution.” This identifies whether to add workers, reduce concurrency, or improve the task itself.

2. **Retry-After integration**  
   Let `PowerRetry`, `PowerRateLimit`, and `PowerBackpressure` consume upstream `Retry-After` or rate-limit headers and coordinate their next attempt.

3. **Shared pressure signals**  
   Allow `PowerPool`, `PowerBulkhead`, and `PowerBackpressure` to publish a small normalized signal such as:

   ```js
   { pressure: 0.8, saturation: 0.9, recovery: 0.2 }
   ```

   Consumers can adapt without knowing each other’s internals.

4. **Failure-mode budgets**  
   Track separate budgets for timeouts, throttling, network errors, and application failures. A server returning 429 should influence adaptation differently from a programming error.

5. **Adaptive fairness**  
   Add weighted or aging queue policies so long-waiting tenants gain priority without allowing noisy tenants to dominate.

6. **Circuit-breaker half-open probing**  
   Replace fixed probe counts with bounded probes based on recovery confidence, while retaining strict maximum concurrency.

7. **Snapshot and restore control state**  
   Persist controller state across process restarts or deployments, with expiration and validation to avoid restoring stale conditions.

8. **Cache diagnostics before cache intelligence**  
   Add hit/miss reason counters, stale-hit counts, eviction causes, and refresh failures. Only add stale-while-revalidate or admission changes after benchmark evidence.

9. **Deterministic fault injection**  
   Provide test-only hooks for latency, throttling, queue saturation, worker loss, and partial recovery. This makes resilience claims reproducible.

10. **Explainable decision records**  
    Give adaptive helpers a bounded `lastDecision` record:
    ```js
    {
      action: 'decrease',
      reason: 'timeout-rate',
      signal: 0.72,
      confidence: 0.81
    }
    ```

===========================================================
