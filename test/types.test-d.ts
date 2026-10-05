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
  PowerEventLoopMonitor,
  PowerRetryBudget,
  PowerSocketAdapter,
  defaultMetrics,
  MetricsCollector,
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

// --- Explicit resource management is part of the documented API -------------
{
  using scopedCache = new PowerCache({ maxEntries: 10 });
  scopedCache.set('x', 1);
}

// --- PowerMemoizer / PowerTimedCache --------------------------------------
const memoizer = new PowerMemoizer(undefined, { cacheOptions: { maxEntries: 10 } });
// Inferred, not annotated: an explicit `(n: number) => number` annotation here
// erased the richer return type, so `memoized.original` - which has always
// existed at runtime (BUG-007) - did not exist as far as the type test was
// concerned. The annotation was asserting something weaker than the API.
const memoized = memoizer.memoize((n: number) => n * 2);
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
const throttle = new PowerThrottle({ capacity: 10, refillRate: 10 });
const took: boolean = throttle.tryConsume(1);
const availableNow: number = throttle.available();
void [took, availableNow];

// `limit` here was never an option: `PowerSlidingWindow` reads `capacity` and
// `windowMs`, so `{ limit: 5 }` silently produced a limiter with the default
// capacity of 1. The consumer test type-checked only because the constructor
// took a bare `Object`; with the real options type in place it failed, which is
// the drift this project keeps finding between JSDoc and the code.
const window = new PowerSlidingWindow({ capacity: 5, windowMs: 1000 });
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

const semaphore = new PowerSemaphore(2);
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
// `resetTimeout` was never an option - `PowerCircuit` reads `timeout`. It
// type-checked only because the constructor took a bare `Object`, so a consumer
// reading this test could have copied an option that is silently ignored.
const circuit = new PowerCircuit({ threshold: 3, timeout: 1000 });
const retry = new PowerRetry({ maxAttempts: 3, baseDelay: 50 });
// `timeout` was the same trap one line further on, and it is worth reading as
// a pair: `PowerDeadline` bounds an attempt with `attemptTimeout` and the whole
// operation with `totalTimeout`, and has never read a `timeout`. This line
// compiled for as long as the constructor took `Object`, and stopped compiling
// the moment QUAL-001 gave that constructor its real options type - which is
// what a types-only change is *for*.
const deadline = new PowerDeadline({ totalTimeout: 1000 });
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
// No `next()`: PowerObserver has no externally callable emit. The public surface
// is `value` plus `subscribe`/`clear`/`map`/`flush`/`drain`. This line previously
// asserted a method that has never existed, which is how three fantasy APIs
// survived in a test meant to describe the real one.
observer.flush();
void observer.drain();
void observer.value;

const logger = new PowerLogger(1);
logger.debug('hi');
logger.setDebugLevel(2);
const level: number = logger.getDebugLevel();
const debugging: boolean = logger.isDebugLevel(2);
void [level, debugging, logger.isDebug()];

const bytes: Uint8Array = o2u8({ a: 1 });
const back: unknown = u82o(bytes);
void back;

// --- utils -----------------------------------------------------------------
const t0: number = nowMs();
void [t0, measureSync(() => 1), measureAsync(async () => 1)];
// `normalizeError` normalises *to a plain object* - that is the point of it -
// so asserting `Error` here was asserting the opposite of the contract.
const normalized: {
  error: true;
  code: string;
  message: string | undefined;
  stack: string | undefined;
} = normalizeError(new Error('boom'));
void [normalized, formatErrorObj({ code: 'X', message: 'y' })];

// --- per-call limiter options (QUAL-011, F8) -------------------------------
//
// These twelve methods used to publish `options?: {}`, which type-checks
// literally any value: a caller passing `{ now: 1234 }` got no completion, no
// error, and no pointer to `LimiterNowOptions`. The runtime has always
// forwarded and honoured `now` — only the declaration was missing — so this is
// the declaration being made to match behaviour that already existed.
//
// The compile-time consequence worth stating: each of these is now *closed*.
// `{ now: 1 }` compiles; `{ notAnOption: 1 }` does not. That asymmetry is the
// whole point, and it is what `@ts-expect-error` below is asserting — an
// `options?: {}` would have compiled the bad call too, and the directive would
// then fail as unused.
const throttled = new PowerThrottle({ capacity: 2 });
throttled.tryConsume(1, { now: 1000 });
throttled.reserve(1, { now: 1000 });
throttled.available({ now: 1000 });
// @ts-expect-error `now` is a number of ms, not a Date.
throttled.tryConsume(1, { now: new Date() });
// @ts-expect-error unknown key on a now-declared options bag.
throttled.tryConsume(1, { notAnOption: true });

const windowed = new PowerSlidingWindow({ capacity: 2 });
windowed.tryConsume(1, { now: 1000 });
windowed.available({ now: 1000 });
// @ts-expect-error unknown key.
windowed.available({ nope: 1 });

const gcraPerCall = new PowerGCRA({ rate: 1, per: 1000 });
gcraPerCall.tryConsume(1, { now: 1000 });
gcraPerCall.retryAfter(1, { now: 1000 });
gcraPerCall.available({ now: 1000 });
// @ts-expect-error unknown key.
gcraPerCall.retryAfter(1, { nope: 1 });

