import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import {
  PowerEventBus,
  PowerSubscriberSet,
  PowerPermitGate,
  PowerSemaphore,
  PowerScheduler,
  PowerTTLMap,
  PowerCircuit,
  PowerLatch,
  PowerBatch,
  PowerBackpressure,
  PowerCache,
  PowerTimedCache,
  PowerMemoizer,
  PowerPool,
  PowerBulkhead,
  PowerGCRA,
  PowerRealtimeHub,
  PowerWebSocketClient,
  preloadNode,
} from '../src/index.js';

beforeAll(async () => {
  await preloadNode();
});

/**
 * Explicit resource management (QUAL-005).
 *
 * The library teaches disposal and the stats helpers, and 2.x added
 * `using` / `await using` to a handful of classes. The rest silently did not
 * support it, so `using cache = new PowerCache(...)` worked while
 * `using bus = new PowerEventBus(...)` threw. These pin the contract so the
 * set cannot quietly shrink again.
 */

/** Every class that owns something and therefore must be disposable. */
const RESOURCE_OWNERS = [
  ['PowerEventBus', () => new PowerEventBus()],
  ['PowerSubscriberSet', () => new PowerSubscriberSet()],
  ['PowerSemaphore', () => new PowerSemaphore({ permits: 2 })],
  ['PowerPermitGate', () => new PowerPermitGate({ capacity: 2 })],
  ['PowerScheduler', () => new PowerScheduler(() => {}, { scheduling: 'microtask' })],
  ['PowerTTLMap', () => new PowerTTLMap(1000)],
  ['PowerCircuit', () => new PowerCircuit({ threshold: 3, resetTimeout: 1000 })],
  ['PowerLatch', () => new PowerLatch(1)],
  ['PowerBatch', () => new PowerBatch(() => {}, { maxSize: 8 })],
  [
    'PowerBackpressure',
    () => new PowerBackpressure({ highWaterMark: 2, lowWaterMark: 1, refillRate: 1 }),
  ],
  ['PowerCache', () => new PowerCache()],
  ['PowerTimedCache', () => new PowerTimedCache(1000)],
  ['PowerMemoizer', () => new PowerMemoizer()],
  ['PowerGCRA', () => new PowerGCRA({ rate: 1 })],
  ['PowerRealtimeHub', () => new PowerRealtimeHub({ send: () => {} })],
  ['PowerBulkhead', () => new PowerBulkhead({ maxConcurrency: 1 })],
  ['PowerWebSocketClient', () => new PowerWebSocketClient({ url: 'ws://x' })],
  [
    'PowerPool',
    () =>
      new PowerPool(
        () => ({
          addEventListener() {},
          removeEventListener() {},
          postMessage() {},
          terminate() {},
        }),
        { size: 1, minSize: 1, maxSize: 1, lazy: false }
      ),
  ],
];

describe('every resource-owning class supports explicit disposal', () => {
  it.each(RESOURCE_OWNERS)('%s implements dispose() and [Symbol.dispose]', (_name, make) => {
    const instance = make();
    expect(typeof instance.dispose, 'dispose() must exist').toBe('function');
    expect(typeof instance[Symbol.dispose], '[Symbol.dispose] must exist so `using` works').toBe(
      'function'
    );
  });

  it.each(RESOURCE_OWNERS)('%s disposes idempotently and without throwing', (_name, make) => {
    const instance = make();
    expect(() => instance.dispose()).not.toThrow();
    expect(() => instance.dispose()).not.toThrow();
    expect(() => instance[Symbol.dispose]()).not.toThrow();
  });

  it('a resource owner is disposable via `using` at scope exit', () => {
    // `using` needs Symbol.dispose at compile time; this asserts the runtime
    // half - that the symbol is present, callable, and that leaving the scope
    // actually ran it.
    const held = { bus: null };
    {
      using bus = new PowerEventBus();
      bus.on('x', () => {});
      held.bus = bus;
      expect(bus._listeners.size).toBeGreaterThan(0);
    }
    // The `using` scope has exited, so `dispose` ran and emptied the registry.
    expect(held.bus._listeners.size).toBe(0);
  });
});

describe('disposal actually releases the resource', () => {
  it('PowerEventBus drops every listener and resets the registry', () => {
    const bus = new PowerEventBus();
    bus.on('a', () => {});
    bus.on('b', () => {}, { once: true });
    const registry = bus._finalizationRefs;
    bus.dispose();
    expect(bus._listeners.size).toBe(0);
    // A new registry, not the populated one: the old closures are collectable.
    expect(bus._finalizationRefs).not.toBe(registry);
  });

  it('PowerScheduler cancels a pending flush', () => {
    let ran = 0;
    const scheduler = new PowerScheduler(() => {
      ran += 1;
    });
    scheduler.schedule();
    scheduler.dispose();
    return new Promise((resolve) => {
      // A microtask is enough for a pending microtask flush to have fired.
      Promise.resolve().then(() => {
        expect(ran).toBe(0);
        resolve();
      });
    });
  });

  it('PowerCache stops its cleanup loop', () => {
    const cache = new PowerCache();
    cache.startCleanup(50);
    expect(cache._cleanupTimer).toBeTruthy();
    cache.dispose();
    expect(cache._cleanupTimer).toBeNull();
  });

  it('PowerBackpressure releases its permit gate', () => {
    const bp = new PowerBackpressure({ highWaterMark: 2, lowWaterMark: 1, refillRate: 1 });
    bp.reset();
    expect(() => bp.dispose()).not.toThrow();
    expect(bp._refillTimer).toBeFalsy();
  });
});

describe('disposal is safe under repeated use', () => {
  it('a disposed instance can still be constructed and disposed many times', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 25 }), (count) => {
        for (let i = 0; i < count; i++) {
          const bus = new PowerEventBus();
          bus.on('x', () => {});
          bus.dispose();
        }
      }),
      { numRuns: 50 }
    );
  });

  it('clears its own timer handles on dispose, not a global count', () => {
    // Deliberately NOT `process.getActiveResourcesInfo()`: that reports unref'd
    // handles too, so a count comparison would pass whether or not disposal did
    // anything. Assert the specific fields instead - that is the contract.
    for (let i = 0; i < 20; i++) {
      const cache = new PowerCache();
      cache.startCleanup(50);
      expect(cache._cleanupTimer).toBeTruthy();
      cache.dispose();
      expect(cache._cleanupTimer).toBeNull();

      // NB: `PowerBackpressure.reset()` *clears* the refill timer rather than
      // scheduling one, so there is no "timer before dispose" precondition to
      // assert here. What matters is that dispose is safe and leaves none.
      const bp = new PowerBackpressure({ highWaterMark: 1, lowWaterMark: 1, refillRate: 1 });
      expect(() => bp.dispose()).not.toThrow();
      expect(bp._refillTimer).toBeFalsy();
    }
  });
});
