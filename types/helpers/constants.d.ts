export const MS_PER_SEC: 1000;
export const MS_PER_MIN: number;
export const DEFAULT_TIMEOUT_MS: number;
export const DEFAULT_MAX_CLEANUP_PER_TICK: 100;
export const MAX_DEEP_EQUAL_DEPTH: 100;
/**
 * Default preallocation for a `PowerQueue`, and the value every helper that
 * builds an internal queue passes explicitly.
 *
 * `PowerQueue` uses a power-of-two bitmask index, so its backing buffer grows by
 * doubling. Preallocating 16 costs 16 slots and saves four grow-and-copy cycles
 * for the small queues that dominate: a batch's pending list, a permit gate's
 * waiters, a sliding window's timestamps, a bulkhead's drain waiters. Those four
 * sites all passed a bare `16` with no name, which made it impossible to change
 * the preallocation, impossible to find the sites, and impossible to tell a
 * deliberate choice from a copy-paste of whatever the default happened to be.
 *
 * Not to be confused with `DEFAULT_QUEUE_CAPACITY`, which is the backlog a
 * backpressure helper admits before it starts shedding, not a buffer size.
 */
export const POWER_QUEUE_INITIAL_CAPACITY: 16;
/**
 * Target number of in-flight chunks per pool worker when splitting an array.
 *
 * Aim for roughly `poolSize * 4` chunks, which keeps every worker fed without
 * queueing far more work than can be in flight. Below that a fast worker idles
 * between messages; much above it and the chunk list itself becomes the thing
 * being allocated per call.
 */
export const CHUNKS_PER_WORKER_TARGET: 4;
/**
 * Window multiplier for adaptive chunk-size re-estimation.
 *
 * After the first pass the target is widened to `poolSize * 8`, giving the pool
 * a deeper queue to chew through before the next measurement. A *wider* target
 * means *smaller* chunks and more of them, so a measurement is taken sooner -
 * this is the convergence knob, not a throughput knob.
 */
export const CHUNK_WINDOW_MULTIPLIER: 8;
/**
 * Fallback for `navigator.hardwareConcurrency` where the runtime does not
 * expose it.
 *
 * Node, Deno and every current browser report it, but a non-browser runtime, a
 * hardened/cross-origin-isolated context, and most test runners do not. `2` is
 * the smallest value that still permits a worker pool to do anything in
 * parallel; anything lower silently serialises the pool.
 */
export const DEFAULT_HARDWARE_CONCURRENCY: 2;
/**
 * How many workers a `PowerPool` starts with when the caller names no `size`.
 *
 * Deliberately small even on a 64-core box. A pool is usually constructed at
 * module load, when the work it will eventually do is unknown, and a pool that
 * eagerly spawns one worker per core pays that startup cost — and holds that
 * memory — whether or not the traffic ever arrives. Start at two and let
 * `autoScale` or the reaper move it. This is both the default initial `size`
 * (capped by real concurrency) and the default `minSize`, because they express
 * the same decision: start small. They are one constant for that reason, and
 * splitting them would imply they can differ.
 */
export const DEFAULT_POOL_SIZE: 2;
/**
 * Floor on a `PowerHistogram`'s bucket count.
 *
 * Fewer than 4 buckets makes the log-bucket ladder degenerate - the space
 * between the first and second boundary swallows most of the value range, so the
 * reported percentiles lose all resolution exactly where a small bucket count
 * seemed like a saving. Rounding up to 4 costs a handful of counters and keeps
 * the ladder meaningful.
 */
export const MIN_HISTOGRAM_BUCKETS: 4;
/**
 * Ceiling on how many *nodes* one `hasEqual` deep comparison will visit.
 *
 * `MAX_DEEP_EQUAL_DEPTH` bounds depth and says nothing about width, so a wide
 * flat value - an array of a million scalars, say - recurses at depth 2, never
 * trips the depth limit, and blocks the event loop for tens of milliseconds
 * on what a caller expects to be a cache lookup. This bounds the work instead.
 *
 * Exceeding it degrades to reference equality, which is the same contract the
 * depth limit already used: the answer becomes less thorough, never wrong.
 * 10_000 nodes is far beyond any hand-written comparison and well inside a
 * tick, which is the whole point - a cache lookup should not cost 37 ms.
 */
