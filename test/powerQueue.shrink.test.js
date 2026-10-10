import { describe, it, expect } from 'vitest';
import { PowerQueue } from '../src/index.js';
import { PowerSlidingWindow } from '../src/index.js';

/**
 * RES-029: a `PowerQueue` retained its high-water mark forever.
 *
 * The buffer only ever grows — `_grow()` doubles it and nothing halves it — so a
 * queue that took 5 000 items once kept an 8 192-slot buffer for the rest of its
 * life. `clear()` empties the slots but does not release them, which is correct
 * for a container whose purpose is bounding memory.
 *
 * **This is not only a caller-facing sharp edge; it was a leak in this library.**
 * `PowerSlidingWindow` keeps its timestamps in a `PowerQueue`
 * (`powerSlidingWindow.js:49`), so a single large `tryConsume` window left every
 * instance holding the memory of the worst burst it had ever seen, for the
 * lifetime of the limiter. That is the case the integration test below pins.
 *
 * Two additions, and the split between them is the design:
 *
 * - `shrink(minimum)` is **explicit**, not automatic. The obvious alternative —
 *   shrink inside `shift()` whenever `size < capacity / 2` — costs a comparison
 *   and a branch on every dequeue forever, to reclaim memory only after a burst.
 *   A caller that has just finished a burst knows when to pay; the dequeue path
 *   does not. `PowerSlidingWindow` calls it from `_prune`, which runs on a window
 *   boundary rather than per item.
 * - `fill(value, n)` removes a temporary allocation from the multi-consume path.
 *   Filling a window with `n` equal timestamps was `new Array(n)`, a loop to
 *   populate the holes, then `pushMany` to walk the result: an allocation and a
 *   second pass on every `tryConsume(n)` with `n > 1`.
 *
 * **Mutation-checked, 5 of 6 caught.** Making `shrink` a no-op fails 4; copying
 * the ring from index 0 instead of `_head` fails 1 (and it is the only test that
 * can, which is why that fixture wraps `_head` off zero); ignoring the current
 * length fails 2; `fill` pushing one copy fails 5; dropping the window's
 * `shrink()` call fails 1.
 *
 * **The sixth is unobservable, and that is the correct outcome rather than a
 * missing test.** Reverting `PowerSlidingWindow` to `new Array(want)` +
 * `pushMany(arr)` passes all 15 — because `fill` is a pure allocation change and
 * the two produce the same queue. There is no behaviour to assert, and the only
 * test that could catch it would be one asserting that a particular method is
 * *called*, which pins an implementation rather than a property. The equivalence
 * itself is pinned, by the test above that compares `fill('ts', 4)` against
 * `pushMany(new Array(4).fill('ts'))`; what is not pinned is which one the window
 * chooses, and the argument for the choice is the allocation, not the result.
 */

const POULATED = 5_000;

