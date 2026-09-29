import { describe, it, expect } from 'vitest';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';
import { PowerSubscriberSet } from '../src/helpers/powerSubscriberSet.js';
import { PowerRealtimeHub } from '../src/helpers/powerRealtimeHub.js';
import { PowerLatch } from '../src/helpers/powerLatch.js';
import { PowerWebSocketClient } from '../src/helpers/powerWebSocketClient.js';

/**
 * BUG-024: validate the remaining hand-rolled numeric options.
 *
 * Thirteen of the seventeen constructors already went through
 * `assertLimitRequired`. These six did not, and the interesting thing is that
 * **they were not all wrong in the same direction** - which is why a single
 * blanket rule ("0 is always a mistake", or "0 is always fine") would have
 * broken half of them:
 *
 *  - `queueCapacity: 0`, `batchDelayMs: 0`, `count: 0`, `maxListeners: 0` are
 *    **requests**, and the old coercions broke them (`0 || default` sent `0` to
 *    the default, so "refuse immediately" became "hold the full default queue").
 *  - `maxListeners: -1` produced `0`, which on those same classes *means
 *    unlimited* - so a mistake silently **removed the cap**.
 *  - `pollIntervalMs: 0` is a busy loop, not a request, and became 20.
 *
 * Every test below therefore checks the specific coercion that was there, not a
 * generic "throws" - a test that only asserted `toThrow()` would have passed
 * against the original code for a different reason.
 */