export const MAX_DEEP_EQUAL_NODES: 10000;
/**
 * The four states of a socket's lifecycle, as constants.
 *
 * Defined here, in the one module every helper may import, so that
 * `PowerWebSocketClient` and `PowerSocketAdapter` hand back the *same* frozen
 * object. They are separate helpers for separate directions - one dials out,
 * one wraps a socket somebody else accepted - and the adapter deliberately does
 * not import the client, because doing so would pull the whole reconnect
 * machinery into a server bundle. Duplicating the constant instead would have
 * been free of that cost and wrong in a subtler way: a user comparing the two
 * with `===` would get `false` for two identical-looking frozen objects, and the
 * only symptom would be a state check that silently never matches.
 *
 * The values are the WebSocket standard's, so a socket's own `readyState` can be
 * compared against them directly.
 */
export const READY_STATE: Readonly<{
    CONNECTING: 0;
    OPEN: 1;
    CLOSING: 2;
    CLOSED: 3;
}>;
export const DEFAULT_RETRY_BASE_DELAY_MS: 100;
export const DEFAULT_RETRY_MAX_DELAY_MS: 10000;
/**
 * The growth factor for the decorrelated-jitter backoff.
 *
 * AWS, *Exponential Backoff and Jitter* (2015): the next sleep is drawn from
 * `random(base, previous * 3)`. The three is the paper's, and it is the whole
 * reason the strategy decorrelates: each attempt randomises against the
 * *actual* previous sleep rather than against a formula, so two clients that
 * started together drift apart instead of marching in step.
 */
export const DECORRELATED_JITTER_FACTOR: 3;
/**
 * Default retry-budget ratio: the fraction of ordinary requests that may be
 * retried before the budget refuses more.
 *
 * Google SRE Workbook, *Handling Overload* (2018) puts the recommended band at
 * 10-20 % of total requests; the top of that band is the default because a
 * budget exists to stop an amplification loop, not to ration retries in normal
 * operation. Every retry is a request the dependency did not ask for, and at
 * 5 % the protection would start refusing retries while the dependency is
 * merely degraded rather than down.
 */
export const DEFAULT_RETRY_BUDGET_RATIO: 0.2;
/**
 * Default retry-budget capacity, in retry tokens.
 *
 * This is a *burst* allowance, not the steady-state rate - the steady state is
 * `ratio` tokens per original request, so a budget of ratio 0.2 that refills
 * to 10 permits ten consecutive retries before it throttles to one per five
 * requests. Sized so a short blip is absorbed without a budget check, and so
 * the cap on the token count is not what decides when protection engages: a
 * capacity of 1 would refuse the first retry of a fresh budget, because one
 * request funds 0.2 of a token and a retry costs a whole one.
 */
export const DEFAULT_RETRY_BUDGET_CAPACITY: 10;
/**
 * How many times a circuit's open window may double before it is capped.
 *
 * `PowerCircuit` opens for `baseTimeout`, then `2x`, then `4x`… up to
 * `baseTimeout * 16`, so a dependency that is genuinely down stops being probed
 * at a rate that cannot itself keep it down, while one that recovers after a
 * brief blip is not locked out for minutes.
 */
export const DEFAULT_CIRCUIT_MAX_OPEN_FACTOR: 16;
/**
 * Floor on the jittered open window, as a fraction of the computed backoff.
 *
 * This is **equal jitter** (the window is drawn uniformly from
 * `[delay / 2, delay]`), not AWS-style *full* jitter (`[0, delay]`), and the
 * distinction matters for a circuit breaker specifically. Full jitter is right
 * for a retry delay, where the goal is to spread attempts. For a breaker's open
 * window the goal is different: the window has to be long enough to actually
 * stop the traffic. A full-jitter draw of a 30 s backoff can land near zero,
 * which re-opens the circuit almost immediately and turns the breaker into a
 * fast flapping no-op. Half-jitter still randomises — which is what breaks the
 * synchronised retry burst, since every client sharing a dependency would
 * otherwise probe it on the same tick — while guaranteeing the window never
 * collapses below half the computed backoff.
 */
