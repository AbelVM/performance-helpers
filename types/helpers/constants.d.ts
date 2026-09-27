export const MS_PER_SEC: 1000;
export const MS_PER_MIN: number;
export const DEFAULT_TIMEOUT_MS: number;
export const DEFAULT_MAX_CLEANUP_PER_TICK: 100;
export const MAX_DEEP_EQUAL_DEPTH: 100;
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
