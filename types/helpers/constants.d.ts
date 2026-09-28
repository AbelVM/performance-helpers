export const MS_PER_SEC: 1000;
export const MS_PER_MIN: number;
export const DEFAULT_TIMEOUT_MS: number;
export const DEFAULT_MAX_CLEANUP_PER_TICK: 100;
export const MAX_DEEP_EQUAL_DEPTH: 100;
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
export const DEFAULT_RETRY_BASE_DELAY_MS: 100;
export const DEFAULT_RETRY_MAX_DELAY_MS: 10000;
export const DEFAULT_REAPER_MIN_INTERVAL_MS: 1000;
export const ENCODE_CACHE_LARGE_KEY_LENGTH: 2048;
export const DEFAULT_POOL_IDLE_TIMEOUT_MS: number;
export const DEFAULT_CACHE_MAX_WEIGHT_BYTES: number;
export const DEFAULT_CACHE_MAX_POOL_SIZE: 1000;
export const DEFAULT_CACHE_DEFAULT_TTL_MS: number;
export const DEFAULT_REFILL_INTERVAL_MS: 1000;
export const DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS: 200;
export const DEFAULT_QUEUE_CAPACITY: 100;
export const DEFAULT_BACKPRESSURE_QUEUE_CAPACITY: 1000;
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
