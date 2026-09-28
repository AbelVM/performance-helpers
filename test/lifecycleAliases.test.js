import { describe, it, expect } from 'vitest';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';
import { PowerQueue } from '../src/helpers/powerQueue.js';
import { PowerSubscriberSet } from '../src/helpers/powerSubscriberSet.js';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';
import { PowerBatch } from '../src/helpers/powerBatch.js';
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerEventLoopMonitor } from '../src/helpers/powerEventLoopMonitor.js';
import { PowerGCRA } from '../src/helpers/powerGCRA.js';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerPermitGate } from '../src/helpers/powerPermitGate.js';
import { PowerSemaphore } from '../src/helpers/powerSemaphore.js';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';
import { PowerLatch } from '../src/helpers/powerLatch.js';
import { PowerRateLimit } from '../src/helpers/powerRateLimit.js';
import { PowerBackpressure } from '../src/helpers/powerBackpressure.js';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';
import { PowerObserver } from '../src/helpers/powerObserver.js';

/**
 * QUAL-004 (aliasing half).
 *
 * The plan asked for `reset`/`clear` to become aliases on every class. That is
 * only correct where the two words describe the same act, and for the limiters
 * it is not just imprecise but **backwards**: `PowerThrottle.reset()` refills
 * the bucket, so a `clear()` alias would read as the exact opposite of what it
 * does. These tests pin the policy in both directions - the aliases that were
 * added, and the ones that were deliberately withheld.
 */
describe('lifecycle aliases (QUAL-004)', () => {
  describe('container classes: reset() and clear() really are synonyms', () => {
    it('PowerQueue.reset() empties the queue', () => {
      const q = new PowerQueue();
      q.push(1);
      q.push(2);
      expect(q.length).toBe(2);
      q.reset();
      expect(q.length).toBe(0);
      // and it is the same act, not a near-miss
      q.push(3);
      q.clear();
      expect(q.length).toBe(0);
    });

    it('PowerEventBus.reset() clears every listener, and takes an event', () => {
      const bus = new PowerEventBus();
      const a = () => {};
      const b = () => {};
      bus.on('x', a);
      bus.on('y', b);
      bus.reset();
      expect(bus.listeners('x')).toEqual([]);
      expect(bus.listeners('y')).toEqual([]);

      bus.on('x', a);
      bus.reset('x');
      expect(bus.listeners('x')).toEqual([]);
    });

    it('PowerSubscriberSet.reset() drops every listener and the registry', () => {
      if (typeof FinalizationRegistry === 'undefined') return;
      const set = new PowerSubscriberSet({ weak: true });
      set.add(() => {});
      set.reset();
      expect(set.size).toBe(0);
      expect(set._finalization).toBeNull();
    });

    it('PowerTTLMap.reset() drops every entry', () => {
      const m = new PowerTTLMap();
      m.set('a', 1);
      m.set('b', 2);
      m.reset();
      expect(m.size).toBe(0);
      expect(m.get('a')).toBeUndefined();
    });

    it('PowerBatch.reset() discards queued work like clear()', async () => {
      const ran = [];
      const b = new PowerBatch(() => ran.push(1));
      // `clear()` rejects the pending batch promise, so capture it rather than
      // leaving an unhandled rejection behind. The rejection is raised
      // synchronously but observed on a microtask, hence the await.
      const settled = [];
      b.add(() => {}).then(
        () => settled.push('ok'),
        (err) => settled.push(err.message)
      );
      b.reset();
      await Promise.resolve();
      expect(ran).toEqual([]);
      expect(settled).toEqual(['PowerBatch cleared before flush']);
    });

    it('PowerSlidingWindow.clear() empties the window like reset()', () => {
      const w = new PowerSlidingWindow({ capacity: 4, windowMs: 10_000 });
      w.tryConsume();
      expect(w.available()).toBe(3);
      w.clear();
      expect(w.available()).toBe(4);
    });

    it('PowerEventLoopMonitor.clear() discards the samples like reset()', () => {
      const m = new PowerEventLoopMonitor({ intervalMs: 1000 });
      // Record a sample directly rather than waiting on the timer, so the test
      // does not race the scheduler.
      m._record(5);
      expect(m.lastDelay()).toBe(5);
      m.clear();
      expect(m.lastDelay()).toBe(0);
      expect(m.stats().samples).toBe(0);
    });

    it('PowerGCRA.clear() forgets the TAT like reset()', () => {
      const g = new PowerGCRA({ rate: 10, per: 1000, burst: 2, emission: 1 });
      // A denied attempt stores a TAT, which is exactly the state to forget.
      g.tryConsume(1000);
      expect(g.stats().tat).not.toBeNull();
      g.clear();
      expect(g.stats().tat).toBeNull();
    });
  });

  it('a reset() alias becomes a no-op after dispose(), consistently', () => {
    // `dispose()` neutralises `clear`, and the alias delegates to it, so the
    // alias must not become a second, live teardown path.
    const m = new PowerTTLMap();
    m.set('a', 1);
    m.dispose();
    m.reset();
    expect(m.size).toBe(0);
    expect(() => m.reset()).not.toThrow();
  });

  describe('limiters: reset() and clear() are NOT synonyms, so no alias', () => {
    it('PowerThrottle.reset() refills - a clear() alias would invert it', () => {
      const t = new PowerThrottle({ capacity: 2, ratePerSec: 0.0001 });
      t.tryConsume();
      t.tryConsume();
      expect(t.tokens).toBe(0);
      t.reset();
      // Refilled, not emptied. Naming this `clear()` would be a lie.
      expect(t.tokens).toBe(2);
      expect(t.clear).toBeUndefined();
    });

    it('the other capacity holders likewise have no clear()', () => {
      for (const instance of [
        new PowerPermitGate({ capacity: 2 }),
        new PowerSemaphore(2),
        new PowerCircuit(),
        new PowerRateLimit(),
        new PowerBackpressure({ capacity: 2 }),
        new PowerBulkhead({ maxConcurrency: 2 }),
      ]) {
        expect(instance.clear).toBeUndefined();
        expect(typeof instance.reset).toBe('function');
      }
    });

    it('PowerLatch.reset() re-arms, which "clear" would contradict', () => {
      const latch = new PowerLatch(0);
      expect(latch.clear).toBeUndefined();
      // `reset(count)` re-arms the latch with a count, so it is an "arm" op and
      // not an emptying one.
      latch.reset(3);
      expect(latch.countDown()).toBe(2);
    });
  });

  it('PowerObserver gets no reset() alias: "reset" implies a value, not listeners', () => {
    const obs = new PowerObserver(1);
    const fn = () => {};
    obs.subscribe(fn);
    obs.clear();
    expect(obs.size).toBe(0);
    // The value survives `clear()` (it removes *subscribers*), so a `reset()`
    // alias would suggest something the class does not do.
    expect(obs.value).toBe(1);
    expect(obs.reset).toBeUndefined();
  });
});