export const DEFAULT_CIRCUIT_MIN_JITTER_RATIO: 0.5;
export const DEFAULT_REAPER_MIN_INTERVAL_MS: 1000;
export const ENCODE_CACHE_LARGE_KEY_LENGTH: 2048;
export const DEFAULT_POOL_IDLE_TIMEOUT_MS: number;
/**
 * How many idempotency-ledger entries one post may examine while expiring.
 *
 * The sweep runs on the post path, so its cost has to be bounded by something
 * other than the size of the ledger — an unbounded scan would make opting in
 * cost more the longer the process runs, which is the opposite of what the
 * option is for. A rotating pass over the keys means the ledger drains at a
 * bounded rate instead of never draining at all.
 *
 * 32 is roughly one cache line's worth of `Map` entries: large enough that a
 * busy pool clears its ledger in a few posts, small enough to stay invisible
 * against a `postMessage` that already encodes and transfers.
 */
export const DEFAULT_IDEMPOTENCY_SWEEP_BATCH: 32;
/**
 * Ceiling on how many `PowerPool.drain()` calls may be *waiting* at once.
 *
 * `drain()` registers an `idle` listener, so N concurrent drains are N
 * listeners and N closures retained until the pool next goes idle. A caller
 * that drains in a loop - once per request, say - accumulates them without
 * bound and eventually trips `MaxListenersExceededWarning`. 100 is far above any
 * deliberate use and low enough to stay under Node's default warning threshold
 * of 10 per emitter only if the caller also raises `maxListeners`; the honest
 * behaviour is to refuse the overflow and say so.
 */
export const DEFAULT_MAX_DRAIN_WAITERS: 100;
export const DEFAULT_CACHE_MAX_WEIGHT_BYTES: number;
export const DEFAULT_CACHE_MAX_POOL_SIZE: 1000;
export const DEFAULT_CACHE_DEFAULT_TTL_MS: number;
export const DEFAULT_REFILL_INTERVAL_MS: 1000;
export const DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS: 200;
export const DEFAULT_QUEUE_CAPACITY: 100;
export const DEFAULT_BACKPRESSURE_QUEUE_CAPACITY: 1000;
/**
 * Consecutive backwards clock observations before `PowerThrottle` accepts a
 * regressed clock (AUD-037).
 *
 * A *transient* backwards step must be ignored — preserving the last valid
 * reading is the safe direction, and crediting the jump would hand out tokens
 * for time that did not pass. A *permanent* one must eventually be accepted, or
 * `elapsedMs` stays `0` forever and the throttle never refills again.
 *
 * The threshold is a count of consecutive observations rather than a duration
 * because the question is whether the regression is *sustained*: any forward
 * step resets the counter, so a clock that jitters backwards once in a while
 * never reaches it. Three is small enough that a genuinely stuck clock recovers
 * within a handful of calls, and large enough that an NTP correction which
 * corrects itself on the next observation never trips it.
 */
export const BACKWARD_CLOCK_TOLERANCE: 3;
export const DEFAULT_HISTOGRAM_MAX_VALUE: 10000;
export const DEFAULT_HISTOGRAM_BUCKET_COUNT: 128;
/**
 * Target relative error for `PowerHistogram` quantile estimates, in `(0, 1)`.
 * `0.01` is 1%, the same default OpenTelemetry's DDSketch aggregator uses.
 */
export const DEFAULT_HISTOGRAM_RELATIVE_ACCURACY: 0.01;
export const DEFAULT_BATCH_MAX_SIZE: 100;
export const DEFAULT_AUTOSCALE_MIN_INTERVAL_MS: 100;
export const DEFAULT_AUTOSCALE_INTERVAL_MS: 1000;
export const DEFAULT_AUTOSCALE_COOLDOWN_MS: 5000;
export const DEFAULT_AUTOSCALE_BACKOFF_MAX_MULTIPLIER: 8;
/** Smoothing factor for the long-window RTT EWMA used by the `gradient2` policy. */
export const DEFAULT_AUTOSCALE_LONG_WINDOW_ALPHA: 0.05;
/** Multiplicative decrease factor for the `aimd` policy. */
export const DEFAULT_AUTOSCALE_AIMD_BETA: 0.7;
