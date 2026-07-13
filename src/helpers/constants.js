// Shared constants for helper modules
// Centralize magic numbers to make tuning and testing easier.

// Time units
export const MS_PER_SEC = 1000;
export const MS_PER_MIN = 60 * MS_PER_SEC;

// General defaults
export const DEFAULT_TIMEOUT_MS = 30 * MS_PER_SEC; // 30000
export const DEFAULT_MAX_CLEANUP_PER_TICK = 100;
export const MAX_DEEP_EQUAL_DEPTH = 100;

// Retry/backoff defaults
export const DEFAULT_RETRY_BASE_DELAY_MS = 100;
export const DEFAULT_RETRY_MAX_DELAY_MS = 10000;

// Pool / encode defaults
export const DEFAULT_REAPER_MIN_INTERVAL_MS = 1000;
export const ENCODE_CACHE_LARGE_KEY_LENGTH = 2048;
// Worker idle timeout before the reaper terminates an idle worker. Kept
// separate from cache TTL constants so the pool's idle semantics are not
// coupled to `DEFAULT_CACHE_DEFAULT_TTL_MS`.
export const DEFAULT_POOL_IDLE_TIMEOUT_MS = 60 * MS_PER_SEC; // 60000

// Cache defaults
export const DEFAULT_CACHE_MAX_WEIGHT_BYTES = 1024 * 1024; // 1MB
export const DEFAULT_CACHE_MAX_POOL_SIZE = 1000;
export const DEFAULT_CACHE_DEFAULT_TTL_MS = MS_PER_MIN; // 60000

// Throttle / backpressure / queue defaults
export const DEFAULT_REFILL_INTERVAL_MS = MS_PER_SEC; // 1000
export const DEFAULT_BACKPRESSURE_REFILL_INTERVAL_MS = 200;
export const DEFAULT_QUEUE_CAPACITY = 100;
export const DEFAULT_BACKPRESSURE_QUEUE_CAPACITY = 1000;

// Histogram defaults
export const DEFAULT_HISTOGRAM_MAX_VALUE = 10000;
export const DEFAULT_HISTOGRAM_BUCKET_COUNT = 128;

// Batch/defaults
export const DEFAULT_BATCH_MAX_SIZE = 100;

// Autoscale defaults
export const DEFAULT_AUTOSCALE_MIN_INTERVAL_MS = 100;
export const DEFAULT_AUTOSCALE_INTERVAL_MS = 1000;
export const DEFAULT_AUTOSCALE_COOLDOWN_MS = 5000;
export const DEFAULT_AUTOSCALE_BACKOFF_MAX_MULTIPLIER = 8;