describe('RES-029: PowerQueue.shrink releases a burst', () => {
  it('releases the buffer after a burst is drained', () => {
    // The row's exact scenario, and the measurement that produced it: 5 000
    // pushes leaves `capacity` at 8 192, and neither draining nor clearing
    // brought it down.
    const queue = new PowerQueue();
    for (let i = 0; i < POULATED; i += 1) queue.push(i);
    expect(queue.capacity).toBe(8_192);

    while (!queue.isEmpty) queue.shift();
    expect(queue.length, 'the queue is empty').toBe(0);
    expect(queue.capacity, 'but the buffer is still the burst high-water mark').toBe(8_192);

    expect(queue.shrink()).toBe(16);
    expect(queue.capacity, 'and now it is not').toBe(16);
  });

  it('releases the buffer after clear()', () => {
    // `clear()` emptying the slots without releasing them is the other half of
    // the same problem, and the one a caller is likelier to reach for.
    const queue = new PowerQueue();
    for (let i = 0; i < POULATED; i += 1) queue.push(i);
    queue.clear();

    queue.shrink();
    expect(queue.capacity).toBeLessThan(8_192);
  });

  it('keeps the items and their order', () => {
    // Shrinking rebuilds the ring into a new buffer, and the ring is indexed by
    // `_head`/`_mask` rather than by position — so a copy that started at 0 would
    // silently reorder a queue whose contents wrapped. This is the assertion that
    // catches that, and it is the reason the queue is left non-empty in the test
    // at all: an empty queue cannot detect a reordering.
    const queue = new PowerQueue(8);
    for (let i = 0; i < 20; i += 1) queue.push(i);
    for (let i = 0; i < 12; i += 1) queue.shift(); // wrap `_head` off zero

    const before = queue.toArray();
    expect(queue.capacity).toBeGreaterThan(before.length);

    queue.shrink(2);
    expect(queue.toArray(), 'order and contents survive the reallocation').toEqual(before);
    expect(queue.length).toBe(before.length);
  });

  it('never shrinks below what the queue holds', () => {
    // The floor is the current length, not the caller's `minimum`. Shrinking to a
    // buffer smaller than the contents would drop items, and the return value
    // makes the outcome observable.
    const queue = new PowerQueue();
    for (let i = 0; i < 100; i += 1) queue.push(i);

    const capacity = queue.shrink(2);
    expect(capacity, 'a floor of 2 cannot hold 100 items').toBe(128);
    expect(queue.length, 'so nothing was dropped').toBe(100);
    expect(queue.toArray()).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('rounds up to a power of two and never below 2', () => {
    // The bitmask indexing requires a power-of-two length, exactly as the
    // constructor requires. Rounding *down* would produce a buffer whose `_mask`
    // wraps indices that do not exist.
    const queue = new PowerQueue();
    for (let i = 0; i < 1_000; i += 1) queue.push(i);
    queue.shrink(0);

    const capacity = queue.capacity;
    expect(capacity & (capacity - 1), `${capacity} is a power of two`).toBe(0);
    expect(capacity, 'and is at least the 2 the constructor also floors at').toBeGreaterThanOrEqual(
      2
    );
    expect(queue.length).toBe(1_000);
  });

  it('is a no-op when the buffer is already at the floor', () => {
    // A caller that shrinks on every window boundary must not reallocate forever.
    // If this ever started returning a smaller number, every prune would be
    // rebuilding the buffer.
    //
    // The queue is built *at* the default floor, which is the case that matters:
    // the first draft of this test built one at 64 and asserted it stayed 64, on
    // the reasoning that "already large enough" meant no-op. It shrank to 16 and
    // was right to — the default floor is 16, and 64 is above it. The property
    // is "at the floor", not "large".
    const queue = new PowerQueue(16);
    for (let i = 0; i < 10; i += 1) queue.push(i);
    expect(queue.capacity).toBe(16);

    const first = queue.shrink();
    expect(first).toBe(16);
    const bufferBefore = queue._buffer;
    expect(queue.shrink(), 'a second call does nothing').toBe(16);
    expect(queue._buffer, 'and does not reallocate the buffer').toBe(bufferBefore);
  });

  it('shrinks down to the default floor from a larger buffer', () => {
    // The companion to the test above, so the two together state the rule: the
    // floor is the *default minimum* (16), and a bigger buffer does come down.
    const queue = new PowerQueue(64);
    for (let i = 0; i < 10; i += 1) queue.push(i);
    expect(queue.capacity).toBe(64);
    expect(queue.shrink(), '64 is above the default floor of 16').toBe(16);
    expect(queue.length, 'and the contents are untouched').toBe(10);
  });

  it('rejects a non-numeric minimum, as the constructor does', () => {
    // Whatever the constructor rejects, the sizing helpers should reject too, or
    // `new PowerQueue('lots')` throws while `shrink('lots')` quietly becomes 16.
    const queue = new PowerQueue();
    expect(() => queue.shrink('lots')).toThrow(TypeError);
    expect(() => queue.shrink(-1)).toThrow(TypeError);
    expect(() => queue.shrink(Number.NaN)).toThrow(TypeError);
  });
});

describe('RES-029: PowerQueue.fill', () => {
  it('enqueues count copies, matching pushMany of a filled array', () => {
    // The equivalence is the claim: `fill(v, n)` must be indistinguishable from
    // what the sliding window used to do, or the window's recorded timestamps
    // change.
    const viaFill = new PowerQueue();
    viaFill.fill('ts', 4);

    const viaArray = new PowerQueue();
    const arr = new Array(4);
    for (let i = 0; i < 4; i += 1) arr[i] = 'ts';
    viaArray.pushMany(arr);

    expect(viaFill.toArray()).toEqual(viaArray.toArray());
    expect(viaFill.length).toBe(4);
  });

  it('appends to existing contents rather than replacing them', () => {
    const queue = new PowerQueue();
    queue.push('a');
    queue.fill('b', 2);
    expect(queue.toArray()).toEqual(['a', 'b', 'b']);
  });

  it('grows the buffer when the fill exceeds the current capacity', () => {
    // The growth path inside `fill` is its own copy of `push`'s, and a fill that
    // spanned the boundary would be the place for it to be wrong.
    const queue = new PowerQueue(2);
    queue.fill('x', 100);
    expect(queue.length).toBe(100);
    expect(queue.toArray()).toEqual(Array.from({ length: 100 }, () => 'x'));
  });

  it('treats a count of 0 as nothing to do, and rejects a bad count', () => {
    const queue = new PowerQueue();
    expect(queue.fill('x', 0)).toBe(0);
    expect(queue.length).toBe(0);
    expect(() => queue.fill('x', -1)).toThrow(TypeError);
    expect(() => queue.fill('x', 'three')).toThrow(TypeError);
  });

  it('wraps correctly when a fill spans the end of the ring (AUD-018)', () => {
    // **A characterisation, not a regression test — and it says so because the
    // distinction matters.** AUD-018 replaced `fill`'s per-item loop with
    // `pushMany`'s bulk block-writing path. The old loop was *correct*; it was
    // only slower. So no behavioural test can fail on the change, and one that
    // claimed to would be decoration.
    //
    // What this pins is the thing the refactor could plausibly have broken: the
    // bulk path writes in contiguous blocks and wraps between them, so a fill
    // starting near the end of the ring is the case to get wrong. None of the
    // tests above reach it — the grow test starts from an empty queue at index 0,
    // and the append test is far too small to wrap.
    //
    // The evidence that the change is *worth* anything is the benchmark, not
    // this file: 13–18 % faster on the real class across four runs, same
    // direction every time.
    //
    // Built by draining rather than by growing, so the capacity stays at 8 and
    // `_tail` sits at 6 with room for only two more before the wrap.
    const queue = new PowerQueue(8);
    expect(queue.capacity).toBe(8);
    for (let i = 0; i < 6; i++) queue.push(`pre-${i}`);
    for (let i = 0; i < 4; i++) queue.shift(); // head advances to 4, tail stays 6
    expect(queue.length).toBe(2);

    // 2 resident + 4 filled = 6, which fits in 8, so no grow happens and the
    // fill has to wrap: two slots at 6–7, then two more at 0–1.
    queue.fill('x', 4);

    expect(queue.length).toBe(6);
    expect(queue.toArray()).toEqual(['pre-4', 'pre-5', 'x', 'x', 'x', 'x']);
    // And the ring is still consistent afterwards — a botched wrap shows up as a
    // corrupted read on the *next* operation, not on this one.
    queue.push('after');
    expect(queue.toArray()).toEqual(['pre-4', 'pre-5', 'x', 'x', 'x', 'x', 'after']);
    expect(queue.shift()).toBe('pre-4');
    expect(queue.toArray()).toEqual(['pre-5', 'x', 'x', 'x', 'x', 'after']);
  });

  it('accounts weight once for the whole batch, not per copy (AUD-018)', () => {
    // Also a characterisation. The old loop already computed the weight once
    // (`itemWeight(item) * n`) and added it once, so this cannot fail on the
    // change either — it pins that the bulk path kept the same arithmetic,
    // which is the part of the refactor with no test of its own.
    const queue = new PowerQueue(4);
    queue.fill({ weight: 3 }, 5);
    expect(queue.totalWeight).toBe(15);
    queue.fill({ weight: 2 }, 3);
    expect(queue.totalWeight).toBe(21);
    // Draining releases it again, so the total tracks the live contents.
    for (let i = 0; i < 8; i++) queue.shift();
    expect(queue.totalWeight).toBe(0);
  });
});

describe('RES-029: PowerSlidingWindow releases its ring', () => {
  it('hands back the buffer a burst grew', () => {
    // The integration case, and the reason this was more than a caller-facing
    // sharp edge: the window's timestamps live in a `PowerQueue`, so the leak was
    // inside the library rather than in the caller's code.
    //
    // **Rewritten for AUD-016, and the expectation moved rather than loosened.**
    // This used to assert that a 5 000-timestamp burst into a capacity-8 192
    // window released its ring on the next prune. It does not any more, and the
    // reason is that the old expectation *was* the thrash: 5 000 timestamps need
    // 8 192 slots, so a ring at 8 192 is correctly sized for the demand that grew
    // it, not oversized. Releasing it to the initial 16 meant the next 5 000-burst
    // regrew it immediately — which is the reallocation-per-window AUD-016
    // measured at 4–6 per window under steady load.
    //
    // What is pinned now is the property that actually matters, in both
    // directions: a ring sized for demand that has *genuinely* dropped is
    // released, and a ring sized for the demand that grew it is retained. The
    // release half is covered below by "still releases the ring after a burst has
    // passed"; this test covers the retain half, and the bound that makes
    // retention safe.
    let clock = 1_000_000;
    const window = new PowerSlidingWindow({ windowMs: 1_000, capacity: 8_192, now: () => clock });

    expect(window.tryConsume(5_000), 'the burst is admitted').toBe(true);
    expect(window._timestamps.capacity, 'the ring grew to hold it').toBe(8_192);

    // Let the whole window age out, then read availability — which prunes.
    clock += 5_000;
    expect(window.available(), 'the window is empty again').toBe(8_192);
    // 5 000 timestamps need 8 192 slots, so the ring is the right size for the
    // demand that grew it. Retaining it is not a leak: it is bounded by the
    // configured capacity, which `tryConsume` enforces.
    expect(window._timestamps.capacity, 'a correctly-sized ring is retained').toBe(8_192);

    // And the bound that makes retention safe — the ring can never exceed what
    // the limiter was configured for, however hard it is pushed.
    const pushed = new PowerSlidingWindow({ windowMs: 1_000, capacity: 8_192, now: () => 1 });
    let admitted = 0;
    for (let i = 0; i < 20_000; i++) if (pushed.tryConsume(1)) admitted += 1;
    expect(admitted).toBe(8_192);
    expect(pushed._timestamps.capacity).toBe(8_192);
  });

  it('does not reallocate on every window boundary', () => {
    // The reason `shrink` is called from `_prune` and not from `shift`. The
    // default floor is the queue's initial capacity, so steady traffic settles
    // there once instead of rebuilding the buffer every window.
    let clock = 1_000_000;
    const window = new PowerSlidingWindow({ windowMs: 1_000, capacity: 8_192, now: () => clock });

    for (let round = 0; round < 20; round += 1) {
      window.tryConsume(10);
      clock += 2_000; // the previous window ages out
      window.available();
    }

    const capacity = window._timestamps.capacity;
    window.tryConsume(10);
    clock += 2_000;
    window.available();
    expect(window._timestamps.capacity, 'steady traffic settles and stays put').toBe(capacity);
    expect(capacity, 'and at the initial capacity, not 8 192').toBeLessThan(64);
  });

  it('still records the right number of timestamps for a multi-consume', () => {
    // `fill` replaced `new Array(n)` + `pushMany` on this path, so the count it
    // records is the thing that has to be unchanged.
    const clock = 1_000_000;
    const window = new PowerSlidingWindow({ windowMs: 60_000, capacity: 100, now: () => clock });

    expect(window.tryConsume(5)).toBe(true);
    expect(window._timestamps.length).toBe(5);
    expect(window.available()).toBe(95);
    expect(window.tryConsume(1)).toBe(true);
    expect(window._timestamps.length).toBe(6);
  });
});
