import { describe, it, expect } from 'vitest';
import { PowerBatch } from '../src/helpers/powerBatch.js';

describe('PowerBatch branches extra', () => {
  it('constructor throws when handler not a function', () => {
    expect(() => new PowerBatch(null)).toThrow();
  });

  it('flush returns resolved promise when empty and not scheduled', async () => {
    const b = new PowerBatch(async () => {});
    // ensure empty
    expect(b.size).toBe(0);
    const res = await b.flush();
    expect(res).toBeUndefined();
  });

  it('rejects an empty flush when its wait signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const b = new PowerBatch(async () => {});

    await expect(b.flush({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('add schedules handler and resolves regular add promise', async () => {
    let called = false;
    const b = new PowerBatch(async (items) => {
      called = true;
      expect(items.length).toBeGreaterThan(0);
    });
    const p = b.add(1);
    await p;
    // wait a tick for handler
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(true);
  });

  it('flush returns a promise that rejects when handler throws', async () => {
    const b = new PowerBatch(async () => {
      throw new Error('boom');
    });
    b.add(1);
    await expect(b.flush()).rejects.toThrow('boom');
  });

  it('clear rejects pending add promises and empties queue', async () => {
    let called = false;
    const b = new PowerBatch(async () => {
      called = true;
    });
    const promise = b.add(1);
    b.clear();
    await expect(promise).rejects.toThrow('PowerBatch cleared before flush');
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(false);
    expect(b.size).toBe(0);
  });

  it('creates a fresh pending batch for items added while the handler is running', async () => {
    const calls = [];
    let releaseFirstBatch;
    const firstBatchGate = new Promise((resolve) => {
      releaseFirstBatch = resolve;
    });

    const b = new PowerBatch(async (items) => {
      calls.push(items.slice());
      if (calls.length === 1) {
        await firstBatchGate;
      }
    });

    const first = b.add('a');
    await Promise.resolve();
    const second = b.add('b');
    releaseFirstBatch();

    await Promise.all([first, second]);

    expect(calls).toEqual([['a'], ['b']]);
  });

  it('rejects a non-positive maxSize instead of silently never flushing', () => {
    // `Number(maxSize) || Infinity` turned `maxSize: 0` into `Infinity`, so a
    // batch accumulated forever and never flushed on its own - a silent leak,
    // not a "normalization". A nonsensical limit is a configuration error.
    expect(() => new PowerBatch(() => {}, { maxSize: 0 })).toThrow(/maxSize/);
    expect(() => new PowerBatch(() => {}, { maxSize: -5 })).toThrow(/maxSize/);
    expect(() => new PowerBatch(() => {}, { maxSize: Number.NaN })).toThrow(/maxSize/);
  });

  it('rejects an unknown scheduling mode rather than normalising it', async () => {
    // **This used to assert the opposite** — "still falls back to microtask for
    // an unknown scheduling mode" — so the fallback was a deliberate decision,
    // not an oversight. It was wrong for two reasons, and RES-033 is the record
    // of the change.
    //
    // The inconsistency is local: the `maxSize` test three assertions above says
    // "A nonsensical limit is a configuration error", and throws for `0`, `-5` and
    // `NaN`. This option normalised the same class of nonsense. One file, two
    // answers to the same question.
    //
    // And the fallback picked `microtask`, the *fastest* strategy, for a
    // scheduler that was asked for something else — which is what
    // `PowerScheduler` throws to prevent, in a comment that says so explicitly.
    // It also made `'yield'` unreachable, since every non-`'macrotask'` value
    // collapsed onto `'microtask'`.
    expect(() => new PowerBatch(() => {}, { scheduling: 'invalid' })).toThrow(
      /scheduling.*must be one of/i
    );
  });

  it('still coalesces a flush on a valid scheduling mode', async () => {
    // Kept so the batching this test used to cover incidentally is still covered:
    // the previous body asserted the items arrived together, which is worth
    // keeping whatever happens to the fallback.
    const calls = [];
    const b = new PowerBatch(
      async (items) => {
        calls.push(items.slice());
      },
      { scheduling: 'microtask' }
    );

    b.add(1);
    b.add(2);
    await b.flush();

    expect(calls).toEqual([[1, 2]]);
  });

  it('accepts Infinity as an explicit "never auto-flush" maxSize', () => {
    const b = new PowerBatch(() => {}, { maxSize: Number.POSITIVE_INFINITY });
    expect(b._maxSize).toBe(Number.POSITIVE_INFINITY);
  });

  it('resets and disposes the batch lifecycle', async () => {
    const b = new PowerBatch(() => {});
    const pending = b.add('x');
    b.reset();

    await expect(pending).rejects.toThrow('PowerBatch cleared before flush');
    expect(b.size).toBe(0);
    b[Symbol.dispose]();
    b.dispose();
  });

  it('flush re-schedules queued work if a pending batch exists but the scheduler was canceled', async () => {
    const calls = [];
    const b = new PowerBatch(async (items) => {
      calls.push(items.slice());
    });

    const addPromise = b.add('x');
    b._scheduler.cancel();

    await b.flush();
    await addPromise;

    expect(calls).toEqual([['x']]);
  });

  it('resolves orphaned pending promises on empty internal runs and rethrows handler errors without pending state', async () => {
    const b = new PowerBatch(async () => {});
    const pending = b.add('x');
    b._queue.clear();

    await b._runBatch();
    await expect(pending).resolves.toBeUndefined();
    expect(b._pending).toBeNull();

    const b2 = new PowerBatch(async () => {
      throw new Error('boom');
    });
    b2._queue.push('y');

    await expect(b2._runBatch()).rejects.toThrow('boom');
  });
});
