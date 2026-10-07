import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { PowerPool, preloadNode } from '../src/index.js';

beforeAll(async () => {
  // Pure-ESM Node needs the node:worker_threads require hoisted before any
  // worker creation path runs.
  await preloadNode();
});

/**
 * Adaptive concurrency policies (ALG-004).
 *
 * The pre-existing `autoScale` coverage lives in `powerPool.autoscale.test.js`
 * and pins the original latency-threshold behaviour. This file covers the
 * feedback-loop controllers layered on top: `aimd`, `vegas` and `gradient2`.
 */

/** A worker whose latency the test controls, so the controller has a real signal. */
class ScriptedWorker {
  constructor(options = {}) {
    this._listeners = [];
    this.latency = options.latency ?? 5;
  }
  setLatency(ms) {
    this.latency = ms;
  }
  addEventListener(type, fn) {
    this._listeners.push([type, fn]);
  }
  removeEventListener() {}
  _emit(type, payload) {
    for (const [t, fn] of this._listeners) if (t === type) fn(payload);
  }
  postMessage() {
    const duration = this.latency;
    setTimeout(() => this._emit('message', { data: { duration, ok: true } }), duration);
  }
  terminate() {}
}

const mkPool = (autoScale, extra = {}) =>
  new PowerPool(() => new ScriptedWorker(extra.worker), {
    size: 1,
    minSize: 1,
    maxSize: 8,
    lazy: false,
    awaitResponseTimeout: 0,
    autoScale,
  });

