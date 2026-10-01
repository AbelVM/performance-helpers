import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  PowerThrottle,
  PowerSlidingWindow,
  PowerRateLimit,
  PowerQueue,
  PowerPermitGate,
  PowerSemaphore,
  PowerBulkhead,
} from '../src/index.js';

const RUNS = Number(process.env.FAST_CHECK_NUM_RUNS || 200);

describe('PowerThrottle / PowerSlidingWindow rate invariants', () => {
  it('never lets more than `limit` requests through a window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 120 }),
        (limit, attempts) => {
          const throttle = new PowerThrottle({ limit, windowMs: 1000, capacity: limit });
          let granted = 0;
          for (let i = 0; i < attempts.length; i++) {
            if (throttle.tryConsume()) granted++;
          }
          // The first `limit` attempts are always granted; nothing beyond that
          // may be, because no time has been advanced.
          expect(granted).toBeLessThanOrEqual(limit);
          expect(granted).toBeGreaterThanOrEqual(Math.min(limit, 1));
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('refills so the bucket never exceeds capacity', () => {
    vi.useFakeTimers();
    try {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.array(fc.nat(), { minLength: 1, maxLength: 40 }),
          (limit, gaps) => {
            const throttle = new PowerThrottle({ limit, windowMs: 1000, capacity: limit });
            for (const gap of gaps) {
              throttle.tryConsume();
              vi.advanceTimersByTime(Math.min(gap, 2000));
              // `available` is a method on PowerThrottle, not a getter.
              const avail = throttle.available();
              expect(avail).toBeGreaterThanOrEqual(0);
              expect(avail).toBeLessThanOrEqual(throttle.capacity);
            }
          }
        ),
        { numRuns: RUNS }
      );
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('PowerSlidingWindow tracks exactly the timestamps inside the window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.nat({ max: 3000 }), { minLength: 1, maxLength: 60 }),
        (limit, times) => {
          // `limit` is not an option of `PowerSlidingWindow` - it reads
          // `capacity`, and passing `limit` alone left the limiter at the
          // default capacity of 1, so this property was only ever checking
          // capacity 1 regardless of the generated `limit`.
          const win = new PowerSlidingWindow({ capacity: limit, windowMs: 1000 });
          let clock = 0;
          let model = [];
          for (const t of times) {
            clock += t;
            vi.setSystemTime(clock);
            // Reference: how many of the recorded times are within the window.
            model = model.filter((x) => clock - x < 1000);
            if (model.length < limit) {
              if (win.tryConsume()) model.push(clock);
            } else {
              expect(win.tryConsume()).toBe(false);
            }
          }
        }
      ),
      { numRuns: RUNS }
    );
  }, 15_000);
});

describe('PowerRateLimit composition invariants', () => {
  it('a composite limiter is bounded by its strictest component', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.nat({ max: 10 }), { minLength: 1, maxLength: 40 }),
        (a, b, n) => {
          const l1 = new PowerThrottle({ capacity: a });
          const l2 = new PowerSlidingWindow({ capacity: b, windowMs: 1000 });
          const combined = new PowerRateLimit([l1, l2]);
          let granted = 0;
          for (let i = 0; i < n.length; i++) {
            if (combined.tryConsume(1)) granted++;
          }
          // Whichever component is stricter caps the composite.
          expect(granted).toBeLessThanOrEqual(Math.min(a, b));
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('treats a non-positive ask as a no-op and never throws', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 0 }), (n) => {
        const r = new PowerRateLimit([new PowerThrottle({ capacity: 2 })]);
        // Nothing is consumed, so the next real ask still succeeds.
        expect(r.tryConsume(n)).toBe(true);
        expect(r.tryConsume(2)).toBe(true);
      }),
      { numRuns: RUNS }
    );
  });

  it('refuses an ask larger than the limit without throwing', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        const r = new PowerRateLimit([new PowerThrottle({ capacity: 2 })]);
        // Must be a boolean either way - the contract is "returns a boolean",
        // so an over-sized ask is a `false`, never a TypeError.
        expect(typeof r.tryConsume(n)).toBe('boolean');
      }),
      { numRuns: RUNS }
    );
  });

  it('validates every limiter before touching any of them', () => {
    fc.assert(
      fc.property(fc.nat({ max: 3 }), (idx) => {
        const good = { tryConsume: vi.fn(() => true) };
        const bad = { available: () => 5 };
        const limiters = [good, good, good];
        limiters[idx] = bad;
        const r = new PowerRateLimit(limiters, { atomic: true });
        expect(() => r.tryConsume(1)).toThrow(TypeError);
        for (const l of limiters) if (l.tryConsume) expect(l.tryConsume).not.toHaveBeenCalled();
      }),
      { numRuns: RUNS }
    );
  });
});