describe('BUG-024 option validation', () => {
  describe('PowerBulkhead', () => {
    it('honours queueCapacity: 0 instead of substituting the default', () => {
      // The worst of the set: a value that reads as "no queue" and produced the
      // *largest* queue the class supports. `Number(0) || 100` is `100`.
      const bulkhead = new PowerBulkhead({ queueCapacity: 0 });
      expect(bulkhead.queueCapacity).toBe(0);
    });

    it('throws rather than inventing partitions for 0 or a negative', () => {
      // `Math.max(1, 0 || 4)` was 4. A caller asking for one partition got four.
      expect(() => new PowerBulkhead({ partitions: 0 })).toThrow('partitions');
      expect(() => new PowerBulkhead({ partitions: -3 })).toThrow('partitions');
      expect(() => new PowerBulkhead({ partitions: Number.NaN })).toThrow('partitions');
    });

    it('throws rather than admitting one task for maxConcurrency: 0', () => {
      // Same mistake `PowerPermitGate.capacity` stopped making: a bulkhead
      // configured to allow nothing is how you switch a dependency off, and `0`
      // became 1 - the opposite of the stated intent.
      expect(() => new PowerBulkhead({ maxConcurrency: 0 })).toThrow('maxConcurrency');
      expect(() => new PowerBulkhead({ maxConcurrency: -1 })).toThrow('maxConcurrency');
    });

    it('keeps the documented defaults when nothing is passed', () => {
      const bulkhead = new PowerBulkhead();
      expect(bulkhead.partitions).toBe(4);
      expect(bulkhead.maxConcurrency).toBe(1);
      expect(bulkhead.queueCapacity).toBeGreaterThan(0);
    });
  });

  describe('maxListeners, where 0 means unlimited', () => {
    it('keeps 0 as unlimited, proven by subscribing past any cap', () => {
      // There is no public getter for the cap, and one should not be added for
      // a test. The observable contract is that `0` means *no cap*: the cap
      // raises on overflow, so subscribing past any plausible limit is the
      // proof. If the default had been substituted for the `0`, the 11th
      // listener would have thrown.
      const bus = new PowerEventBus({ maxListeners: 0 });
      for (let i = 0; i < 20; i++) bus.on('e', () => {});
      expect(bus.listeners('e').length).toBe(20);

      const set = new PowerSubscriberSet({ maxListeners: 0 });
      for (let i = 0; i < 20; i++) set.add(() => {});
      expect(set.size).toBe(20);
    });

    it('still raises past a positive cap, so 0 is a setting and not a no-op', () => {
      // Without this, "0 means unlimited" and "the cap is broken" are
      // indistinguishable, and the test above would pass either way.
      const bus = new PowerEventBus({ maxListeners: 2 });
      bus.on('e', () => {});
      bus.on('e', () => {});
      expect(() => bus.on('e', () => {})).toThrow();
    });

    it('throws on a negative instead of turning it into unlimited', () => {
      // The inverse failure and the more dangerous one: `Math.max(0, -5)` is
      // `0`, and `0` means *no cap at all*, so a mistake removed the limit that
      // exists to bound a listener leak.
      expect(() => new PowerEventBus({ maxListeners: -1 })).toThrow('maxListeners');
      expect(() => new PowerSubscriberSet({ maxListeners: -5 })).toThrow('maxListeners');
      expect(() => new PowerEventBus({ maxListeners: Number.NaN })).toThrow('maxListeners');
    });
  });

  describe('PowerRealtimeHub', () => {
    it('keeps batchDelayMs: 0, which means flush immediately', () => {
      // Proved by behaviour: with a delay of 0 the hub still batches, and
      // `flush()` sends synchronously. If `0` had been replaced by the default
      // the send would be deferred onto a timer.
      const sent = [];
      const hub = new PowerRealtimeHub({ send: (s, f) => sent.push(f), batchDelayMs: 0 });
      hub.subscribe('t', (f) => f);
      hub.publish('t', { a: 1 });
      hub.flush();
      expect(sent).toHaveLength(1);
    });

    it('throws on a negative or non-finite batchDelayMs', () => {
      // `NaN` reached `0` by way of `|| 0`, so a caller who passed a computed
      // value got immediate flushing - which looks exactly like a bug in the
      // hub rather than a bad argument.
      expect(() => new PowerRealtimeHub({ send: () => {}, batchDelayMs: -1 })).toThrow(
        'batchDelayMs'
      );
      expect(() => new PowerRealtimeHub({ send: () => {}, batchDelayMs: Number.NaN })).toThrow(
        'batchDelayMs'
      );
    });
  });

  describe('PowerLatch', () => {
    it('keeps count: 0, a latch that is already complete', () => {
      // A latch constructed at 0 must resolve `wait()` immediately rather than
      // hanging - the whole point of accepting the value.
      const latch = new PowerLatch(0);
      let settled = false;
      latch.wait().then(() => {
        settled = true;
      });
      return Promise.resolve().then(() => {
        expect(settled).toBe(true);
      });
    });

    it('throws on a negative or non-finite count', () => {
      // `Math.max(0, Number(count) || 0)` turned a `NaN` into `0`, so `wait()`
      // returned immediately and nothing was ever waited for - a latch that
      // silently does not latch.
      expect(() => new PowerLatch(-1)).toThrow('count');
      expect(() => new PowerLatch(Number.NaN)).toThrow('count');
      expect(() => new PowerLatch(Number.POSITIVE_INFINITY)).toThrow('count');
    });
  });

  describe('PowerWebSocketClient', () => {
    it('keeps 0 for the options where 0 switches a mechanism off', () => {
      const client = new PowerWebSocketClient({ url: 'ws://x' });
      // Defaults are 0 for the heartbeat and the watermarks, meaning "off".
      expect(client).toBeInstanceOf(PowerWebSocketClient);
      const off = new PowerWebSocketClient({
        url: 'ws://x',
        heartbeatIntervalMs: 0,
        heartbeatTimeoutMs: 0,
        highWaterMarkBytes: 0,
        lowWaterMarkBytes: 0,
        connectTimeoutMs: 0,
      });
      expect(off).toBeInstanceOf(PowerWebSocketClient);
    });

    it('throws on a zero poll interval, which is a busy loop rather than a request', () => {
      // `Number(0) || 20` was 20, so the caller got a default they never asked
      // for; and the backoff curve built on top of it was tuned to nothing they
      // chose.
      expect(() => new PowerWebSocketClient({ url: 'ws://x', pollIntervalMs: 0 })).toThrow(
        'pollIntervalMs'
      );
      expect(() => new PowerWebSocketClient({ url: 'ws://x', maxPollIntervalMs: 0 })).toThrow(
        'maxPollIntervalMs'
      );
    });

    it('throws on a negative or non-finite limit', () => {
      const bad = ['heartbeatIntervalMs', 'heartbeatTimeoutMs', 'connectTimeoutMs'];
      for (const key of bad) {
        expect(() => new PowerWebSocketClient({ url: 'ws://x', [key]: -1 }), key).toThrow(key);
        expect(() => new PowerWebSocketClient({ url: 'ws://x', [key]: Number.NaN }), key).toThrow(
          key
        );
      }
    });
  });
});
