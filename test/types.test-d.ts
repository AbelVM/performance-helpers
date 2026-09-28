/**
 * Consumer type test.
 *
 * This file is NOT part of the runtime build. It is compiled by
 * `npm run test:types` against the *generated* declarations in `types/`, exactly
 * as a downstream TypeScript consumer would see them. It exists because
 * `types:generate` only *emits* declarations (`checkJs: false`), so before this
 * nothing verified that the published `.d.ts` files are actually usable.
 *
 * Anything that compiles here is a promise the package makes to consumers.
 * Anything that fails is a broken promise, regardless of what the JSDoc looks
 * like internally.
 *
 * @see tsconfig.types.json
 * @see scripts/typecheck-ratchet.cjs
 */
import {
  PowerCache,
  PowerMemoizer,
  PowerTimedCache,
  PowerPool,
  PowerThrottle,
  PowerSlidingWindow,
  PowerGCRA,
  PowerRateLimit,
  PowerQueue,
  PowerSemaphore,
  PowerPermitGate,
  PowerBulkhead,
  PowerCircuit,
  PowerRetry,
  PowerDeadline,
  PowerHistogram,
  PowerRealtimeHub,
  PowerWebSocketClient,
  PowerMessageCodec,
  encodeMessage,
  decodeMessage,
  frameEncodedJson,
  PowerEventBus,
  PowerObserver,
  PowerLogger,
  o2u8,
  u82o,
  nowMs,
  measureSync,
  measureAsync,
  normalizeError,
  formatErrorObj,
} from '../types/index.js';

// --- PowerCache: options, the new policy, and the onError channel ---------
const cache = new PowerCache({
  maxEntries: 100,
  maxWeight: 1000,
  weightFn: (v: unknown) => (typeof v === 'string' ? v.length : 1),
  defaultTTL: 60_000,
  maxPoolSize: 100,
  rejectOversized: true,
  onEvict: (key: unknown, value: unknown, reason: string) => {
    void key;
    void value;
    void reason;
  },
  onExpire: (key: unknown, value: unknown) => {
    void key;
    void value;
  },
  onError: (err: unknown, msg: string) => {
    void err;
    void msg;
  },
  // Added in 2.0 - the opt-in scan-resistant policy.
  policy: 'slru',
});

cache.set('a', 1);
const hit: number | undefined = cache.get('a');
const has: boolean = cache.has('a');
const size: number = cache.size;
const touched: boolean = cache.touch('a');
const removed: boolean = cache.delete('a');
const stats: Record<string, unknown> = cache.stats() as unknown as Record<string, unknown>;
void [hit, has, size, touched, removed, stats];

// The union must include the new policy, or a 2.0 consumer is rejected.
const policy: 'lru' | 'slru' = 'slru';
cache._policy = policy;

// --- Explicit resource management is part of the documented API -------------
{
  using scopedCache = new PowerCache({ maxEntries: 10 });
  scopedCache.set('x', 1);
}

// --- PowerMemoizer / PowerTimedCache --------------------------------------
const memoizer = new PowerMemoizer({ cacheOptions: { maxEntries: 10 } });
const memoized: (n: number) => number = memoizer.memoize((n: number) => n * 2);
const ran: number = memoized(21);
const memo: string | undefined = memoized.original?.name;
void [ran, memo, memoizer.cache, memoizer.stats()];

// The wrapper must still be a real Function (BUG-007).
const callResult: number = memoized.call(null, 2);
void callResult;

const timed = new PowerTimedCache(1000, { maxEntries: 10 });
timed.set('k', 'v');
const timedValue: unknown = timed.get('k');
timed.stopCleanup();
void timedValue;

// --- PowerPool: options including the 2.0 protocol flag --------------------
const pool = new PowerPool(() => new MessageChannel().port1, {
  size: 2,
  minSize: 1,
  maxSize: 4,
  lazy: false,
  queuePolicy: 'drop-oldest',
  autoScale: {
    policy: 'gradient2',
    intervalMs: 1000,
    limitMin: 1,
    limitMax: 8,
    longWindowAlpha: 0.05,
    aimdBeta: 0.7,
  },
  // Added in 2.0 alongside the framed wire protocol.
  messageCodec: 'framed',
});

const dispatched: boolean | Promise<unknown> = pool.postMessage({ hello: 'world' });
pool.broadcast({ hello: 'world' });
const poolStats: Record<string, unknown> = pool.getStats() as unknown as Record<string, unknown>;
pool.shutdown();
void [dispatched, poolStats];

// --- Limiters -------------------------------------------------------------
const throttle = new PowerThrottle({ limit: 10, windowMs: 1000, capacity: 10 });
const took: boolean = throttle.tryConsume(1);
const availableNow: number = throttle.available();
void [took, availableNow];

const window = new PowerSlidingWindow({ limit: 5, windowMs: 1000 });
void window.tryConsume();