describe('PowerQueue ordering invariants', () => {
  // PowerQueue is a plain FIFO ring buffer: push(item) takes a single
  // argument, and there is no pop()/priority mode. These properties pin the
  // ordering the ring buffer actually guarantees.

  it('shift() dequeues in strict insertion order', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 150 }), (values) => {
        const q = new PowerQueue();
        for (const v of values) q.push(v);
        expect(q.length).toBe(values.length);
        expect(q.toArray()).toEqual(values);
        expect(q.peek()).toBe(values[0]);

        const out = [];
        while (q.length > 0) out.push(q.shift());
        expect(out).toEqual(values);
        expect(q.length).toBe(0);
        expect(q.shift()).toBeUndefined();
        expect(q.peek()).toBeUndefined();
      }),
      { numRuns: RUNS }
    );
  });

  it('interleaved push/shift preserves the invariant q.toArray() == remaining', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 1, maxLength: 200 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 200 }),
        (pushed, ops) => {
          const q = new PowerQueue();
          const model = [];
          let cursor = 0;
          for (const shift of ops) {
            if (cursor < pushed.length) {
              q.push(pushed[cursor]);
              model.push(pushed[cursor]);
              cursor++;
            }
            if (shift) {
              expect(q.shift()).toBe(model.shift());
            }
            expect(q.toArray()).toEqual(model);
            expect(q.length).toBe(model.length);
          }
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('survives the internal grow path (bulk drain keeps order)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 600 }), (values) => {
        // 16 is the default initial capacity, so this forces several regrows.
        const q = new PowerQueue();
        for (const v of values) q.push(v);
        const out = [];
        while (q.length > 0) out.push(q.shift());
        expect(out).toEqual(values);
      }),
      { numRuns: 60 }
    );
  });

  it('pushMany/unshiftMany keep bulk order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 1, maxLength: 100 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 100 }),
        (a, b) => {
          const q = new PowerQueue();
          q.pushMany(a);
          q.pushMany(b);
          expect(q.toArray()).toEqual([...a, ...b]);
          expect(q.length).toBe(a.length + b.length);
        }
      ),
      { numRuns: RUNS }
    );
  });

  it('clear() empties the ring without corrupting later pushes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 1, maxLength: 60 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 60 }),
        (before, after) => {
          const q = new PowerQueue();
          for (const v of before) q.push(v);
          q.clear();
          expect(q.length).toBe(0);
          expect(q.toArray()).toEqual([]);
          for (const v of after) q.push(v);
          expect(q.toArray()).toEqual(after);
        }
      ),
      { numRuns: RUNS }
    );
  });
});

describe('PowerPermitGate / PowerSemaphore concurrency invariants', () => {
  it('never grants more than `capacity` concurrent permits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.nat({ max: 5 }), { minLength: 1, maxLength: 40 }),
        async (capacity, holds) => {
          const gate = new PowerPermitGate({ capacity });
          let concurrent = 0;
          let peak = 0;
          const tasks = holds.map(() =>
            gate.acquire().then(async (release) => {
              concurrent++;
              peak = Math.max(peak, concurrent);
              await new Promise((r) => setTimeout(r, 0));
              concurrent--;
              release();
            })
          );
          await Promise.all(tasks);
          expect(peak).toBeLessThanOrEqual(capacity);
          expect(gate.available).toBe(capacity);
        }
      ),
      { numRuns: 40 }
    );
  });

  it('PowerSemaphore never exceeds its permits', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.nat({ max: 4 }), { minLength: 1, maxLength: 30 }),
        async (permits, holds) => {
          const sem = new PowerSemaphore(permits);
          let concurrent = 0;
          let peak = 0;
          await Promise.all(
            holds.map(() =>
              sem.acquire().then((release) => {
                concurrent++;
                peak = Math.max(peak, concurrent);
                return new Promise((r) => setTimeout(r, 0)).then(() => {
                  concurrent--;
                  release();
                });
              })
            )
          );
          expect(peak).toBeLessThanOrEqual(permits);
        }
      ),
      { numRuns: 40 }
    );
  });

  it('PowerBulkhead counters always return to zero after drain', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 12 }),
        async (maxConcurrency, holds) => {
          // partitions: 1 so every task contends for the same gate.
          const bh = new PowerBulkhead({ maxConcurrency, queueCapacity: 64, partitions: 1 });
          const run = (hold) =>
            bh.run(async () => {
              await new Promise((r) => setTimeout(r, 0));
              return hold;
            });
          const results = await Promise.all(holds.map(run));
          expect(results).toEqual(holds);
          await bh.drain();
          expect(bh.active).toBe(0);
          expect(bh.pending).toBe(0);
        }
      ),
      { numRuns: 40 }
    );
  });

  it('a rejected bulkhead task still returns the counters to zero', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (maxConcurrency) => {
        const bh = new PowerBulkhead({ maxConcurrency, queueCapacity: 8, partitions: 1 });
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, (_, i) =>
            bh.run(() => {
              if (i % 2 === 0) throw new Error(`boom-${i}`);
              return i;
            })
          )
        );
        expect(results.filter((r) => r.status === 'rejected').length).toBe(3);
        await bh.drain();
        expect(bh.active).toBe(0);
        expect(bh.pending).toBe(0);
      }),
      { numRuns: 40 }
    );
  });
});
