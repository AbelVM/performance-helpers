import { describe, it, expect } from 'vitest';
import { PowerQueue } from '../src/helpers/powerQueue.js';

describe('PowerQueue', () => {
  it('push/shift preserves order and length updates', () => {
    const q = new PowerQueue(4);
    expect(q.length).toBe(0);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.length).toBe(3);
    expect(q.shift()).toBe(1);
    expect(q.shift()).toBe(2);
    expect(q.shift()).toBe(3);
    expect(q.shift()).toBeUndefined();
    expect(q.length).toBe(0);
  });

  it('grows capacity when full and preserves order', () => {
    const q = new PowerQueue(2);
    const pushed = [];
    for (let i = 0; i < 10; i++) {
      q.push(i);
      pushed.push(i);
    }
    expect(q.capacity).toBeGreaterThanOrEqual(10);
    const got = [];
    while (!q.isEmpty) got.push(q.shift());
    expect(got).toEqual(pushed);
  });

  it('peek returns next item without removing it', () => {
    const q = new PowerQueue(4);
    q.push('a');
    expect(q.peek()).toBe('a');
    expect(q.length).toBe(1);
    expect(q.shift()).toBe('a');
  });

  it('clear empties the queue', () => {
    const q = new PowerQueue(4);
    q.push(1);
    q.push(2);
    q.clear();
    expect(q.length).toBe(0);
    expect(q.shift()).toBeUndefined();
  });
});

// --- AUD-013: dispose() and the using/await using teardown -------------------

describe('PowerQueue dispose (AUD-013)', () => {
  it('releases the buffer that clear() deliberately keeps', () => {
    // `clear()` nulls the occupied slots but does not release the array, and
    // that is right for a container whose purpose is bounding memory — see the
    // `shrink()` docblock, which measures a 5 000-push queue still holding an
    // 8 192-slot buffer afterwards. Teardown is the one moment the caller is
    // finished with the queue, so `dispose()` is where the array goes.
    //
    // Asserted on the buffer *identity* rather than on `capacity`, because
    // `dispose()` keeps the capacity: shrinking it would be `shrink()`'s job and
    // a caller tearing down does not care. What has to change is that the old
    // array — and every reference it still holds — is unreachable.
    const q = new PowerQueue(4);
    for (let i = 0; i < 5000; i++) q.push({ i });
    const grown = q._buffer;
    expect(q.capacity).toBeGreaterThanOrEqual(5000);

    q.dispose();

    expect(q._buffer).not.toBe(grown);
    expect(q.length).toBe(0);
    expect(q.shift()).toBeUndefined();
    // The queue is still usable afterwards — dispose is a teardown, not a
    // poisoning, and a caller that reuses the instance must not get a crash.
    q.push('after');
    expect(q.shift()).toBe('after');
  });

  it('takes part in `using` teardown', () => {
    // The reason the method exists at all: without it `PowerQueue` could not
    // participate in `using` / `await using` or a DI teardown, which every other
    // long-lived helper here supports — and its sibling `PowerPriorityQueue` has
    // had `dispose()` all along.
    let disposed;
    {
      using q = new PowerQueue(4);
      q.push(1);
      disposed = q;
    }
    expect(disposed.length).toBe(0);
    expect(disposed._buffer.every((v) => v === undefined)).toBe(true);
  });

  it('takes part in `await using` teardown', async () => {
    let disposed;
    {
      await using q = new PowerQueue(4);
      q.push(1);
      disposed = q;
    }
    expect(disposed.length).toBe(0);
  });

  it('is idempotent, so a double teardown is not an error', () => {
    // `using` plus an explicit `dispose()` in a `finally` is a shape callers
    // write, and the second call must be a no-op rather than a throw.
    const q = new PowerQueue(4);
    q.push(1);
    expect(() => {
      q.dispose();
      q.dispose();
    }).not.toThrow();
    expect(q.length).toBe(0);
  });
});