const gatePerCall = new PowerPermitGate({ capacity: 1 });
void gatePerCall.acquire({ signal: new AbortController().signal });
// @ts-expect-error `signal` is the only per-call option on the gate.
void gatePerCall.acquire({ signal: undefined, nope: 1 });

const timedPerCall = new PowerTimedCache(1000);
timedPerCall.set('k', 1, { ttl: 500 });
timedPerCall.set('k', 1, { weight: 2 });
timedPerCall.has('k');
// @ts-expect-error unknown key on the per-entry options.
timedPerCall.set('k', 1, { nope: 1 });

// --- getStats()/stats() are the same type to a consumer (QUAL-011) ---------
//
// Asserted by bidirectional assignability rather than by comparing declaration
// text, because the two spellings legitimately differ in form: where `stats()`
// says `PowerRetryBudgetStats`, the inferred `getStats()` says
// `import("./jsdoc-types.js").PowerRetryBudgetStats`. Those are the same type,
// and a string comparison reported them as different. Assignability is the
// property a consumer actually relies on, so it is the property asserted.
//
// Each of these compiles only if the two methods agree. If a `stats()` return
// shape changes and `getStats()` stops matching — which is what happened once,
// when `PowerCache.stats()` gained `staleServes` and `expirations` — one of
// these lines fails.
type EqGCRA = [ReturnType<PowerGCRA['getStats']>, ReturnType<PowerGCRA['stats']>];
const gcraTyped = new PowerGCRA({ rate: 1, per: 1000 });
const gcraForward: ReturnType<PowerGCRA['stats']> = gcraTyped.getStats();
const gcraBackward: ReturnType<PowerGCRA['getStats']> = gcraTyped.stats();
void ([gcraForward, gcraBackward] satisfies EqGCRA);

const cacheTyped = new PowerCache();
const cacheForward: ReturnType<PowerCache['stats']> = cacheTyped.getStats();
const cacheBackward: ReturnType<PowerCache['getStats']> = cacheTyped.stats();
void [cacheForward, cacheBackward];

const bulkheadTyped = new PowerBulkhead({ maxConcurrency: 1 });
const bulkheadForward: ReturnType<PowerBulkhead['stats']> = bulkheadTyped.getStats();
const bulkheadBackward: ReturnType<PowerBulkhead['getStats']> = bulkheadTyped.stats();
void [bulkheadForward, bulkheadBackward];

const elmTyped = new PowerEventLoopMonitor({ intervalMs: 1000 });
const elmForward: ReturnType<PowerEventLoopMonitor['stats']> = elmTyped.getStats();
const elmBackward: ReturnType<PowerEventLoopMonitor['getStats']> = elmTyped.stats();
void [elmForward, elmBackward];

const budgetTyped = new PowerRetryBudget();
const budgetForward: ReturnType<PowerRetryBudget['stats']> = budgetTyped.getStats();
const budgetBackward: ReturnType<PowerRetryBudget['getStats']> = budgetTyped.stats();
void [budgetForward, budgetBackward];

// --- PowerPool encode-cache options were read but never declared ------------
//
// Both were read by the constructor (`powerPool.js:_encodeCacheLimit`,
// `_encodeCacheByteLimit`) and absent from `PowerPoolOptions`, so a TypeScript
// caller could not pass them at all — a real defect, found by a pass that was
// checking for unknown options and turned up two that the published type was
// missing. Asserted here so neither can go missing again.
const poolWithEncodeCache = new PowerPool(
  function EncodeCacheWorker(this: any) {
    this.onmessage = null;
    this.postMessage = () => {};
    this.terminate = () => {};
  },
  {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    encodeCacheLimit: 128,
    encodeCacheByteLimit: 1 << 20,
  }
);
poolWithEncodeCache.terminate();
// @ts-expect-error `encodeCacheLimit` is a number of entries, not a string.
const poolBadEncodeCache = new PowerPool(function W(this: any) {}, { encodeCacheLimit: 'lots' });
void poolBadEncodeCache;

// --- observability was read by eight constructors and typed by seven --------
//
// `attach(instance, name, options)` in `src/helpers/metrics.js` reads
// `options.observability`, and eight constructors call it. `PowerCacheOptions`
// did not declare the field, so a TypeScript caller could not pass it — the same
// defect as `PowerPool`'s `encodeCacheLimit` pair in 3d54d29, found by the same
// kind of pass. Asserted per class so a future option removal is caught here
// rather than by a consumer's compiler.
new PowerCache({ observability: true });
new PowerGCRA({ rate: 1, per: 1000, observability: true });
new PowerBulkhead({ maxConcurrency: 1, observability: true });
new PowerRetryBudget({ ratio: 0.2, observability: true });
new PowerEventLoopMonitor({ observability: true });
new PowerRealtimeHub({ send: () => {}, observability: true });
new PowerWebSocketClient({ url: 'ws://x', observability: true });
new PowerSocketAdapter({ readyState: 1 } as any, { observability: true });
// A collector instance registers with that collector instead of the shared one.
// `defaultMetrics` is already an instance, not a factory (src/index.js:18).
new PowerCache({ observability: defaultMetrics });
new PowerCache({ observability: new MetricsCollector() });
// No `@ts-expect-error` for a wrong *value*: `new PowerCache({ observability:
// 'yes' })` compiles, so the declared union is not enforced at the constructor.
// Asserting it would be asserting something untrue; the useful half of this test
// is that the option is *accepted* at all, which was the defect. Tightening the
// value type is separate work and needs its own investigation.
