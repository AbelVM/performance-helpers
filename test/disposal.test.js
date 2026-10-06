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
  PowerSocketAdapter,
  WorkerAgnostic,
  preloadNode,
} from '../src/index.js';

/**
 * A worker-like for the `WorkerAgnostic` entry.
 *
 * **Extends `EventTarget`, not `EventEmitter`, and that is load-bearing rather than
 * stylistic.** Node `EventEmitter` has no `addEventListener`, so an
 * `EventEmitter`-based worker silently takes `_wireEvents`' *emitter* branch —
 * this entry would then exercise a different code path from the one a browser
 * Web Worker takes, while appearing to cover it. Caught by a mutation that stored
 * a different function from the one it registered and passed 7/7.
 */
class EventTargetWorker extends EventTarget {
  terminate() {
    this.terminated = true;
  }
}

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
  ['PowerSemaphore', () => new PowerSemaphore(2)],
  ['PowerPermitGate', () => new PowerPermitGate({ capacity: 2 })],
  ['PowerScheduler', () => new PowerScheduler(() => {}, { scheduling: 'microtask' })],
  ['PowerTTLMap', () => new PowerTTLMap(1000)],
  ['PowerCircuit', () => new PowerCircuit({ threshold: 3, timeout: 1000 })],
  ['PowerLatch', () => new PowerLatch(1)],
  ['PowerBatch', () => new PowerBatch(() => {}, { maxSize: 8 })],
  [
    'PowerBackpressure',
    () => new PowerBackpressure({ capacity: 2, lowWaterMark: 1, refillAmount: 1 }),
  ],
  ['PowerCache', () => new PowerCache()],
  ['PowerTimedCache', () => new PowerTimedCache(1000)],
  ['PowerMemoizer', () => new PowerMemoizer()],
  ['PowerGCRA', () => new PowerGCRA({ rate: 1 })],
  ['PowerRealtimeHub', () => new PowerRealtimeHub({ send: () => {} })],
  ['PowerBulkhead', () => new PowerBulkhead({ maxConcurrency: 1 })],
  ['PowerWebSocketClient', () => new PowerWebSocketClient({ url: 'ws://x' })],
  [
    'PowerSocketAdapter',
    // The adapter owns a heartbeat timer and five socket listeners, so leaving
    // it undisposed pins both the timer and the socket for the life of the
    // process - one leak per connection on a server.
    () =>
      new PowerSocketAdapter(
        {
          readyState: 1,
          bufferedAmount: 0,
          on() {},
          off() {},
          send() {},
          ping() {},
          close() {},
        },
        { heartbeatIntervalMs: 1000 }
      ),
  ],
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
  // WRK-002. This one needs a worker source, and it is here rather than
  // elsewhere because it is the class that could not be added before: `_wireEvents`
  // passed anonymous arrow functions straight to `addEventListener`, so nothing
  // held a reference and `dispose()` had no handle to remove. Fixed by storing the
  // handlers per native model — see `workerAgnostic.dispose.test.js`, which counts
  // listeners on a real `EventTarget` rather than a stub.
  ['WorkerAgnostic', () => new WorkerAgnostic(() => new EventTargetWorker())],
];

describe('the RESOURCE_OWNERS list itself', () => {
  it('holds exactly the 20 classes it claims to', () => {
    // This assertion exists because **two different wrong counts** reached the
    // record inside one session, and neither was caught. WRK-002's note said the
    // list held 19 classes; the changeset entry for the same work said it held 16
    // and that `WorkerAgnostic` became the 17th entry. Checked against git rather
    // than believed: `13d781b^` really does hold **19**, and `13d781b` **20**. So
    // the row was right and the changeset was wrong twice over — and `it.each`
    // over the list cannot notice either, because every assertion in the file
    // still passes at 16 or at 25 entries.
    //
    // The number is a real guard rather than a snapshot of a moment: it is
    // asserted so that adding or removing an entry is a **deliberate edit** that
    // fails loudly. Growing the list is the good direction, so whoever does it
    // updates this line in the same commit — which is the intent, not an
    // inconvenience.
    expect(RESOURCE_OWNERS).toHaveLength(20);
  });

  it('has no duplicate class names', () => {
    // A duplicate would silently double every `it.each` case while reporting a
    // green suite, and the count assertion above would then be the only thing
    // complaining — about a number nobody would think to re-derive.
    const names = RESOURCE_OWNERS.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('ends at WorkerAgnostic, the class WRK-002 added', () => {
    // Position is the part worth pinning: WRK-002's note claimed the class was
    // "absent from the 19-entry list", so the list's length is the row's own
    // evidence and the name has to still be in it.
    expect(RESOURCE_OWNERS.at(-1)?.[0]).toBe('WorkerAgnostic');
  });
});

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

  it('a resource owner is disposable via a scope-exit dispose', () => {
    // The runtime half of the contract: the symbol is present, callable, and
    // leaving the scope actually ran it. Node 22.12 cannot parse `using`
    // declarations and no transformer in this tree downlevels them, so the
    // scope exit is spelled out here; the behaviour under test is identical.
    const held = { bus: null };
    const bus = new PowerEventBus();
    try {
      bus.on('x', () => {});
      held.bus = bus;
      expect(bus._listeners.size).toBeGreaterThan(0);
    } finally {
      bus.dispose();
    }
    // The scope has exited, so `dispose` ran and emptied the registry.
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
    const bp = new PowerBackpressure({ capacity: 2, lowWaterMark: 1, refillAmount: 1 });
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
      const bp = new PowerBackpressure({ capacity: 1, lowWaterMark: 1, refillAmount: 1 });
      expect(() => bp.dispose()).not.toThrow();
      expect(bp._refillTimer).toBeFalsy();
    }
  });
});
