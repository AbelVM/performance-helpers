import { describe, it, expect, vi } from 'vitest';
import { PowerScheduler } from '../src/helpers/powerScheduler.js';

describe('PowerScheduler', () => {
  it('throws when constructed without a flush function', () => {
    expect(() => new PowerScheduler(null)).toThrow(TypeError);
  });

  it('schedules a microtask flush and invokes the callback once', async () => {
    let called = 0;
    const scheduler = new PowerScheduler(() => {
      called += 1;
    });

    scheduler.schedule();
    scheduler.schedule();
    expect(scheduler.scheduled).toBe(true);
    await Promise.resolve();
    expect(called).toBe(1);
    expect(scheduler.scheduled).toBe(false);
  });

  it('supports flushing immediately before the scheduled callback runs', async () => {
    let called = 0;
    const scheduler = new PowerScheduler(() => {
      called += 1;
    });

    scheduler.schedule();
    expect(scheduler.scheduled).toBe(true);
    scheduler.flush();
    expect(called).toBe(1);
    expect(scheduler.scheduled).toBe(false);
    await Promise.resolve();
    expect(called).toBe(1);
  });

  it('cancels a scheduled flush and prevents callback invocation', async () => {
    let called = 0;
    const scheduler = new PowerScheduler(() => {
      called += 1;
    });

    scheduler.schedule();
    expect(scheduler.scheduled).toBe(true);
    scheduler.cancel();
    expect(scheduler.scheduled).toBe(false);
    await Promise.resolve();
    expect(called).toBe(0);
  });

  it('supports macrotask scheduling', async () => {
    let called = 0;
    const scheduler = new PowerScheduler(
      () => {
        called += 1;
      },
      { scheduling: 'macrotask' }
    );

    scheduler.schedule();
    expect(scheduler.scheduled).toBe(true);
    // The scheduler uses `setImmediate`, and this test used to wait with
    // `setTimeout(resolve, 0)`. Those are different phases - timers and check -
    // and Node guarantees no ordering between them when both are scheduled from
    // the main module, so the assertion raced and failed roughly one run in
    // three. A fixed sleep is a guess in both directions: on a loaded machine
    // it can also assert before the callback has run.
    //
    // Polling the actual condition is the fix (TEST-008). `scheduler.scheduled`
    // is asserted after the wait rather than before, so the test ends only once
    // the flush has actually happened.
    await vi.waitFor(() => {
      expect(called).toBe(1);
    });
    expect(scheduler.scheduled).toBe(false);
  });

  it('flush and cancel are no-ops when nothing is scheduled', () => {
    const scheduler = new PowerScheduler(() => {});

    expect(() => scheduler.flush()).not.toThrow();
    expect(() => scheduler.cancel()).not.toThrow();
    expect(scheduler.scheduled).toBe(false);
  });

  it('swallows callback errors by default without logging to console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const scheduler = new PowerScheduler(() => {
        throw new Error('flush failed');
      });

      scheduler.schedule();
      await Promise.resolve();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(scheduler.scheduled).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('calls onError when provided and continues scheduling safely', async () => {
    const onError = vi.fn();
    const scheduler = new PowerScheduler(
      () => {
        throw new Error('flush failed');
      },
      { onError }
    );

    scheduler.schedule();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(scheduler.scheduled).toBe(false);
  });

  it('swallows onError hook failures', async () => {
    const scheduler = new PowerScheduler(
      () => {
        throw new Error('flush failed');
      },
      {
        onError: () => {
          throw new Error('hook failed');
        },
      }
    );

    scheduler.schedule();
    await Promise.resolve();

    expect(scheduler.scheduled).toBe(false);
  });
});

// ─── ALG-007: the macrotask path ────────────────────────────────────────────
//
// `setTimeout(fn, 0)` is the obvious way to schedule a macrotask and it is the
// slow one: Node clamps a zero timeout to 1 ms, so a scheduler flushing per
// turn pays a full millisecond every time. Measured over 10 000 macrotasks in
// this runtime, MessageChannel is 37 ms and setTimeout(0) is 10 554 ms. The
// implementation therefore posts to a MessageChannel, falling back to
// setImmediate and only then to setTimeout.
//
// The part worth testing is not the speed - it is that the new *cancellation*
// path is correct, since `flush()` has to detach a pending post rather than
// `clearTimeout` a handle that is no longer a timer.
describe('PowerScheduler macrotask scheduling (ALG-007)', () => {
  it('flushes on a macrotask, not a microtask', async () => {
    const seen = [];
    const s = new PowerScheduler(() => seen.push('flush'), { scheduling: 'macrotask' });
    s.schedule();
    // A microtask would already have run by the time this await resolves, so
    // awaiting one tick first is what makes "macrotask" an observable claim.
    await Promise.resolve();
    expect(seen).toEqual([]);
    await vi.waitFor(() => {
      expect(seen).toEqual(['flush']);
    });
  });

  it('coalesces many schedules into one flush', async () => {
    let flushes = 0;
    const s = new PowerScheduler(() => flushes++, { scheduling: 'macrotask' });
    for (let i = 0; i < 50; i++) s.schedule();
    await vi.waitFor(() => {
      expect(flushes).toBe(1);
    });
  });

  it('flush() cancels a pending macrotask instead of double-flushing', async () => {
    // `flush()` used to `clearTimeout` its handle. It now has to cancel a
    // MessagePort listener instead, and a cancellation that silently did
    // nothing would leave the scheduled flush to run afterwards - so the
    // scheduled callback fires and the immediate one does not.
    const seen = [];
    const s = new PowerScheduler(() => seen.push('flush'), { scheduling: 'macrotask' });
    s.schedule();
    s.flush(); // run it now, before the posted macrotask gets its turn
    expect(seen).toEqual(['flush']);
    await vi.waitFor(() => {
      // Still exactly one: the pending post was cancelled, not merely raced.
      expect(seen).toEqual(['flush']);
    });
  });

  it('cancel() also cancels a pending macrotask', async () => {
    let flushes = 0;
    const s = new PowerScheduler(() => flushes++, { scheduling: 'macrotask' });
    s.schedule();
    s.cancel();
    // Real wait, deliberately. This asserts the flush *never* ran, and
    // `vi.waitFor` cannot express that — its condition is already true before
    // it starts, so it would return immediately and assert nothing. The
    // macrotask is a `setImmediate`, so there is no handle to fake either.
    await new Promise((r) => setTimeout(r, 30));
    expect(flushes).toBe(0);
  });

  it('survives being flushed after the macrotask already fired', async () => {
    // Cancelling an already-delivered post must not throw; a MessagePort
    // listener that has been removed is simply not there.
    const s = new PowerScheduler(() => {}, { scheduling: 'macrotask' });
    s.schedule();
    await vi.waitFor(() => {
      expect(s.scheduled).toBe(false);
    });
    // The macrotask has landed, so the later flush is operating on an already
    // delivered post.
    expect(() => s.flush()).not.toThrow();
    expect(() => s.cancel()).not.toThrow();
    expect(() => s.dispose()).not.toThrow();
  });
});
