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

describe('PowerQueue unshift', () => {
  // PISC-008. The mirror of `push`, and the primitive a return-to-front path needs:
  // a task dequeued for dispatch that could not be delivered goes back where it came
  // from, not behind everything that arrived after it.
  //
  // **The wrap case is the one that matters.** A queue whose head is not 0 is where
  // wrong slot arithmetic hides, and it is exactly what the first draft of this
  // method got wrong — it looped over every item moving it back, dropped the tail
  // item, and left a hole. The correct form is O(1) and moves nothing: see the JSDoc
  // on the method for why.

  it('enqueues at the head, so it is the next shift', () => {
    const q = new PowerQueue(4);
    q.push('a');
    q.push('b');
    q.push('c');
    expect(q.unshift('z')).toBe(4);
    expect(q.toArray()).toEqual(['z', 'a', 'b', 'c']);
    expect(q.shift()).toBe('z');
    expect(q.shift()).toBe('a');
    expect(q.toArray()).toEqual(['b', 'c']);
  });

  it('works when the head has wrapped, which is where slot arithmetic hides', () => {
    // Fill past the initial capacity so `_grow()` runs and the head is no longer 0.
    // A draft that moved items by index rather than by ring position failed here
    // while passing the plain case above.
    const q = new PowerQueue(4);
    for (let i = 0; i < 6; i++) q.push(i);
    expect(q.toArray()).toEqual([0, 1, 2, 3, 4, 5]);
    q.unshift('X');
    expect(q.toArray()).toEqual(['X', 0, 1, 2, 3, 4, 5]);
    expect(q.length).toBe(7);
    expect(q.shift()).toBe('X');
    expect(q.shift()).toBe(0);
    expect(q.toArray()).toEqual([1, 2, 3, 4, 5]);
  });

  it('grows when full, and preserves order across the growth', () => {
    const q = new PowerQueue(2);
    q.push(1);
    q.push(2);
    expect(q.length).toBe(2);
    q.unshift(0);
    expect(q.toArray()).toEqual([0, 1, 2]);
    expect(q.length).toBe(3);
  });

  it('interleaves with push, so the two are true mirrors', () => {
    const q = new PowerQueue(4);
    q.push('a');
    q.unshift('z');
    q.push('b');
    q.unshift('y');
    expect(q.toArray()).toEqual(['y', 'z', 'a', 'b']);
  });

  it('accounts weight, so totalWeight stays the sum over queued items', () => {
    // The bookkeeping `push` and `shift` maintain. A method that moved items without
    // adjusting it would desynchronise the total from the contents.
    const q = new PowerQueue(4);
    q.push({ weight: 2 });
    q.push({ weight: 3 });
    expect(q.totalWeight).toBe(5);
    q.unshift({ weight: 5 });
    expect(q.totalWeight).toBe(10);
    expect(q.shift().weight).toBe(5);
    expect(q.totalWeight).toBe(5);
  });

  it('works on an empty queue', () => {
    const q = new PowerQueue(4);
    expect(q.unshift('solo')).toBe(1);
    expect(q.toArray()).toEqual(['solo']);
    expect(q.shift()).toBe('solo');
    expect(q.length).toBe(0);
  });

  it('is the inverse of shift, so a round-trip is a no-op', () => {
    // The property the return-to-front path actually relies on: dequeue, fail to
    // deliver, put it back, and the queue is exactly as it was.
    const q = new PowerQueue(4);
    q.push('a');
    q.push('b');
    q.push('c');
    const before = q.toArray();
    const taken = q.shift();
    q.unshift(taken);
    expect(q.toArray()).toEqual(before);
  });
});