// Added in 2.0.
const gcra = new PowerGCRA({ rate: 100, per: 1000, burst: 20 });
const gcraOk: boolean = gcra.tryConsume();
const gcraWait: number = gcra.retryAfter();
const gcraTake: { ok: true } | { ok: false; retryAfter: number } = gcra.take();
void [gcraOk, gcraWait, gcraTake, gcra.available(), gcra.hasCapacity];

const combined = new PowerRateLimit([gcra, throttle], { atomic: true });
void combined.tryConsume(1);

// --- Concurrency primitives ------------------------------------------------
const queue = new PowerQueue(16);
queue.push(1);
const dequeued: number | undefined = queue.shift();
const queueLength: number = queue.length;
void [dequeued, queueLength];

const semaphore = new PowerSemaphore({ permits: 2 });
void semaphore.acquire().then((release: () => void) => release());

const gate = new PowerPermitGate({ capacity: 2, queueCapacity: 8 });
void gate.acquire();

// PowerBulkhead gained reset()/dispose()/stats() and Symbol.dispose in 2.0.
const bulkhead = new PowerBulkhead({ maxConcurrency: 2, partitions: 1, onError: () => {} });
bulkhead.reset();
bulkhead.dispose();
const bulkheadStats: Record<string, unknown> = bulkhead.stats() as unknown as Record<
  string,
  unknown
>;
void [bulkheadStats, bulkhead.active, bulkhead.pending];

// --- Resilience -----------------------------------------------------------
const circuit = new PowerCircuit({ threshold: 3, resetTimeout: 1000 });
const retry = new PowerRetry({ retries: 3, baseDelay: 50 });
const deadline = new PowerDeadline({ timeout: 1000 });
void [circuit, retry, deadline];

// --- PowerHistogram: DDSketch since 2.0 -----------------------------------
const histogram = new PowerHistogram({ relativeAccuracy: 0.01 });
histogram.record(1);
histogram.record(1e8);
const p99: number | undefined = histogram.percentile(99);
const outOfRange: number = histogram.outOfRangeCount;
const merged: PowerHistogram = new PowerHistogram().merge(histogram);
void [p99, outOfRange, merged.count, merged.toJSON()];

// --- Realtime family -------------------------------------------------------
const hub = new PowerRealtimeHub({
  send: () => {},
  close: () => {},
  batch: true,
  codec: 'json',
});
const unsubscribe: () => boolean = hub.subscribe('topic', () => {}, {
  maxQueue: 32,
  slowConsumer: 'drop-oldest',
  id: 's1',
});
const published: number = hub.publish('topic', { a: 1 });
const hubStats: Record<string, unknown> = hub.stats() as unknown as Record<string, unknown>;
void [unsubscribe, published, hubStats];
hub.close();

const ws = new PowerWebSocketClient({
  url: 'wss://example.test',
  highWaterMarkBytes: 1 << 20,
  lowWaterMarkBytes: 1 << 19,
  heartbeatIntervalMs: 30_000,
  maxReconnectAttempts: 5,
  codec: 'json',
});
const backpressure: 'watermark' | 'streams' | 'none' = ws.backpressureMode;
const readyState: number = ws.readyState;
void [backpressure, readyState, ws.isOpen, ws.paused, ws.bufferedAmount];
ws.on('message', (message: unknown) => void message);
// Added in 2.0: the correct adapter for an already-framed hub payload.
const sent: Promise<boolean> = ws.sendFrame(encodeMessage({ a: 1 }));
void [ws.send({ a: 1 }, { dropOnBackpressure: true }), sent, ws.stats()];
ws.close();

const frame: Uint8Array = encodeMessage({ a: 1 }, { codec: 'json' });
const decodedFrame: { version: number; codec: string; value: unknown; byteLength: number } =
  decodeMessage(frame);
const fromString: Uint8Array = frameEncodedJson('[1,2,3]');
void [decodedFrame, fromString, decodeMessage(frame, { rawAsBytes: true }).value];

// --- Eventing / reactive / logging ----------------------------------------
const bus = new PowerEventBus();
bus.on('x', () => {});
bus.emit('x', { a: 1 });
bus.dispose();

const observer = new PowerObserver(0);
observer.subscribe((next: number) => void next);
observer.next(1);
void observer.value;

const logger = new PowerLogger(1);
logger.debug('hi');
logger.count('things');
void logger.getCount('things');

const bytes: Uint8Array = o2u8({ a: 1 });
const back: unknown = u82o(bytes);
void back;

// --- utils -----------------------------------------------------------------
const t0: number = nowMs();
void [t0, measureSync(() => 1), measureAsync(async () => 1)];
const normalized: Error = normalizeError(new Error('boom'));
void [normalized, formatErrorObj({ code: 'X', message: 'y' })];