describe('PowerPool adaptive concurrency policies (ALG-004)', () => {
  it('accepts the four policies and falls back for anything else', () => {
    for (const policy of ['ewma', 'aimd', 'vegas', 'gradient2']) {
      const p = mkPool({ policy, intervalMs: 100000, cooldownMs: 0 });
      expect(p._autoScale.policy).toBe(policy);
      p.shutdown();
    }
    const bad = mkPool({ policy: 'nonsense' });
    expect(bad._autoScale.policy).toBe('ewma');
    bad.shutdown();
  });

  it("'ewma' keeps the default behaviour and reports no limit", () => {
    const p = mkPool({ policy: 'ewma', intervalMs: 100000, cooldownMs: 0 });
    p._ewmaLatency = 10;
    p._autoScaleTick();
    expect(p.getStats().performance.concurrencyLimit).toBeNull();
    expect(p.getStats().performance.autoScalePolicy).toBe('ewma');
    p.shutdown();
  });

  it('reports the limit and congestion signal for adaptive policies', () => {
    const p = mkPool({ policy: 'gradient2', intervalMs: 100000, cooldownMs: 0 });
    p._ewmaLatency = 10;
    p._longEwmaLatency = 10;
    p._autoScaleTick();
    const perf = p.getStats().performance;
    expect(perf.autoScalePolicy).toBe('gradient2');
    expect(typeof perf.concurrencyLimit).toBe('number');
    expect(perf.concurrencyLimit).toBeGreaterThan(0);
    expect(typeof perf.congestion).toBe('boolean');
    p.shutdown();
  });

  it('queues work once the adaptive concurrency limit is reached', () => {
    const p = mkPool({
      policy: 'aimd',
      intervalMs: 100000,
      cooldownMs: 0,
    });
    p._adaptiveLimit = 1;

    expect(p.postMessage({ first: true })).toBe(true);
    expect(p.postMessage({ second: true })).toBe(true);
    expect(p.queue.length).toBe(1);
    expect(p._activeTasks).toBe(1);
    p.shutdown();
  });

  it('does not drain queued work past the adaptive limit', () => {
    const p = mkPool({ policy: 'aimd', intervalMs: 100000, cooldownMs: 0 });
    p._adaptiveLimit = 1;
    p._maxTasksPerWorker = 4;

    p.postMessage({ first: true });
    p.postMessage({ second: true });
    p._dispatchQueuedTasks();

    expect(p.queue.length).toBe(1);
    expect(p._activeTasks).toBe(1);
    expect(p.workers[0].tasks).toBe(1);
    p.shutdown();
  });

  it('applies the adaptive limit to fire-and-forget batches', () => {
    const p = mkPool({ policy: 'aimd', intervalMs: 100000, cooldownMs: 0 });
    p._adaptiveLimit = 1;
    p._maxTasksPerWorker = 4;

    expect(
      p.postMessageBatch([{ message: { first: true } }, { message: { second: true } }])
    ).toEqual([true, true]);
    expect(p._activeTasks).toBe(1);
    expect(p.queue.length).toBe(1);
    p.shutdown();
  });

  it('separates queue wait from worker service time', () => {
    const p = mkPool({ policy: 'aimd', intervalMs: 100000, cooldownMs: 0 });
    p._recordQueueWait(2);
    p._recordQueueWait(6);
    expect(p.getStats().performance.queueWait).toMatchObject({
      count: 2,
      min: 2,
      max: 6,
      average: 4,
    });
    p.shutdown();
  });

  it('clamps the limit to [limitMin, limitMax]', () => {
    const p = mkPool({
      policy: 'aimd',
      intervalMs: 100000,
      cooldownMs: 0,
      limitMin: 2,
      limitMax: 3,
    });
    for (let i = 0; i < 50; i++) {
      p._ewmaLatency = i % 2 === 0 ? 100 : 1;
      p._longEwmaLatency = 5;
      p._autoScaleTick();
      const l = p.getStats().performance.concurrencyLimit;
      expect(l).toBeGreaterThanOrEqual(1.9);
      expect(l).toBeLessThanOrEqual(3.1);
    }
    p.shutdown();
  });

  it('aimd increases the limit while healthy and cuts it when congested', () => {
    const p = mkPool({
      policy: 'aimd',
      intervalMs: 100000,
      cooldownMs: 0,
      limitMin: 1,
      limitMax: 50,
    });
    p._ewmaLatency = 10;
    p._longEwmaLatency = 10;
    const start = p._adaptiveLimit;
    for (let i = 0; i < 5; i++) p._autoScaleTick();
    const grown = p._adaptiveLimit;
    // Additive increase: a healthy signal must raise the limit.
    expect(grown).toBeGreaterThan(start);
    expect(p.getStats().performance.congestion).toBe(false);

    // Congested: short RTT far above long RTT -> multiplicative decrease.
    p._ewmaLatency = 100;
    p._longEwmaLatency = 10;
    p._autoScaleTick();
    expect(p.getStats().performance.congestion).toBe(true);
    expect(p._adaptiveLimit).toBeLessThan(grown);
    p.shutdown();
  });

  it('gradient2 holds steady when idle, rises on a backlog and backs off on latency', () => {
    const p = mkPool({
      policy: 'gradient2',
      intervalMs: 100000,
      cooldownMs: 0,
      limitMin: 1,
      limitMax: 50,
    });
    p._ewmaLatency = 10;
    p._longEwmaLatency = 10;
    // No queue-pressure term to grow from, so a backed-up pool correctly holds.
    for (let i = 0; i < 5; i++) p._autoScaleTick();
    const idle = p._adaptiveLimit;
    for (let i = 0; i < 5; i++) p._autoScaleTick();
    expect(p._adaptiveLimit).toBeCloseTo(idle, 5);

    // Depth of queue is what drives the limit up.
    for (let i = 0; i < 8; i++) p.queue.push({ message: null });
    p._autoScaleTick();
    const backedUp = p._adaptiveLimit;
    expect(backedUp).toBeGreaterThan(idle);
    p.queue.clear();

    // Short RTT now well above long RTT, so the gradient is well under 1.
    p._ewmaLatency = 40;
    p._longEwmaLatency = 10;
    p._autoScaleTick();
    expect(p._adaptiveLimit).toBeLessThan(backedUp);
    p.shutdown();
  });

  it('vegas grows without a min-RTT sample, then steps down once it has one', () => {
    const p = mkPool({
      policy: 'vegas',
      intervalMs: 100000,
      cooldownMs: 0,
      limitMin: 1,
      limitMax: 50,
    });
    p._ewmaLatency = 10;
    p._minLatencyWindow = Number.POSITIVE_INFINITY;
    const before = p._adaptiveLimit;
    p._autoScaleTick();
    expect(p._adaptiveLimit).toBeGreaterThan(before);

    // Vegas's alpha/beta scale with log10(limit), so at a small limit the queue
    // estimate lands in a neutral band and nothing moves. It needs a limit
    // above roughly 3 before it will step down - that is the algorithm, not a
    // stall.
    for (let i = 0; i < 40; i++) p._autoScaleTick();
    const grown = p._adaptiveLimit;
    expect(grown).toBeGreaterThan(3);

    p._minLatencyWindow = 1;
    p._ewmaLatency = 100;
    p._autoScaleTick();
    expect(p.getStats().performance.congestion).toBe(true);
    expect(p._adaptiveLimit).toBeLessThan(grown);
    p.shutdown();
  });

  it('is a no-op with no latency samples yet', () => {
    for (const policy of ['aimd', 'vegas', 'gradient2']) {
      const p = mkPool({ policy, intervalMs: 100000, cooldownMs: 0 });
      p._ewmaLatency = null;
      p._longEwmaLatency = null;
      const before = p._adaptiveLimit;
      p._autoScaleTick();
      expect(p._adaptiveLimit).toBe(before);
      p.shutdown();
    }
  });

  it('never produces a non-finite or out-of-range limit, for any input', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('aimd', 'vegas', 'gradient2'),
        fc.array(
          fc.record({
            short: fc.double({ min: 0.0001, max: 1e6, noNaN: true }),
            long: fc.double({ min: 0.0001, max: 1e6, noNaN: true }),
            min: fc.double({ min: 0.0001, max: 1e5, noNaN: true }),
            queue: fc.nat({ max: 1000 }),
          }),
          { minLength: 1, maxLength: 40 }
        ),
        (policy, samples) => {
          const p = mkPool({
            policy,
            intervalMs: 100000,
            cooldownMs: 0,
            limitMin: 1,
            limitMax: 20,
          });
          for (const s of samples) {
            p._ewmaLatency = s.short;
            p._longEwmaLatency = s.long;
            p._minLatencyWindow = s.min;
            while (p.queue.length < s.queue) p.queue.push({ message: null });
            p._autoScaleTick();
            const l = p._adaptiveLimit;
            expect(Number.isFinite(l)).toBe(true);
            expect(l).toBeGreaterThanOrEqual(1);
            expect(l).toBeLessThanOrEqual(20);
          }
          p.shutdown();
        }
      ),
      { numRuns: 40 }
    );
  });

  it('shuts down cleanly with an adaptive policy running', () => {
    const p = mkPool({ policy: 'gradient2', intervalMs: 100000, cooldownMs: 0 });
    p._ewmaLatency = 5;
    p._autoScaleTick();
    expect(() => p.shutdown()).not.toThrow();
    expect(p._autoScaleInterval).toBeNull();
  });
});
